import { execFileSync, execFile, execSync } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/**
 * Whether the given binary path requires shell execution.
 * On Windows, .cmd/.bat files cannot be executed directly by execFileSync.
 */
function needsShell(binPath: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(binPath);
}

/**
 * Execute a binary and return stdout. Handles Windows .cmd files with spaces in paths.
 * execFileSync with shell:true doesn't quote paths, so .cmd files in paths with spaces fail.
 * We use execSync with explicit quoting for .cmd/.bat on Windows.
 */
function execBinary(binPath: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }): string {
  if (needsShell(binPath)) {
    // Use execSync with quoted path to handle spaces in Windows paths
    const quotedCmd = `"${binPath}" ${args.join(' ')}`;
    return execSync(quotedCmd, { timeout: options.timeout, stdio: 'pipe', ...(options.env ? { env: options.env } : {}) }).toString();
  }
  return execFileSync(binPath, args, { timeout: options.timeout, stdio: 'pipe', shell: false, ...(options.env ? { env: options.env } : {}) }).toString();
}

/**
 * Normalize a stdio MCP server command for cross-platform compatibility.
 * On Windows, certain commands (npx, npm, etc.) are actually .cmd wrappers
 * and require shell execution to resolve correctly.
 */
export function normalizeStdioCommand(command: string): { command: string; shell: boolean } {
  if (process.platform !== 'win32') return { command, shell: false };
  // .cmd/.bat files need shell execution
  if (/\.(cmd|bat)$/i.test(command)) return { command, shell: true };
  // Common Node.js tools need shell on Windows to resolve .cmd wrappers
  if (['npx', 'npm', 'node', 'pnpm', 'yarn', 'bunx'].includes(command)) {
    return { command, shell: true };
  }
  return { command, shell: false };
}

/**
 * Extra PATH directories to search for Claude CLI and other tools.
 */
export function getExtraPathDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.nvm', 'current', 'bin'),
    ];
  }
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
  ];
}

/**
 * Claude CLI candidate installation paths.
 */
export function getClaudeCandidatePaths(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exts = ['.cmd', '.exe', '.bat', ''];
    const baseDirs = [
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.local', 'bin'),
    ];
    const candidates: string[] = [];
    for (const dir of baseDirs) {
      for (const ext of exts) {
        candidates.push(path.join(dir, 'claude' + ext));
      }
    }
    return candidates;
  }
  return [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'bin', 'claude'),
  ];
}

/**
 * Build an expanded PATH string with extra directories, deduped and filtered.
 * - Filters out non-existent directories
 * - Case-insensitive dedup on Windows (paths are case-insensitive there)
 * - Handles paths with spaces correctly
 */
export function getExpandedPath(): string {
  const current = process.env.PATH || '';
  const currentParts = current.split(path.delimiter).filter(Boolean);

  // On Windows, paths are case-insensitive so normalise the dedup key
  const normalizeKey = isWindows ? (p: string) => p.toLowerCase() : (p: string) => p;
  const seen = new Set(currentParts.map(normalizeKey));
  const parts = [...currentParts];

  for (const p of getExtraPathDirs()) {
    const key = normalizeKey(p);
    if (p && !seen.has(key)) {
      parts.push(p);
      seen.add(key);
    }
  }

  // Filter to only existing directories
  const validParts = parts.filter(p => {
    try { return p && fs.existsSync(p); } catch { return false; }
  });

  return validParts.join(path.delimiter);
}

/**
 * Find and validate the Claude CLI binary.
 * Tests each candidate with --version before returning.
 */
export function findClaudeBinary(): string | undefined {
  // Try known candidate paths first
  for (const p of getClaudeCandidatePaths()) {
    try {
      execBinary(p, ['--version'], { timeout: 3000 });
      return p;
    } catch {
      // not found, try next
    }
  }

  // Fallback: use `where` (Windows) or `which` (Unix) with expanded PATH
  try {
    const cmd = isWindows ? 'where' : '/usr/bin/which';
    const args = isWindows ? ['claude'] : ['claude'];
    const result = execFileSync(cmd, args, {
      timeout: 3000,
      stdio: 'pipe',
      env: { ...process.env, PATH: getExpandedPath() },
      shell: isWindows,
    });
    // where.exe may return multiple lines; try each with --version validation
    const lines = result.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        execBinary(candidate, ['--version'], { timeout: 3000 });
        return candidate;
      } catch {
        continue;
      }
    }
  } catch {
    // not found
  }

  return undefined;
}

/**
 * Execute claude --version and return the version string.
 * Handles .cmd shell execution on Windows.
 */
export async function getClaudeVersion(claudePath: string): Promise<string | null> {
  try {
    if (needsShell(claudePath)) {
      // Use execSync with quoted path to handle spaces in Windows paths
      const quotedCmd = `"${claudePath}" --version`;
      const result = execSync(quotedCmd, {
        timeout: 5000,
        stdio: 'pipe',
        env: { ...process.env, PATH: getExpandedPath() } as NodeJS.ProcessEnv,
      });
      return result.toString().trim() || null;
    }
    const { stdout } = await execFileAsync(claudePath, ['--version'], {
      timeout: 5000,
      env: { ...process.env, PATH: getExpandedPath() },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Find Git Bash (bash.exe) on Windows.
 * Returns the path to bash.exe or null if not found.
 */
export function findGitBash(): string | null {
  // 1. Check user-specified environment variable
  const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // 2. Check common installation paths
  const home = os.homedir();
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    // Scoop installation
    path.join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    // Chocolatey installation
    'C:\\ProgramData\\chocolatey\\lib\\git\\tools\\bin\\bash.exe',
    // MSYS2
    'C:\\msys64\\usr\\bin\\bash.exe',
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 3. Try to locate git.exe via `where git` and derive bash.exe path
  try {
    const result = execFileSync('where', ['git'], {
      timeout: 3000,
      stdio: 'pipe',
      shell: true,
    });
    const lines = result.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      // git.exe is typically at <GitDir>\cmd\git.exe or <GitDir>\bin\git.exe
      const gitDir = path.dirname(path.dirname(gitExe));
      const bashPath = path.join(gitDir, 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) {
        return bashPath;
      }
    }
  } catch {
    // where git failed or timed out
  }

  // 4. Try registry as last resort
  try {
    const regResult = execFileSync('reg', [
      'query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'
    ], { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = regResult.match(/InstallPath\s+REG_SZ\s+(.+)/);
    if (match) {
      const bashPath = path.join(match[1].trim(), 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) return bashPath;
    }
  } catch {
    // registry query failed
  }

  return null;
}
