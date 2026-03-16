'use client';

import { useEffect, useState } from 'react';

// Declare Telegram WebApp global
declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe: {
          user?: {
            id: number;
            first_name: string;
            last_name?: string;
            username?: string;
          };
        };
        ready: () => void;
        close: () => void;
        expand: () => void;
        MainButton: {
          text: string;
          show: () => void;
          hide: () => void;
          onClick: (fn: () => void) => void;
          offClick: (fn: () => void) => void;
        };
        themeParams: {
          bg_color?: string;
          text_color?: string;
          hint_color?: string;
          button_color?: string;
          button_text_color?: string;
        };
      };
    };
  }
}

type AppState =
  | { step: 'loading' }
  | { step: 'existing'; walletAddress: string }
  | { step: 'creating' }
  | { step: 'done'; walletAddress: string }
  | { step: 'error'; message: string };

export default function WalletSetupPage() {
  const [state, setState] = useState<AppState>({ step: 'loading' });

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) {
      setState({ step: 'error', message: 'Please open this from Telegram.' });
      return;
    }

    // Tell Telegram we're ready and expand to full height
    tg.ready();
    tg.expand();

    // Start the auth + wallet creation flow
    runSetup(tg.initData)
      .then((result) => {
        if (result.existing) {
          setState({ step: 'existing', walletAddress: result.walletAddress });
        } else {
          setState({ step: 'done', walletAddress: result.walletAddress });
        }
      })
      .catch((err: unknown) => {
        console.error('Setup failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        if (stack) console.error('Stack:', stack);
        setState({ step: 'error', message });
      });
  }, []);

  // Wire up the Telegram MainButton for closing
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    if (state.step === 'done' || state.step === 'existing') {
      tg.MainButton.text = 'Back to Ospex Bot';
      tg.MainButton.show();
      const close = () => tg.close();
      tg.MainButton.onClick(close);
      return () => tg.MainButton.offClick(close);
    } else {
      tg.MainButton.hide();
    }
  }, [state.step]);

  return (
    <div style={{ maxWidth: 400, margin: '0 auto', textAlign: 'center', paddingTop: 40 }}>
      {/* Logo / Header */}
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>ospex</h1>
      <p style={{
        fontSize: 14,
        opacity: 0.6,
        marginBottom: 40,
      }}>
        peer-to-peer sports betting
      </p>

      {state.step === 'loading' && (
        <div>
          <Spinner />
          <p style={{ marginTop: 16 }}>Checking your account...</p>
        </div>
      )}

      {state.step === 'creating' && (
        <div>
          <Spinner />
          <p style={{ marginTop: 16 }}>Creating your wallet...</p>
          <p style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>
            This is a non-custodial wallet. Only you control your funds.
          </p>
        </div>
      )}

      {state.step === 'existing' && (
        <div>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Wallet already set up!</p>
          <WalletDisplay address={state.walletAddress} />
          <p style={{ fontSize: 13, opacity: 0.5, marginTop: 16 }}>
            You can close this and start betting.
          </p>
        </div>
      )}

      {state.step === 'done' && (
        <div>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Wallet created!</p>
          <WalletDisplay address={state.walletAddress} />
          <p style={{ fontSize: 13, opacity: 0.5, marginTop: 16 }}>
            Fund this address with USDC on Polygon to start betting.
            <br />
            You can close this and return to the bot.
          </p>
        </div>
      )}

      {state.step === 'error' && (
        <div>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Setup failed</p>
          <p style={{ fontSize: 13, opacity: 0.7 }}>{state.message}</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 24,
              padding: '12px 24px',
              borderRadius: 8,
              border: 'none',
              backgroundColor: 'var(--tg-theme-button-color, #5288c1)',
              color: 'var(--tg-theme-button-text-color, #ffffff)',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The core setup flow:
 * 1. Send initData to our backend for Telegram validation + Openfort auth
 * 2. If user already has wallet → return it
 * 3. If new user → use Openfort JS SDK to create embedded wallet
 * 4. Save wallet address to Firestore
 */
async function runSetup(initData: string): Promise<{
  walletAddress: string;
  existing: boolean;
}> {
  // Step 1: Authenticate via our backend
  console.log('[setup] Step 1: Authenticating with backend...');
  const authRes = await fetch('/api/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });

  if (!authRes.ok) {
    const err = await authRes.json();
    console.error('[setup] Auth failed:', authRes.status, err);
    throw new Error(err.error || 'Authentication failed');
  }

  const authData = await authRes.json();
  console.log('[setup] Auth success:', { status: authData.status, playerId: authData.playerId });

  // Step 2: Already has wallet
  if (authData.status === 'existing') {
    return {
      walletAddress: authData.walletAddress,
      existing: true,
    };
  }

  // Step 3: Create wallet with Openfort JS SDK
  console.log('[setup] Step 3: Loading Openfort JS SDK...');
  const {
    default: Openfort,
    EmbeddedState,
    ThirdPartyOAuthProvider,
    TokenType,
  } = await import('@openfort/openfort-js');

  console.log('[setup] Creating encryption session...');
  const encryptionSession = await getEncryptionSession();

  const openfort = new Openfort({
    baseConfiguration: {
      publishableKey: process.env.NEXT_PUBLIC_OPENFORT_PUBLISHABLE_KEY!,
    },
    shieldConfiguration: {
      shieldPublishableKey: process.env.NEXT_PUBLIC_SHIELD_PUBLISHABLE_KEY!,
      shieldEncryptionKey: encryptionSession,
    },
  });

  console.log('[setup] Calling authenticateWithThirdPartyProvider...');
  await openfort.authenticateWithThirdPartyProvider({
    provider: ThirdPartyOAuthProvider.CUSTOM,
    token: authData.openfortToken,
    tokenType: TokenType.CUSTOM_TOKEN,
  });
  console.log('[setup] Auth with Openfort SDK complete');

  const embeddedState = openfort.getEmbeddedState();
  console.log('[setup] Embedded state:', embeddedState);

  if (embeddedState !== EmbeddedState.READY) {
    console.log('[setup] Configuring embedded signer...');
    await openfort.configureEmbeddedSigner();
    console.log('[setup] Embedded signer configured');
  }

  console.log('[setup] Getting wallet address...');
  const accounts = await openfort.getEthereumProvider().request({
    method: 'eth_accounts',
  }) as string[];
  const walletAddress = accounts[0];
  console.log('[setup] Wallet address:', walletAddress);

  if (!walletAddress) {
    throw new Error('Failed to get wallet address');
  }

  // Step 4: Save to Firestore
  console.log('[setup] Step 4: Saving wallet to Firestore...');
  await fetch('/api/save-wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telegramUserId: authData.telegramUserId,
      walletAddress,
      openfortPlayerId: authData.playerId,
    }),
  });

  return {
    walletAddress,
    existing: false,
  };
}

/**
 * Get a Shield encryption session from our backend.
 * Used for automatic wallet recovery.
 */
async function getEncryptionSession(): Promise<string> {
  const res = await fetch('/api/create-encryption-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) throw new Error('Failed to create encryption session');

  const data = await res.json();
  return data.session;
}

/** Simple spinner component */
function Spinner() {
  return (
    <div style={{
      width: 40,
      height: 40,
      border: '3px solid rgba(255,255,255,0.2)',
      borderTopColor: 'var(--tg-theme-button-color, #5288c1)',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      margin: '0 auto',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/** Wallet address display with truncation */
function WalletDisplay({ address }: { address: string }) {
  const truncated = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return (
    <div style={{
      backgroundColor: 'rgba(255,255,255,0.08)',
      borderRadius: 12,
      padding: '12px 16px',
      fontFamily: 'monospace',
      fontSize: 14,
      marginTop: 8,
    }}>
      {truncated}
    </div>
  );
}
