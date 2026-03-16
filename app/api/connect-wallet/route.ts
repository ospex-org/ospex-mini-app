import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { verifyMessage } from "ethers";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { buildChallengeMessage } from "@/lib/challenge";

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

    params.delete("hash");
    const dataCheckArr: string[] = [];
    params.forEach((value, key) => {
      dataCheckArr.push(`${key}=${value}`);
    });
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join("\n");

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
// POST handler — two auth paths
// ============================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, signature, message } = body;

    // Common field validation
    if (!walletAddress || !signature || !message) {
      return NextResponse.json(
        { error: "Missing required fields (walletAddress, signature, message)" },
        { status: 400 }
      );
    }

    // Route to the correct auth path
    if (body.linkToken) {
      return handleLinkTokenPath(body);
    } else if (body.initData) {
      return handleInitDataPath(body);
    } else {
      return NextResponse.json(
        { error: "Missing auth method: provide either linkToken or initData" },
        { status: 400 }
      );
    }
  } catch (err) {
    console.error("[connect-wallet] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ============================================================
// Path A: Telegram initData flow (existing)
// ============================================================

async function handleInitDataPath(body: {
  telegramUserId: number;
  walletAddress: string;
  signature: string;
  message: string;
  initData: string;
}) {
  const { telegramUserId, walletAddress, signature, message, initData } = body;

  if (!telegramUserId) {
    return NextResponse.json(
      { error: "Missing telegramUserId" },
      { status: 400 }
    );
  }

  // Validate Telegram initData
  const telegramValidation = validateTelegramInitData(initData);
  if (!telegramValidation.valid) {
    return NextResponse.json(
      { error: "Invalid Telegram authentication" },
      { status: 403 }
    );
  }

  if (
    telegramValidation.userId &&
    telegramValidation.userId !== telegramUserId
  ) {
    return NextResponse.json(
      { error: "Telegram user ID mismatch" },
      { status: 403 }
    );
  }

  // Verify expected message format
  const expectedMessage = `Connect wallet to OspexBot: ${telegramUserId}`;
  if (message !== expectedMessage) {
    return NextResponse.json(
      { error: "Invalid message format" },
      { status: 400 }
    );
  }

  // Verify wallet signature
  if (!verifyWalletSignature(message, signature, walletAddress)) {
    return NextResponse.json(
      { error: "Invalid wallet signature" },
      { status: 403 }
    );
  }

  // Save to Firestore
  await db
    .collection("botUsers")
    .doc(String(telegramUserId))
    .set(
      {
        walletAddress: walletAddress.toLowerCase(),
        custody: "self",
        linkMethod: "telegram_miniapp",
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

  console.log(
    `[connect-wallet] Path A: Saved wallet ${walletAddress} for user ${telegramUserId}`
  );

  return NextResponse.json({ success: true, walletAddress });
}

// ============================================================
// Path B: Link token flow (MetaMask browser)
// ============================================================

async function handleLinkTokenPath(body: {
  linkToken: string;
  walletAddress: string;
  signature: string;
  message: string;
}) {
  const { linkToken, walletAddress, signature, message } = body;

  // Validate signature before entering transaction (pure computation, no DB needed)
  if (!verifyWalletSignature(message, signature, walletAddress)) {
    return NextResponse.json(
      { error: "Invalid wallet signature" },
      { status: 403 }
    );
  }

  // Atomic transaction: read token, validate, mark used, write wallet linkage
  const tokenRef = db.collection("linkTokens").doc(linkToken);

  // Use a class so TS control flow recognizes the type in the catch block
  class TransactionAbortError extends Error {
    constructor(
      public readonly clientError: string,
      public readonly statusCode: number
    ) {
      super("abort");
    }
  }

  try {
    await db.runTransaction(async (tx) => {
      const tokenDoc = await tx.get(tokenRef);

      // 1. Check token exists
      if (!tokenDoc.exists) {
        throw new TransactionAbortError("Token not found", 404);
      }

      const tokenData = tokenDoc.data()!;

      // 2. Check token not used
      if (tokenData.used) {
        throw new TransactionAbortError("Token already used", 410);
      }

      // 3. Check token not expired
      const expiresAt = tokenData.expiresAt instanceof Date
        ? tokenData.expiresAt
        : tokenData.expiresAt.toDate();

      if (new Date() > expiresAt) {
        throw new TransactionAbortError("Token expired", 410);
      }

      // 4. Verify message matches server challenge
      const expectedMessage = buildChallengeMessage(
        tokenData.telegramUserId,
        tokenData.nonce
      );

      if (message !== expectedMessage) {
        throw new TransactionAbortError(
          "Invalid message format — message does not match server challenge",
          400
        );
      }

      // 5. Mark token as used
      tx.update(tokenRef, {
        used: true,
        usedAt: new Date().toISOString(),
        walletAddress: walletAddress.toLowerCase(),
      });

      // 6. Write wallet to botUsers
      const userRef = db
        .collection("botUsers")
        .doc(String(tokenData.telegramUserId));

      tx.set(
        userRef,
        {
          walletAddress: walletAddress.toLowerCase(),
          custody: "self",
          linkMethod: "metamask_browser",
          connectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    });
  } catch (err) {
    if (err instanceof TransactionAbortError) {
      return NextResponse.json(
        { error: err.clientError },
        { status: err.statusCode }
      );
    }
    throw err;
  }

  console.log(
    `[connect-wallet] Path B: Saved wallet ${walletAddress} for token ${linkToken}`
  );

  return NextResponse.json({ success: true, walletAddress });
}
