import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { getCurrentContext, getServers } from '../config';
import { findCurrentServer, parseSshAuthority } from '../serverRegistration';
import { realpathSafe } from '../paths';
import { nodeFileIO, type FileIO } from '../views/settingsData';
import { execLocal, execRemote, type ExecResult } from './remoteExec';
import { buildRealpathScript } from './sshArgs';
import { createBatcher } from '../batch';
import { log } from '../log';

const clog = log.child('current');

let kind: vscode.ExtensionKind | undefined;

export function setExtensionKind(k: vscode.ExtensionKind): void {
  kind = k;
}

/**
 * 扩展以 UI 侧运行且窗口连着远程时，"当前服务器"≠扩展宿主机（客户端），
 * 所有针对当前服务器的 shell / 文件操作必须改走 ssh 或 vscode.fs 代理。
 */
export function currentNeedsSsh(): boolean {
  return kind === vscode.ExtensionKind.UI && !!vscode.env.remoteName;
}

/** 当前窗口的身份标识：会话快照按它隔离，避免客户端全局缓存跨机器串用。 */
export function currentWindowId(): string {
  const ctx = getCurrentContext();
  return ctx.isLocal ? 'local' : ctx.sshHost ?? ctx.remoteName ?? 'remote';
}

export function currentServerConfig(): ServerConfig | undefined {
  const ctx = getCurrentContext();
  if (!ctx.sshHost) {
    return undefined;
  }
  const found = findCurrentServer(getServers(), ctx.sshHost);
  if (found) {
    clog.debug(`resolve ${ctx.sshHost} → configured server`, { name: found.name, host: found.host, user: found.user, port: found.port });
    return found;
  }
  const { user, host, port } = parseSshAuthority(ctx.sshHost);
  clog.debug(`resolve ${ctx.sshHost} → authority fallback (not in agentDock.servers)`, { host, user, port });
  return { name: host, host, user, port };
}

export async function execCurrent(script: string, timeoutMs = 60_000): Promise<ExecResult> {
  if (currentNeedsSsh()) {
    const server = currentServerConfig();
    if (!server) {
      clog.warn('current window needs ssh but has no authority (empty workspace?)');
      return { stdout: '', stderr: 'no ssh authority for the current window', code: -1, timedOut: false };
    }
    return execRemote(server, script, timeoutMs);
  }
  return execLocal(script, timeoutMs);
}

/**
 * realpath 合并执行：文件装饰器等调用方会逐路径触发，无 ControlMaster 的平台
 * 上每路径一次 ssh 会形成连接风暴，这里把窗口期内的请求并为一次远程调用。
 */
const realpathBatched = createBatcher(async (paths: string[]): Promise<string[]> => {
  const res = await execCurrent(buildRealpathScript(paths), 15_000);
  if (res.code !== 0) {
    return paths;
  }
  const lines = res.stdout.split('\n');
  return paths.map((p, i) => lines[i]?.trim() || p);
});

/** 批量 realpath：UI 侧远程窗口走合并后的单次 ssh，每行必有结果（失败回显原路径）。 */
export async function realpathCurrent(paths: string[]): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }
  if (!currentNeedsSsh()) {
    return Promise.all(paths.map((p) => realpathSafe(p)));
  }
  return realpathBatched(paths).catch(() => paths);
}

export function currentRemoteAuthority(): string | undefined {
  if (!currentNeedsSsh()) {
    return undefined;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? undefined;
}

export function currentFileUri(p: string): vscode.Uri {
  const authority = currentRemoteAuthority();
  return authority ? vscode.Uri.from({ scheme: 'vscode-remote', authority, path: p }) : vscode.Uri.file(p);
}

export function currentFileIO(): FileIO {
  const authority = currentRemoteAuthority();
  if (!authority) {
    return nodeFileIO;
  }
  const uri = (p: string): vscode.Uri => vscode.Uri.from({ scheme: 'vscode-remote', authority, path: p });
  return {
    readFile: async (p) => Buffer.from(await vscode.workspace.fs.readFile(uri(p))).toString('utf8'),
    readdir: async (p) =>
      (await vscode.workspace.fs.readDirectory(uri(p))).map(([name, type]) => ({
        name,
        isDir: (type & vscode.FileType.Directory) !== 0,
        isFile: (type & vscode.FileType.File) !== 0,
      })),
    join: (...parts) => path.posix.join(...parts),
  };
}

export async function currentHomeDir(): Promise<string> {
  if (currentNeedsSsh()) {
    const res = await execCurrent('echo $HOME', 10_000);
    return res.stdout.trim() || '/';
  }
  return os.homedir();
}
