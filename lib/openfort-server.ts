import Openfort, { ShieldAuthProvider } from '@openfort/openfort-node';

let openfort: Openfort;

export function getOpenfort(): Openfort {
  if (!openfort) {
    const secretKey = process.env.OPENFORT_SECRET_KEY;
    if (!secretKey) throw new Error('OPENFORT_SECRET_KEY is required');
    openfort = new Openfort(secretKey);
  }
  return openfort;
}

/**
 * Authenticate a Telegram user with Openfort.
 *
 * Creates a player if one doesn't exist for this Telegram ID,
 * then returns a JWT the frontend can use to initialize
 * the Openfort JS SDK and create/recover the embedded wallet.
 *
 * The JWT is signed with OPENFORT_SECRET_KEY and verified by Openfort
 * when the client calls authenticateWithThirdPartyProvider().
 */
export async function authenticateTelegramUser(telegramUserId: string): Promise<{
  playerId: string;
  token: string;
}> {
  const of = getOpenfort();

  // Create/get the player in Openfort with an embedded account.
  // Shield config is required when preGenerateEmbeddedAccount is true.
  // If the player already exists, Openfort returns 409 — extract the player ID from the error.
  let playerId: string;
  try {
    const authResponse = await of.iam.v1.players.create(
      {
        thirdPartyProvider: 'custom',
        thirdPartyUserId: `telegram_${telegramUserId}`,
        preGenerateEmbeddedAccount: true,
        chainId: 80002, // Polygon Amoy testnet
      },
      {
        shieldApiKey: process.env.NEXT_PUBLIC_SHIELD_PUBLISHABLE_KEY!,
        shieldApiSecret: process.env.SHIELD_SECRET_KEY!,
        encryptionShare: process.env.SHIELD_ENCRYPTION_SHARE!,
        shieldAuthProvider: ShieldAuthProvider.OPENFORT,
      },
    );
    playerId = authResponse.id;
  } catch (err: unknown) {
    // 409 = player already exists — extract ID and continue.
    // Openfort SDK throws APIError with statusCode, errorMessage, and cause.
    const statusCode = (err as { statusCode?: number }).statusCode ?? 0;
    const message = (err as { message?: string }).message ?? '';
    const errorMessage = (err as { errorMessage?: unknown }).errorMessage;
    // errorMessage can be an object like { type, message } — stringify everything
    const errorMessageStr = typeof errorMessage === 'string'
      ? errorMessage
      : JSON.stringify(errorMessage ?? '');
    const allText = `${message} ${errorMessageStr}`;

    if (statusCode === 409 || allText.includes('409') || allText.includes('already exists')) {
      // Extract pla_... from any field in the error
      const match = allText.match(/pla_[a-f0-9-]+/);
      if (match) {
        playerId = match[0];
      } else {
        console.error('409 conflict but could not extract player ID from error:', allText);
        throw err;
      }
    } else {
      throw err;
    }
  }

  // The token is the thirdPartyUserId string. Openfort forwards it to our
  // /api/auth/verify endpoint which echoes it back as { userId, email }.
  const token = `telegram_${telegramUserId}`;

  return {
    playerId,
    token,
  };
}

/**
 * Create a Shield encryption session for wallet recovery.
 * This is needed by the frontend Openfort SDK to encrypt/decrypt
 * the user's key share.
 */
export async function createEncryptionSession(): Promise<string> {
  const of = getOpenfort();

  const session = await of.createEncryptionSession(
    process.env.NEXT_PUBLIC_SHIELD_PUBLISHABLE_KEY!,
    process.env.SHIELD_SECRET_KEY!,
    process.env.SHIELD_ENCRYPTION_SHARE!,
  );

  return session;
}
