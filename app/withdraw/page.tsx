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
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

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

      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];

      const connectedWallet = accounts[0]?.toLowerCase();
      if (!connectedWallet || connectedWallet !== expectedWallet.toLowerCase()) {
        setError(
          `Wrong wallet connected. Expected ${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}. ` +
          `Switch wallets in MetaMask and try again.`
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

  return (
    <div style={{ padding: "24px", maxWidth: "480px", margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ marginBottom: "16px" }}>Withdraw Position</h2>

      {flow === "loading" && <p>Loading...</p>}

      {flow === "error" && (
        <div>
          <p style={{ color: "#dc3545" }}>{error}</p>
          <p style={{ marginTop: "12px", fontSize: "14px", color: "#666" }}>
            Go back to Telegram and try again.
          </p>
        </div>
      )}

      {flow === "no_metamask" && (
        <div>
          <p>MetaMask is required to sign this transaction.</p>
          <p style={{ marginTop: "8px", fontSize: "14px", color: "#666" }}>
            Open this page in the MetaMask browser.
          </p>
        </div>
      )}

      {flow === "ready" && txDetails && (
        <div>
          <div style={{ padding: "16px", background: "#f8f9fa", borderRadius: "8px", marginBottom: "16px" }}>
            <p style={{ fontWeight: "bold", marginBottom: "8px" }}>Withdrawing:</p>
            <p>{txDetails.description}</p>
          </div>
          <button
            onClick={handleConfirm}
            style={{
              width: "100%",
              padding: "14px",
              background: "#007bff",
              color: "white",
              border: "none",
              borderRadius: "8px",
              fontSize: "16px",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            Sign with MetaMask
          </button>
        </div>
      )}

      {flow === "submitting" && (
        <p>Confirming withdrawal on-chain... Please approve in MetaMask.</p>
      )}

      {flow === "posting" && <p>Recording transaction...</p>}

      {flow === "success" && (
        <div>
          <p style={{ color: "#28a745", fontWeight: "bold" }}>Withdrawal successful!</p>
          {txDetails && <p style={{ marginTop: "8px" }}>{txDetails.description}</p>}
          {txHash && (
            <p style={{ marginTop: "8px", fontSize: "14px" }}>
              <a
                href={`https://polygonscan.com/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#007bff" }}
              >
                View on Polygonscan
              </a>
            </p>
          )}
          <p style={{ marginTop: "12px", fontSize: "14px", color: "#666" }}>
            You can close this page and return to Telegram.
          </p>
        </div>
      )}

      {flow === "partial_success" && (
        <div>
          <p style={{ color: "#ffc107", fontWeight: "bold" }}>
            Withdrawal submitted on-chain but server confirmation failed.
          </p>
          <p style={{ marginTop: "8px", fontSize: "14px" }}>
            Your withdrawal is safe. The bot will pick it up shortly.
          </p>
          {txHash && (
            <p style={{ marginTop: "8px", fontSize: "14px" }}>
              <a
                href={`https://polygonscan.com/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#007bff" }}
              >
                View on Polygonscan
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
