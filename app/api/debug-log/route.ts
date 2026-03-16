import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { step, status, error, detail } = body as {
      step: string;
      status: string;
      error?: string;
      detail?: string;
    };

    const timestamp = new Date().toISOString();

    if (status === 'error') {
      console.error(`[debug-log] ${timestamp} | STEP: ${step} | STATUS: ${status} | ERROR: ${error ?? 'unknown'}${detail ? ` | DETAIL: ${detail}` : ''}`);
    } else {
      console.log(`[debug-log] ${timestamp} | STEP: ${step} | STATUS: ${status}${detail ? ` | DETAIL: ${detail}` : ''}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[debug-log] Failed to parse log request:', err);
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
