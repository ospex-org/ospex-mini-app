import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Custom auth verification endpoint called by Openfort.
 *
 * When a client calls authenticateWithThirdPartyProvider({ provider: CUSTOM, token }),
 * Openfort POSTs to this URL with { payload: "<the token>" }.
 * We verify the JWT and return { userId } so Openfort can identify the player.
 *
 * Dashboard config: https://dashboard.openfort.io/providers
 * Set authenticationUrl to: https://ospex-mini-app.vercel.app/api/auth/verify
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { payload } = body as { payload?: string };

    console.log('[auth/verify] Received verification request');

    if (!payload) {
      console.error('[auth/verify] Missing payload field in request body');
      return NextResponse.json({ error: 'Missing payload' }, { status: 400 });
    }

    const secretKey = process.env.OPENFORT_SECRET_KEY;
    if (!secretKey) {
      console.error('[auth/verify] OPENFORT_SECRET_KEY not configured');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // Verify the JWT we signed in authenticateTelegramUser()
    const secret = new TextEncoder().encode(secretKey);
    const { payload: claims } = await jwtVerify(payload, secret, {
      algorithms: ['HS256'],
    });

    const userId = claims.sub;
    if (!userId) {
      console.error('[auth/verify] JWT missing sub claim');
      return NextResponse.json({ error: 'Invalid token: missing sub' }, { status: 401 });
    }

    console.log('[auth/verify] Verified user:', userId);

    // Openfort expects { userId, email } — email is optional for Telegram users
    return NextResponse.json({
      userId,
    });
  } catch (error) {
    console.error('[auth/verify] Verification failed:', error);
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
}
