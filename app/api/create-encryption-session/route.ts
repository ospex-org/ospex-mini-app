import { NextRequest, NextResponse } from 'next/server';
import { createEncryptionSession } from '@/lib/openfort-server';

export async function POST(request: NextRequest) {
  try {
    // TODO: Add auth check here - verify the request comes from
    // an authenticated session (the frontend should pass the Openfort token)
    
    const session = await createEncryptionSession();
    
    return NextResponse.json({ session });
    
  } catch (error) {
    console.error('Encryption session error:', error);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}
