import { NextRequest, NextResponse } from 'next/server';
import { createEncryptionSession } from '@/lib/openfort-server';

export async function POST(request: NextRequest) {
  try {
    // TODO: Add auth check here - verify the request comes from
    // an authenticated session (the frontend should pass the Openfort token)
    
    const session = await createEncryptionSession();
    
    return NextResponse.json({ session });
    
  } catch (error) {
    console.error('[create-encryption-session] Failed:', error instanceof Error ? { message: error.message, stack: error.stack } : error);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}
