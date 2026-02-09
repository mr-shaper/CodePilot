import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ErrorResponse } from '@/types';

let driveCache: { drives: string[]; timestamp: number } | null = null;
const DRIVE_CACHE_TTL = 30000; // 30 seconds

async function getWindowsDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return [];

  // Return cached result if fresh
  if (driveCache && Date.now() - driveCache.timestamp < DRIVE_CACHE_TTL) {
    return driveCache.drives;
  }

  const checks: Promise<string | null>[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = String.fromCharCode(i) + ':\\';
    checks.push(
      new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 500); // 500ms timeout per drive
        fs.access(drive, (err) => {
          clearTimeout(timer);
          resolve(err ? null : drive);
        });
      })
    );
  }

  const results = await Promise.all(checks);
  const drives = results.filter((d): d is string => d !== null);

  // Cache result
  driveCache = { drives, timestamp: Date.now() };
  return drives;
}

// List only directories for folder browsing (no safety restriction since user is choosing where to work)
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dir = searchParams.get('dir') || os.homedir();

  const resolvedDir = path.resolve(dir);

  if (!fs.existsSync(resolvedDir)) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Directory does not exist' },
      { status: 404 }
    );
  }

  try {
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(resolvedDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const drives = await getWindowsDrives();

    return NextResponse.json({
      current: resolvedDir,
      parent: path.dirname(resolvedDir) !== resolvedDir ? path.dirname(resolvedDir) : null,
      directories,
      drives,
    });
  } catch {
    return NextResponse.json<ErrorResponse>(
      { error: 'Cannot read directory' },
      { status: 500 }
    );
  }
}
