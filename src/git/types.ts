/**
 * 统一 git 状态抽象层。
 *
 * 非当前连接服务器（其他服务器）的文件状态、以及后续可能的「源代码管理」/Git Graph
 * 联动，都消费这一套状态模型，避免三处各自实现一套 git 追踪逻辑。
 *
 * 状态来源：远端服务器上 git status --porcelain=v1 -z 的输出（经 parse.ts 归一），
 * 与原生 git 插件对本地仓库的语义保持一致。
 */

export type GitStatusKind =
  | 'conflict'
  | 'deleted'
  | 'modified'
  | 'added'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored';

export interface GitFileStatus {
  /** 变更文件在服务器上的绝对路径（rename/copy 时为「新」路径）。 */
  path: string;
  /** rename/copy 时的原路径（普通条目为 undefined）。 */
  originalPath?: string;
  kind: GitStatusKind;
  /** git status --porcelain 的原始 XY 状态码（前两列）。 */
  xy: string;
}

/** 单个远端仓库的状态快照。 */
export interface RepoStatus {
  /** 仓库根目录（服务器上的绝对路径）。 */
  root: string;
  /** 绝对路径 → 状态（仅含已变更文件）。 */
  files: Map<string, GitFileStatus>;
  /** 绝对路径 → 聚合状态：目录下任一后代变更即打标，并向上滚到仓库根。 */
  dirs: Map<string, GitStatusKind>;
  /** 是否因超出 statusLimit 而截断（截断后不再追踪更多文件，与原生 git 一致）。 */
  truncated: boolean;
  scannedAt: number;
}

/** 状态严重度：数字越小越优先；目录聚合时取最严重状态作为徽标。 */
export const STATUS_PRIORITY: Record<GitStatusKind, number> = {
  conflict: 0,
  deleted: 1,
  modified: 2,
  added: 3,
  renamed: 4,
  copied: 5,
  untracked: 6,
  ignored: 7,
};
