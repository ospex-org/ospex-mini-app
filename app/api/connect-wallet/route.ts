import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { verifyMessage } from "ethers";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ============================================================
// Firebase Admin init (singleton)
// ============================================================

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

// ============================================================
// Telegram initData validation
// ============================================================

/**
 * Validates Telegram Mini App initData using HMAC-SHA256.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Steps:
 * 1. Parse the initData query string
 * 2. Extract the `hash` param
 * 3. Sort remaining params alphabetically
 * 4. Build data-check-string: "key=value\nkey=value\n..."
 * 5. Compute secret_key = HMAC-SHA256("WebAppData", bot_token)
 * 6. Compute hash = HMAC-SHA256(secret_key, data_check_string)
 * 7. Compare with received hash
 */
function validateTelegramInitData(initData: string): {
  valid: boolean;
  userId?: number;
} {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("[connect-wallet] TELEGRAM_BOT_TOKEN not set");
    return { valid: false };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { valid: false };

    // Remove hash from params, sort remaining
    params.delete("hash");
    const dataCheckArr: string[] = [];
    params.forEach((value, key) => {
      dataCheckArr.push(`${key}=${value}`);
    });
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join("\n");

    // Compute HMAC
    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const computedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (computedHash !== hash) {
      console.error("[connect-wallet] initData hash mismatch");
      return { valid: false };
    }

    // Extract user ID from the validated data
    const userParam = params.get("user");
    if (userParam) {
      const user = JSON.parse(userParam);
      return { valid: true, userId: user.id };
    }

    return { valid: true };
  } catch (err) {
    console.error("[connect-wallet] initData validation error:", err);
    return { valid: false };
  }
}

// ============================================================
// Signature verification
// ============================================================

/**
 * Verifies that the signature was produced by the claimed wallet address.
 * Uses ethers v6 verifyMessage.
 */
function verifyWalletSignature(
  message: string,
  signature: string,
  expectedAddress: string
): boolean {
  try {
    const recovered = verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch (err) {
    console.error("[connect-wallet] Signature verification error:", err);
    return false;
  }
}

// ============================================================
// POST handler
// ============================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { telegramUserId, walletAddress, signature, message, initData } =
      body;

    // ----------------------------------------------------------
    // 1. Basic field validation
    // ----------------------------------------------------------
    if (!telegramUserId || !walletAddress || !signature || !message) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // ----------------------------------------------------------
    // 2. Validate Telegram initData
    // ----------------------------------------------------------
    if (!initData) {
      return NextResponse.json(
        { error: "Missing Telegram initData" },
        { status: 400 }
      );
    }

    const telegramValidation = validateTelegramInitData(initData);

    if (!telegramValidation.valid) {
      return NextResponse.json(
        { error: "Invalid Telegram authentication" },
        { status: 403 }
      );
    }

    // Cross-check: the user ID in initData should match the claimed user ID
    if (
      telegramValidation.userId &&
      telegramValidation.userId !== telegramUserId
    ) {
      return NextResponse.json(
        { error: "Telegram user ID mismatch" },
        { status: 403 }
      );
    }

    // ----------------------------------------------------------
    // 3. Verify the expected message format
    // ----------------------------------------------------------
    const expectedMessage = `Connect wallet to OspexBot: ${telegramUserId}`;
    if (message !== expectedMessage) {
      return NextResponse.json(
        { error: "Invalid message format" },
        { status: 400 }
      );
    }

    // ----------------------------------------------------------
    // 4. Verify wallet signature
    // ----------------------------------------------------------
    const signatureValid = verifyWalletSignature(
      message,
      signature,
      walletAddress
    );

    if (!signatureValid) {
      return NextResponse.json(
        { error: "Invalid wallet signature" },
        { status: 403 }
      );
    }

    // ----------------------------------------------------------
    // 5. Save to Firestore
    // ----------------------------------------------------------
    const docRef = db
      .collection("botUsers")
      .doc(String(telegramUserId));

    await docRef.set(
      {
        walletAddress: walletAddress.toLowerCase(),
        custody: "self",
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(
      `[connect-wallet] Saved wallet ${walletAddress} for user ${telegramUserId}`
    );

    return NextResponse.json({ success: true, walletAddress });
  } catch (err) {
    console.error("[connect-wallet] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
