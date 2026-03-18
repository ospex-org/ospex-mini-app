"use client";

import { useEffect, useState } from "react";

function buildMetaMaskLink(linkToken: string) {
  const dappUrl = `https://ospex-mini-app.vercel.app?linkToken=${encodeURIComponent(linkToken)}`;
  return `https://link.metamask.io/dapp/${encodeURIComponent(dappUrl)}`;
}

export default function ConnectRedirectPage() {
  const [linkToken, setLinkToken] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("linkToken") ?? "";
    setLinkToken(token);

    if (!token) return;

    const appUrl = `https://ospex-mini-app.vercel.app?linkToken=${encodeURIComponent(token)}`;

    if (window.ethereum?.isMetaMask) {
      window.location.replace(appUrl);
    }
  }, []);

  const appUrl = linkToken
    ? `https://ospex-mini-app.vercel.app?linkToken=${encodeURIComponent(linkToken)}`
    : "https://ospex-mini-app.vercel.app";
  const metaMaskLink = linkToken ? buildMetaMaskLink(linkToken) : null;

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    display: "flex",
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
    textAlign: "center",
  };

  const buttonStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 24px",
    borderRadius: "12px",
    border: "none",
    fontSize: "16px",
    fontWeight: 600,
    textDecoration: "none",
    backgroundColor: "#e94560",
    color: "#ffffff",
    marginTop: "16px",
  };

  if (!linkToken) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h1 style={{ fontSize: "22px", margin: "0 0 12px 0" }}>Ospex Wallet</h1>
          <p style={{ fontSize: "14px", color: "#8c8c8c", margin: 0 }}>
            Missing link token. Go back to Telegram and try again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: "22px", margin: "0 0 8px 0" }}>Open MetaMask</h1>
        <p style={{ fontSize: "14px", color: "#8c8c8c", margin: "0 0 12px 0" }}>
          If Telegram opened this page in-app, use the button below to jump into MetaMask's browser.
        </p>
        <a href={metaMaskLink ?? appUrl} style={buttonStyle}>
          Open in MetaMask
        </a>
      </div>
    </div>
  );
}
