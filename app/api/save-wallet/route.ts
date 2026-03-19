import { NextRequest, NextResponse } from 'next/server';
import { saveBotUser } from '@/lib/firebase';

export async function POST(request: NextRequest) {
  try {
    const { telegramUserId, walletAddress, openfortPlayerId } = await request.json();
    
    if (!telegramUserId || !walletAddress || !openfortPlayerId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    
    await saveBotUser({
      telegramUserId,
      walletAddress,
      openfortPlayerId,
    });
    
    return NextResponse.json({ success: true });
    
  } catch (error) {
    console.error('[save-wallet] Failed:', error instanceof Error ? { message: error.message, stack: error.stack } : error);
    return NextResponse.json({ error: 'Failed to save wallet' }, { status: 500 });
  }
}
