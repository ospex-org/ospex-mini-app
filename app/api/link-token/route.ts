import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Firebase Admin init (singleton)
if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = getFirestore();

/**
 * Build the challenge message that the user must sign.
 * Must match exactly what connect-wallet expects.
 */
function buildChallengeMessage(telegramUserId: string, nonce: string): string {
  return [
    "Connect wallet to OspexBot",
    `Telegram user: ${telegramUserId}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export { buildChallengeMessage };

/**
 * GET /api/link-token?token=abc123
 *
 * Validates a link token without consuming it.
 * Returns the challenge message the user must sign.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json(
      { valid: false, error: "Missing token parameter" },
      { status: 400 }
    );
  }

  try {
    const doc = await db.collection("linkTokens").doc(token).get();

    if (!doc.exists) {
      return NextResponse.json(
        { valid: false, error: "Token not found" },
        { status: 404 }
      );
    }

    const data = doc.data()!;

    if (data.used) {
      return NextResponse.json(
        { valid: false, error: "Token already used" },
        { status: 410 }
      );
    }

    const expiresAt = data.expiresAt instanceof Date
      ? data.expiresAt
      : data.expiresAt.toDate();

    if (new Date() > expiresAt) {
      return NextResponse.json(
        { valid: false, error: "Token expired" },
        { status: 410 }
      );
    }

    const challengeMessage = buildChallengeMessage(
      data.telegramUserId,
      data.nonce
    );

    return NextResponse.json({
      valid: true,
      challengeMessage,
    });
  } catch (err) {
    console.error("[link-token] Unexpected error:", err);
    return NextResponse.json(
      { valid: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
