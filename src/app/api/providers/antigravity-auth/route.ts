import { NextRequest, NextResponse } from 'next/server';
import { startAntigravityOAuth, refreshAccessToken } from '@/lib/antigravity';

/**
 * In-memory storage for the pending OAuth promise.
 * Only one OAuth flow at a time is supported.
 */
let pendingResult: Promise<{ refreshToken: string; email: string }> | null = null;
let lastResult: { refreshToken: string; email: string } | null = null;
let lastError: string | null = null;

/**
 * POST /api/providers/antigravity-auth
 * Start the Antigravity OAuth flow. Returns the auth URL to open in the browser.
 */
export async function POST() {
  try {
    // Reset state
    lastResult = null;
    lastError = null;

    const { authUrl, promise } = startAntigravityOAuth();
    pendingResult = promise;

    // Listen for result in background
    promise
      .then((result) => {
        lastResult = result;
        lastError = null;
        pendingResult = null;
      })
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        lastResult = null;
        pendingResult = null;
      });

    return NextResponse.json({ authUrl });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start OAuth' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/providers/antigravity-auth
 * Poll for OAuth completion status.
 */
export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action');

  // Validate an existing refresh token
  if (action === 'validate') {
    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json({ valid: false, error: 'No token provided' });
    }
    const result = await refreshAccessToken(token);
    return NextResponse.json({ valid: !!result });
  }

  // Poll for OAuth result
  if (lastResult) {
    const result = lastResult;
    lastResult = null; // consume once
    return NextResponse.json({
      status: 'complete',
      refreshToken: result.refreshToken,
      email: result.email,
    });
  }

  if (lastError) {
    const error = lastError;
    lastError = null;
    return NextResponse.json({ status: 'error', error });
  }

  if (pendingResult) {
    return NextResponse.json({ status: 'pending' });
  }

  return NextResponse.json({ status: 'idle' });
}
