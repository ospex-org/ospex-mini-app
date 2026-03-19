"use client";

import { useEffect } from "react";

function logToServer(step: string, error: string, detail?: string) {
  fetch("/api/debug-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, status: "error", error, detail }),
  }).catch(() => {
    // Logging itself failed — nothing we can do
  });
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error-boundary] Uncaught render error:", error);
    logToServer(
      "error-boundary",
      error.message,
      error.stack ?? error.digest
    );
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
        backgroundColor: "#0a0a0a",
        color: "#f2f2f2",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "360px",
          backgroundColor: "#141414",
          borderRadius: "12px",
          padding: "32px 24px",
          textAlign: "center",
        }}
      >
        <p
          style={{
            fontSize: "14px",
            color: "#e94560",
            whiteSpace: "pre-wrap",
            marginBottom: "12px",
          }}
        >
          Something went wrong. Please go back to Telegram and try again.
        </p>
        <button
          onClick={reset}
          style={{
            width: "100%",
            padding: "14px 24px",
            borderRadius: "12px",
            border: "none",
            fontSize: "16px",
            fontWeight: 600,
            cursor: "pointer",
            backgroundColor: "#e94560",
            color: "#ffffff",
            marginTop: "16px",
          }}
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
