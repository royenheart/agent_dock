import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { getServers } from '../config';
import { execRemote, execRemoteBuffer, shq } from './remoteExec';
import { joinRemotePath, parseLsAp, parseStatFs } from './remoteFsParse';

export const REMOTE_SCHEME = 'agentdock-remote';

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export function remoteUri(serverKey: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REMOTE_SCHEME, authority: serverKey, path });
}

function serverFor(authority: string): ServerConfig | undefined {
  return getServers().find((s) => s.name === authority);
}

export class RemoteFsProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
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
    const sizeRes = await execRemote(server, `stat -c '%s' ${shq(uri.path)}`, 15_000);
    const size = Number(sizeRes.stdout.trim());
    if (Number.isFinite(size) && size > MAX_PREVIEW_BYTES) {
      throw vscode.FileSystemError.Unavailable(
        `${uri.path} exceeds the ${MAX_PREVIEW_BYTES / 1_048_576} MiB preview cap`,
      );
    }
    const res = await execRemoteBuffer(server, `cat ${shq(uri.path)}`, 30_000);
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

export { joinRemotePath };
