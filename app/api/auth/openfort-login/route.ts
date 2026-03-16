import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy for Openfort's third-party auth endpoint.
 *
 * Telegram's WebView blocks cross-origin requests to api.openfort.xyz.
 * This endpoint makes the same call server-side and returns the result
 * so the client can use storeCredentials() instead of
 * authenticateWithThirdPartyProvider().
 */
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json() as { token?: string };

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    const publishableKey = process.env.NEXT_PUBLIC_OPENFORT_PUBLISHABLE_KEY;
    if (!publishableKey) {
      console.error('[openfort-login] Missing NEXT_PUBLIC_OPENFORT_PUBLISHABLE_KEY');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    console.log('[openfort-login] Proxying third-party auth to Openfort API');

    // Make the same call the JS SDK would make to api.openfort.xyz
    const openfortRes = await fetch('https://api.openfort.xyz/iam/v1/oauth/third_party', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${publishableKey}`,
      },
      body: JSON.stringify({
        provider: 'custom',
        token,
        tokenType: 'customToken',
      }),
    });

    const responseText = await openfortRes.text();
    console.log('[openfort-login] Openfort response:', openfortRes.status, responseText.substring(0, 500));

    if (!openfortRes.ok) {
      console.error('[openfort-login] Openfort API error:', openfortRes.status, responseText);
      return NextResponse.json(
        { error: 'Openfort authentication failed', detail: responseText },
        { status: openfortRes.status },
      );
    }

    const data = JSON.parse(responseText);

    return NextResponse.json({
      playerId: data.id,
      // Pass through the full response so the client has everything it needs
      openfortResponse: data,
    });
  } catch (error) {
    console.error('[openfort-login] Error:', error);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
