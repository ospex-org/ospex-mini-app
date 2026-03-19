import { NextRequest, NextResponse } from "next/server";

function getEnvOrThrow(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

/**
 * POST /api/bet-match
 *
 * After the user's on-chain position creation tx succeeds, this endpoint
 * completes the instant match by:
 * 1. Looking up the positionId from the tx hash (with retry for indexer lag)
 * 2. Calling the instant-match/{quoteId}/match endpoint
 *
 * Returns { matched, positionId, matchTxHash?, reason? }.
 * Match failure is NOT an error — the position is safe on-chain.
 */
export async function POST(request: NextRequest) {
  let body: { txHash?: string; quoteId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { txHash, quoteId } = body;

  if (!txHash || !quoteId) {
    return NextResponse.json(
      { error: "Missing txHash or quoteId" },
      { status: 400 }
    );
  }

  const apiBaseUrl = getEnvOrThrow("OSPEX_API_BASE_URL");

  try {
    // ── 1. Look up positionId from tx hash (retry for indexer lag) ──
    let positionId: string | null = null;

    for (let attempt = 1; attempt <= 5; attempt++) {
      // Wait before each attempt (indexer needs time)
      await new Promise((r) => setTimeout(r, 5000));

      const posRes = await fetch(
        `${apiBaseUrl}/v1/positions/by-tx/${encodeURIComponent(txHash)}`
      );

      if (posRes.ok) {
        const posData = (await posRes.json()) as {
          data?: { positions?: Array<{ positionId: string }> };
        };
        const positions = posData?.data?.positions;
        if (positions && positions.length > 0) {
          positionId = positions[0].positionId;
          break;
        }
      }

      // Check for POSITION_NOT_FOUND error — retry
      if (!posRes.ok) {
        const errData = (await posRes.json().catch(() => ({}))) as {
          code?: string;
        };
        if (errData.code === "POSITION_NOT_FOUND" && attempt < 5) {
          continue;
        }
        // Non-retryable error or last attempt
        if (attempt === 5) {
          return NextResponse.json({
            matched: false,
            positionId: null,
            reason: "Could not find position after 5 attempts. The position is on-chain — the market maker may match it during normal processing.",
          });
        }
      }
    }

    if (!positionId) {
      return NextResponse.json({
        matched: false,
        positionId: null,
        reason: "Position not found after retries. It is safe on-chain.",
      });
    }

    // ── 2. Call instant-match/{quoteId}/match ──
    const matchRes = await fetch(
      `${apiBaseUrl}/v1/instant-match/${encodeURIComponent(quoteId)}/match`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId }),
      }
    );

    if (matchRes.ok) {
      const matchData = (await matchRes.json()) as {
        txHash?: string;
      };
      return NextResponse.json({
        matched: true,
        positionId,
        matchTxHash: matchData.txHash ?? null,
      });
    }

    // Match failed — not an error, position is safe on-chain
    const matchErr = (await matchRes.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    return NextResponse.json({
      matched: false,
      positionId,
      reason: matchErr.error ?? matchErr.code ?? "Match endpoint returned an error",
    });
  } catch (err) {
    console.error("[bet-match] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
