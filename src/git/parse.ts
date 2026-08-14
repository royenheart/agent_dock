import type { GitFileStatus, GitStatusKind, RepoStatus } from "./types";
import { STATUS_PRIORITY } from "./types";

/** 目录聚合用：返回更严重（优先级数字更小）的状态。 */
function worse(a: GitStatusKind | undefined, b: GitStatusKind): GitStatusKind {
  if (a === undefined) {
    return b;
  }
  return STATUS_PRIORITY[b] < STATUS_PRIORITY[a] ? b : a;
}

/** POSIX 路径的父目录（远程路径统一 posix）；根目录的父目录返回 undefined。 */
export function parentPosix(p: string): string | undefined {
  const norm = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  if (norm === "" || norm === "/") {
    return undefined;
  }
  const idx = norm.lastIndexOf("/");
  if (idx < 0) {
    return undefined;
  }
  return idx === 0 ? "/" : norm.slice(0, idx);
}

/** path 是否等于 root 或在 root 之下（root=/ 时任意绝对路径都视为在内）。 */
export function isWithin(path: string, root: string): boolean {
  if (root === "/") {
    return path.startsWith("/");
  }
  return path === root || path.startsWith(root + "/");
}

/** 由 XY 状态码归类为统一的 GitStatusKind。 */
function classify(xy: string): GitStatusKind {
  const x = xy.charAt(0);
  const y = xy.charAt(1);
  if (x === "U" || y === "U" || xy === "DD" || xy === "AA") {
    return 'conflict';
  }
  if (x === "R" || y === "R") {
    return 'renamed';
  }
  if (x === "C" || y === "C") {
    return 'copied';
  }
  if (x === "A" || y === "A") {
    return 'added';
  }
  if (x === "D" || y === "D") {
    return 'deleted';
  }
  if (x === "M" || y === "M" || x === "T" || y === "T") {
    return 'modified';
  }
  if (x === "?" && y === "?") {
    return 'untracked';
  }
  if (x === "!" || y === "!") {
    return 'ignored';
  }
  // 理论不可达；兜底为 modified 以保证有可见状态
  return 'modified';
}

/** rename/copy 条目在 -z 输出里额外带一个 NUL 分隔的原路径。 */
function isRenameLike(xy: string): boolean {
  const x = xy.charAt(0);
  const y = xy.charAt(1);
  return x === "R" || y === "R" || x === "C" || y === "C";
}

export interface PorcelainResult {
  files: GitFileStatus[];
  truncated: boolean;
}

/** 把相对仓库根的路径转成绝对路径（根为 / 时避免 //）。 */
export function joinAbs(root: string, rel: string): string {
  if (rel.startsWith("/")) {
    return rel;
  }
  return root === "/" ? "/" + rel : root + "/" + rel;
}

/**
 * 解析 git status --porcelain=v1 -z 的输出。
 * -z 格式：常规条目为 "XY PATH\0"；rename/copy 条目为 "XY NEW\0OLD\0"。
 * 超过 limit 条后停止解析并置 truncated（与原生 git statusLimit 语义一致）。
 */
export function parsePorcelainZ(output: string, limit: number): PorcelainResult {
  const files: GitFileStatus[] = [];
  const segments = output.split("\0");
  let i = 0;
  let truncated = false;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg === "") {
      i += 1;
      continue;
    }
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    // 头部至少 4 字符："XY " + 至少 1 字符路径
    if (seg.length < 4) {
      i += 1;
      continue;
    }
    const xy = seg.slice(0, 2);
    const path = seg.slice(3);
    if (isRenameLike(xy)) {
      const originalPath = segments[i + 1] ?? "";
      files.push({ path, originalPath, kind: classify(xy), xy });
      i += 2;
    } else {
      files.push({ path, kind: classify(xy), xy });
      i += 1;
    }
  }
  return { files, truncated };
}

/** 由变更文件列表构建仓库快照（含目录聚合滚标）。 */
export function buildRepoStatus(
  root: string,
  files: GitFileStatus[],
  truncated: boolean,
  scannedAt: number,
): RepoStatus {
  const byFile = new Map<string, GitFileStatus>();
  const dirs = new Map<string, GitStatusKind>();
  for (const f of files) {
    // git status --porcelain 输出的是相对仓库根的路径，这里归一为绝对路径
    const abs: GitFileStatus = f.originalPath
      ? { ...f, path: joinAbs(root, f.path), originalPath: joinAbs(root, f.originalPath) }
      : { ...f, path: joinAbs(root, f.path) };
    byFile.set(abs.path, abs);
    let p = parentPosix(abs.path);
    while (p !== undefined && isWithin(p, root)) {
      dirs.set(p, worse(dirs.get(p), abs.kind));
      if (p === root) {
        break;
      }
      p = parentPosix(p);
    }
  }
  return { root, files: byFile, dirs, truncated, scannedAt };
}
