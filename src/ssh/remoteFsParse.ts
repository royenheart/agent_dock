export interface LsEntry {
  name: string;
  isDir: boolean;
}

/** 解析 `ls -1Ap --color=never` 输出：/ 目录、@ 符号链接、* 可执行、= socket、| fifo、% whiteout。 */
export function parseLsAp(output: string): LsEntry[] {
  const out: LsEntry[] = [];
  for (const line of output.split('\n')) {
    const s = line.trimEnd();
    if (!s || s === './' || s === '../') {
      continue;
    }
    const last = s.slice(-1);
    if (last === '/') {
      out.push({ name: s.slice(0, -1), isDir: true });
    } else if (last === '@' || last === '*' || last === '=' || last === '|' || last === '%') {
      out.push({ name: s.slice(0, -1), isDir: false });
    } else {
      out.push({ name: s, isDir: false });
    }
  }
  return out;
}

export interface RemoteStatInfo {
  kind: 'directory' | 'file' | 'link' | 'other';
  size: number;
  mtimeMs: number;
}

/** 解析 `stat -c '%F|%s|%Y'` 输出。 */
export function parseStatFs(output: string): RemoteStatInfo | undefined {
  const parts = output.trim().split('|');
  if (parts.length < 3) {
    return undefined;
  }
  const desc = parts[0].toLowerCase();
  const size = Number(parts[1]);
  const mtimeSec = Number(parts[2]);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) {
    return undefined;
  }
  const kind = desc.includes('directory')
    ? 'directory'
    : desc.includes('regular')
      ? 'file'
      : desc.includes('symbolic link')
        ? 'link'
        : 'other';
  return { kind, size, mtimeMs: Math.round(mtimeSec * 1000) };
}

export function joinRemotePath(base: string, name: string): string {
  return base.endsWith('/') ? base + name : `${base}/${name}`;
}
