import crypto from 'crypto';

/**
 * Validates Telegram Mini App initData.
 * 
 * Telegram signs the initData with HMAC-SHA256 using a key derived from
 * the bot token. We recompute the hash and compare to verify authenticity.
 * 
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string, botToken: string): { valid: boolean; user?: TelegramUser } {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  
  if (!hash) return { valid: false };
  
  // Remove hash from params, sort alphabetically, join with \n
  params.delete('hash');
  const entries = Array.from(params.entries());
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  
  // Compute HMAC-SHA256
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  
  if (computedHash !== hash) return { valid: false };
  
  // Parse the user object
  const userStr = params.get('user');
  if (!userStr) return { valid: false };
  
  try {
    const user: TelegramUser = JSON.parse(userStr);
    return { valid: true, user };
  } catch {
    return { valid: false };
  }
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
