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

// ── Contract ABIs (minimal — only the functions we encode) ──

const POSITION_MODULE_ABI = [
  "function createUnmatchedPair(uint256 speculationId, uint64 odds, uint32 unmatchedExpiry, uint8 positionType, uint256 amount, uint256 contributionAmount)",
  "function createUnmatchedPairWithSpeculation(uint256 contestId, address scorer, int32 theNumber, uint256 leaderboardId, uint64 odds, uint32 unmatchedExpiry, uint8 positionType, uint256 amount, uint256 contributionAmount)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// ── Types ──

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

interface TxParamsCreateUnmatchedPairArgs {
  speculationId: string;
  odds: string;
  unmatchedExpiry: string;
  positionType: number;
  amount: string;
  contributionAmount: string;
}

interface TxParamsCreateWithSpeculationArgs {
  contestId: string;
  scorer: string;
  theNumber: string;
  leaderboardId: string;
  odds: string;
  unmatchedExpiry: string;
  positionType: number;
  amount: string;
  contributionAmount: string;
}

type AgentTxParams =
  | { method: "createUnmatchedPair"; args: TxParamsCreateUnmatchedPairArgs }
  | {
      method: "createUnmatchedPairWithSpeculation";
      args: TxParamsCreateWithSpeculationArgs;
    };

interface QuoteApproved {
  approved: true;
  quoteId: string;
  approvedOddsDecimal: number;
  approvedOddsAmerican: number;
  expiresAt: string;
  txParams?: AgentTxParams | undefined;
}

interface QuoteRejected {
  approved: false;
  reason: string;
}

type QuoteResponse = QuoteApproved | QuoteRejected;

// ── Helpers ──

function toDate(val: FirebaseFirestore.Timestamp | Date): Date {
  if (val instanceof Date) return val;
  if (typeof val === "object" && "toDate" in val) return val.toDate();
  return new Date(val as unknown as string);
}

function getEnvOrThrow(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function encodeBetTransaction(
  txParams: AgentTxParams,
  positionModuleAddress: string
): { to: string; data: string; value: string } {
  const iface = new ethers.Interface(POSITION_MODULE_ABI);

  let data: string;
  if (txParams.method === "createUnmatchedPair") {
    const a = txParams.args;
    data = iface.encodeFunctionData("createUnmatchedPair", [
      a.speculationId,
      a.odds,
      a.unmatchedExpiry,
      a.positionType,
      a.amount,
      a.contributionAmount,
    ]);
  } else {
    const a = txParams.args;
    data = iface.encodeFunctionData("createUnmatchedPairWithSpeculation", [
      a.contestId,
      a.scorer,
      a.theNumber,
      a.leaderboardId,
      a.odds,
      a.unmatchedExpiry,
      a.positionType,
      a.amount,
      a.contributionAmount,
    ]);
  }

  return { to: positionModuleAddress, data, value: "0x0" };
}

function encodeApproveTransaction(
  usdcAddress: string,
  spender: string,
  amount: bigint
): { to: string; data: string; value: string } {
  const iface = new ethers.Interface(ERC20_ABI);
  const data = iface.encodeFunctionData("approve", [spender, amount]);
  return { to: usdcAddress, data, value: "0x0" };
}

/**
 * POST /api/bet-txparams
 *
 * Generates ready-to-submit transaction parameters for a pending bet.
 * 1. Validates the confirm token
 * 2. Verifies wallet matches
 * 3. Calls agent-server for a fresh quote (instant-match/quote with stream=false)
 * 4. Checks odds drift against user's maxDriftPercent
 * 5. Encodes the contract call using ethers
 * 6. Checks USDC allowance; includes approve tx if needed
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; walletAddress?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { token, walletAddress } = body;

  if (!token || !walletAddress) {
    return NextResponse.json(
      { error: "Missing token or walletAddress" },
      { status: 400 }
    );
  }

  try {
    // ── 1. Validate confirm token ──
    const tokenDoc = await db.collection("betConfirmTokens").doc(token).get();
    if (!tokenDoc.exists) {
      return NextResponse.json(
        { error: "Token not found" },
        { status: 404 }
      );
    }

    const tokenData = tokenDoc.data() as BetConfirmToken;

    if (tokenData.used) {
      return NextResponse.json(
        { error: "Token already used" },
        { status: 410 }
      );
    }

    if (new Date() > toDate(tokenData.expiresAt)) {
      return NextResponse.json(
        { error: "Token expired" },
        { status: 410 }
      );
    }

    // ── 2. Verify wallet matches ──
    if (walletAddress.toLowerCase() !== tokenData.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "Wallet address does not match" },
        { status: 400 }
      );
    }

    // ── 3. Load pending bet ──
    const betDoc = await db
      .collection("pendingBets")
      .doc(tokenData.pendingBetId)
      .get();

    if (!betDoc.exists) {
      return NextResponse.json(
        { error: "Pending bet not found" },
        { status: 404 }
      );
    }

    const bet = betDoc.data() as PendingBet;

    if (bet.status !== "pending") {
      return NextResponse.json(
        { error: `Bet not in pending status (current: ${bet.status})` },
        { status: 409 }
      );
    }

    if (new Date() > toDate(bet.expiresAt)) {
      return NextResponse.json(
        { error: "Bet expired" },
        { status: 410 }
      );
    }

    // ── 4. Get fresh quote from agent-server ──
    const apiBaseUrl = getEnvOrThrow("OSPEX_API_BASE_URL");

    const quoteBody: Record<string, unknown> = {
      side: bet.side,
      amountUSDC: bet.stake,
      odds: bet.indicativeOdds ?? 2.0, // fallback to even odds if no indicative
      wallet: walletAddress.toLowerCase(),
      contestId: bet.contestId,
      marketType: bet.marketType,
    };
    if (bet.line != null) {
      quoteBody.line = bet.line;
    }

    const quoteRes = await fetch(
      `${apiBaseUrl}/v1/instant-match/quote?stream=false`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quoteBody),
      }
    );

    if (!quoteRes.ok) {
      const errText = await quoteRes.text().catch(() => "Unknown error");
      console.error("[bet-txparams] Quote request failed:", quoteRes.status, errText);
      return NextResponse.json(
        { error: "Failed to get quote from market maker" },
        { status: 422 }
      );
    }

    const quoteText = await quoteRes.text();
    const quote = JSON.parse(quoteText.trim()) as QuoteResponse;

    if (!quote.approved) {
      return NextResponse.json(
        { error: `Quote rejected: ${quote.reason}` },
        { status: 422 }
      );
    }

    // ── 5. Check odds drift ──
    if (bet.indicativeOdds != null && bet.indicativeOdds > 0) {
      // Load user's drift threshold from botUsers settings
      const userDoc = await db
        .collection("botUsers")
        .doc(bet.telegramUserId)
        .get();
      const userData = userDoc.exists ? userDoc.data() : undefined;
      const maxDriftPercent =
        (userData?.settings?.maxDriftPercent as number | undefined) ?? 5;

      const driftPercent =
        (Math.abs(quote.approvedOddsDecimal - bet.indicativeOdds) /
          bet.indicativeOdds) *
        100;

      if (driftPercent > maxDriftPercent) {
        return NextResponse.json(
          {
            driftExceeded: true,
            indicativeOdds: bet.indicativeOdds,
            finalOdds: quote.approvedOddsDecimal,
            driftPercent: Math.round(driftPercent * 100) / 100,
            maxDriftPercent,
          },
          { status: 409 }
        );
      }
    }

    // ── 6. Encode transaction ──
    if (!quote.txParams) {
      return NextResponse.json(
        { error: "Quote approved but no transaction parameters available" },
        { status: 422 }
      );
    }

    const positionModuleAddress = getEnvOrThrow("POSITION_MODULE_ADDRESS");
    const usdcAddress = getEnvOrThrow("USDC_ADDRESS");
    const rpcUrl = getEnvOrThrow("POLYGON_RPC_URL");

    const encodedTx = encodeBetTransaction(quote.txParams, positionModuleAddress);

    // ── 7. Check USDC allowance ──
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
    const allowance: bigint = await usdc.allowance(
      walletAddress,
      positionModuleAddress
    );

    // stake in USDC with 6 decimals
    const stakeOnChain = BigInt(Math.round(bet.stake * 1_000_000));
    const needsApproval = allowance < stakeOnChain;

    let approveTxParams: { to: string; data: string; value: string } | undefined;
    if (needsApproval) {
      // Approve max uint256 so user doesn't need to approve again
      const maxApproval = ethers.MaxUint256;
      approveTxParams = encodeApproveTransaction(
        usdcAddress,
        positionModuleAddress,
        maxApproval
      );
    }

    // Calculate final payout
    const finalPayout =
      Math.round(bet.stake * quote.approvedOddsDecimal * 100) / 100;

    return NextResponse.json({
      txParams: encodedTx,
      finalOdds: quote.approvedOddsDecimal,
      finalOddsAmerican: quote.approvedOddsAmerican,
      finalPayout,
      needsApproval,
      approveTxParams,
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
    });
  } catch (err) {
    console.error("[bet-txparams] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
