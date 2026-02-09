/**
 * Google Antigravity OAuth integration for CodePilot.
 *
 * Uses Google OAuth 2.0 with PKCE to authenticate via Google's Antigravity IDE backend,
 * then generates Application Default Credentials (ADC) for Claude Code's Vertex AI mode.
 *
 * Flow:
 * 1. User clicks "Login with Google" → opens system browser to Google OAuth
 * 2. OAuth callback on localhost:51121 → receives auth code
 * 3. Exchange auth code for refresh_token + access_token
 * 4. Write result to ~/.codepilot/antigravity-pending.json (file-based IPC)
 * 5. Frontend polls API, which reads the file → gets refreshToken + email
 * 6. Store refresh_token as provider's api_key
 * 7. Before chat: write ADC file with refresh_token → Claude Code uses Vertex AI mode
 */

import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Google OAuth constants (from Antigravity IDE)
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:51121/oauth-callback';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

const CALLBACK_PORT = 51121;

/** Path to the file used to communicate OAuth results between callback server and API route */
function getPendingFilePath(): string {
  return path.join(os.homedir(), '.codepilot', 'antigravity-pending.json');
}

// PKCE helpers
function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Track active server so we can cancel if a new OAuth starts */
let activeServer: http.Server | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Write OAuth result to the pending file.
 * This is the file-based IPC mechanism between the callback HTTP server
 * and the Next.js API route that the frontend polls.
 */
function writePendingResult(data: { status: 'complete'; refreshToken: string; email: string } | { status: 'error'; error: string }): void {
  const dir = path.join(os.homedir(), '.codepilot');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getPendingFilePath(), JSON.stringify(data), { mode: 0o600 });
}

/**
 * Read and consume the pending OAuth result file.
 * Returns null if no pending result. Deletes the file after reading.
 */
export function readPendingResult(): { status: 'complete'; refreshToken: string; email: string } | { status: 'error'; error: string } | null {
  const filePath = getPendingFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Delete after reading (consume once)
    fs.unlinkSync(filePath);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear any stale pending result file (called when starting a new OAuth flow).
 */
function clearPendingResult(): void {
  try {
    const filePath = getPendingFilePath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * Start the Antigravity OAuth flow.
 * Returns the authorization URL to open in the system browser.
 * The callback server writes the result to a file, which the API route polls.
 */
export function startAntigravityOAuth(): { authUrl: string } {
  // Cancel any pending OAuth
  if (activeServer) {
    try { activeServer.close(); } catch {}
    activeServer = null;
  }
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }

  // Clear stale result file
  clearPendingResult();

  const pkce = generatePKCE();
  const state = base64url(crypto.randomBytes(16));

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  const server = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/oauth-callback')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    try {
      const callbackUrl = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

      // Verify OAuth state parameter to prevent CSRF attacks
      const returnedState = callbackUrl.searchParams.get('state');
      if (returnedState !== state) {
        throw new Error('OAuth state mismatch - possible CSRF attack');
      }

      const code = callbackUrl.searchParams.get('code');
      if (!code) {
        throw new Error('No authorization code received');
      }

      // Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
          code_verifier: pkce.verifier,
        }),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${errText}`);
      }

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      if (!tokens.refresh_token) {
        throw new Error('No refresh token received. Please revoke app access and try again.');
      }

      // Fetch user email
      let email = '';
      try {
        const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (userInfoRes.ok) {
          const userInfo = await userInfoRes.json() as { email?: string };
          email = userInfo.email || '';
        }
      } catch {
        // email is optional
      }

      // Write result to file for the API route to pick up
      writePendingResult({ status: 'complete', refreshToken: tokens.refresh_token, email });
      console.log(`[antigravity] OAuth success, email=${email}, result written to file`);

      // Success page — tells user to go back to CodePilot
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>CodePilot - Auth Success</title>
        <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
        .card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333}
        h1{color:#4ade80;margin-bottom:0.5rem}p{color:#999;margin-top:0.5rem}.hint{font-size:0.85rem;margin-top:1rem;color:#666}</style></head>
        <body><div class="card"><h1>Authentication Successful</h1>
        <p>${email ? `Signed in as ${email}` : 'Google account connected.'}</p>
        <p class="hint">You can close this tab and return to CodePilot.</p></div></body></html>`);
    } catch (err) {
      // Write error to file
      writePendingResult({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      console.error(`[antigravity] OAuth failed:`, err);

      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>CodePilot - Auth Failed</title>
        <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
        .card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333}
        h1{color:#ef4444;margin-bottom:0.5rem}p{color:#999}</style></head>
        <body><div class="card"><h1>Authentication Failed</h1>
        <p>${err instanceof Error ? err.message : 'Unknown error'}</p></div></body></html>`);
    } finally {
      // Clean up server after handling callback
      if (activeTimeout) { clearTimeout(activeTimeout); activeTimeout = null; }
      setTimeout(() => {
        try { server.close(); } catch {}
        if (activeServer === server) activeServer = null;
      }, 1000); // delay 1s to let response flush
    }
  });

  server.listen(CALLBACK_PORT, '127.0.0.1', () => {
    console.log(`[antigravity] OAuth callback server listening on port ${CALLBACK_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const msg = `Port ${CALLBACK_PORT} is already in use. Please close any other application using this port and try again.`;
      console.error(`[antigravity] ${msg}`);
      writePendingResult({ status: 'error', error: msg });
    } else {
      console.error(`[antigravity] Callback server error:`, err);
      writePendingResult({ status: 'error', error: `Failed to start callback server: ${err.message}` });
    }
    activeServer = null;
  });

  activeServer = server;

  // 5 minute timeout
  activeTimeout = setTimeout(() => {
    writePendingResult({ status: 'error', error: 'OAuth login timed out (5 minutes)' });
    try { server.close(); } catch {}
    activeServer = null;
    activeTimeout = null;
  }, 5 * 60 * 1000);

  return { authUrl: url.toString() };
}

/**
 * Write Google Application Default Credentials (ADC) file.
 * Claude Code's Vertex AI mode uses the Google Auth Library which reads this file.
 */
export function writeADCCredentials(refreshToken: string): string {
  const adcDir = path.join(os.homedir(), '.codepilot');
  if (!fs.existsSync(adcDir)) {
    fs.mkdirSync(adcDir, { recursive: true });
  }

  const adcPath = path.join(adcDir, 'google-adc.json');
  const adc = {
    type: 'authorized_user',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  };

  fs.writeFileSync(adcPath, JSON.stringify(adc, null, 2), { mode: 0o600 });
  return adcPath;
}

/**
 * Write accounts.json for cross-compatibility with standalone antigravity-claude-proxy.
 * Format: composite refresh token = refreshToken|projectId|projectId
 * Path: ~/.config/antigravity-proxy/accounts.json
 */
export function writeProxyAccounts(refreshToken: string, projectId: string, email?: string): void {
  try {
    const configDir = path.join(os.homedir(), '.config', 'antigravity-proxy');
    const configPath = path.join(configDir, 'accounts.json');

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Composite refresh token format: refreshToken|projectId|managedProjectId
    const compositeToken = `${refreshToken}|${projectId}|${projectId}`;

    // Read existing accounts to avoid duplicates
    let existingConfig: { accounts: Array<Record<string, unknown>>; settings: Record<string, unknown>; activeIndex: number } = {
      accounts: [],
      settings: {},
      activeIndex: 0,
    };
    try {
      if (fs.existsSync(configPath)) {
        existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch {
      // ignore parse errors, start fresh
    }

    // Check if account already exists (by email or refresh token prefix)
    const accountEmail = email || 'codepilot@antigravity';
    const existingIdx = existingConfig.accounts.findIndex(
      (acc) => acc.email === accountEmail || (acc.refreshToken as string)?.startsWith(refreshToken.slice(0, 20)),
    );

    const account = {
      email: accountEmail,
      source: 'oauth',
      enabled: true,
      dbPath: null,
      refreshToken: compositeToken,
      projectId,
      addedAt: new Date().toISOString(),
      isInvalid: false,
      invalidReason: null,
      modelRateLimits: {},
      lastUsed: null,
      subscription: { tier: 'unknown', projectId: null, detectedAt: null },
      quota: { models: {}, lastChecked: null },
    };

    if (existingIdx >= 0) {
      existingConfig.accounts[existingIdx] = account;
    } else {
      existingConfig.accounts.push(account);
    }

    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), { mode: 0o600 });
    console.log(`[antigravity] Wrote proxy accounts.json with ${existingConfig.accounts.length} account(s)`);
  } catch (err) {
    console.warn('[antigravity] Failed to write proxy accounts.json:', err);
  }
}

/**
 * Refresh an access token from a refresh token.
 * Used to verify the refresh token is still valid.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
} | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { access_token: string; expires_in: number };
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  } catch {
    return null;
  }
}
