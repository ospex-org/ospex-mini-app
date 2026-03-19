import { NextRequest, NextResponse } from "next/server";

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
  } catch (err) {
    console.error("[bet-match] Invalid JSON body:", err instanceof Error ? err.message : err);
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

  try {
    const apiBaseUrl = process.env.OSPEX_API_BASE_URL;
    if (!apiBaseUrl) {
      console.error("[bet-match] OSPEX_API_BASE_URL not configured");
      return NextResponse.json(
        { error: "OSPEX_API_BASE_URL not configured" },
        { status: 500 }
      );
    }

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

      // Non-OK response — distinguish retryable from non-retryable
      if (!posRes.ok) {
        const rawText = await posRes.text().catch(() => "unreadable");
        let errData: { code?: string; error?: string } = {};
        try {
          errData = JSON.parse(rawText) as { code?: string; error?: string };
        } catch {
          console.error("[bet-match] Position lookup JSON parse failed", {
            status: posRes.status,
            body: rawText.slice(0, 500),
          });
        }

        // Only retry on 404 / POSITION_NOT_FOUND (expected indexer lag)
        if (errData.code === "POSITION_NOT_FOUND" && attempt < 5) {
          continue;
        }

        // Non-retryable error (500, 401, 403, etc.) — stop immediately
        if (posRes.status >= 500 || posRes.status === 401 || posRes.status === 403) {
          console.error("[bet-match] Position lookup upstream error", {
            status: posRes.status,
            body: rawText.slice(0, 500),
          });
          return NextResponse.json(
            {
              matched: false,
              positionId: null,
              reason: `Upstream error looking up position (${posRes.status}). The position is on-chain — the market maker may match it during normal processing.`,
            },
            { status: 502 }
          );
        }

        // Last attempt for any other error
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
    const rawText = await matchRes.text().catch(() => "unreadable");
    let matchErr: { error?: string; code?: string } = {};
    try {
      matchErr = JSON.parse(rawText) as { error?: string; code?: string };
    } catch {
      console.error("[bet-match] Match response JSON parse failed", {
        status: matchRes.status,
        body: rawText.slice(0, 500),
      });
    }

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
