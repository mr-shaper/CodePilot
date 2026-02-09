import { NextRequest, NextResponse } from 'next/server';
import { startAntigravityOAuth, readPendingResult, refreshAccessToken } from '@/lib/antigravity';

/**
 * POST /api/providers/antigravity-auth
 * Start the Antigravity OAuth flow. Returns the auth URL to open in the system browser.
 */
export async function POST() {
  try {
    const { authUrl } = startAntigravityOAuth();
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
 * Poll for OAuth completion by reading the result file written by the callback server.
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

  // Poll for OAuth result from file
  const pending = readPendingResult();
  if (pending) {
    if (pending.status === 'complete') {
      return NextResponse.json({
        status: 'complete',
        refreshToken: pending.refreshToken,
        email: pending.email,
      });
    }
    if (pending.status === 'error') {
      return NextResponse.json({ status: 'error', error: pending.error });
    }
  }

  // No result yet
  return NextResponse.json({ status: 'pending' });
}
