"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ============================================================
// Types
// ============================================================

type FlowState =
  | "loading"
  | "validating"
  | "ready"
  | "confirming"
  | "approving"
  | "submitting"
  | "posting"
  | "success"
  | "error"
  | "drift";

interface BetDetails {
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
}

interface TxParamsPayload {
  txParams: { to: string; data: string; value: string };
  finalOdds: number;
  finalOddsAmerican: number;
  finalPayout: number;
  needsApproval: boolean;
  approveTxParams?: { to: string; data: string; value: string } | undefined;
  quoteId: string;
  expiresAt: string;
}

interface DriftInfo {
  indicativeOdds: number;
  finalOdds: number;
  driftPercent: number;
  maxDriftPercent: number;
}

interface EthereumProvider {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

// ============================================================
// Helpers
// ============================================================

function formatOdds(decimal: number | null): string {
  if (decimal == null) return "TBD";
  // Convert decimal to American
  if (decimal >= 2.0) {
    return `+${Math.round((decimal - 1) * 100)}`;
  }
  return `${Math.round(-100 / (decimal - 1))}`;
}

function formatSide(bet: BetDetails): string {
  if (bet.marketType === "total") {
    return bet.side === "over" ? "Over" : "Under";
  }
  const teamName = bet.side === "away" ? bet.awayTeam : bet.homeTeam;
  return teamName;
}

function formatMarket(bet: BetDetails): string {
  if (bet.marketType === "moneyline") return "Moneyline";
  if (bet.marketType === "spread") {
    const sign = bet.line != null && bet.line > 0 ? "+" : "";
    return `Spread ${sign}${bet.line ?? ""}`;
  }
  return `Total ${bet.line ?? ""}`;
}

function formatMatchTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

const POLYGON_CHAIN_ID = "0x89"; // 137

// ============================================================
// Component
// ============================================================

export default function ConfirmBetPage() {
  const [flowState, setFlowState] = useState<FlowState>("loading");
  const [bet, setBet] = useState<BetDetails | null>(null);
  const [expectedWallet, setExpectedWallet] = useState<string | null>(null);
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [finalOdds, setFinalOdds] = useState<number | null>(null);
  const [finalPayout, setFinalPayout] = useState<number | null>(null);
  const [driftInfo, setDriftInfo] = useState<DriftInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const initCalledRef = useRef(false);

  // ----------------------------------------------------------
  // On mount: validate token + load bet details
  // ----------------------------------------------------------

  useEffect(() => {
    if (initCalledRef.current) return;
    initCalledRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("token");

    if (!tokenParam) {
      setErrorMessage("Missing token. Go back to Telegram and try again.");
      setFlowState("error");
      return;
    }

    setToken(tokenParam);
    setFlowState("validating");

    fetch(`/api/bet-confirm?token=${encodeURIComponent(tokenParam)}`)
      .then(async (res) => {
        const data = await res.json();
        if (data.valid) {
          setBet(data.bet);
          setExpectedWallet(data.walletAddress);
          setFlowState("ready");
        } else {
          setErrorMessage(data.error ?? "Invalid or expired token");
          setFlowState("error");
        }
      })
      .catch(() => {
        setErrorMessage("Failed to validate bet. Check your connection.");
        setFlowState("error");
      });
  }, []);

  // ----------------------------------------------------------
  // Connect wallet + verify chain on ready
  // ----------------------------------------------------------

  useEffect(() => {
    if (flowState !== "ready" || !expectedWallet) return;

    if (!window.ethereum) {
      setErrorMessage(
        "MetaMask not detected. Please open this page in the MetaMask mobile browser."
      );
      setFlowState("error");
      return;
    }

    (async () => {
      try {
        const accounts = (await window.ethereum!.request({
          method: "eth_requestAccounts",
        })) as string[];

        if (!accounts || accounts.length === 0) {
          setErrorMessage("No accounts returned from MetaMask.");
          setFlowState("error");
          return;
        }

        const connected = accounts[0].toLowerCase();
        setConnectedWallet(connected);

        if (connected !== expectedWallet.toLowerCase()) {
          setErrorMessage(
            `Wrong wallet connected.\nExpected: ${expectedWallet}\nGot: ${accounts[0]}\n\nSwitch to the correct wallet and refresh.`
          );
          setFlowState("error");
          return;
        }

        // Check chain
        const chainId = (await window.ethereum!.request({
          method: "eth_chainId",
        })) as string;

        if (chainId !== POLYGON_CHAIN_ID) {
          try {
            await window.ethereum!.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: POLYGON_CHAIN_ID }],
            });
          } catch {
            setErrorMessage(
              "Please switch to Polygon network in MetaMask and refresh."
            );
            setFlowState("error");
            return;
          }
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to connect wallet";
        setErrorMessage(msg);
        setFlowState("error");
      }
    })();
  }, [flowState, expectedWallet]);

  // ----------------------------------------------------------
  // Wait for tx confirmation (poll receipt)
  // ----------------------------------------------------------

  const waitForReceipt = useCallback(
    async (hash: string): Promise<{ status: number }> => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const receipt = (await window.ethereum!.request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        })) as { status: string } | null;

        if (receipt) {
          return { status: parseInt(receipt.status, 16) };
        }
      }
      throw new Error("Transaction confirmation timed out");
    },
    []
  );

  // ----------------------------------------------------------
  // Confirm bet: get txparams → approve (if needed) → submit → post hash
  // ----------------------------------------------------------

  const handleConfirm = useCallback(async () => {
    if (!token || !connectedWallet || !window.ethereum) return;

    setFlowState("confirming");
    setErrorMessage(null);

    try {
      // 1. Get fresh tx params
      const res = await fetch("/api/bet-txparams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, walletAddress: connectedWallet }),
      });

      const data = await res.json();

      // Handle drift exceeded
      if (res.status === 409 && data.driftExceeded) {
        setDriftInfo({
          indicativeOdds: data.indicativeOdds,
          finalOdds: data.finalOdds,
          driftPercent: data.driftPercent,
          maxDriftPercent: data.maxDriftPercent,
        });
        setFlowState("drift");
        return;
      }

      if (!res.ok) {
        throw new Error(data.error ?? `Server error: ${res.status}`);
      }

      const payload = data as TxParamsPayload;
      setFinalOdds(payload.finalOdds);
      setFinalPayout(payload.finalPayout);

      // 2. Approve USDC if needed
      if (payload.needsApproval && payload.approveTxParams) {
        setFlowState("approving");

        const approveTxHash = (await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: connectedWallet,
              to: payload.approveTxParams.to,
              data: payload.approveTxParams.data,
              value: payload.approveTxParams.value,
            },
          ],
        })) as string;

        const approveReceipt = await waitForReceipt(approveTxHash);
        if (approveReceipt.status !== 1) {
          throw new Error("USDC approval transaction failed");
        }

        // Re-fetch fresh tx params after approval (quote may have expired)
        const freshRes = await fetch("/api/bet-txparams", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, walletAddress: connectedWallet }),
        });

        const freshData = await freshRes.json();
        if (!freshRes.ok) {
          throw new Error(
            freshData.error ?? `Server error: ${freshRes.status}`
          );
        }

        const freshPayload = freshData as TxParamsPayload;
        setFinalOdds(freshPayload.finalOdds);
        setFinalPayout(freshPayload.finalPayout);

        // Use fresh params for the bet tx
        Object.assign(payload, freshPayload);
      }

      // 3. Submit bet transaction
      setFlowState("submitting");

      const betTxHash = (await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: connectedWallet,
            to: payload.txParams.to,
            data: payload.txParams.data,
            value: payload.txParams.value,
          },
        ],
      })) as string;

      const betReceipt = await waitForReceipt(betTxHash);
      if (betReceipt.status !== 1) {
        throw new Error("Bet transaction reverted on-chain");
      }

      // 4. Post tx hash back to server
      setFlowState("posting");
      setTxHash(betTxHash);

      const confirmRes = await fetch("/api/bet-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, txHash: betTxHash }),
      });

      if (!confirmRes.ok) {
        // Tx succeeded on-chain but server recording failed — still show success
        console.error(
          "[confirm] Failed to record txHash:",
          await confirmRes.text()
        );
      }

      setFlowState("success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";

      // Detect user rejection
      if (
        msg.includes("User denied") ||
        msg.includes("user rejected") ||
        msg.includes("rejected the request")
      ) {
        setErrorMessage("Transaction cancelled. You can try again.");
      } else {
        setErrorMessage(msg);
      }
      setFlowState("error");
    }
  }, [token, connectedWallet, waitForReceipt]);

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    backgroundColor: "var(--tg-theme-bg-color, #1a1a2e)",
    color: "var(--tg-theme-text-color, #e0e0e0)",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: "360px",
    backgroundColor: "var(--tg-theme-secondary-bg-color, #16213e)",
    borderRadius: "16px",
    padding: "32px 24px",
  };

  const buttonStyle: React.CSSProperties = {
    width: "100%",
    padding: "14px 24px",
    borderRadius: "12px",
    border: "none",
    fontSize: "16px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: "var(--tg-theme-button-color, #e94560)",
    color: "var(--tg-theme-button-text-color, #ffffff)",
    marginTop: "16px",
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: "transparent",
    border: "1px solid var(--tg-theme-hint-color, #666)",
    color: "var(--tg-theme-hint-color, #aaa)",
  };

  const hintColor = "var(--tg-theme-hint-color, #888)";

  const detailRowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 0",
    fontSize: "14px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  };

  // ── Loading / Validating ──
  if (flowState === "loading" || flowState === "validating") {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "14px" }}>
            {flowState === "loading" ? "Loading..." : "Validating bet..."}
          </p>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (flowState === "error") {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p
            style={{
              fontSize: "14px",
              color: "#e94560",
              whiteSpace: "pre-wrap",
              marginBottom: "12px",
            }}
          >
            {errorMessage ?? "Something went wrong."}
          </p>
          {connectedWallet && bet && (
            <button
              style={buttonStyle}
              onClick={() => {
                setErrorMessage(null);
                setFlowState("ready");
              }}
            >
              Try Again
            </button>
          )}
          <a
            href="https://t.me/OspexBot"
            style={{
              ...secondaryButtonStyle,
              display: "block",
              textDecoration: "none",
              textAlign: "center",
            }}
          >
            Return to Telegram
          </a>
        </div>
      </div>
    );
  }

  // ── Drift warning ──
  if (flowState === "drift" && driftInfo) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2
            style={{ fontSize: "18px", margin: "0 0 12px 0", textAlign: "center" }}
          >
            Odds Have Changed
          </h2>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Original odds</span>
            <span>{formatOdds(driftInfo.indicativeOdds)}</span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Current odds</span>
            <span style={{ fontWeight: 600 }}>
              {formatOdds(driftInfo.finalOdds)}
            </span>
          </div>
          <div style={{ ...detailRowStyle, borderBottom: "none" }}>
            <span style={{ color: hintColor }}>Drift</span>
            <span style={{ color: "#e94560" }}>
              {driftInfo.driftPercent.toFixed(1)}% (limit: {driftInfo.maxDriftPercent}%)
            </span>
          </div>
          <p
            style={{
              fontSize: "13px",
              color: hintColor,
              textAlign: "center",
              margin: "16px 0 0 0",
            }}
          >
            The odds moved beyond your drift limit. Start a new bet in Telegram
            if you&apos;d like to proceed at the new odds.
          </p>
          <a
            href="https://t.me/OspexBot"
            style={{
              ...buttonStyle,
              display: "block",
              textDecoration: "none",
              textAlign: "center",
            }}
          >
            Return to Telegram
          </a>
        </div>
      </div>
    );
  }

  // ── Success ──
  if (flowState === "success" && bet) {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "40px", margin: "0 0 12px 0" }}>&#10003;</p>
          <h2 style={{ fontSize: "18px", margin: "0 0 16px 0" }}>
            Bet Placed!
          </h2>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Game</span>
            <span>
              {bet.awayTeam} @ {bet.homeTeam}
            </span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Pick</span>
            <span>{formatSide(bet)}</span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Stake</span>
            <span>{bet.stake.toFixed(2)} USDC</span>
          </div>
          {finalOdds && (
            <div style={detailRowStyle}>
              <span style={{ color: hintColor }}>Final odds</span>
              <span>{formatOdds(finalOdds)}</span>
            </div>
          )}
          {finalPayout && (
            <div style={{ ...detailRowStyle, borderBottom: "none" }}>
              <span style={{ color: hintColor }}>Payout</span>
              <span style={{ fontWeight: 600 }}>
                {finalPayout.toFixed(2)} USDC
              </span>
            </div>
          )}
          {txHash && (
            <a
              href={`https://polygonscan.com/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                fontSize: "13px",
                color: "var(--tg-theme-link-color, #5dade2)",
                marginTop: "16px",
                wordBreak: "break-all",
              }}
            >
              View on Polygonscan
            </a>
          )}
          <a
            href="https://t.me/OspexBot"
            style={{
              ...buttonStyle,
              display: "block",
              textDecoration: "none",
              textAlign: "center",
            }}
          >
            Return to Telegram
          </a>
        </div>
      </div>
    );
  }

  // ── In-progress states (confirming, approving, submitting, posting) ──
  if (
    flowState === "confirming" ||
    flowState === "approving" ||
    flowState === "submitting" ||
    flowState === "posting"
  ) {
    const statusMessages: Record<string, string> = {
      confirming: "Getting fresh quote...",
      approving: "Approve USDC spending in MetaMask...",
      submitting: "Confirm bet transaction in MetaMask...",
      posting: "Recording transaction...",
    };

    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "14px" }}>{statusMessages[flowState]}</p>
          {(flowState === "approving" || flowState === "submitting") && (
            <p
              style={{ fontSize: "12px", color: hintColor, marginTop: "8px" }}
            >
              Check MetaMask for the transaction prompt.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Ready: show bet details + confirm button ──
  if (flowState === "ready" && bet) {
    const estimatedPayout =
      bet.indicativeOdds != null
        ? (bet.stake * bet.indicativeOdds).toFixed(2)
        : null;

    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2
            style={{ fontSize: "18px", margin: "0 0 4px 0", textAlign: "center" }}
          >
            {bet.awayTeam} @ {bet.homeTeam}
          </h2>
          <p
            style={{
              fontSize: "13px",
              color: hintColor,
              margin: "0 0 20px 0",
              textAlign: "center",
            }}
          >
            {formatMatchTime(bet.matchTime)}
          </p>

          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Market</span>
            <span>{formatMarket(bet)}</span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Your pick</span>
            <span style={{ fontWeight: 600 }}>{formatSide(bet)}</span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Stake</span>
            <span>{bet.stake.toFixed(2)} USDC</span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Est. odds</span>
            <span>
              {formatOdds(bet.indicativeOdds)}
              {bet.indicativeOdds != null && (
                <span style={{ color: hintColor, fontSize: "12px" }}>
                  {" "}
                  ({bet.indicativeOdds.toFixed(2)})
                </span>
              )}
            </span>
          </div>
          {estimatedPayout && (
            <div style={{ ...detailRowStyle, borderBottom: "none" }}>
              <span style={{ color: hintColor }}>Est. payout</span>
              <span style={{ fontWeight: 600 }}>{estimatedPayout} USDC</span>
            </div>
          )}

          <button style={buttonStyle} onClick={handleConfirm}>
            Confirm Bet
          </button>

          <p
            style={{
              fontSize: "12px",
              color: hintColor,
              textAlign: "center",
              margin: "12px 0 0 0",
            }}
          >
            Odds are refreshed at confirm time. Final odds may differ.
          </p>
        </div>
      </div>
    );
  }

  // Fallback
  return (
    <div style={containerStyle}>
      <div style={{ ...cardStyle, textAlign: "center" }}>
        <p style={{ fontSize: "14px" }}>Loading...</p>
      </div>
    </div>
  );
}
