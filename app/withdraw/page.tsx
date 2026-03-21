"use client";

import { useEffect, useState, useCallback, useRef } from "react";

type FlowState =
  | "loading"
  | "error"
  | "no_metamask"
  | "ready"
  | "submitting"
  | "posting"
  | "success"
  | "partial_success";

interface TransactionDetails {
  type: "claim" | "withdraw";
  positionId: string;
  description: string;
  txParams: { method: string; args: Record<string, unknown> };
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

// ── Styles ──

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

const detailRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "8px 0",
  fontSize: "14px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const hintColor = "#8c8c8c";

export default function WithdrawPage() {
  const [flow, setFlow] = useState<FlowState>("loading");
  const [error, setError] = useState("");
  const [txDetails, setTxDetails] = useState<TransactionDetails | null>(null);
  const [expectedWallet, setExpectedWallet] = useState("");
  const [txHash, setTxHash] = useState("");
  const tokenRef = useRef("");
  const submittingRef = useRef(false);

  // 1. Validate token on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setError("Missing token parameter");
      setFlow("error");
      return;
    }
    tokenRef.current = token;

    fetch(`/api/tx-confirm?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!data.valid) {
          setError(data.error || "Invalid token");
          setFlow("error");
          return;
        }
        if (data.transaction.type !== "withdraw") {
          setError("This token is for a claim, not a withdrawal. Use the correct link.");
          setFlow("error");
          return;
        }
        setTxDetails(data.transaction);
        setExpectedWallet(data.walletAddress);
        setFlow("ready");
      })
      .catch(() => {
        setError("Failed to validate token");
        setFlow("error");
      });
  }, []);

  // 2. Sign and submit
  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;

    try {
      if (!window.ethereum?.isMetaMask) {
        setFlow("no_metamask");
        return;
      }

      // Skip the popup if already connected
      let accounts = (await window.ethereum.request({
        method: "eth_accounts",
      })) as string[];
      if (!accounts.length) {
        accounts = (await window.ethereum.request({
          method: "eth_requestAccounts",
        })) as string[];
      }

      const connectedWallet = accounts[0]?.toLowerCase();
      if (!connectedWallet || connectedWallet !== expectedWallet.toLowerCase()) {
        setError(
          `Wrong wallet connected.\nExpected: ${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}\nSwitch wallets in MetaMask and try again.`
        );
        setFlow("error");
        return;
      }

      const chainId = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;
      if (chainId !== "0x89") {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x89" }],
        });
      }

      setFlow("submitting");
      const encodeRes = await fetch("/api/tx-encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokenRef.current,
          walletAddress: connectedWallet,
        }),
      });

      if (!encodeRes.ok) {
        const data = await encodeRes.json().catch(() => ({ error: "Encoding failed" }));
        setError(data.error || "Failed to encode transaction");
        setFlow("error");
        return;
      }

      const { txParams } = await encodeRes.json();

      // Submit to MetaMask — no USDC approval needed for withdrawals
      const hash = (await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: connectedWallet,
            to: txParams.to,
            data: txParams.data,
            value: txParams.value,
          },
        ],
      })) as string;

      // Wait for receipt
      let receipt = null;
      for (let i = 0; i < 60; i++) {
        receipt = await window.ethereum.request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        });
        if (receipt) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!receipt || (receipt as { status: string }).status !== "0x1") {
        setError("Transaction failed or timed out on-chain.");
        setFlow("error");
        return;
      }

      setFlow("posting");
      setTxHash(hash);

      const confirmRes = await fetch("/api/tx-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenRef.current, txHash: hash }),
      });

      if (!confirmRes.ok) {
        setFlow("partial_success");
        return;
      }

      setFlow("success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User denied") || msg.includes("user rejected")) {
        setError("Transaction was rejected in MetaMask.");
      } else {
        setError(msg);
      }
      setFlow("error");
    } finally {
      submittingRef.current = false;
    }
  }, [expectedWallet]);

  // ── Render ──

  // Loading
  if (flow === "loading") {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "14px" }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Error
  if (flow === "error") {
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
            {error}
          </p>
          <p style={{ fontSize: "13px", color: hintColor, margin: 0 }}>
            Go back to Telegram and try again.
          </p>
        </div>
      </div>
    );
  }

  // No MetaMask
  if (flow === "no_metamask") {
    const confirmUrl = `https://ospex-mini-app.vercel.app/withdraw?token=${encodeURIComponent(tokenRef.current)}`;
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

  // Ready — show position details and sign button
  if (flow === "ready" && txDetails) {
    const truncatedWallet = `${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}`;

    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2
            style={{ fontSize: "18px", margin: "0 0 4px 0", textAlign: "center" }}
          >
            Withdraw Position
          </h2>
          <p
            style={{
              fontSize: "13px",
              color: hintColor,
              margin: "0 0 20px 0",
              textAlign: "center",
            }}
          >
            Review and sign to withdraw your unmatched funds
          </p>

          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Position</span>
            <span style={{ fontWeight: 600, textAlign: "right", maxWidth: "60%" }}>
              {txDetails.description}
            </span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Action</span>
            <span>Withdraw unmatched</span>
          </div>
          <div style={detailRowStyle}>
            <span style={{ color: hintColor }}>Network</span>
            <span>Polygon</span>
          </div>
          <div style={{ ...detailRowStyle, borderBottom: "none" }}>
            <span style={{ color: hintColor }}>Wallet</span>
            <span style={{ fontFamily: "monospace", fontSize: "13px" }}>
              {truncatedWallet}
            </span>
          </div>

          <button style={buttonStyle} onClick={handleConfirm}>
            Sign with MetaMask
          </button>
        </div>
      </div>
    );
  }

  // In-progress states
  if (flow === "submitting" || flow === "posting") {
    const statusMessages: Record<string, string> = {
      submitting: "Confirm withdrawal in MetaMask...",
      posting: "Recording transaction...",
    };

    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "14px" }}>{statusMessages[flow]}</p>
          {flow === "submitting" && (
            <p style={{ fontSize: "12px", color: hintColor, marginTop: "8px" }}>
              Check MetaMask for the transaction prompt.
            </p>
          )}
        </div>
      </div>
    );
  }

  // Success
  if (flow === "success") {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <p style={{ fontSize: "40px", margin: "0 0 12px 0" }}>&#10003;</p>
          <h2 style={{ fontSize: "18px", margin: "0 0 16px 0" }}>
            Withdrawal Successful
          </h2>
          {txDetails && (
            <p style={{ fontSize: "14px", color: hintColor, margin: "0 0 16px 0" }}>
              {txDetails.description}
            </p>
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
                marginTop: "8px",
                wordBreak: "break-all",
              }}
            >
              View on Polygonscan
            </a>
          )}
          <p style={{ fontSize: "13px", color: hintColor, marginTop: "16px" }}>
            You can close this page and return to Telegram.
          </p>
        </div>
      </div>
    );
  }

  // Partial success
  if (flow === "partial_success") {
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
            Your withdrawal went through on-chain but we couldn&apos;t record it.
            The bot will pick it up shortly.
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

  // Fallback
  return (
    <div style={containerStyle}>
      <div style={{ ...cardStyle, textAlign: "center" }}>
        <p style={{ fontSize: "14px" }}>Loading...</p>
      </div>
    </div>
  );
}
