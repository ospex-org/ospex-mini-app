import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';

let app: App;
let db: Firestore;

function getFirebaseAdmin(): Firestore {
  if (!db) {
    if (getApps().length === 0) {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!projectId || !clientEmail || !privateKey) {
        throw new Error(
          'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are required'
        );
      }

      app = initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
      });
    } else {
      app = getApps()[0];
    }

    db = getFirestore(app);
  }

  return db;
}

/**
 * Write the telegramUserId → walletAddress mapping to Firestore.
 * This is called once per user, ever.
 */
export async function saveBotUser(params: {
  telegramUserId: string;
  walletAddress: string;
  openfortPlayerId: string;
}) {
  const db = getFirebaseAdmin();
  
  await db.collection('botUsers').doc(params.telegramUserId).set({
    walletAddress: params.walletAddress,
    openfortPlayerId: params.openfortPlayerId,
    createdAt: new Date(),
    chain: 'polygon-amoy', // switch to 'polygon' for mainnet
  });
}

/**
 * Check if a user already has a wallet.
 */
export async function getBotUser(telegramUserId: string) {
  const db = getFirebaseAdmin();
  const doc = await db.collection('botUsers').doc(telegramUserId).get();
  
  if (!doc.exists) return null;
  return doc.data();
}
