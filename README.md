# ospex-mini-app

Telegram Mini App for one-time wallet creation via Openfort embedded wallets.

Users open this from the ospex-bot `/start` command. It creates a non-custodial
wallet (keys generated client-side, split via MPC) and writes the
`telegramUserId → walletAddress` mapping to Firestore. After setup, all
interaction happens through the Telegram bot — users never need to open this
mini-app again.

## Architecture

```
User in Telegram
    │
    ├── /start → bot checks Firestore for existing wallet
    │           └── no wallet → sends inline button → opens this mini-app
    │
    ├── Mini-app loads in Telegram WebView
    │   ├── Gets initData from Telegram SDK
    │   ├── POST /api/auth/telegram (validates initData, creates Openfort player)
    │   ├── Openfort JS SDK creates embedded wallet (client-side key generation)
    │   ├── POST /api/save-wallet (writes mapping to Firestore)
    │   └── Shows success → user closes → back to bot
    │
    └── Bot now knows user's wallet → single-word betting works
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env.local
```

Fill in all values from:
- **Openfort Dashboard** → API Keys, Shield keys
- **Telegram BotFather** → Bot token
- **Firebase Console** → Service account JSON

### 3. Configure Telegram BotFather

Run `/newapp` with BotFather to create a Mini App linked to your bot.
Set the Mini App URL to your deployment URL (or ngrok for local dev).

### 4. Local development
```bash
# Start the dev server
npm run dev

# Expose via ngrok for Telegram to reach
ngrok http 3000
```

Update BotFather's Mini App URL with the ngrok HTTPS URL.

### 5. Deploy to Vercel
```bash
# Connect repo to Vercel, add env vars in Vercel dashboard
vercel deploy
```

After deploy:
- Update BotFather Mini App URL to production Vercel URL
- Update Openfort Dashboard → Configuration → Providers → Custom auth URL
- Update Openfort Dashboard → Configuration → Security → Web Origins

## Files

| File | Purpose |
|------|---------|
| `app/page.tsx` | Main UI — wallet creation flow in Telegram WebView |
| `app/api/auth/telegram/route.ts` | Validates Telegram initData, authenticates with Openfort |
| `app/api/create-encryption-session/route.ts` | Shield encryption session for wallet recovery |
| `app/api/save-wallet/route.ts` | Writes telegramUserId → walletAddress to Firestore |
| `lib/telegram.ts` | Telegram initData HMAC-SHA256 validation |
| `lib/openfort-server.ts` | Server-side Openfort client (player creation, auth) |
| `lib/firebase.ts` | Firebase Admin SDK for Firestore writes |

## SDK Notes

The Openfort JS SDK calls in `page.tsx` may need adjustment based on the
current version of `@openfort/openfort-js`. The key methods are:
- `new Openfort(config)` — initialize with publishable key + Shield config
- `authenticateWithThirdPartyProvider()` — auth with custom token
- `getEmbeddedState()` — check if wallet exists
- `configureEmbeddedSigner()` — create the wallet (key gen + MPC split)
- `getEthereumProvider()` — get the wallet address

Consult https://www.openfort.io/docs for the latest SDK API.
