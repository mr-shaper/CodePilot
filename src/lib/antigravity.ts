/**
 * Google Antigravity OAuth integration for CodePilot.
 *
 * Uses Google OAuth 2.0 with PKCE to authenticate via Google's Antigravity IDE backend,
 * then generates Application Default Credentials (ADC) for Claude Code's Vertex AI mode.
 *
 * Flow:
 * 1. User clicks "Login with Google" → opens browser to Google OAuth
 * 2. OAuth callback on localhost:51121 → receives auth code
 * 3. Exchange auth code for refresh_token + access_token
 * 4. Store refresh_token as provider's api_key
 * 5. Before chat: write ADC file with refresh_token → Claude Code uses Vertex AI mode
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
];

const CALLBACK_PORT = 51121;

// PKCE helpers
function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Active OAuth state (in-memory, one at a time) */
let pendingOAuth: {
  verifier: string;
  resolve: (result: { refreshToken: string; email: string }) => void;
  reject: (err: Error) => void;
  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

/**
 * Start the Antigravity OAuth flow.
 * Returns the authorization URL to open in the browser.
 * The returned Promise resolves when the callback is received.
 */
export function startAntigravityOAuth(): {
  authUrl: string;
  promise: Promise<{ refreshToken: string; email: string }>;
} {
  // Cancel any pending OAuth
  if (pendingOAuth) {
    pendingOAuth.reject(new Error('New OAuth started'));
    clearTimeout(pendingOAuth.timeout);
    try { pendingOAuth.server.close(); } catch {}
    pendingOAuth = null;
  }

  const pkce = generatePKCE();

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  const promise = new Promise<{ refreshToken: string; email: string }>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth-callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      try {
        const callbackUrl = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
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

        // Success page
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>CodePilot - Auth Success</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
          .card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333}
          h1{color:#4ade80;margin-bottom:0.5rem}p{color:#999;margin-top:0.5rem}</style></head>
          <body><div class="card"><h1>Authentication Successful</h1>
          <p>${email ? `Signed in as ${email}` : 'You can close this window and return to CodePilot.'}</p></div></body></html>`);

        resolve({ refreshToken: tokens.refresh_token, email });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>CodePilot - Auth Failed</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
          .card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333}
          h1{color:#ef4444;margin-bottom:0.5rem}p{color:#999}</style></head>
          <body><div class="card"><h1>Authentication Failed</h1>
          <p>${err instanceof Error ? err.message : 'Unknown error'}</p></div></body></html>`);
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        // Clean up
        clearTimeout(pendingOAuth?.timeout as ReturnType<typeof setTimeout>);
        try { server.close(); } catch {}
        pendingOAuth = null;
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`[antigravity] OAuth callback server listening on port ${CALLBACK_PORT}`);
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      pendingOAuth = null;
    });

    // 5 minute timeout
    const timeout = setTimeout(() => {
      reject(new Error('OAuth login timed out (5 minutes)'));
      try { server.close(); } catch {}
      pendingOAuth = null;
    }, 5 * 60 * 1000);

    pendingOAuth = { verifier: pkce.verifier, resolve, reject, server, timeout };
  });

  return { authUrl: url.toString(), promise };
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
