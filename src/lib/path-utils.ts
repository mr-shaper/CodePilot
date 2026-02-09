/**
 * Split a file path into segments, handling both / and \ separators.
 * Works in browser context without Node.js path module.
 */
export function splitPath(filepath: string): string[] {
  return filepath.split(/[/\\]/).filter(Boolean);
}

export function getBasename(filepath: string): string {
  const parts = splitPath(filepath);
  return parts[parts.length - 1] || filepath;
}

export function isWindowsPath(filepath: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(filepath);
}

export function getHomeHint(): string {
  const isWin = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  return isWin
    ? '%USERPROFILE%\\.claude\\commands\\ or .claude\\commands\\'
    : '~/.claude/commands/ or .claude/commands/';
}

export function getModifierKey(): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  return isMac ? '\u2318' : 'Ctrl';
}
