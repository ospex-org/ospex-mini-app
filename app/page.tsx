"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { MetaMaskSDK } from "@metamask/sdk";

// ============================================================
// Types
// ============================================================

type ConnectionMode = "metamask_browser" | "telegram_desktop" | "unknown";

type FlowState =
  | "initializing"
  | "validating_token"
  | "ready"
  | "connecting"
  | "connected"
  | "signing"
  | "submitting"
  | "success"
  | "error";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name: string;
      username?: string;
    };
    query_id?: string;
  };
  openLink: (url: string) => void;
  close: () => void;
  ready: () => void;
  expand: () => void;
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    link_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
  };
}

interface EthereumProvider {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
    ethereum?: EthereumProvider;
  }
}

// ============================================================
// Component
// ============================================================

export default function WalletConnectPage() {
  const [mode, setMode] = useState<ConnectionMode>("unknown");
  const [flowState, setFlowState] = useState<FlowState>("initializing");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [challengeMessage, setChallengeMessage] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [telegramUserId, setTelegramUserId] = useState<number | null>(null);
  const [theme, setTheme] = useState<TelegramWebApp["themeParams"] | undefined>(undefined);

  const sdkRef = useRef<MetaMaskSDK | null>(null);
  const initCalledRef = useRef(false);

  // ----------------------------------------------------------
  // Initialize: detect environment
  // ----------------------------------------------------------

  useEffect(() => {
    if (initCalledRef.current) return;
    initCalledRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("linkToken");
    const tg = window.Telegram?.WebApp;

    if (tg) {
      tg.ready();
      tg.expand();
      setTheme(tg.themeParams);
    }

    if (tokenParam) {
      // ----------------------------------------------------------
      // Path B: MetaMask browser — opened via deep link with token
      // ----------------------------------------------------------
      setMode("metamask_browser");
      setLinkToken(tokenParam);
      setFlowState("validating_token");

      fetch(`/api/link-token?token=${encodeURIComponent(tokenParam)}`)
        .then(async (res) => {
          const data = await res.json();
          if (data.valid) {
            setChallengeMessage(data.challengeMessage);
            setFlowState("ready");
          } else {
            setErrorMessage(data.error ?? "Invalid link token");
            setFlowState("error");
          }
        })
        .catch((err) => {
          setErrorMessage(
            err instanceof Error ? err.message : "Failed to validate token"
          );
          setFlowState("error");
        });
    } else if (tg?.initData) {
      // ----------------------------------------------------------
      // Path A: Telegram desktop — opened as mini-app
      // ----------------------------------------------------------
      setMode("telegram_desktop");

      const userId = tg.initDataUnsafe?.user?.id ?? null;
      setTelegramUserId(userId);

      if (!userId) {
        setErrorMessage(
          "Could not identify Telegram user. Please open this app from the Ospex bot."
        );
        setFlowState("error");
        return;
      }

      // Initialize MetaMask SDK for desktop Telegram flow
      const sdk = new MetaMaskSDK({
        dappMetadata: {
          name: "Ospex",
          url: "https://ospex-mini-app.vercel.app",
        },
        useDeeplink: true,
        checkInstallationImmediately: false,
      });

      sdkRef.current = sdk;
      setFlowState("ready");
    } else {
      // ----------------------------------------------------------
      // Unknown environment
      // ----------------------------------------------------------
      setMode("unknown");
      setErrorMessage(
        "Please open this page from the Ospex Telegram bot, or use the MetaMask browser link provided by the bot."
      );
      setFlowState("error");
    }
  }, []);

  // ----------------------------------------------------------
  // MetaMask browser: connect via window.ethereum
  // ----------------------------------------------------------

  const handleMetaMaskBrowserConnect = useCallback(async () => {
    if (!window.ethereum) {
      setErrorMessage(
        "MetaMask not detected. Please open this page in the MetaMask mobile browser."
      );
      setFlowState("error");
      return;
    }

    setFlowState("connecting");
    setErrorMessage(null);

    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from MetaMask");
      }

      setWalletAddress(accounts[0]);
      setFlowState("connected");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect wallet";
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, []);

  // ----------------------------------------------------------
  // MetaMask browser: sign challenge + submit
  // ----------------------------------------------------------

  const handleMetaMaskBrowserSign = useCallback(async () => {
    if (!window.ethereum || !walletAddress || !challengeMessage || !linkToken) {
      return;
    }

    setFlowState("signing");
    setErrorMessage(null);

    try {
      const messageHex = `0x${Array.from(
        new TextEncoder().encode(challengeMessage)
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;

      const signature = (await window.ethereum.request({
        method: "personal_sign",
        params: [messageHex, walletAddress],
      })) as string;

      setFlowState("submitting");

      const response = await fetch("/api/connect-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linkToken,
          walletAddress,
          signature,
          message: challengeMessage,
        }),
      });

      if (!response.ok) {
        const respBody = await response.json().catch(() => ({}));
        throw new Error(
          respBody.error ?? `Server error: ${response.status}`
        );
      }

      setFlowState("success");
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to sign or submit wallet connection";
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, [walletAddress, challengeMessage, linkToken]);

  // ----------------------------------------------------------
  // Telegram desktop: connect via MetaMask SDK
  // ----------------------------------------------------------

  const handleTelegramConnect = useCallback(async () => {
    const sdk = sdkRef.current;
    if (!sdk) return;

    setFlowState("connecting");
    setErrorMessage(null);

    try {
      const accounts = (await sdk.connect()) as string[] | undefined;

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from MetaMask");
      }

      setWalletAddress(accounts[0]);
      setFlowState("connected");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect MetaMask";
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, []);

  // ----------------------------------------------------------
  // Telegram desktop: sign + submit via SDK provider
  // ----------------------------------------------------------

  const handleTelegramSign = useCallback(async () => {
    const sdk = sdkRef.current;
    if (!sdk || !walletAddress || !telegramUserId) return;

    setFlowState("signing");
    setErrorMessage(null);

    const message = `Connect wallet to OspexBot: ${telegramUserId}`;

    try {
      const provider = sdk.getProvider();
      if (!provider) throw new Error("No provider available");

      const messageHex = `0x${Array.from(
        new TextEncoder().encode(message)
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;

      const signature = (await provider.request({
        method: "personal_sign",
        params: [messageHex, walletAddress],
      })) as string;

      setFlowState("submitting");

      const initData = window.Telegram?.WebApp?.initData ?? "";

      const response = await fetch("/api/connect-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegramUserId,
          walletAddress,
          signature,
          message,
          initData,
        }),
      });

      if (!response.ok) {
        const respBody = await response.json().catch(() => ({}));
        throw new Error(
          respBody.error ?? `Server error: ${response.status}`
        );
      }

      setFlowState("success");

      setTimeout(() => {
        window.Telegram?.WebApp?.close();
      }, 2500);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to sign or submit wallet connection";
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, [walletAddress, telegramUserId]);

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
    backgroundColor: theme?.bg_color ?? "#1a1a2e",
    color: theme?.text_color ?? "#e0e0e0",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: "360px",
    backgroundColor: theme?.secondary_bg_color ?? "#16213e",
    borderRadius: "16px",
    padding: "32px 24px",
    textAlign: "center",
  };

  const buttonStyle: React.CSSProperties = {
    width: "100%",
    padding: "14px 24px",
    borderRadius: "12px",
    border: "none",
    fontSize: "16px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: theme?.button_color ?? "#e94560",
    color: theme?.button_text_color ?? "#ffffff",
    marginTop: "16px",
  };

  const hintColor = theme?.hint_color ?? "#888";

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const handleConnect =
    mode === "metamask_browser"
      ? handleMetaMaskBrowserConnect
      : handleTelegramConnect;

  const handleSign =
    mode === "metamask_browser"
      ? handleMetaMaskBrowserSign
      : handleTelegramSign;

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: "22px", margin: "0 0 8px 0" }}>
          Ospex Wallet
        </h1>
        <p
          style={{
            fontSize: "14px",
            color: hintColor,
            margin: "0 0 24px 0",
          }}
        >
          {mode === "metamask_browser"
            ? "Connect your wallet to link it to your Telegram account"
            : "Connect your MetaMask wallet to place bets"}
        </p>

        {/* Initializing / Validating */}
        {(flowState === "initializing" || flowState === "validating_token") && (
          <p style={{ fontSize: "14px" }}>
            {flowState === "validating_token"
              ? "Validating link..."
              : "Initializing..."}
          </p>
        )}

        {/* Ready: Connect button */}
        {flowState === "ready" && (
          <button style={buttonStyle} onClick={handleConnect}>
            Connect MetaMask
          </button>
        )}

        {/* Connecting */}
        {flowState === "connecting" && (
          <p style={{ fontSize: "14px" }}>Connecting to MetaMask...</p>
        )}

        {/* Connected: show address + Sign button */}
        {flowState === "connected" && walletAddress && (
          <>
            <p style={{ fontSize: "14px", marginBottom: "4px" }}>Connected</p>
            <p
              style={{
                fontSize: "14px",
                fontWeight: 600,
                fontFamily: "monospace",
                margin: "4px 0 16px 0",
                wordBreak: "break-all",
              }}
            >
              {walletAddress}
            </p>
            <p
              style={{
                fontSize: "13px",
                color: hintColor,
                marginBottom: "8px",
              }}
            >
              Sign a message to verify you own this wallet.
            </p>
            <button style={buttonStyle} onClick={handleSign}>
              Sign &amp; Connect
            </button>
          </>
        )}

        {/* Signing */}
        {flowState === "signing" && (
          <>
            <p style={{ fontSize: "14px" }}>Signing message...</p>
            <p
              style={{
                fontSize: "12px",
                color: hintColor,
                marginTop: "8px",
              }}
            >
              Confirm the signature in MetaMask.
            </p>
          </>
        )}

        {/* Submitting */}
        {flowState === "submitting" && (
          <p style={{ fontSize: "14px" }}>Saving wallet...</p>
        )}

        {/* Success */}
        {flowState === "success" && (
          <>
            <p style={{ fontSize: "40px", margin: "0 0 12px 0" }}>
              &#10003;
            </p>
            <p style={{ fontSize: "16px", fontWeight: 600 }}>
              Wallet connected!
            </p>
            {walletAddress && (
              <p
                style={{
                  fontSize: "14px",
                  fontFamily: "monospace",
                  color: hintColor,
                  marginTop: "4px",
                }}
              >
                {truncateAddress(walletAddress)}
              </p>
            )}
            <p
              style={{
                fontSize: "13px",
                color: hintColor,
                marginTop: "12px",
              }}
            >
              {mode === "metamask_browser"
                ? "You can return to Telegram now."
                : "Closing..."}
            </p>
          </>
        )}

        {/* Error */}
        {flowState === "error" && (
          <>
            <p
              style={{
                fontSize: "14px",
                color: "#e94560",
                marginBottom: "12px",
              }}
            >
              {errorMessage ?? "Something went wrong."}
            </p>
            {mode !== "unknown" && (
              <button
                style={buttonStyle}
                onClick={() => {
                  setErrorMessage(null);
                  setFlowState(walletAddress ? "connected" : "ready");
                }}
              >
                Try Again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
