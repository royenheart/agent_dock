/**
 * 移动/复制文件操作（本地与远程共用）。
 *
 * - 右键菜单「移动到…」与树内拖放（drag & drop）共用这里的实现；
 * - 远程 → 远程（同一服务器）用 ssh mv（单次往返）；
 * - 本地 → 本地用 vscode.workspace.fs.rename；
 * - 远程 ↔ 本地走 SFTP 流式传输（不受 8 MiB 预览上限限制），目录递归复制。
 *
 * 本模块只执行操作与确认，不做树刷新——由调用方（命令 / DnD）负责刷新相关目录。
 */
import * as os from 'node:os';
import * as fsp from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { getServers, getSshHostKeyMode, getSshTimeoutMs } from '../config';
import { execRemote, shq } from '../ssh/remoteExec';
import { buildListDirsScript } from '../ssh/sshArgs';
import { joinRemotePath } from '../ssh/remoteFsParse';
import { remoteUri } from '../ssh/remoteFsProvider';
import { sessionFor } from '../ssh/sshSession';
import { pickDirectory, type SubdirsResult } from '../views/dirPicker';
import { uriFsPath, pathBasename } from '../paths';
import { t } from '../i18n';
import { log } from '../log';

const NOENT_MARKER = '__AGENTDOCK_NOENT_7f3a9__';

export type MoveResult = 'ok' | 'cancel' | 'error';

export function localListSubdirs(path: string): Promise<SubdirsResult> {
  return fsp.readdir(path, { withFileTypes: true }).then(
    (entries) => ({ kind: 'ok' as const, dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name) }),
    () => ({ kind: 'missing' as const }),
  );
}

export function remoteListSubdirs(server: ServerConfig): (path: string) => Promise<SubdirsResult> {
  return async (path: string) => {
    const res = await execRemote(server, buildListDirsScript(path, NOENT_MARKER), 15_000);
    if (res.code !== 0) {
      return { kind: 'conn', detail: res.stderr.trim().slice(0, 120) || (res.timedOut ? 'timeout' : `exit ${res.code}`) };
    }
    if (res.stdout.includes(NOENT_MARKER)) {
      return { kind: 'missing' };
    }
    return { kind: 'ok', dirs: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
  };
}

/** 远端路径的父目录（路径本身是 / 时返回 / ）。 */
export function remoteParentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * 移动守卫（纯函数，单测覆盖）。移动语义是 `mv srcPath destDir/name`：
 * - 'same'：destDir 就是源所在的父目录（目的地即源本身，无需移动）；
 * - 'into-self'：目录试图移入自身或其子树（destDir 等于源目录或在其下，mv 会失败/递归，必须拦截）。
 */
export function remoteMoveGuard(srcPath: string, srcIsDir: boolean, destDir: string): 'same' | 'into-self' | undefined {
  const norm = (p: string): string => {
    const s = p.replace(/\/+$/, '');
    return s === '' ? '/' : s;
  };
  const src = norm(srcPath);
  const dir = norm(destDir);
  const idx = src.lastIndexOf('/');
  const parent = idx <= 0 ? '/' : src.slice(0, idx);
  if (dir === parent) {
    return 'same';
  }
  if (srcIsDir && (dir === src || dir.startsWith(`${src}/`))) {
    return 'into-self';
  }
  return undefined;
}

/* ---------- 目标目录选择（复用 dirPicker 的路径浏览） ---------- */

export async function pickRemoteMoveTarget(server: ServerConfig, name: string): Promise<string | undefined> {
  let home = '/';
  try {
    const res = await execRemote(server, 'echo $HOME', 10_000);
    const h = res.stdout.trim();
    if (h.startsWith('/')) {
      home = h;
    }
  } catch {
    // 探测失败就用 / 兜底
  }
  const result = await pickDirectory({
    title: t('Move {0} to…', name),
    sessionDirs: server.folders ?? [],
    listSubdirs: remoteListSubdirs(server),
    homeDir: home,
  });
  if (!result || result.kind !== 'dir') {
    return undefined;
  }
  return result.path;
}

export async function pickLocalMoveTarget(name: string): Promise<string | undefined> {
  const result = await pickDirectory({
    title: t('Move {0} to…', name),
    sessionDirs: (vscode.workspace.workspaceFolders ?? []).map((f) => uriFsPath(f.uri)),
    listSubdirs: localListSubdirs,
    homeDir: os.homedir(),
  });
  if (!result || result.kind !== 'dir') {
    return undefined;
  }
  return result.path;
}

/* ---------- 覆盖确认 ---------- */

async function confirmRemoteOverwrite(server: ServerConfig, destPath: string, name: string): Promise<MoveResult> {
  let exists = false;
  try {
    const check = await execRemote(server, `[ -e ${shq(destPath)} ] && echo EXISTS || echo ABSENT`, 10_000, { quiet: true });
    exists = check.stdout.trim() === 'EXISTS';
  } catch (err) {
    log.child('fs').warn(`exists check ${destPath} failed: ${String(err)}`);
    vscode.window.showErrorMessage(t('Failed to check {0}: {1}', name, String(err)));
    return 'error';
  }
  if (!exists) {
    return 'ok';
  }
  const overwrite = await vscode.window.showWarningMessage(
    t('{0} already exists. Overwrite?', name),
    { modal: true },
    t('Overwrite'),
  );
  if (!overwrite) {
    return 'cancel';
  }
  try {
    const rmRes = await execRemote(server, `rm -rf -- ${shq(destPath)}`, 30_000);
    if (rmRes.code !== 0) {
      vscode.window.showErrorMessage(t('Failed to replace {0}: {1}', name, rmRes.stderr.trim() || `exit ${rmRes.code}`));
      return 'error';
    }
  } catch (err) {
    vscode.window.showErrorMessage(t('Failed to replace {0}: {1}', name, String(err)));
    return 'error';
  }
  return 'ok';
}

async function confirmLocalOverwrite(destUri: vscode.Uri, name: string): Promise<MoveResult> {
  let exists = false;
  try {
    await vscode.workspace.fs.stat(destUri);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    return 'ok';
  }
  const overwrite = await vscode.window.showWarningMessage(
    t('{0} already exists. Overwrite?', name),
    { modal: true },
    t('Overwrite'),
  );
  if (!overwrite) {
    return 'cancel';
  }
  try {
    await vscode.workspace.fs.delete(destUri, { recursive: true });
  } catch (err) {
    vscode.window.showErrorMessage(t('Failed to replace {0}: {1}', name, String(err)));
    return 'error';
  }
  return 'ok';
}

/* ---------- 移动 ---------- */

/** 同一服务器内移动远程文件/目录（ssh mv；覆盖需确认）。返回 'ok' | 'cancel' | 'error'。 */
export async function remoteMove(
  serverKey: string,
  srcPath: string,
  name: string,
  srcIsDir: boolean,
  destDir: string,
): Promise<MoveResult> {
  const guard = remoteMoveGuard(srcPath, srcIsDir, destDir);
  if (guard === 'same') {
    vscode.window.showInformationMessage(t('{0} is already there', name));
    return 'cancel';
  }
  if (guard === 'into-self') {
    vscode.window.showErrorMessage(t('Cannot move {0} into itself', name));
    return 'cancel';
  }
  const server = getServers().find((s) => s.name === serverKey);
  if (!server) {
    vscode.window.showErrorMessage(t('Server {0} not found in config', serverKey));
    return 'error';
  }
  const dest = joinRemotePath(destDir, name);
  const overwrite = await confirmRemoteOverwrite(server, dest, name);
  if (overwrite !== 'ok') {
    return overwrite;
  }
  try {
    const res = await execRemote(server, `mv -- ${shq(srcPath)} ${shq(dest)}`, getSshTimeoutMs());
    if (res.code !== 0) {
      vscode.window.showErrorMessage(t('Failed to move {0}: {1}', name, res.stderr.trim() || `exit ${res.code}`));
      return 'error';
    }
  } catch (err) {
    vscode.window.showErrorMessage(t('Failed to move {0}: {1}', name, String(err)));
    return 'error';
  }
  vscode.window.setStatusBarMessage(t('Moved {0}', name), 3000);
  return 'ok';
}

/** 本地移动文件/目录（vscode rename；覆盖需确认）。 */
export async function localMove(uri: vscode.Uri, name: string, srcIsDir: boolean, destDir: vscode.Uri): Promise<MoveResult> {
  const toPosix = (p: string): string => p.replace(/\\/g, '/');
  const guard = remoteMoveGuard(toPosix(uriFsPath(uri)), srcIsDir, toPosix(uriFsPath(destDir)));
  if (guard === 'same') {
    vscode.window.showInformationMessage(t('{0} is already there', name));
    return 'cancel';
  }
  if (guard === 'into-self') {
    vscode.window.showErrorMessage(t('Cannot move {0} into itself', name));
    return 'cancel';
  }
  const destUri = vscode.Uri.joinPath(destDir, name);
  const overwrite = await confirmLocalOverwrite(destUri, name);
  if (overwrite !== 'ok') {
    return overwrite;
  }
  try {
    await vscode.workspace.fs.rename(uri, destUri, { overwrite: true });
  } catch (err) {
    vscode.window.showErrorMessage(t('Failed to move {0}: {1}', name, String(err)));
    return 'error';
  }
  vscode.window.setStatusBarMessage(t('Moved {0}', name), 3000);
  return 'ok';
}

/* ---------- 跨端复制（远程 ↔ 本地，SFTP 流式传输，目录递归） ---------- */

/** 流式复制的进度/取消上下文（可选；不提供则无进度上报、不可取消）。 */
export interface CopyCtx {
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
  token?: vscode.CancellationToken;
}

interface PumpOptions {
  /** 总字节数（>0 时按字节上报 increment 百分比）。 */
  size?: number;
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
  token?: vscode.CancellationToken;
  /** 失败/取消时的收尾（如下载删除半成品文件）。 */
  cleanup?: () => void;
}

/**
 * 流式泵：rs.pipe(ws) 传输，按字节上报进度，支持取消；任一侧出错即双侧销毁并 reject。
 * 0.2.4/0.2.5 曾因漏掉 pipe 导致下载/上传只建空文件——这是本函数存在的意义（并有单测锁死）。
 */
export function pumpStreams(rs: NodeJS.ReadableStream, ws: NodeJS.WritableStream, opts: PumpOptions = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      (rs as { destroy?: () => void }).destroy?.();
      (ws as { destroy?: () => void }).destroy?.();
      opts.cleanup?.();
      reject(err);
    };
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    rs.on('error', fail);
    ws.on('error', fail);
    // ssh2 的 SFTP 写流 'finish' 不可靠（fastWrite），finish/close 先到先结算
    ws.on('finish', done);
    ws.on('close', done);
    if (opts.size && opts.size > 0 && opts.progress) {
      const total = opts.size;
      const progress = opts.progress;
      rs.on('data', (chunk: Buffer) => {
        progress.report({ increment: (chunk.length / total) * 100 });
      });
    }
    opts.token?.onCancellationRequested(() => fail(new vscode.CancellationError()));
    rs.pipe(ws);
  });
}

type FsRef = { kind: 'local'; uri: vscode.Uri } | { kind: 'remote'; serverKey: string; path: string };

function serverFor(serverKey: string): ServerConfig | undefined {
  return getServers().find((s) => s.name === serverKey);
}

function refUri(ref: FsRef): vscode.Uri {
  return ref.kind === 'local' ? ref.uri : remoteUri(ref.serverKey, ref.path);
}

function joinRef(ref: FsRef, name: string): FsRef {
  return ref.kind === 'local'
    ? { kind: 'local', uri: vscode.Uri.joinPath(ref.uri, name) }
    : { kind: 'remote', serverKey: ref.serverKey, path: joinRemotePath(ref.path, name) };
}

async function fsList(ref: FsRef): Promise<[string, boolean][]> {
  const entries = await vscode.workspace.fs.readDirectory(refUri(ref));
  return entries.map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0]);
}

async function fsEnsureDir(ref: FsRef): Promise<void> {
  try {
    await vscode.workspace.fs.stat(refUri(ref));
    return; // 已存在
  } catch {
    await vscode.workspace.fs.createDirectory(refUri(ref));
  }
}

async function sftpDownload(server: ServerConfig, remotePath: string, localDest: string, ctx?: CopyCtx): Promise<void> {
  const sftp = await sessionFor(server, { hostKeyMode: getSshHostKeyMode() }).sftp();
  const size = await new Promise<number>((res) => sftp.stat(remotePath, (err, st) => res(err ? 0 : st.size)));
  const rs = sftp.createReadStream(remotePath);
  const ws = createWriteStream(localDest);
  await pumpStreams(rs, ws, {
    size,
    progress: ctx?.progress,
    token: ctx?.token,
    cleanup: () => {
      void fsp.rm(localDest, { force: true }).catch(() => {});
    },
  });
}

async function sftpUpload(server: ServerConfig, localSrc: string, remoteDest: string, ctx?: CopyCtx): Promise<void> {
  const sftp = await sessionFor(server, { hostKeyMode: getSshHostKeyMode() }).sftp();
  const size = await fsp.stat(localSrc).then((st) => st.size).catch(() => 0);
  const rs = createReadStream(localSrc);
  const ws = sftp.createWriteStream(remoteDest);
  await pumpStreams(rs, ws, {
    size,
    progress: ctx?.progress,
    token: ctx?.token,
    cleanup: () => {
      sftp.unlink(remoteDest, () => {});
    },
  });
}

async function fsCopyFile(src: FsRef, dest: FsRef, ctx?: CopyCtx): Promise<void> {
  if (src.kind === 'local' && dest.kind === 'local') {
    await fsp.copyFile(uriFsPath(src.uri), uriFsPath(dest.uri));
    return;
  }
  if (src.kind === 'remote' && dest.kind === 'local') {
    const server = serverFor(src.serverKey);
    if (!server) {
      throw new Error(t('Server {0} not found in config', src.serverKey));
    }
    await sftpDownload(server, src.path, uriFsPath(dest.uri), ctx);
    return;
  }
  if (src.kind === 'local' && dest.kind === 'remote') {
    const server = serverFor(dest.serverKey);
    if (!server) {
      throw new Error(t('Server {0} not found in config', dest.serverKey));
    }
    await sftpUpload(server, uriFsPath(src.uri), dest.path, ctx);
    return;
  }
  throw new Error('unsupported copy direction');
}

async function copyRecursive(src: FsRef, dest: FsRef, ctx?: CopyCtx): Promise<void> {
  if (ctx?.token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  const st = await vscode.workspace.fs.stat(refUri(src));
  if ((st.type & vscode.FileType.Directory) !== 0) {
    await fsEnsureDir(dest);
    const entries = await fsList(src);
    for (const [name] of entries) {
      await copyRecursive(joinRef(src, name), joinRef(dest, name), ctx);
    }
    return;
  }
  ctx?.progress?.report({ message: pathBasename(refUri(src).path) });
  await fsCopyFile(src, dest, ctx);
}

/** 全走 workspace.fs 的递归复制：两端可以是任意已注册 scheme（file / vscode-remote / agentdock-remote）。 */
export async function copyUriRecursive(src: vscode.Uri, dest: vscode.Uri, ctx?: CopyCtx): Promise<void> {
  if (ctx?.token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  const st = await vscode.workspace.fs.stat(src);
  if ((st.type & vscode.FileType.Directory) !== 0) {
    try {
      await vscode.workspace.fs.createDirectory(dest);
    } catch {
      // 目标目录已存在
    }
    for (const [name] of await vscode.workspace.fs.readDirectory(src)) {
      await copyUriRecursive(vscode.Uri.joinPath(src, name), vscode.Uri.joinPath(dest, name), ctx);
    }
    return;
  }
  ctx?.progress?.report({ message: pathBasename(src.path) });
  await vscode.workspace.fs.writeFile(dest, await vscode.workspace.fs.readFile(src));
}

/** 当前服务器（或任意 workspace.fs 可达的 URI）复制到客户端磁盘（下载；保留原件）。 */
export async function copyCurrentToLocal(srcUri: vscode.Uri, name: string, destDir: vscode.Uri): Promise<MoveResult> {
  const destUri = vscode.Uri.joinPath(destDir, name);
  const overwrite = await confirmLocalOverwrite(destUri, name);
  if (overwrite !== 'ok') {
    return overwrite;
  }
  return runCopyWithProgress(t('Downloading {0}', name), name, (ctx) => copyUriRecursive(srcUri, destUri, ctx));
}

/** 远程文件下载到客户端指定文件路径（覆盖确认由保存对话框完成，这里不再重复询问）。 */
export async function downloadRemoteToUri(serverKey: string, srcPath: string, dest: vscode.Uri): Promise<MoveResult> {
  const server = serverFor(serverKey);
  if (!server) {
    vscode.window.showErrorMessage(t('Server {0} not found in config', serverKey));
    return 'error';
  }
  const name = pathBasename(srcPath);
  return runCopyWithProgress(t('Downloading {0}', name), name, (ctx) =>
    copyRecursive({ kind: 'remote', serverKey, path: srcPath }, { kind: 'local', uri: dest }, ctx),
  );
}

/** 带进度的跨端复制执行器：右下角通知（字节级进度 + 可取消），取消映射为 'cancel'。 */
async function runCopyWithProgress(title: string, name: string, op: (ctx: CopyCtx) => Promise<void>): Promise<MoveResult> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => op({ progress, token }),
    );
  } catch (err) {
    if (err instanceof vscode.CancellationError) {
      vscode.window.setStatusBarMessage(t('Cancelled'), 3000);
      return 'cancel';
    }
    vscode.window.showErrorMessage(t('Failed to copy {0}: {1}', name, String(err)));
    return 'error';
  }
  vscode.window.setStatusBarMessage(t('Copied {0}', name), 3000);
  return 'ok';
}

/** 远程文件/目录复制到本地（下载；保留远端原件）。 */
export async function copyRemoteToLocal(
  serverKey: string,
  srcPath: string,
  name: string,
  destDir: vscode.Uri,
): Promise<MoveResult> {
  const server = serverFor(serverKey);
  if (!server) {
    vscode.window.showErrorMessage(t('Server {0} not found in config', serverKey));
    return 'error';
  }
  const destUri = vscode.Uri.joinPath(destDir, name);
  const overwrite = await confirmLocalOverwrite(destUri, name);
  if (overwrite !== 'ok') {
    return overwrite;
  }
  return runCopyWithProgress(t('Downloading {0}', name), name, (ctx) =>
    copyRecursive({ kind: 'remote', serverKey, path: srcPath }, { kind: 'local', uri: destUri }, ctx),
  );
}

/** 本地文件/目录复制到远程目录（上传；保留本地原件）。 */
export async function copyLocalToRemote(
  serverKey: string,
  destDirPath: string,
  srcUri: vscode.Uri,
  name: string,
): Promise<MoveResult> {
  const server = serverFor(serverKey);
  if (!server) {
    vscode.window.showErrorMessage(t('Server {0} not found in config', serverKey));
    return 'error';
  }
  const destPath = joinRemotePath(destDirPath, name);
  const overwrite = await confirmRemoteOverwrite(server, destPath, name);
  if (overwrite !== 'ok') {
    return overwrite;
  }
  return runCopyWithProgress(t('Uploading {0}', name), name, (ctx) =>
    copyRecursive({ kind: 'local', uri: srcUri }, { kind: 'remote', serverKey, path: destPath }, ctx),
  );
}
