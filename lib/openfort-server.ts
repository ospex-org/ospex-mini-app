import Openfort from '@openfort/openfort-node';
import { SignJWT } from 'jose';

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
  const authResponse = await of.iam.v1.players.create({
    thirdPartyProvider: 'custom',
    thirdPartyUserId: `telegram_${telegramUserId}`,
    preGenerateEmbeddedAccount: true,
    chainId: 80002, // Polygon Amoy testnet
  });

  // Generate a JWT for the client-side SDK to authenticate.
  // This token is passed to authenticateWithThirdPartyProvider() on the client.
  const secretKey = process.env.OPENFORT_SECRET_KEY;
  if (!secretKey) throw new Error('OPENFORT_SECRET_KEY is required');

  const secret = new TextEncoder().encode(secretKey);
  const token = await new SignJWT({ sub: `telegram_${telegramUserId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);

  return {
    playerId: authResponse.id,
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
