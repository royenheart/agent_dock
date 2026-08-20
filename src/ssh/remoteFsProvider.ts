import * as vscode from 'vscode';
import type { SFTPWrapper, Stats, FileEntryWithStats } from 'ssh2';
import type { ServerConfig } from '../model';
import { getRemoteAutoRefresh, getRemoteWatchIntervalMs, getServers, getSshHostKeyMode } from '../config';
import { execRemote, shq } from './remoteExec';
import { joinRemotePath, type LsEntry } from './remoteFsParse';
import { sessionFor } from './sshSession';
import {
  buildPollScript,
  diffDirSnapshot,
  diffFileSnapshot,
  parsePollOutput,
  REMOTE_PREVIEW_CAP,
  type FileFingerprint,
  type PollSnapshot,
} from './remoteFsPoll';
import { log } from '../log';
import { isUnder, normPath, pathBasename } from '../paths';

export const REMOTE_SCHEME = 'agentdock-remote';

/**
 * 计算 agentdock-remote 资源的显示标签：优先取「服务器上配置的 workspace 目录名 + 目录内相对路径」，
 * 路径不落在任何已配置目录时退回完整路径（去掉开头 /）。
 * 结果放进 query.label，由 package.json 的 resourceLabelFormatters 渲染。
 */
function remoteLabel(serverKey: string, path: string): string {
  const folders = getServers()
    .find((s) => s.name === serverKey)
    ?.folders?.slice()
    .sort((a, b) => b.length - a.length) ?? [];
  for (const folder of folders) {
    if (!isUnder(path, folder)) {
      continue;
    }
    const root = normPath(folder);
    if (root === '/') {
      return path.replace(/^\/+/, '') || path;
    }
    const rel = path.slice(root.length).replace(/^\/+/, '');
    const base = pathBasename(root);
    return rel ? `${base}/${rel}` : base;
  }
  return path.replace(/^\/+/, '') || path;
}

export function remoteUri(serverKey: string, path: string): vscode.Uri {
  // query.label 供 resourceLabelFormatters 使用：编辑器标签页显示
  // “server:workspace/relative/path”（见 package.json contributes）。
  return vscode.Uri.from({
    scheme: REMOTE_SCHEME,
    authority: serverKey,
    path,
    query: JSON.stringify({ label: remoteLabel(serverKey, path) }),
  });
}

function serverFor(authority: string): ServerConfig | undefined {
  return getServers().find((s) => s.name === authority);
}

/* ---------- SFTP 小工具（promisify + 错误映射） ---------- */

const SFX_NO_SUCH_FILE = 2;
const SFX_PERMISSION_DENIED = 3;
const SFX_FAILURE = 4;
const SFX_FILE_ALREADY_EXISTS = 11;

function isSfx(err: unknown, code: number): boolean {
  return (err as { code?: number })?.code === code;
}

function sftpStat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st))));
}

function sftpList(sftp: SFTPWrapper, p: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.opendir(p, (err, handle) => {
      if (err) {
        reject(err);
        return;
      }
      sftp.readdir(handle, (err2, list) => {
        sftp.close(handle, () => {});
        if (err2) {
          reject(err2);
          return;
        }
        resolve(list);
      });
    });
  });
}

function sftpWrite(sftp: SFTPWrapper, p: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => sftp.writeFile(p, data, (err) => (err ? reject(err) : resolve())));
}

function sftpUnlink(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.unlink(p, (err) => (err ? reject(err) : resolve())));
}

function sftpRmdir(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.rmdir(p, (err) => (err ? reject(err) : resolve())));
}

function sftpMkdir(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.mkdir(p, (err) => (err ? reject(err) : resolve())));
}

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
}

/**
 * 覆盖式 rename：OpenSSH sftp-server 对 flags=0 的 rename 在目标已存在时返回
 * EEXIST，需要先删目标再 rename（非原子，但对预览编辑场景足够）。
 */
async function sftpRenameOverwrite(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  try {
    await sftpRename(sftp, from, to);
    return;
  } catch (err) {
    if (!isSfx(err, SFX_FILE_ALREADY_EXISTS) && !isSfx(err, SFX_FAILURE)) {
      throw err;
    }
  }
  await sftpUnlink(sftp, to);
  await sftpRename(sftp, from, to);
}

/** 带上限的读取：超过 cap 字节即中断，避免大文件整块进内存（与旧 TOOBIG 语义一致）。 */
function sftpReadBounded(sftp: SFTPWrapper, p: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = sftp.createReadStream(p, { start: 0 });
    const fail = (err: unknown): void => {
      try {
        stream.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    stream.on('data', (d: Buffer) => {
      total += d.length;
      if (total > maxBytes) {
        fail(vscode.FileSystemError.Unavailable('read exceeded preview cap'));
        return;
      }
      chunks.push(d);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', fail);
  });
}

/** SFTP 状态码 → vscode.FileSystemError。 */
function mapSftpError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
  if (isSfx(err, SFX_NO_SUCH_FILE)) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (isSfx(err, SFX_PERMISSION_DENIED)) {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  if (isSfx(err, SFX_FILE_ALREADY_EXISTS)) {
    return vscode.FileSystemError.FileExists(uri);
  }
  const msg = (err as Error)?.message ?? String(err);
  return vscode.FileSystemError.Unavailable(msg.slice(0, 200));
}

/** 文件类型位判断。 */
function isSftpDir(st: Stats | FileEntryWithStats['attrs']): boolean {
  return (st.mode & 0o170000) === 0o040000;
}
function isSftpLink(st: Stats): boolean {
  return (st.mode & 0o170000) === 0o120000;
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
    const sftp = await this.sftpFor(uri);
    let st: Stats;
    try {
      st = await sftpStat(sftp, uri.path);
    } catch (err) {
      throw mapSftpError(err, uri);
    }
    return {
      type: isSftpDir(st) ? vscode.FileType.Directory : isSftpLink(st) ? vscode.FileType.SymbolicLink : vscode.FileType.File,
      ctime: st.mtime * 1000,
      mtime: st.mtime * 1000,
      size: st.size,
      // 不返回 Readonly：其他服务器文件可写（编辑器保存走 writeFile → SFTP 原子写）
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const sftp = await this.sftpFor(uri);
    let list: FileEntryWithStats[];
    try {
      list = await sftpList(sftp, uri.path);
    } catch (err) {
      throw mapSftpError(err, uri);
    }
    return list.map((e) => [e.filename, isSftpDir(e.attrs) ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const sftp = await this.sftpFor(uri);
    // 先 stat 拦截超限文件（不读），读取时再带上限兜底，防止读取途中文件暴涨
    let st: Stats;
    try {
      st = await sftpStat(sftp, uri.path);
    } catch (err) {
      throw mapSftpError(err, uri);
    }
    if (st.size > REMOTE_PREVIEW_CAP) {
      throw vscode.FileSystemError.Unavailable(
        `${uri.path} exceeds the ${REMOTE_PREVIEW_CAP / 1_048_576} MiB preview cap`,
      );
    }
    try {
      const buf = await sftpReadBounded(sftp, uri.path, REMOTE_PREVIEW_CAP);
      return new Uint8Array(buf);
    } catch (err) {
      if (err instanceof vscode.FileSystemError) {
        throw err;
      }
      throw mapSftpError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const sftp = await this.sftpFor(uri);
    try {
      await sftpMkdir(sftp, uri.path);
    } catch (err) {
      throw mapSftpError(err, uri);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const sftp = await this.sftpFor(uri);
    const p = uri.path;
    let exists = true;
    try {
      await sftpStat(sftp, p);
    } catch (err) {
      if (isSfx(err, SFX_NO_SUCH_FILE)) {
        exists = false;
      } else {
        throw mapSftpError(err, uri);
      }
    }
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // 原子写：临时文件 + rename 覆盖，避免轮询 watch 读到半截内容
    const tmp = `${p}.agentdock-tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
      await sftpWrite(sftp, tmp, Buffer.from(content));
      await sftpRenameOverwrite(sftp, tmp, p);
    } catch (err) {
      try {
        await sftpUnlink(sftp, tmp);
      } catch {
        // 清理失败可忽略
      }
      throw mapSftpError(err, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const server = this.mustServer(uri);
    const sftp = await this.sftpFor(uri);
    let st: Stats;
    try {
      st = await sftpStat(sftp, uri.path);
    } catch (err) {
      throw mapSftpError(err, uri);
    }
    if (st.isDirectory() && options.recursive) {
      // sftp 无递归删除原语；rm -rf 走持久连接的 exec 通道（单次往返），不是新 ssh 进程
      const res = await execRemote(server, `rm -rf -- ${shq(uri.path)}`, 30_000);
      if (res.code !== 0) {
        throw vscode.FileSystemError.Unavailable(res.stderr.slice(0, 200) || `rm failed (${res.code})`);
      }
      return;
    }
    try {
      if (st.isDirectory()) {
        await sftpRmdir(sftp, uri.path);
      } else {
        await sftpUnlink(sftp, uri.path);
      }
    } catch (err) {
      throw mapSftpError(err, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const sftp = await this.sftpFor(oldUri);
    let targetExists = false;
    try {
      await sftpStat(sftp, newUri.path);
      targetExists = true;
    } catch (err) {
      if (!isSfx(err, SFX_NO_SUCH_FILE)) {
        throw mapSftpError(err, newUri);
      }
    }
    if (targetExists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri);
    }
    try {
      await sftpRenameOverwrite(sftp, oldUri.path, newUri.path);
    } catch (err) {
      throw mapSftpError(err, oldUri);
    }
  }

  /** 取该 uri 对应服务器的持久会话 SFTP 句柄。 */
  private async sftpFor(uri: vscode.Uri): Promise<SFTPWrapper> {
    const server = this.mustServer(uri);
    return sessionFor(server, { hostKeyMode: getSshHostKeyMode() }).sftp();
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
