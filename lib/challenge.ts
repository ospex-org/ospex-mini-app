/**
 * Build the challenge message that the user must sign.
 * Used by both /api/link-token (to return the message) and
 * /api/connect-wallet (to verify it matches).
 */
export function buildChallengeMessage(
  telegramUserId: string,
  nonce: string
): string {
  return [
    "Connect wallet to OspexBot",
    `Telegram user: ${telegramUserId}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}
