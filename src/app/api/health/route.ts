import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    getDb(); // This triggers better-sqlite3 native module loading
    return NextResponse.json({ status: 'ok', db: true });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', db: false, error: error instanceof Error ? error.message : 'Database unavailable' },
      { status: 503 }
    );
  }
}
