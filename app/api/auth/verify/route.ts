import { NextRequest, NextResponse } from 'next/server';

/**
 * Custom auth verification endpoint called by Openfort.
 *
 * When a client calls authenticateWithThirdPartyProvider({ provider: CUSTOM, token }),
 * Openfort POSTs to this URL with { payload: "<the token>" }.
 * The token is the thirdPartyUserId string (e.g. "telegram_123456").
 * We return it as { userId, email } so Openfort can identify the player.
 *
 * Dashboard config: https://dashboard.openfort.io/providers
 * authenticationUrl: https://ospex-mini-app.vercel.app/api/auth/verify
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { payload } = body as { payload?: string };

    console.log('[auth/verify] Received verification request, payload:', payload);

    if (!payload) {
      console.error('[auth/verify] Missing payload field in request body');
      return NextResponse.json({ error: 'Missing payload' }, { status: 400 });
    }

    // The payload is the thirdPartyUserId (e.g. "telegram_123456").
    // Return it as userId with a synthetic email for Openfort.
    console.log('[auth/verify] Verified user:', payload);

    return NextResponse.json({
      userId: payload,
      email: `${payload}@ospex.bot`,
    });
  } catch (error) {
    console.error('[auth/verify] Verification failed:', error);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
