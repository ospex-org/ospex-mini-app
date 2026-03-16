"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { MetaMaskSDK } from "@metamask/sdk";

// ============================================================
// Types
// ============================================================

type FlowState =
  | "initializing"
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
  MainButton: {
    text: string;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
    enable: () => void;
    disable: () => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    isVisible: boolean;
    isActive: boolean;
    color: string;
    textColor: string;
    setText: (text: string) => void;
    setParams: (params: Record<string, unknown>) => void;
  };
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

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function isTelegramEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window.Telegram?.WebApp?.initData);
}

/**
 * Convert metamask:// deep links to universal links.
 * Telegram's WebView can't dispatch custom URL schemes reliably,
 * but https://metamask.app.link/ routes through universal links
 * which the OS handles correctly.
 */
function normalizeMetaMaskLink(link: string): string {
  if (link.startsWith("metamask://")) {
    return `https://metamask.app.link/${link.slice("metamask://".length)}`;
  }
  return link;
}

/**
 * Open a URL from within the Telegram Mini App.
 * Prefers Telegram.WebApp.openLink, falls back to window.location.
 */
function openLinkFromTelegram(url: string): void {
  const normalized = normalizeMetaMaskLink(url);
  console.log(`[ospex] openLinkFromTelegram: ${normalized}`);

  if (window.Telegram?.WebApp?.openLink) {
    window.Telegram.WebApp.openLink(normalized);
  } else {
    window.location.href = normalized;
  }
}

// ============================================================
// Component
// ============================================================

export default function WalletConnectPage() {
  const [flowState, setFlowState] = useState<FlowState>("initializing");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [telegramUserId, setTelegramUserId] = useState<number | null>(null);

  const [theme, setTheme] = useState<TelegramWebApp["themeParams"] | undefined>(undefined);

  const sdkRef = useRef<MetaMaskSDK | null>(null);
  const initCalledRef = useRef(false);

  // ----------------------------------------------------------
  // Initialize Telegram + MetaMask SDK
  // ----------------------------------------------------------

  useEffect(() => {
    if (initCalledRef.current) return;
    initCalledRef.current = true;

    const tg = window.Telegram?.WebApp;

    // Tell Telegram the mini-app is ready
    if (tg) {
      tg.ready();
      tg.expand();
      setTheme(tg.themeParams);
    }

    // Extract Telegram user ID
    const userId = tg?.initDataUnsafe?.user?.id ?? null;
    setTelegramUserId(userId);

    if (!userId) {
      setErrorMessage(
        "Could not identify Telegram user. Please open this app from the Ospex bot."
      );
      setFlowState("error");
      return;
    }

    // ----------------------------------------------------------
    // Install window.open safety net BEFORE SDK init.
    // The SDK's openDeeplink hook is the primary mechanism,
    // but some internal code paths may still call window.open.
    // ----------------------------------------------------------
    let originalOpen: typeof window.open | null = null;

    if (isTelegramEnvironment()) {
      originalOpen = window.open.bind(window);

      window.open = ((
        url?: string | URL,
        target?: string,
        features?: string
      ) => {
        const raw = String(url ?? "");

        if (
          raw.startsWith("metamask://") ||
          raw.includes("metamask.app.link")
        ) {
          openLinkFromTelegram(raw);
          return null;
        }

        return originalOpen!(url, target, features);
      }) as typeof window.open;
    }

    // ----------------------------------------------------------
    // Initialize MetaMask SDK with openDeeplink hook
    // ----------------------------------------------------------
    const sdk = new MetaMaskSDK({
      dappMetadata: {
        name: "Ospex",
        url: "https://ospex-mini-app.vercel.app",
      },
      useDeeplink: true,
      openDeeplink: (link: string) => {
        openLinkFromTelegram(link);
      },
      // On desktop Telegram, this shows a QR code in the mini-app.
      // On mobile, it triggers the MetaMask app via universal link.
      checkInstallationImmediately: false,
    });

    sdkRef.current = sdk;
    setFlowState("ready");

    return () => {
      if (originalOpen) {
        window.open = originalOpen;
      }
    };
  }, []);

  // ----------------------------------------------------------
  // Connect wallet
  // ----------------------------------------------------------

  const handleConnect = useCallback(async () => {
    const sdk = sdkRef.current;
    if (!sdk) return;

    setFlowState("connecting");
    setErrorMessage(null);

    try {
      const accounts = (await sdk.connect()) as string[] | undefined;

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from MetaMask");
      }

      const address = accounts[0];
      setWalletAddress(address);
      setFlowState("connected");
      console.log(`[ospex] Connected: ${address}`);
    } catch (err: unknown) {
      console.error("[ospex] Connect error:", err);
      const msg =
        err instanceof Error ? err.message : "Failed to connect MetaMask";
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, []);

  // ----------------------------------------------------------
  // Sign message to prove ownership, then POST to backend
  // ----------------------------------------------------------

  const handleSignAndSubmit = useCallback(async () => {
    const sdk = sdkRef.current;
    if (!sdk || !walletAddress || !telegramUserId) return;

    setFlowState("signing");
    setErrorMessage(null);

    const message = `Connect wallet to OspexBot: ${telegramUserId}`;

    try {
      const provider = sdk.getProvider();
      if (!provider) throw new Error("No provider available");

      // Request personal_sign
      const signature = (await provider.request({
        method: "personal_sign",
        params: [
          `0x${Buffer.from(message, "utf8").toString("hex")}`,
          walletAddress,
        ],
      })) as string;

      console.log(`[ospex] Signature obtained`);
      setFlowState("submitting");

      // POST to backend
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
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.error ?? `Server error: ${response.status}`
        );
      }

      setFlowState("success");
      console.log(`[ospex] Wallet connected successfully`);

      // Auto-close back to the bot after a short delay
      setTimeout(() => {
        window.Telegram?.WebApp?.close();
      }, 2500);
    } catch (err: unknown) {
      console.error("[ospex] Sign/submit error:", err);
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
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        {/* Header */}
        <h1 style={{ fontSize: "22px", margin: "0 0 8px 0" }}>
          Ospex Wallet
        </h1>
        <p
          style={{
            fontSize: "14px",
            color: theme?.hint_color ?? "#888",
            margin: "0 0 24px 0",
          }}
        >
          Connect your MetaMask wallet to place bets
        </p>

        {/* ------- Initializing ------- */}
        {flowState === "initializing" && (
          <p style={{ fontSize: "14px" }}>Initializing...</p>
        )}

        {/* ------- Ready: show Connect button ------- */}
        {flowState === "ready" && (
          <button style={buttonStyle} onClick={handleConnect}>
            Connect MetaMask
          </button>
        )}

        {/* ------- Connecting: waiting for MetaMask ------- */}
        {flowState === "connecting" && (
          <>
            <p style={{ fontSize: "14px" }}>
              Opening MetaMask...
            </p>
            <p
              style={{
                fontSize: "12px",
                color: theme?.hint_color ?? "#888",
                marginTop: "8px",
              }}
            >
              Approve the connection in MetaMask, then return here.
            </p>
          </>
        )}

        {/* ------- Connected: show address + Sign button ------- */}
        {flowState === "connected" && walletAddress && (
          <>
            <p style={{ fontSize: "14px", marginBottom: "4px" }}>
              Connected
            </p>
            <p
              style={{
                fontSize: "18px",
                fontWeight: 600,
                fontFamily: "monospace",
                margin: "4px 0 16px 0",
              }}
            >
              {truncateAddress(walletAddress)}
            </p>
            <p
              style={{
                fontSize: "13px",
                color: theme?.hint_color ?? "#888",
                marginBottom: "8px",
              }}
            >
              Sign a message to verify you own this wallet.
            </p>
            <button style={buttonStyle} onClick={handleSignAndSubmit}>
              Sign &amp; Connect
            </button>
          </>
        )}

        {/* ------- Signing ------- */}
        {flowState === "signing" && (
          <>
            <p style={{ fontSize: "14px" }}>
              Signing message...
            </p>
            <p
              style={{
                fontSize: "12px",
                color: theme?.hint_color ?? "#888",
                marginTop: "8px",
              }}
            >
              Confirm the signature in MetaMask, then return here.
            </p>
          </>
        )}

        {/* ------- Submitting ------- */}
        {flowState === "submitting" && (
          <p style={{ fontSize: "14px" }}>
            Saving wallet...
          </p>
        )}

        {/* ------- Success ------- */}
        {flowState === "success" && (
          <>
            <p style={{ fontSize: "40px", margin: "0 0 12px 0" }}>
              ✓
            </p>
            <p style={{ fontSize: "16px", fontWeight: 600 }}>
              Wallet connected!
            </p>
            {walletAddress && (
              <p
                style={{
                  fontSize: "14px",
                  fontFamily: "monospace",
                  color: theme?.hint_color ?? "#888",
                  marginTop: "4px",
                }}
              >
                {truncateAddress(walletAddress)}
              </p>
            )}
            <p
              style={{
                fontSize: "13px",
                color: theme?.hint_color ?? "#888",
                marginTop: "12px",
              }}
            >
              Closing...
            </p>
          </>
        )}

        {/* ------- Error ------- */}
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
            <button
              style={buttonStyle}
              onClick={() => {
                setErrorMessage(null);
                setFlowState(walletAddress ? "connected" : "ready");
              }}
            >
              Try Again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
