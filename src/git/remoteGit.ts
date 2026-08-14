import type { GitStatusKind, RepoStatus } from "./types";
import { buildRepoStatus, isWithin, parsePorcelainZ } from "./parse";
import { getGitStatusEnable, getGitStatusLimit, getGitStatusTimeoutMs, getServers } from "../config";
import { execRemote, shq } from "../ssh/remoteExec";
import { log } from "../log";

type Listener = () => void;

/** serverKey:path → 值；serverKey 约定不含冒号（与 nodeId 的既有约定一致）。 */
function key(serverKey: string, path: string): string {
  return serverKey + ":" + path;
}

function splitKey(k: string): { serverKey: string; path: string } {
  const idx = k.indexOf(":");
  return idx < 0 ? { serverKey: "", path: k } : { serverKey: k.slice(0, idx), path: k.slice(idx + 1) };
}

/**
 * 远端 git 状态仓库：负责「仓库定位 → 状态扫描 → 缓存」全流程。
 *
 * 性能要点（对齐用户要求，避免反复刷新）：
 * - 仓库根定位按目录批量合并为一次 ssh 调用，并缓存；
 * - 状态按「仓库」而非「目录」扫描并缓存，同一仓库下的所有目录共享一份快照；
 * - 请求合并去抖（200ms 窗口），同一仓库扫描去重（inflight）并带最小冷却间隔；
 * - 单条命令超时（gitStatusTimeoutSeconds），单个仓库最多追踪 statusLimit 个文件；
 * - 超限即截断（truncated），不再追踪更多文件（与原生 git statusLimit 一致）。
 */
export class RemoteGitStore {
  /** serverKey:dir → 仓库根（null 表示确认不是仓库）。 */
  private readonly repoRoot = new Map<string, string | null>();
  /** 已发现的唯一仓库根，按服务器分组（用于按路径反查所属仓库）。 */
  private readonly rootsByServer = new Map<string, Set<string>>();
  /** serverKey:root → 状态快照。 */
  private readonly status = new Map<string, RepoStatus>();
  /** 待重扫的仓库（serverKey:root）。 */
  private readonly staleRepos = new Set<string>();
  /** 正在扫描的仓库（serverKey:root），用于去重。 */
  private readonly inflight = new Set<string>();
  /** 上次扫描时间戳（serverKey:root），用于最小冷却间隔。 */
  private readonly cooldown = new Map<string, number>();
  /** 待解析仓库根的目录（serverKey:dir → 目标）。 */
  private readonly pendingResolve = new Map<string, { serverKey: string; dir: string }>();
  private resolveTimer?: NodeJS.Timeout;
  private scanTimer?: NodeJS.Timeout;
  private readonly listeners = new Set<Listener>();
  /** 同一仓库两次扫描之间的最小间隔。 */
  private readonly minCooldownMs = 2000;
  /** 扫描失败后的重试退避：记录下次允许重试的时间戳（serverKey:root）。 */
  private readonly failCooldown = new Map<string, number>();
  /** 扫描失败后多久允许重试。 */
  private readonly retryAfterMs = 30_000;

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      l();
    }
  }

  private canRetry(sk: string): boolean {
    return Date.now() >= (this.failCooldown.get(sk) ?? 0);
  }

  /**
   * 请求确保某目录的 git 状态可用（目录被列出 / 展开 / 轮询发现变化时调用）。
   * 只负责调度，不阻塞渲染；状态到位后通过 onChange 通知刷新装饰。
   */
  request(serverKey: string, dir: string): void {
    if (!getGitStatusEnable()) {
      return;
    }
    const k = key(serverKey, dir);
    const root = this.repoRoot.get(k);
    if (root === undefined) {
      this.pendingResolve.set(k, { serverKey, dir });
      this.scheduleResolve();
      return;
    }
    if (root === null) {
      return;
    }
    const sk = key(serverKey, root);
    if (this.status.has(sk) || !this.canRetry(sk)) {
      return; // 已有快照，或处于失败退避期内——避免反复刷新
    }
    this.staleRepos.add(sk);
    this.scheduleScan();
  }

  /** 某目录被手动刷新 / 轮询发现变化：其所属仓库状态失效，安排重扫。 */
  invalidate(serverKey: string, dir: string): void {
    if (!getGitStatusEnable()) {
      return;
    }
    const k = key(serverKey, dir);
    const root = this.repoRoot.get(k);
    if (root === null || root === undefined) {
      // 仓库根未知：请求时再解析（目录内容变化不改变仓库根）
      return;
    }
    this.staleRepos.add(key(serverKey, root));
    this.scheduleScan();
  }

  /**
   * 查询远程路径（文件或目录）的 git 状态。同步返回缓存值；
   * 若仓库根已知但状态尚未扫描，会顺带触发一次后台扫描。
   */
  statusForPath(serverKey: string, path: string): GitStatusKind | undefined {
    const roots = this.rootsByServer.get(serverKey);
    if (!roots || roots.size === 0) {
      return undefined;
    }
    let bestRoot: string | undefined;
    for (const root of roots) {
      if (isWithin(path, root) && (bestRoot === undefined || root.length > bestRoot.length)) {
        bestRoot = root;
      }
    }
    if (bestRoot === undefined) {
      return undefined;
    }
    const sk = key(serverKey, bestRoot);
    const st = this.status.get(sk);
    if (!st) {
      if (this.canRetry(sk)) {
        this.staleRepos.add(sk);
        this.scheduleScan();
      }
      return undefined;
    }
    return st.files.get(path)?.kind ?? st.dirs.get(path);
  }

  /** 仓库状态快照（供「源代码管理」联动消费）；未扫描返回 undefined。 */
  statusForRepo(serverKey: string, root: string): RepoStatus | undefined {
    return this.status.get(key(serverKey, root));
  }

  /** 已知的仓库根（serverKey → roots），供「源代码管理」联动枚举仓库。 */
  knownRoots(): Array<{ serverKey: string; root: string }> {
    const out: Array<{ serverKey: string; root: string }> = [];
    for (const [serverKey, roots] of this.rootsByServer) {
      for (const root of roots) {
        out.push({ serverKey, root });
      }
    }
    return out;
  }

  /** 全局失效：所有已知仓库重扫（手动刷新入口），并跳过冷却。 */
  invalidateAll(): void {
    if (!getGitStatusEnable()) {
      return;
    }
    for (const [serverKey, roots] of this.rootsByServer) {
      for (const root of roots) {
        this.staleRepos.add(key(serverKey, root));
        this.cooldown.delete(key(serverKey, root));
      }
    }
    this.scheduleScan();
  }

  dispose(): void {
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
      this.resolveTimer = undefined;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = undefined;
    }
    this.pendingResolve.clear();
    this.staleRepos.clear();
    this.listeners.clear();
  }

  private scheduleResolve(): void {
    if (this.resolveTimer || this.pendingResolve.size === 0) {
      return;
    }
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = undefined;
      void this.flushResolve();
    }, 150);
  }

  private scheduleScan(delayMs = 0): void {
    if (this.scanTimer || this.staleRepos.size === 0) {
      return;
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.flushScan();
    }, delayMs);
  }

  /** 批量解析仓库根：每个目录一次 rev-parse，合并为一条 ssh 调用。 */
  private async flushResolve(): Promise<void> {
    if (!getGitStatusEnable() || this.pendingResolve.size === 0) {
      this.pendingResolve.clear();
      return;
    }
    const pending = [...this.pendingResolve.values()];
    this.pendingResolve.clear();
    const byServer = new Map<string, string[]>();
    for (const p of pending) {
      const arr = byServer.get(p.serverKey) ?? [];
      arr.push(p.dir);
      byServer.set(p.serverKey, arr);
    }
    await Promise.all([...byServer.entries()].map(([serverKey, dirs]) => this.resolveRoots(serverKey, dirs)));
    // 解析出仓库根的目录触发状态扫描（仅当该仓库尚无快照、且不在失败退避期内）
    for (const p of pending) {
      const root = this.repoRoot.get(key(p.serverKey, p.dir));
      const sk = root ? key(p.serverKey, root) : undefined;
      if (sk && !this.status.has(sk) && this.canRetry(sk)) {
        this.staleRepos.add(sk);
      }
    }
    this.scheduleScan();
  }

  private async resolveRoots(serverKey: string, dirs: string[]): Promise<void> {
    const server = getServers().find((s) => s.name === serverKey);
    if (!server) {
      for (const d of dirs) {
        this.repoRoot.set(key(serverKey, d), null);
      }
      return;
    }
    // 每个目录输出 dir\0root\0；非仓库 root 为空串。NUL 分隔避免路径含换行/空格歧义。
    const script = dirs
      .map((d) => `printf "%s\\0%s\\0" ${shq(d)} "$(git -C ${shq(d)} rev-parse --show-toplevel 2>/dev/null)"`)
      .join("\n");
    let res;
    try {
      res = await execRemote(server, script, getGitStatusTimeoutMs(), { quiet: true });
    } catch (err) {
      log.child("git").debug(`repo root resolve failed on ${serverKey}: ${String(err)}`);
      return;
    }
    if (res.code !== 0) {
      return; // 瞬时失败：下一轮 request 再试
    }
    const parts = res.stdout.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const dir = parts[i];
      const root = parts[i + 1];
      this.repoRoot.set(key(serverKey, dir), root || null);
      if (root) {
        const roots = this.rootsByServer.get(serverKey) ?? new Set<string>();
        roots.add(root);
        this.rootsByServer.set(serverKey, roots);
      }
    }
  }

  private async flushScan(): Promise<void> {
    if (!getGitStatusEnable()) {
      this.staleRepos.clear();
      return;
    }
    const now = Date.now();
    const jobs: Array<{ serverKey: string; root: string; sk: string }> = [];
    const skips: string[] = [];
    for (const sk of this.staleRepos) {
      if (this.inflight.has(sk)) {
        skips.push(sk);
        continue;
      }
      if (now - (this.cooldown.get(sk) ?? 0) < this.minCooldownMs) {
        skips.push(sk);
        continue;
      }
      const { serverKey, path: root } = splitKey(sk);
      jobs.push({ serverKey, root, sk });
    }
    this.staleRepos.clear();
    for (const sk of skips) {
      this.staleRepos.add(sk);
    }
    if (jobs.length === 0) {
      if (this.staleRepos.size > 0) {
        this.scheduleScan(this.minCooldownMs);
      }
      return;
    }
    await Promise.all(jobs.map((j) => this.scan(j.serverKey, j.root, j.sk)));
    if (this.staleRepos.size > 0) {
      this.scheduleScan();
    }
  }

  private async scan(serverKey: string, root: string, sk: string): Promise<void> {
    this.inflight.add(sk);
    const started = Date.now();
    try {
      const server = getServers().find((s) => s.name === serverKey);
      if (!server) {
        return;
      }
      const limit = getGitStatusLimit();
      const script = `git -C ${shq(root)} status --porcelain=v1 -z --untracked-files=all 2>/dev/null`;
      const res = await execRemote(server, script, getGitStatusTimeoutMs(), { quiet: true });
      if (res.cancelled || res.timedOut) {
        log.child("git").debug(`status ${serverKey}:${root} ${res.timedOut ? "timeout" : "cancelled"}`);
        this.failCooldown.set(sk, Date.now() + this.retryAfterMs);
        return;
      }
      if (res.code !== 0) {
        // 稳定错误（权限 / 仓库被删等）：缓存空快照，避免反复重试；invalid 后再重扫
        this.status.set(sk, buildRepoStatus(root, [], false, started));
        this.emit();
        return;
      }
      const { files, truncated } = parsePorcelainZ(res.stdout, limit);
      this.status.set(sk, buildRepoStatus(root, files, truncated, started));
      this.failCooldown.delete(sk);
      if (truncated) {
        log.child("git").warn(`status ${serverKey}:${root} exceeds limit ${limit} — further files untracked`);
      } else {
        log.child("git").debug(`status ${serverKey}:${root} → ${files.length} changed in ${Date.now() - started}ms`);
      }
      this.emit();
    } catch (err) {
      log.child("git").debug(`status ${serverKey}:${root} failed: ${String(err)}`);
      this.failCooldown.set(sk, Date.now() + this.retryAfterMs);
    } finally {
      this.inflight.delete(sk);
      this.cooldown.set(sk, Date.now());
    }
  }
}

/** 单例：树装饰与「源代码管理」联动共用同一状态仓库。 */
export const remoteGitStore = new RemoteGitStore();
