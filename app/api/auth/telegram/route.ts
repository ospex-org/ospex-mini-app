import { NextRequest, NextResponse } from 'next/server';
import { validateInitData } from '@/lib/telegram';
import { authenticateTelegramUser } from '@/lib/openfort-server';
import { getBotUser } from '@/lib/firebase';

export async function POST(request: NextRequest) {
  try {
    const { initData } = await request.json();
    
    if (!initData) {
      return NextResponse.json({ error: 'initData is required' }, { status: 400 });
    }
    
    // Step 1: Validate that the initData actually came from Telegram
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    
    const { valid, user } = validateInitData(initData, botToken);
    
    if (!valid || !user) {
      return NextResponse.json({ error: 'Invalid Telegram data' }, { status: 401 });
    }
    
    const telegramUserId = user.id.toString();
    
    // Step 2: Check if user already has a wallet
    const existingUser = await getBotUser(telegramUserId);
    if (existingUser) {
      return NextResponse.json({
        status: 'existing',
        walletAddress: existingUser.walletAddress,
        telegramUserId,
      });
    }
    
    // Step 3: Authenticate with Openfort (creates player if needed)
    const { playerId, token } = await authenticateTelegramUser(telegramUserId);
    
    return NextResponse.json({
      status: 'new',
      telegramUserId,
      playerId,
      openfortToken: token,
    });
    
  } catch (error) {
    console.error('Telegram auth error:', error);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
