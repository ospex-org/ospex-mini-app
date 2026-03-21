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

// ── Types (mirrors ospex-bot PendingTransaction / TxConfirmToken) ──

interface PendingTransaction {
  type: "claim" | "withdraw";
  telegramUserId: string;
  walletAddress: string;
  positionId: string;
  description: string;
  txParams: { method: string; args: Record<string, unknown> };
  status: "pending" | "submitted" | "cancelled" | "expired";
  createdAt: FirebaseFirestore.Timestamp | Date;
  expiresAt: FirebaseFirestore.Timestamp | Date;
  txHash: string | null;
}

// ABI for decoding on-chain calldata
const POSITION_MODULE_ABI = [
  "function claimPosition(uint256 speculationId, uint128 oddsPairId, uint8 positionType)",
  "function adjustUnmatchedPair(uint256 speculationId, uint128 oddsPairId, uint32 newUnmatchedExpiry, uint8 positionType, int256 amount, uint256 contributionAmount)",
];

interface TxConfirmToken {
  pendingTransactionId: string;
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
  tokenData: TxConfirmToken | undefined
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
 * GET /api/tx-confirm?token=xxx
 *
 * Validates a transaction confirm token and returns the pending transaction details.
 * Used by /claim and /withdraw pages to display transaction summary.
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
    const tokenDoc = await db.collection("txConfirmTokens").doc(token).get();
    const tokenData = tokenDoc.exists
      ? (tokenDoc.data() as TxConfirmToken)
      : undefined;

    const tokenCheck = validateToken(tokenData);
    if (!tokenCheck.valid) {
      return NextResponse.json(
        { valid: false, error: tokenCheck.error },
        { status: tokenCheck.status }
      );
    }

    const txDoc = await db
      .collection("pendingTransactions")
      .doc(tokenData!.pendingTransactionId)
      .get();

    if (!txDoc.exists) {
      return NextResponse.json(
        { valid: false, error: "Pending transaction not found" },
        { status: 404 }
      );
    }

    const tx = txDoc.data() as PendingTransaction;

    if (tx.status !== "pending") {
      const msg =
        tx.status === "submitted"
          ? "Transaction already submitted"
          : tx.status === "cancelled"
            ? "Transaction was cancelled"
            : tx.status === "expired"
              ? "Transaction expired"
              : `Transaction status is ${tx.status}`;
      return NextResponse.json(
        { valid: false, error: msg },
        { status: 409 }
      );
    }

    if (new Date() > toDate(tx.expiresAt)) {
      return NextResponse.json(
        { valid: false, error: "Transaction expired" },
        { status: 410 }
      );
    }

    return NextResponse.json({
      valid: true,
      transaction: {
        type: tx.type,
        positionId: tx.positionId,
        description: tx.description,
        txParams: tx.txParams,
      },
      walletAddress: tokenData!.walletAddress,
    });
  } catch (err) {
    console.error("[tx-confirm GET] Unexpected error:", err);
    return NextResponse.json(
      { valid: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tx-confirm
 *
 * Receives the transaction hash after on-chain submission.
 * Marks the confirm token as used and updates the pending transaction status.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; txHash?: string };
  try {
    body = await request.json();
  } catch (err) {
    console.error("[tx-confirm POST] Invalid JSON body:", err instanceof Error ? err.message : err);
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
    const tokenRef = db.collection("txConfirmTokens").doc(token);
    const tokenDoc = await tokenRef.get();
    const tokenData = tokenDoc.exists
      ? (tokenDoc.data() as TxConfirmToken)
      : undefined;

    const tokenCheck = validateToken(tokenData);
    if (!tokenCheck.valid) {
      return NextResponse.json(
        { success: false, error: tokenCheck.error },
        { status: tokenCheck.status }
      );
    }

    // Verify the transaction on-chain
    const rpcUrl = process.env.POLYGON_RPC_URL;
    const positionModuleAddress = process.env.POSITION_MODULE_ADDRESS;
    if (!rpcUrl || !positionModuleAddress) {
      console.error("[tx-confirm POST] Missing POLYGON_RPC_URL or POSITION_MODULE_ADDRESS");
      return NextResponse.json(
        { success: false, error: "Server misconfigured" },
        { status: 500 }
      );
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return NextResponse.json(
        { success: false, error: "Transaction not found on-chain. It may still be pending — wait and retry." },
        { status: 404 }
      );
    }

    if (receipt.from.toLowerCase() !== tokenData!.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Transaction sender does not match linked wallet" },
        { status: 400 }
      );
    }

    if (!receipt.to || receipt.to.toLowerCase() !== positionModuleAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Transaction target is not the expected contract" },
        { status: 400 }
      );
    }

    if (receipt.status !== 1) {
      return NextResponse.json(
        { success: false, error: "Transaction reverted on-chain" },
        { status: 422 }
      );
    }

    // Verify calldata matches the pending transaction's txParams
    const txRef = db.collection("pendingTransactions").doc(tokenData!.pendingTransactionId);
    const pendingTxDoc = await txRef.get();
    if (!pendingTxDoc.exists) {
      return NextResponse.json(
        { success: false, error: "Pending transaction not found" },
        { status: 404 }
      );
    }
    const pendingTx = pendingTxDoc.data() as PendingTransaction;

    const fullTx = await provider.getTransaction(txHash);
    if (!fullTx || !fullTx.data) {
      return NextResponse.json(
        { success: false, error: "Could not fetch transaction data" },
        { status: 404 }
      );
    }

    const iface = new ethers.Interface(POSITION_MODULE_ABI);
    let decoded: ethers.TransactionDescription | null;
    try {
      decoded = iface.parseTransaction({ data: fullTx.data });
    } catch {
      return NextResponse.json(
        { success: false, error: "Transaction calldata does not match expected ABI" },
        { status: 400 }
      );
    }

    if (!decoded || decoded.name !== pendingTx.txParams.method) {
      return NextResponse.json(
        { success: false, error: `Expected method ${pendingTx.txParams.method} but got ${decoded?.name ?? "unknown"}` },
        { status: 400 }
      );
    }

    // Compare decoded args to stored args
    const storedArgs = pendingTx.txParams.args;
    const fragment = decoded.fragment;
    for (const param of fragment.inputs) {
      const storedVal = storedArgs[param.name];
      if (storedVal === undefined) continue;
      const decodedVal = decoded.args.getValue(param.name);
      if (String(decodedVal) !== String(storedVal)) {
        return NextResponse.json(
          { success: false, error: `Argument ${param.name} mismatch: expected ${storedVal}, got ${decodedVal}` },
          { status: 400 }
        );
      }
    }

    // Atomic update: mark token used + update pending transaction

    await db.runTransaction(async (firestoreTx) => {
      const txDoc = await firestoreTx.get(txRef);
      if (!txDoc.exists) {
        throw new TransactionAbortError("Pending transaction not found", 404);
      }

      const pendingTx = txDoc.data() as PendingTransaction;
      if (pendingTx.status !== "pending") {
        throw new TransactionAbortError(
          `Transaction not in pending status (current: ${pendingTx.status})`,
          409
        );
      }

      firestoreTx.update(tokenRef, { used: true, usedAt: FieldValue.serverTimestamp() });
      firestoreTx.update(txRef, {
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
    console.error("[tx-confirm POST] Unexpected error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

class TransactionAbortError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "TransactionAbortError";
    this.statusCode = statusCode;
  }
}
