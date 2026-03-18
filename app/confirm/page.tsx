"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ============================================================
// Types
// ============================================================

type FlowState =
  | "loading"
  | "validating"
  | "ready"
  | "no_metamask"
  | "confirming"
  | "review"
  | "approving"
  | "submitting"
  | "posting"
  | "success"
  | "partial_success"
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
      timeZone: "America/New_York",
    }) + " ET";
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
  const [preparedPayload, setPreparedPayload] = useState<TxParamsPayload | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);

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
      setFlowState("no_metamask");
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
  // Auto-fetch quote after wallet connects successfully
  // ----------------------------------------------------------

  useEffect(() => {
    if (flowState !== "ready" || !connectedWallet || !token) return;
    handleRefreshQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowState, connectedWallet, token]);

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
  // Helper: fetch quote and check for drift
  // ----------------------------------------------------------

  const fetchQuote = useCallback(
    async (): Promise<TxParamsPayload | "drift" | null> => {
      const res = await fetch("/api/bet-txparams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, walletAddress: connectedWallet }),
      });

      const data = await res.json();

      if (res.status === 409 && data.driftExceeded) {
        setDriftInfo({
          indicativeOdds: data.indicativeOdds,
          finalOdds: data.finalOdds,
          driftPercent: data.driftPercent,
          maxDriftPercent: data.maxDriftPercent,
        });
        return "drift";
      }

      if (!res.ok) {
        throw new Error(data.error ?? `Server error: ${res.status}`);
      }

      return data as TxParamsPayload;
    },
    [token, connectedWallet]
  );

  // ----------------------------------------------------------
  // Step 1: Fetch fresh quote → show review screen with final terms
  // ----------------------------------------------------------

  const handleRefreshQuote = useCallback(async () => {
    if (!token || !connectedWallet) return;

    setFlowState("confirming");
    setErrorMessage(null);

    try {
      const result = await fetchQuote();

      if (result === "drift") {
        setFlowState("drift");
        return;
      }

      if (!result) {
        throw new Error("Failed to get quote");
      }

      setPreparedPayload(result);
      setFinalOdds(result.finalOdds);
      setFinalPayout(result.finalPayout);
      setNeedsApproval(result.needsApproval);
      setFlowState("review");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to get quote";
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, [token, connectedWallet, fetchQuote]);

  // ----------------------------------------------------------
  // Step 2: Submit tx (approve if needed → bet tx → post hash)
  // ----------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    if (!token || !connectedWallet || !window.ethereum || !preparedPayload) return;

    let payload = preparedPayload;

    try {
      // 1. Approve USDC if needed
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
        const freshResult = await fetchQuote();

        if (freshResult === "drift") {
          setFlowState("drift");
          return;
        }

        if (!freshResult) {
          throw new Error("Failed to refresh quote after approval");
        }

        payload = freshResult;
        setPreparedPayload(payload);
        setFinalOdds(payload.finalOdds);
        setFinalPayout(payload.finalPayout);
      }

      // 2. Submit bet transaction
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

      // 3. Post tx hash back to server
      setFlowState("posting");
      setTxHash(betTxHash);

      const confirmRes = await fetch("/api/bet-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, txHash: betTxHash }),
      });

      if (!confirmRes.ok) {
        console.error(
          "[confirm] Failed to record txHash:",
          await confirmRes.text()
        );
        setFlowState("partial_success");
        return;
      }

      setFlowState("success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";

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
  }, [token, connectedWallet, preparedPayload, waitForReceipt, fetchQuote]);

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
    fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
    backgroundColor: "#0a0a0a",
    color: "#f2f2f2",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: "360px",
    backgroundColor: "#141414",
    borderRadius: "12px",
    padding: "32px 24px",
  };

  const buttonStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 24px",
    borderRadius: "12px",
    border: "none",
    fontSize: "16px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: "#e94560",
    color: "#ffffff",
    marginTop: "16px",
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: "transparent",
    border: "1px solid #2e2e2e",
    color: "#8c8c8c",
  };

  const hintColor = "#8c8c8c";

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
        </div>
      </div>
    );
  }

  // ── No MetaMask: redirect via deep link ──
  if (flowState === "no_metamask" && token) {
    const confirmUrl = `https://ospex-mini-app.vercel.app/confirm?token=${encodeURIComponent(token)}`;
    const metaMaskLink = `https://link.metamask.io/dapp/${encodeURIComponent(confirmUrl)}`;

    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <h1 style={{ fontSize: "22px", margin: "0 0 8px 0" }}>Open MetaMask</h1>
          <p style={{ fontSize: "14px", color: hintColor, margin: "0 0 12px 0" }}>
            MetaMask isn&apos;t available in this browser. Tap below to open in
            MetaMask&apos;s built-in browser.
          </p>
          <a
            href={metaMaskLink}
            style={{
              ...buttonStyle,
              display: "block",
              textDecoration: "none",
              textAlign: "center",
            }}
          >
            Open in MetaMask
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
        </div>
      </div>
    );
  }

  // ── Partial success (tx on-chain but server sync failed) ──
  if (flowState === "partial_success" && bet) {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "40px", margin: "0 0 12px 0" }}>&#9888;</p>
          <h2 style={{ fontSize: "18px", margin: "0 0 8px 0" }}>
            Transaction Succeeded
          </h2>
          <p
            style={{
              fontSize: "14px",
              color: "#f0ad4e",
              margin: "0 0 16px 0",
            }}
          >
            Your bet was placed on-chain, but we couldn&apos;t sync it back to
            OspexBot. The bot may not send a confirmation message.
          </p>
          {txHash && (
            <a
              href={`https://polygonscan.com/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                fontSize: "13px",
                color: "#5dade2",
                marginTop: "8px",
                wordBreak: "break-all",
              }}
            >
              View on Polygonscan
            </a>
          )}
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
                color: "#5dade2",
                marginTop: "16px",
                wordBreak: "break-all",
              }}
            >
              View on Polygonscan
            </a>
          )}
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

  // ── Review: show final executable terms + submit button ──
  if (flowState === "review" && bet && preparedPayload) {
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

          {bet.indicativeOdds != null && finalOdds != null && Math.abs(finalOdds - bet.indicativeOdds) >= 0.01 && (
            <p
              style={{
                fontSize: "13px",
                color: "#e3a820",
                textAlign: "center",
                margin: "0 0 16px 0",
              }}
            >
              Odds moved from {formatOdds(bet.indicativeOdds)} to {formatOdds(finalOdds)}
            </p>
          )}

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
            <span style={{ color: hintColor }}>Final odds</span>
            <span style={{ fontWeight: 600 }}>
              {formatOdds(finalOdds)}
              {finalOdds != null && (
                <span style={{ color: hintColor, fontSize: "12px" }}>
                  {" "}
                  ({finalOdds.toFixed(2)})
                </span>
              )}
            </span>
          </div>
          <div style={{ ...detailRowStyle, borderBottom: "none" }}>
            <span style={{ color: hintColor }}>Payout</span>
            <span style={{ fontWeight: 600 }}>
              {finalPayout?.toFixed(2) ?? "—"} USDC
            </span>
          </div>

          {needsApproval && (
            <p
              style={{
                fontSize: "12px",
                color: "#f0ad4e",
                textAlign: "center",
                margin: "12px 0 0 0",
              }}
            >
              USDC approval required — you&apos;ll confirm two transactions.
            </p>
          )}

          <button style={buttonStyle} onClick={handleSubmit}>
            Confirm Bet
          </button>

          <button
            style={secondaryButtonStyle}
            onClick={() => setFlowState("ready")}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Ready: wallet connected, auto-fetching quote ──
  if (flowState === "ready" && bet) {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "14px" }}>
            {connectedWallet ? "Getting fresh quote..." : "Connecting wallet..."}
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
