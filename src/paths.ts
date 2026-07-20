import * as fsp from 'node:fs/promises';

export function normPath(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function isUnder(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  if (p === '/') {
    return c.startsWith('/');
  }
  return c === p || c.startsWith(`${p}/`);
}

export async function realpathSafe(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

export function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
