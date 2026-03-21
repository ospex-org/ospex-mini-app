import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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

// ABI for claim and withdraw methods on PositionModule
const POSITION_MODULE_ABI = [
  "function claimPosition(uint256 speculationId, uint128 oddsPairId, uint8 positionType)",
  "function adjustUnmatchedPair(uint256 speculationId, uint128 oddsPairId, uint32 newUnmatchedExpiry, uint8 positionType, int256 amount, uint256 contributionAmount)",
];

const ALLOWED_METHODS = ["claimPosition", "adjustUnmatchedPair"];

// ── Types ──

interface TxConfirmToken {
  pendingTransactionId: string;
  telegramUserId: string;
  walletAddress: string;
  createdAt: FirebaseFirestore.Timestamp | Date;
  expiresAt: FirebaseFirestore.Timestamp | Date;
  used: boolean;
}

interface ClaimPositionArgs {
  speculationId: string;
  oddsPairId: string;
  positionType: number;
}

interface AdjustUnmatchedPairArgs {
  speculationId: string;
  oddsPairId: string;
  newUnmatchedExpiry: string;
  positionType: number;
  amount: string;
  contributionAmount: string;
}

type TxParams =
  | { method: "claimPosition"; args: ClaimPositionArgs }
  | { method: "adjustUnmatchedPair"; args: AdjustUnmatchedPairArgs };

interface PendingTransaction {
  type: "claim" | "withdraw";
  telegramUserId: string;
  walletAddress: string;
  positionId: string;
  description: string;
  txParams: TxParams;
  status: "pending" | "submitted" | "cancelled" | "expired";
  createdAt: FirebaseFirestore.Timestamp | Date;
  expiresAt: FirebaseFirestore.Timestamp | Date;
  txHash: string | null;
}

function toDate(val: FirebaseFirestore.Timestamp | Date): Date {
  if (val instanceof Date) return val;
  if (typeof val === "object" && "toDate" in val) return val.toDate();
  return new Date(val as unknown as string);
}

/**
 * POST /api/tx-encode
 *
 * Encodes pre-computed txParams into a MetaMask-ready transaction.
 * No quotes, no drift checking, no USDC approval — just ABI encoding.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; walletAddress?: string };
  try {
    body = await request.json();
  } catch (err) {
    console.error("[tx-encode] Invalid JSON body:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { token, walletAddress } = body;

  if (!token || !walletAddress) {
    return NextResponse.json(
      { error: "Missing token or walletAddress" },
      { status: 400 }
    );
  }

  try {
    // 1. Validate token
    const tokenDoc = await db.collection("txConfirmTokens").doc(token).get();
    if (!tokenDoc.exists) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    const tokenData = tokenDoc.data() as TxConfirmToken;
    if (tokenData.used) {
      return NextResponse.json({ error: "Token already used" }, { status: 410 });
    }
    if (new Date() > toDate(tokenData.expiresAt)) {
      return NextResponse.json({ error: "Token expired" }, { status: 410 });
    }

    // 2. Verify wallet matches
    if (walletAddress.toLowerCase() !== tokenData.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "Wallet does not match token" },
        { status: 403 }
      );
    }

    // 3. Load pending transaction
    const txDoc = await db
      .collection("pendingTransactions")
      .doc(tokenData.pendingTransactionId)
      .get();

    if (!txDoc.exists) {
      return NextResponse.json(
        { error: "Pending transaction not found" },
        { status: 404 }
      );
    }

    const pendingTx = txDoc.data() as PendingTransaction;
    if (pendingTx.status !== "pending") {
      return NextResponse.json(
        { error: `Transaction is ${pendingTx.status}` },
        { status: 409 }
      );
    }
    if (new Date() > toDate(pendingTx.expiresAt)) {
      return NextResponse.json({ error: "Transaction expired" }, { status: 410 });
    }

    // 4. Validate method is allowed
    const { method } = pendingTx.txParams;
    if (!ALLOWED_METHODS.includes(method)) {
      console.error(`[tx-encode] Blocked unknown method: ${method}`);
      return NextResponse.json(
        { error: "Unsupported contract method" },
        { status: 400 }
      );
    }

    // 5. Encode the transaction with explicit field ordering
    const positionModuleAddress = process.env.POSITION_MODULE_ADDRESS;
    if (!positionModuleAddress) {
      return NextResponse.json(
        { error: "Server misconfigured" },
        { status: 500 }
      );
    }

    const iface = new ethers.Interface(POSITION_MODULE_ABI);
    let data: string;

    if (pendingTx.txParams.method === "claimPosition") {
      const a = pendingTx.txParams.args;
      data = iface.encodeFunctionData("claimPosition", [
        a.speculationId,
        a.oddsPairId,
        a.positionType,
      ]);
    } else {
      const a = pendingTx.txParams.args;
      data = iface.encodeFunctionData("adjustUnmatchedPair", [
        a.speculationId,
        a.oddsPairId,
        a.newUnmatchedExpiry,
        a.positionType,
        a.amount,
        a.contributionAmount,
      ]);
    }

    return NextResponse.json({
      txParams: {
        to: positionModuleAddress,
        data,
        value: "0x0",
      },
      description: pendingTx.description,
      type: pendingTx.type,
    });
  } catch (err) {
    console.error("[tx-encode] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
