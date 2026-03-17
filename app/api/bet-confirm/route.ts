import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ethers } from "ethers";

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

// ── Types (mirrors ospex-bot PendingBet / BetConfirmToken) ──

interface PendingBet {
  telegramUserId: string;
  walletAddress: string;
  contestId: number;
  speculationId: string;
  marketType: "moneyline" | "spread" | "total";
  side: "home" | "away" | "over" | "under";
  line: number | null;
  stake: number;
  indicativeOdds: number | null;
  awayTeam: string;
  homeTeam: string;
  matchTime: string;
  status: "pending" | "claimed" | "submitted" | "expired" | "cancelled";
  createdAt: FirebaseFirestore.Timestamp | Date;
  expiresAt: FirebaseFirestore.Timestamp | Date;
  txHash: string | null;
  error: string | null;
}

interface BetConfirmToken {
  pendingBetId: string;
  telegramUserId: string;
  walletAddress: string;
  createdAt: FirebaseFirestore.Timestamp | Date;
  expiresAt: FirebaseFirestore.Timestamp | Date;
  used: boolean;
}

// ── Helpers ──

function toDate(val: FirebaseFirestore.Timestamp | Date): Date {
  if (val instanceof Date) return val;
  if (typeof val === "object" && "toDate" in val) return val.toDate();
  return new Date(val as unknown as string);
}

function validateToken(
  tokenData: BetConfirmToken | undefined
): { valid: true } | { valid: false; error: string; status: number } {
  if (!tokenData) {
    return { valid: false, error: "Token not found", status: 404 };
  }
  if (tokenData.used) {
    return { valid: false, error: "Token already used", status: 410 };
  }
  if (new Date() > toDate(tokenData.expiresAt)) {
    return { valid: false, error: "Token expired", status: 410 };
  }
  return { valid: true };
}

/**
 * GET /api/bet-confirm?token=xxx
 *
 * Validates a bet confirm token and returns the pending bet details.
 * Called by the /confirm page to display bet summary before execution.
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
    // 1. Read and validate the confirm token
    const tokenDoc = await db.collection("betConfirmTokens").doc(token).get();
    const tokenData = tokenDoc.exists
      ? (tokenDoc.data() as BetConfirmToken)
      : undefined;

    const tokenCheck = validateToken(tokenData);
    if (!tokenCheck.valid) {
      return NextResponse.json(
        { valid: false, error: tokenCheck.error },
        { status: tokenCheck.status }
      );
    }

    // 2. Load the pending bet
    const betDoc = await db
      .collection("pendingBets")
      .doc(tokenData!.pendingBetId)
      .get();

    if (!betDoc.exists) {
      return NextResponse.json(
        { valid: false, error: "Pending bet not found" },
        { status: 404 }
      );
    }

    const bet = betDoc.data() as PendingBet;

    // 3. Check bet status — only "pending" is valid for confirmation
    if (bet.status !== "pending") {
      const msg =
        bet.status === "submitted"
          ? "Bet already submitted"
          : bet.status === "cancelled"
            ? "Bet was cancelled"
            : bet.status === "expired"
              ? "Bet expired"
              : `Bet status is ${bet.status}`;
      return NextResponse.json(
        { valid: false, error: msg },
        { status: 409 }
      );
    }

    // 4. Check bet expiry
    if (new Date() > toDate(bet.expiresAt)) {
      return NextResponse.json(
        { valid: false, error: "Bet expired" },
        { status: 410 }
      );
    }

    // 5. Return bet details for the confirm page
    return NextResponse.json({
      valid: true,
      bet: {
        contestId: bet.contestId,
        speculationId: bet.speculationId,
        marketType: bet.marketType,
        side: bet.side,
        line: bet.line,
        stake: bet.stake,
        indicativeOdds: bet.indicativeOdds,
        awayTeam: bet.awayTeam,
        homeTeam: bet.homeTeam,
        matchTime: bet.matchTime,
      },
      walletAddress: tokenData!.walletAddress,
    });
  } catch (err) {
    console.error("[bet-confirm GET] Unexpected error:", err);
    return NextResponse.json(
      { valid: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/bet-confirm
 *
 * Receives the transaction hash after on-chain submission.
 * Marks the confirm token as used and updates the pending bet status.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; txHash?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { token, txHash } = body;

  if (!token || !txHash) {
    return NextResponse.json(
      { success: false, error: "Missing token or txHash" },
      { status: 400 }
    );
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return NextResponse.json(
      { success: false, error: "Invalid txHash format" },
      { status: 400 }
    );
  }

  try {
    // 1. Validate the confirm token
    const tokenRef = db.collection("betConfirmTokens").doc(token);
    const tokenDoc = await tokenRef.get();
    const tokenData = tokenDoc.exists
      ? (tokenDoc.data() as BetConfirmToken)
      : undefined;

    const tokenCheck = validateToken(tokenData);
    if (!tokenCheck.valid) {
      return NextResponse.json(
        { success: false, error: tokenCheck.error },
        { status: tokenCheck.status }
      );
    }

    // 2. Verify the transaction on-chain
    const rpcUrl = process.env.POLYGON_RPC_URL;
    const positionModuleAddress = process.env.POSITION_MODULE_ADDRESS;
    if (!rpcUrl || !positionModuleAddress) {
      console.error("[bet-confirm POST] Missing POLYGON_RPC_URL or POSITION_MODULE_ADDRESS");
      return NextResponse.json(
        { success: false, error: "Server misconfigured" },
        { status: 500 }
      );
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return NextResponse.json(
        { success: false, error: "Transaction not found on-chain. It may still be pending — wait for confirmation and retry." },
        { status: 404 }
      );
    }

    // Verify sender matches the wallet linked to this token
    if (receipt.from.toLowerCase() !== tokenData!.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Transaction sender does not match linked wallet" },
        { status: 400 }
      );
    }

    // Verify the tx targeted the PositionModule contract
    if (!receipt.to || receipt.to.toLowerCase() !== positionModuleAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Transaction target is not the expected contract" },
        { status: 400 }
      );
    }

    // Verify the tx succeeded (status 1 = success)
    if (receipt.status !== 1) {
      return NextResponse.json(
        { success: false, error: "Transaction reverted on-chain" },
        { status: 422 }
      );
    }

    // 3. Atomic update: mark token used + update pending bet
    const betRef = db.collection("pendingBets").doc(tokenData!.pendingBetId);

    await db.runTransaction(async (tx) => {
      const betDoc = await tx.get(betRef);
      if (!betDoc.exists) {
        throw new TransactionAbortError("Pending bet not found", 404);
      }

      const bet = betDoc.data() as PendingBet;
      if (bet.status !== "pending") {
        throw new TransactionAbortError(
          `Bet not in pending status (current: ${bet.status})`,
          409
        );
      }

      // Mark token as used
      tx.update(tokenRef, { used: true, usedAt: FieldValue.serverTimestamp() });

      // Update pending bet — verified on-chain
      tx.update(betRef, {
        status: "submitted",
        txHash,
        submittedAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof TransactionAbortError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.statusCode }
      );
    }
    console.error("[bet-confirm POST] Unexpected error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ── Transaction abort helper (same pattern as connect-wallet) ──

class TransactionAbortError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "TransactionAbortError";
    this.statusCode = statusCode;
  }
}
