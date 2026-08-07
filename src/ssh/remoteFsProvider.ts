import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { getRemoteAutoRefresh, getRemoteWatchIntervalMs, getServers } from '../config';
import { execRemote, execRemoteBuffer, shq } from './remoteExec';
import { joinRemotePath, parseLsAp, parseStatFs, type LsEntry } from './remoteFsParse';
import {
  buildLimitedReadScript,
  buildPollScript,
  diffDirSnapshot,
  diffFileSnapshot,
  isTooBigResult,
  parsePollOutput,
  REMOTE_PREVIEW_CAP,
  type FileFingerprint,
  type PollSnapshot,
} from './remoteFsPoll';
import { log } from '../log';

export const REMOTE_SCHEME = 'agentdock-remote';

export function remoteUri(serverKey: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REMOTE_SCHEME, authority: serverKey, path });
}

function serverFor(authority: string): ServerConfig | undefined {
  return getServers().find((s) => s.name === authority);
}

/**
 * 单个 watch() 的轮询状态。首次取到基线（baseline）只记录不发事件；
 * 之后指纹/条目集合与上次不同才产生 FileChangeEvent，VSCode 收到后
 * 会对打开的编辑器重新 stat/readFile —— 即「远程文件实时更新」。
 */
export class PollWatcher {
  disposed = false;
  private lastFile?: PollSnapshot;
  private lastEntries?: PollSnapshot;

  constructor(
    readonly uri: vscode.Uri,
    readonly isDir: boolean,
  ) {}

  dispose(): void {
    this.disposed = true;
    this.lastFile = undefined;
    this.lastEntries = undefined;
  }

  apply(snapshot: PollSnapshot, events: vscode.FileChangeEvent[]): void {
    if (this.disposed) {
      return;
    }
    if (this.isDir) {
      this.applyDir(snapshot, events);
    } else {
      this.applyFile(snapshot, events);
    }
  }

  private applyFile(fp: PollSnapshot, events: vscode.FileChangeEvent[]): void {
    const changed = diffFileSnapshot(
      this.lastFile as FileFingerprint | null | undefined,
      fp as FileFingerprint | null,
    );
    this.lastFile = fp;
    if (changed) {
      events.push({ type: vscode.FileChangeType.Changed, uri: this.uri });
    }
  }

  private applyDir(entries: PollSnapshot, events: vscode.FileChangeEvent[]): void {
    const diff = diffDirSnapshot(
      this.lastEntries as LsEntry[] | null | undefined,
      entries as LsEntry[] | null,
    );
    this.lastEntries = entries;
    if (!diff.changed) {
      return;
    }
    if (entries === null) {
      // 目录整体消失：只报目录自身变化
      events.push({ type: vscode.FileChangeType.Changed, uri: this.uri });
      return;
    }
    for (const name of diff.created) {
      events.push({
        type: vscode.FileChangeType.Created,
        uri: remoteUri(this.uri.authority, joinRemotePath(this.uri.path, name)),
      });
    }
    for (const name of diff.toggled) {
      events.push({
        type: vscode.FileChangeType.Changed,
        uri: remoteUri(this.uri.authority, joinRemotePath(this.uri.path, name)),
      });
    }
    for (const name of diff.deleted) {
      events.push({
        type: vscode.FileChangeType.Deleted,
        uri: remoteUri(this.uri.authority, joinRemotePath(this.uri.path, name)),
      });
    }
    events.push({ type: vscode.FileChangeType.Changed, uri: this.uri });
  }
}

export class RemoteFsProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private readonly watchers = new Set<PollWatcher>();
  private pollTimer?: NodeJS.Timeout;
  private polling = false;

  /**
   * 轮询式 watch：VSCode 打开 agentdock-remote 文件时会调用它，
   * 我们按配置间隔轮询远端 stat/ls，变化时派发 FileChangeEvent。
   */
  watch(uri: vscode.Uri, options: { recursive: boolean }): vscode.Disposable {
    if (!getRemoteAutoRefresh() || !serverFor(uri.authority)) {
      return new vscode.Disposable(() => {});
    }
    const watcher = new PollWatcher(uri, options.recursive);
    this.watchers.add(watcher);
    void this.pollOnce();
    return new vscode.Disposable(() => {
      this.watchers.delete(watcher);
      watcher.dispose();
      this.maybeStopPolling();
    });
  }

  /** 手动刷新入口：向 VSCode 派发一次变更事件，打开的编辑器会重新 stat/readFile。 */
  notifyChanged(uri: vscode.Uri): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  disposeAll(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers.clear();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.watchers.size === 0) {
      return;
    }
    // setTimeout 链：每次调度都重读配置，改间隔无需重启
    this.pollTimer = setTimeout(() => void this.pollOnce(), getRemoteWatchIntervalMs());
  }

  private maybeStopPolling(): void {
    if (this.pollTimer && this.watchers.size === 0) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    this.pollTimer = undefined;
    if (this.polling || this.watchers.size === 0) {
      return;
    }
    if (!getRemoteAutoRefresh()) {
      this.disposeAll();
      return;
    }
    this.polling = true;
    try {
      const groups = new Map<string, PollWatcher[]>();
      for (const w of this.watchers) {
        const arr = groups.get(w.uri.authority);
        if (arr) {
          arr.push(w);
        } else {
          groups.set(w.uri.authority, [w]);
        }
      }
      // 各组并发轮询（全局 ssh 信号量已限制并发上限），
      // 避免一台慢服务器串行拖长所有服务器的有效刷新间隔
      await Promise.all(
        [...groups.entries()].map(async ([authority, ws]) => {
          const server = serverFor(authority);
          if (!server) {
            return;
          }
          try {
            const res = await execRemote(
              server,
              buildPollScript(ws.map((w) => ({ path: w.uri.path, isDir: w.isDir }))),
              15_000,
              { quiet: true },
            );
            if (res.code !== 0) {
              return; // 瞬时失败：下一轮再试
            }
            const snapshots = parsePollOutput(res.stdout);
            const events: vscode.FileChangeEvent[] = [];
            for (const w of ws) {
              w.apply(snapshots.get(w.uri.path) ?? null, events);
            }
            if (events.length > 0) {
              log.child('watch').debug(`fire ${events.length} change event(s) on ${authority}`);
              this.emitter.fire(events);
            }
          } catch (err) {
            log.child('watch').debug(`poll ${authority} failed: ${String(err)}`);
          }
        }),
      );
    } catch (err) {
      log.child('watch').debug(`poll failed: ${String(err)}`);
    } finally {
      this.polling = false;
      this.ensurePolling();
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const server = this.mustServer(uri);
    const res = await execRemote(server, `stat -c '%F|%s|%Y' ${shq(uri.path)}`, 15_000);
    const info = res.code === 0 ? parseStatFs(res.stdout) : undefined;
    if (!info) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type:
        info.kind === 'directory'
          ? vscode.FileType.Directory
          : info.kind === 'link'
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.File,
      ctime: info.mtimeMs,
      mtime: info.mtimeMs,
      size: info.size,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const server = this.mustServer(uri);
    const res = await execRemote(server, `ls -1Ap --color=never ${shq(uri.path)}`, 15_000);
    if (res.code !== 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return parseLsAp(res.stdout).map((e) => [
      e.name,
      e.isDir ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const server = this.mustServer(uri);
    // 单次 ssh 完成 stat+cat，避免两次调用间文件增长绕过上限（TOCTOU）；
    // 超限时远端 stderr 输出标记，不把大文件整块拉进内存
    const res = await execRemoteBuffer(server, buildLimitedReadScript(uri.path, REMOTE_PREVIEW_CAP), 30_000);
    if (isTooBigResult(res, REMOTE_PREVIEW_CAP)) {
      throw vscode.FileSystemError.Unavailable(
        `${uri.path} exceeds the ${REMOTE_PREVIEW_CAP / 1_048_576} MiB preview cap`,
      );
    }
    if (res.code !== 0) {
      throw vscode.FileSystemError.Unavailable(res.stderr.slice(0, 200) || `failed to read ${uri.path}`);
    }
    return new Uint8Array(res.stdout);
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions();
  }

  private mustServer(uri: vscode.Uri): ServerConfig {
    const server = serverFor(uri.authority);
    if (!server) {
      throw vscode.FileSystemError.Unavailable(`unknown server: ${uri.authority}`);
    }
    return server;
  }
}

/** 单例：extension 注册与 commands 手动刷新共用同一实例（同一 emitter）。 */
export const remoteFsProvider = new RemoteFsProvider();

export { joinRemotePath };
