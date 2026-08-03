import { shq } from './sshArgs';
import { parseLsAp, type LsEntry } from './remoteFsParse';

/**
 * 远程文件轮询的纯函数部分（不依赖 vscode，供单测直接断言）。
 * 轮询脚本把同一服务器上的所有 watcher 合并成一条 ssh 调用：
 *  - 文件行：`S|<path>|<size>|<mtimeSec>`（stat 失败则无行）
 *  - 目录块：`D|<path>` 后跟 `ls -1Ap` 输出行，`E|<path>` 收块；
 *    ls 失败输出 `M|<path>`（missing），解析为 null 快照
 * 分隔符选择：解析一律从行尾按固定字段反推（size/mtime 是纯数字），
 * 路径本身允许包含 '|'；块边界用精确匹配 `E|<path>`/`M|<path>`（绝对路径
 * 含 '/'，目录条目名不可能与整行相等），文件名以 S|/D|/E|/M| 开头不再干扰。
 */

/** 文件指纹：mtime（秒）+ size，用于检测内容变化。 */
export interface FileFingerprint {
  size: number;
  mtimeSec: number;
}

export type PollSnapshot = FileFingerprint | LsEntry[] | null;

export interface PollTarget {
  path: string;
  isDir: boolean;
}

export function buildPollScript(targets: readonly PollTarget[]): string {
  const seen = new Set<string>();
  const files: string[] = [];
  const dirs: string[] = [];
  for (const t of targets) {
    if (seen.has(t.path)) {
      continue;
    }
    seen.add(t.path);
    (t.isDir ? dirs : files).push(t.path);
  }
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(
      `for p in ${files.map((p) => shq(p)).join(' ')}; do s=$(stat -c '%s|%Y' -- "$p" 2>/dev/null) && printf 'S|%s|%s\\n' "$p" "$s"; done`,
    );
  }
  for (const d of dirs) {
    parts.push(`printf 'D|%s\\n' ${shq(d)}`);
    parts.push(`ls -1Ap --color=never -- ${shq(d)} 2>/dev/null || printf 'M|%s\\n' ${shq(d)}`);
    parts.push(`printf 'E|%s\\n' ${shq(d)}`);
  }
  // stat/ls 失败时退出码非 0，会误导 execRemote 认为整轮轮询失败而跳过；
  // 缺失条目本就该静默处理（下一轮保持缺失即可），因此强制成功退出
  parts.push('exit 0');
  return parts.join('\n');
}

export function parsePollOutput(output: string): Map<string, PollSnapshot> {
  const out = new Map<string, PollSnapshot>();
  const lines = output.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('S|')) {
      // 从右往左取最后两个 '|' 分隔的 size/mtime，中间剩余（可能含 '|'）是路径
      const rest = line.slice(2);
      const last = rest.lastIndexOf('|');
      const prev = last > 0 ? rest.lastIndexOf('|', last - 1) : -1;
      if (prev <= 0) {
        out.set(rest, null); // 字段数不足：无法解析
      } else {
        const path = rest.slice(0, prev);
        const size = Number(rest.slice(prev + 1, last));
        const mtimeSec = Number(rest.slice(last + 1));
        out.set(path, Number.isFinite(size) && Number.isFinite(mtimeSec) ? { size, mtimeSec } : null);
      }
    } else if (line.startsWith('D|')) {
      const path = line.slice(2);
      const endFile = `E|${path}`;
      const endMissing = `M|${path}`;
      const block: string[] = [];
      for (i++; i < lines.length; i++) {
        const l = lines[i].trimEnd();
        if (l === endFile || l === endMissing) {
          i--; // 回退，让外层循环处理收块/缺失标记行
          break;
        }
        if (l) {
          block.push(l);
        }
      }
      out.set(path, parseLsAp(block.join('\n')));
    } else if (line.startsWith('M|')) {
      out.set(line.slice(2), null);
    }
    i++;
  }
  return out;
}

/** 解析目录轮询的 `path|mtime` 行（mtime 为最后一个 '|' 后的整数，path 可含 '|'）。 */
export function parseDirMtimeLine(line: string): { path: string; mtimeSec: number } | undefined {
  const sep = line.lastIndexOf('|');
  if (sep <= 0) {
    return undefined;
  }
  const path = line.slice(0, sep);
  const mtimeSec = Number(line.slice(sep + 1));
  return Number.isFinite(mtimeSec) ? { path, mtimeSec } : undefined;
}

/** 超过该大小的远程文件不预览（与 RemoteFsProvider.MAX_PREVIEW_BYTES 一致）。 */
export const REMOTE_PREVIEW_CAP = 8 * 1024 * 1024;

/** 单次 ssh 带限读取：stat 与读取合并成一条脚本，消除 TOCTOU；超限时 stderr 输出标记。 */
export function buildLimitedReadScript(path: string, maxBytes: number = REMOTE_PREVIEW_CAP): string {
  const marker = `__AD_TOOBIG_${maxBytes}__`;
  return [
    `s=$(stat -c '%s' -- ${shq(path)} 2>/dev/null) || { printf '%s\\n' ${shq(marker)} >&2; exit 0; }`,
    `[ "$s" -gt ${maxBytes} ] && { printf '%s\\n' ${shq(marker)} >&2; exit 0; }`,
    `cat ${shq(path)}`,
  ].join('\n');
}

/** 判断一次带限读取结果是否因文件超限而被拒绝（stderr 含标记且 stdout 为空）。 */
export function isTooBigResult(res: { stdout: Buffer; stderr: string; code: number }, maxBytes: number = REMOTE_PREVIEW_CAP): boolean {
  return res.code === 0 && res.stdout.length === 0 && res.stderr.includes(`__AD_TOOBIG_${maxBytes}__`);
}

/** 文件指纹 diff：prev === undefined 表示首次（基线），此时只记录不发事件（返回 false）。 */
export function diffFileSnapshot(
  prev: FileFingerprint | null | undefined,
  fp: FileFingerprint | null,
): boolean {
  if (prev === undefined) {
    return false;
  }
  if (fp === null) {
    return prev !== null;
  }
  return prev === null || fp.size !== prev.size || fp.mtimeSec !== prev.mtimeSec;
}

export interface DirDiff {
  changed: boolean;
  /** 新增条目名。 */
  created: string[];
  /** 消失的条目名。 */
  deleted: string[];
  /** 类型翻转（文件↔目录）的条目名。 */
  toggled: string[];
}

/** 目录条目集合 diff：prev === undefined 表示首次（基线），此时只记录不发事件。 */
export function diffDirSnapshot(prev: LsEntry[] | null | undefined, entries: LsEntry[] | null): DirDiff {
  if (prev === undefined) {
    return { changed: false, created: [], deleted: [], toggled: [] };
  }
  if (entries === null || prev === null) {
    return { changed: entries !== prev, created: [], deleted: [], toggled: [] };
  }
  const prevNames = new Map(prev.map((e) => [e.name, e.isDir]));
  const nowNames = new Map(entries.map((e) => [e.name, e.isDir]));
  const created: string[] = [];
  const deleted: string[] = [];
  const toggled: string[] = [];
  for (const [name, isDir] of nowNames) {
    const before = prevNames.get(name);
    if (before === undefined) {
      created.push(name);
    } else if (before !== isDir) {
      toggled.push(name);
    }
  }
  for (const name of prevNames.keys()) {
    if (!nowNames.has(name)) {
      deleted.push(name);
    }
  }
  return { changed: created.length > 0 || deleted.length > 0 || toggled.length > 0, created, deleted, toggled };
}
