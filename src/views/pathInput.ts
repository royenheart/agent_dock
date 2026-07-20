export function expandTilde(value: string, homeDir: string): string {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/')) {
    return homeDir.replace(/\/$/, '') + value.slice(1);
  }
  return value;
}

export function splitPathInput(value: string): { base: string; segment: string } {
  if (value.endsWith('/')) {
    return { base: value, segment: '' };
  }
  const idx = value.lastIndexOf('/');
  return { base: value.slice(0, idx + 1) || '/', segment: value.slice(idx + 1) };
}

export function parentDir(base: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx + 1);
}
