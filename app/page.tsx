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
  | "awaiting_launch"
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

function normalizeMetaMaskLink(link: string): string {
  if (link.startsWith("metamask://")) {
    return `https://metamask.app.link/${link.slice("metamask://".length)}`;
  }
  return link;
}

function toDirectScheme(url: string): string {
  if (url.startsWith("https://metamask.app.link/")) {
    return `metamask://${url.slice("https://metamask.app.link/".length)}`;
  }
  return url;
}

/**
 * Module-level callbacks for debug logging and deeplink capture.
 * Uses the same ref-based pattern as the previous onDebugUrl.
 */
let addLogCallback: ((msg: string) => void) | null = null;
let onDeeplinkUrl: ((url: string) => void) | null = null;

function addLog(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  addLogCallback?.(`[${ts}] ${msg}`);
}

/**
 * Modified: Instead of immediately navigating, capture the URL
 * and let the user pick a launch strategy.
 */
function openLinkFromTelegram(url: string): void {
  const normalized = normalizeMetaMaskLink(url);
  addLog(`openDeeplink received URL: ${normalized}`);
  addLog("Pausing for launch strategy selection");
  onDeeplinkUrl?.(normalized);
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

  const [logs, setLogs] = useState<string[]>([]);
  const [pendingDeeplinkUrl, setPendingDeeplinkUrl] = useState<string | null>(null);

  const sdkRef = useRef<MetaMaskSDK | null>(null);
  const initCalledRef = useRef(false);
  const logPanelRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll log panel on new entries
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [logs]);

  // ----------------------------------------------------------
  // Initialize Telegram + MetaMask SDK + logging
  // ----------------------------------------------------------

  useEffect(() => {
    if (initCalledRef.current) return;
    initCalledRef.current = true;

    // Register callbacks
    addLogCallback = (msg: string) => setLogs((prev) => [...prev, msg]);
    onDeeplinkUrl = (url: string) => {
      setPendingDeeplinkUrl(url);
      setFlowState("awaiting_launch");
    };

    // --- Page load diagnostics ---
    addLog(`userAgent: ${navigator.userAgent}`);
    addLog(`Telegram.WebApp exists: ${!!window.Telegram?.WebApp}`);
    addLog(`initData present: ${!!window.Telegram?.WebApp?.initData}`);

    const tg = window.Telegram?.WebApp;

    if (tg) {
      tg.ready();
      tg.expand();
      setTheme(tg.themeParams);
    }

    const userId = tg?.initDataUnsafe?.user?.id ?? null;
    setTelegramUserId(userId);
    addLog(`Telegram user ID: ${userId ?? "none"}`);

    if (!userId) {
      setErrorMessage(
        "Could not identify Telegram user. Please open this app from the Ospex bot."
      );
      setFlowState("error");
      return;
    }

    // ----------------------------------------------------------
    // Install window.open safety net BEFORE SDK init
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
        addLog(`window.open intercepted: ${raw.slice(0, 120)}`);

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
      checkInstallationImmediately: false,
    });

    sdkRef.current = sdk;
    setFlowState("ready");
    addLog("SDK initialized, ready to connect");

    // ----------------------------------------------------------
    // Visibility change listener
    // ----------------------------------------------------------
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        addLog("Page visibility: visible — checking SDK state...");
        const provider = sdk.getProvider();
        if (provider) {
          addLog("Provider exists, requesting eth_accounts...");
          provider
            .request({ method: "eth_accounts" })
            .then((accounts) => {
              addLog(`eth_accounts result: ${JSON.stringify(accounts)}`);
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              addLog(`eth_accounts error: ${msg}`);
            });
        } else {
          addLog("No provider available after resume");
        }
      } else {
        addLog("Page visibility: hidden");
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (originalOpen) {
        window.open = originalOpen;
      }
      document.removeEventListener("visibilitychange", handleVisibility);
      addLogCallback = null;
      onDeeplinkUrl = null;
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
    addLog("SDK connect() called");

    try {
      const accounts = (await sdk.connect()) as string[] | undefined;

      addLog(`connect() resolved: ${JSON.stringify(accounts)}`);

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from MetaMask");
      }

      const address = accounts[0];
      setWalletAddress(address);
      setFlowState("connected");
      addLog(`Connected: ${address}`);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect MetaMask";
      const stack = err instanceof Error ? err.stack : undefined;
      addLog(`connect() error: ${msg}`);
      if (stack) addLog(`Stack: ${stack}`);
      setErrorMessage(msg);
      setFlowState("error");
    }
  }, []);

  // ----------------------------------------------------------
  // Launch strategy handlers
  // ----------------------------------------------------------

  const handleLaunchAppLink = useCallback(() => {
    if (!pendingDeeplinkUrl) return;
    const url = normalizeMetaMaskLink(pendingDeeplinkUrl);
    addLog(`Launching via App Link (openLink): ${url}`);
    window.Telegram?.WebApp?.openLink(url);
  }, [pendingDeeplinkUrl]);

  const handleLaunchDirectScheme = useCallback(() => {
    if (!pendingDeeplinkUrl) return;
    const url = toDirectScheme(pendingDeeplinkUrl);
    addLog(`Launching via Direct Scheme (openLink): ${url}`);
    window.Telegram?.WebApp?.openLink(url);
  }, [pendingDeeplinkUrl]);

  const handleLaunchLocationHref = useCallback(() => {
    if (!pendingDeeplinkUrl) return;
    const url = normalizeMetaMaskLink(pendingDeeplinkUrl);
    addLog(`Launching via location.href: ${url}`);
    window.location.href = url;
  }, [pendingDeeplinkUrl]);

  const handleCopyUrl = useCallback(async () => {
    if (!pendingDeeplinkUrl) return;
    addLog(`Copying URL to clipboard: ${pendingDeeplinkUrl}`);
    try {
      await navigator.clipboard.writeText(pendingDeeplinkUrl);
      addLog("Copied to clipboard");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(`Clipboard error: ${msg}`);
    }
  }, [pendingDeeplinkUrl]);

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

      const signature = (await provider.request({
        method: "personal_sign",
        params: [
          `0x${Buffer.from(message, "utf8").toString("hex")}`,
          walletAddress,
        ],
      })) as string;

      addLog("Signature obtained");
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
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.error ?? `Server error: ${response.status}`
        );
      }

      setFlowState("success");
      addLog("Wallet connected successfully");

      setTimeout(() => {
        window.Telegram?.WebApp?.close();
      }, 2500);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to sign or submit wallet connection";
      addLog(`Sign/submit error: ${msg}`);
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
    justifyContent: "flex-start",
    padding: "24px 24px 280px 24px",
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

  const launchBtnBase: React.CSSProperties = {
    width: "100%",
    padding: "12px 16px",
    borderRadius: "10px",
    border: "none",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    color: "#ffffff",
    marginTop: "8px",
    textAlign: "left" as const,
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

        {/* ------- Connecting: waiting for openDeeplink ------- */}
        {flowState === "connecting" && (
          <>
            <p style={{ fontSize: "14px" }}>
              Starting SDK connection...
            </p>
            <p
              style={{
                fontSize: "12px",
                color: theme?.hint_color ?? "#888",
                marginTop: "8px",
              }}
            >
              Waiting for deeplink URL from SDK...
            </p>
          </>
        )}

        {/* ------- Awaiting Launch: show 4 strategy buttons ------- */}
        {flowState === "awaiting_launch" && pendingDeeplinkUrl && (
          <>
            <p style={{ fontSize: "14px", marginBottom: "4px", fontWeight: 600 }}>
              Pick a launch strategy:
            </p>
            <p
              style={{
                fontSize: "11px",
                color: theme?.hint_color ?? "#888",
                marginBottom: "12px",
                wordBreak: "break-all",
                fontFamily: "monospace",
              }}
            >
              URL: {pendingDeeplinkUrl.slice(0, 80)}...
            </p>

            <button
              style={{ ...launchBtnBase, backgroundColor: "#2563eb" }}
              onClick={handleLaunchAppLink}
            >
              App Link
              <span style={{ display: "block", fontSize: "11px", fontWeight: 400, opacity: 0.8 }}>
                openLink(https://metamask.app.link/...)
              </span>
            </button>

            <button
              style={{ ...launchBtnBase, backgroundColor: "#d97706" }}
              onClick={handleLaunchDirectScheme}
            >
              Direct Scheme
              <span style={{ display: "block", fontSize: "11px", fontWeight: 400, opacity: 0.8 }}>
                openLink(metamask://...)
              </span>
            </button>

            <button
              style={{ ...launchBtnBase, backgroundColor: "#059669" }}
              onClick={handleLaunchLocationHref}
            >
              location.href
              <span style={{ display: "block", fontSize: "11px", fontWeight: 400, opacity: 0.8 }}>
                window.location.href = app.link URL
              </span>
            </button>

            <button
              style={{ ...launchBtnBase, backgroundColor: "#6b7280" }}
              onClick={handleCopyUrl}
            >
              Copy URL
              <span style={{ display: "block", fontSize: "11px", fontWeight: 400, opacity: 0.8 }}>
                Copy raw SDK URL to clipboard
              </span>
            </button>
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

      {/* ============================================================ */}
      {/* Debug Log Panel — fixed at bottom */}
      {/* ============================================================ */}
      <div
        ref={logPanelRef}
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: "40vh",
          overflowY: "auto",
          backgroundColor: "#1a1a1a",
          padding: "8px 10px",
          fontFamily: "monospace",
          fontSize: "11px",
          lineHeight: "1.5",
          color: "#a0ffa0",
          borderTop: "1px solid #333",
          zIndex: 9999,
        }}
      >
        <p style={{ margin: "0 0 4px 0", fontWeight: 600, color: "#fff", fontSize: "12px" }}>
          DEBUG LOG
        </p>
        {logs.length === 0 ? (
          <p style={{ margin: 0, color: "#666" }}>Waiting for events...</p>
        ) : (
          logs.map((entry, i) => (
            <p key={i} style={{ margin: 0, wordBreak: "break-all" }}>
              {entry}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
