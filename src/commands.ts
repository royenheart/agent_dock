import * as os from 'node:os';
import * as vscode from 'vscode';
import type { PortForward, ServerConfig } from './model';
import {
  addServer,
  addServerFolders,
  ensureCurrentServerRegistered,
  getConnectInNewWindow,
  getCurrentContext,
  getServers,
  getSessionLimit,
  getSshTimeoutMs,
  removeServer,
  removeServerFolders,
  updateServerForwards,
} from './config';
import { resumeCommand } from './agents/resume';
import { buildDiscoveryScript } from './agents/discoveryScript';
import { parseDiscoveryOutput } from './agents/parse';
import { execRemote, sshDestination, shq } from './ssh/remoteExec';
import { joinRemotePath } from './ssh/remoteFsParse';
import { currentFileUri, currentHomeDir, currentNeedsSsh, currentServerConfig } from './ssh/currentExec';
import { openClientTerminal, sshSpawnSpec } from './ssh/clientTerminal';
import { trackNativeTerminal } from './ssh/nativeTerminal';
import { forwardSpec, setOnDidChange, startForward, stopForward } from './ssh/portForward';
import { readSshConfigHosts, type SshHostEntry } from './ssh/sshConfig';
import { normPath, pathBasename, uriFsPath } from './paths';
import { pickDirectory } from './views/dirPicker';
import { copyCurrentToLocal, copyLocalToRemote, copyRemoteToLocal, copyUriRecursive, downloadRemoteToUri, localListSubdirs, localMove, pickLocalMoveTarget, pickRemoteMoveTarget, remoteListSubdirs, remoteMove, remoteParentPath } from './tree/moveOps';
import { SessionPanel, type SessionTarget } from './views/sessionPanel';
import type { Node, WorkspaceProvider } from './tree/workspaceProvider';
import { CURRENT_SERVER_KEY } from './tree/workspaceProvider';
import { remoteFsProvider, remoteUri } from './ssh/remoteFsProvider';
import { t } from './i18n';
import { log } from './log';

type ServerNode = Extract<Node, { kind: 'server' }>;
type SessionNode = Extract<Node, { kind: 'session' }>;
type FsEntryNode = Extract<Node, { kind: 'fsEntry' }>;
type FolderNode = Extract<Node, { kind: 'folder' }>;
type PortsRootNode = Extract<Node, { kind: 'portsRoot' }>;
type PortForwardNode = Extract<Node, { kind: 'portForward' }>;
type RemoteFsEntryNode = Extract<Node, { kind: 'remoteFsEntry' }>;

/** 复制/粘贴的剪贴板：本地条目记 uri，远程条目记 serverKey+path。 */
type CopyClipboard =
  | { kind: 'local'; uri: vscode.Uri; name: string; isDir: boolean }
  | { kind: 'remote'; serverKey: string; path: string; name: string; isDir: boolean };

let copyClipboard: CopyClipboard | undefined;

function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

function targetDirUri(node: FsEntryNode | FolderNode): vscode.Uri | undefined {
  if (node.kind === 'fsEntry') {
    return node.isDir ? node.uri : parentUri(node.uri);
  }
  if (node.kind === 'folder') {
    return node.workspaceUri;
  }
  return undefined;
}

const AGENT_CLI: Record<'opencode' | 'codex' | 'claude', { cmd: string; hint: string }> = {
  opencode: { cmd: 'opencode', hint: 'opencode --session 新会话' },
  codex: { cmd: 'codex', hint: 'codex 新会话' },
  claude: { cmd: 'claude', hint: 'claude 新会话' },
};

function sessionTarget(node: SessionNode): SessionTarget | undefined {
  const servers = getServers();
  const server = node.serverKey === CURRENT_SERVER_KEY ? undefined : servers.find((s) => s.name === node.serverKey);
  if (node.serverKey !== CURRENT_SERVER_KEY && !server) {
    return undefined;
  }
  const serverLabel = server
    ? `${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`
    : t('Current server');
  return { serverKey: node.serverKey, server, serverLabel, session: node.session };
}

export function resumeInTerminal(target: SessionTarget): void {
  const { session, server } = target;
  const cmd = resumeCommand(session);
  const name = `${session.agent}: ${session.title.slice(0, 20)}`;
  const full = session.cwd ? `cd ${shq(session.cwd)} && ${cmd}` : cmd;
  if (server) {
    if (currentNeedsSsh()) {
      openClientTerminal({
        name,
        spec: sshSpawnSpec(server, full),
        persist: { name, kind: 'ssh', serverName: server.name, remoteCommand: full },
      });
      return;
    }
    const port = server.port ? `-p ${server.port} ` : '';
    const term = vscode.window.createTerminal({ name });
    term.sendText(`ssh -t ${port}${sshDestination(server)} ${shq(full)}`);
    term.show();
    return;
  }
  const term = vscode.window.createTerminal({ name });
  term.sendText(full);
  term.show();
}

async function connectToServer(server: ServerConfig): Promise<void> {
  let home = '/';
  try {
    const res = await execRemote(server, 'echo $HOME', 10_000);
    const probed = res.stdout.trim();
    if (probed.startsWith('/')) {
      home = probed;
    }
  } catch {
    home = '/';
  }
  const authority = `ssh-remote+${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`;
  // 已 pin 目录时在远端生成 .code-workspace 并整体打开，让原生资源管理器与 AW 的目录集合一致
  let openPath = server.folders?.[0] ?? home;
  if (server.folders && server.folders.length > 0) {
    const wsFile = `${home}/.agent-dock/${server.name.replace(/[^\w.-]+/g, '_')}.code-workspace`;
    const json = JSON.stringify({ folders: server.folders.map((p) => ({ path: p })) }, null, 2);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    try {
      const res = await execRemote(
        server,
        `mkdir -p ${shq(`${home}/.agent-dock`)} && printf %s ${shq(b64)} | base64 -d > ${shq(wsFile)}`,
        15_000,
      );
      if (res.code === 0) {
        openPath = wsFile;
      } else {
        log.child('connect').warn(`workspace file write failed on ${server.name}: ${res.stderr.slice(0, 200)}`);
      }
    } catch (err) {
      log.child('connect').warn(`workspace file write failed on ${server.name}: ${String(err)}`);
    }
  }
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority, path: openPath });
  try {
    // Remote-SSH 是客户端侧扩展，远程窗口的扩展宿主探测不到它，故不做安装检查（踩过的坑）
    await vscode.commands.executeCommand('vscode.openFolder', uri, {
      forceNewWindow: getConnectInNewWindow(),
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      t('Failed to connect to {0}: {1}. Make sure the Remote-SSH extension is installed and ssh key auth works non-interactively.', server.host, String(err)),
    );
  }
}

function validateServerName(v: string): string | undefined {
  if (!v.trim()) {
    return t('Name is required');
  }
  if (getServers().some((s) => s.name === v.trim())) {
    return t('Name already exists');
  }
  return undefined;
}

async function saveServer(server: ServerConfig, provider: WorkspaceProvider): Promise<void> {
  void provider;
  await addServer(server);
  vscode.window.showInformationMessage(t('Server {0} added', server.name));
}
interface HostPick extends vscode.QuickPickItem {
  entry?: SshHostEntry;
  manual?: boolean;
}

/** 二级选择：ssh config 主机列表 + 底部手动输入。 */
async function pickOtherServer(isLocal: boolean, sshHost?: string): Promise<SshHostEntry | 'manual' | undefined> {
  const hosts = await readSshConfigHosts();
  const picks: HostPick[] = hosts.map((h) => ({
    label: h.host,
    description: [h.user ? `${h.user}@` : '', h.hostName ?? '', h.port ? `:${h.port}` : ''].join(''),
    entry: h,
  }));
  picks.push({ label: `$(pencil) ${t('Enter manually…')}`, alwaysShow: true, manual: true });
  const placeHolder = isLocal
    ? t('Parsed from local ~/.ssh/config')
    : t('Parsed from {0}:~/.ssh/config', sshHost ?? 'remote');
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder, matchOnDescription: true });
  if (!chosen) {
    return undefined;
  }
  return chosen.manual ? 'manual' : chosen.entry;
}

async function manualAddServerFlow(provider: WorkspaceProvider): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: t('Server display name (e.g. "remote server1")'),
    placeHolder: 'server1',
    validateInput: validateServerName,
  });
  if (!name) {
    return;
  }
  const host = await vscode.window.showInputBox({
    prompt: t('SSH host (Host alias from ~/.ssh/config, or hostname/IP)'),
    placeHolder: '192.168.1.10 or my-server',
    validateInput: (v) => (v.trim() ? undefined : t('Host is required')),
  });
  if (!host) {
    return;
  }
  const user = await vscode.window.showInputBox({ prompt: t('SSH user (optional)'), placeHolder: 'root' });
  if (user === undefined) {
    return;
  }
  const portStr = await vscode.window.showInputBox({
    prompt: t('SSH port (optional, default 22)'),
    validateInput: (v) => (!v || /^\d+$/.test(v.trim()) ? undefined : t('Port must be a number')),
  });
  if (portStr === undefined) {
    return;
  }
  await saveServer(
    {
      name: name.trim(),
      host: host.trim(),
      user: user.trim() || undefined,
      port: portStr.trim() ? Number(portStr.trim()) : undefined,
    },
    provider,
  );
}

function uniqueServerName(base: string): string {
  const names = new Set(getServers().map((s) => s.name));
  if (!names.has(base)) {
    return base;
  }
  for (let i = 2; ; i++) {
    if (!names.has(`${base}-${i}`)) {
      return `${base}-${i}`;
    }
  }
}

async function ensureServerSaved(entry: SshHostEntry): Promise<ServerConfig> {
  const existing = getServers().find((s) => s.host === entry.host && s.user === entry.user);
  if (existing) {
    return existing;
  }
  const server: ServerConfig = {
    name: uniqueServerName(entry.host),
    host: entry.host,
    user: entry.user,
    port: entry.port,
    folders: [],
  };
  await addServer(server);
  return server;
}

async function addRemoteDirectory(server: ServerConfig, provider: WorkspaceProvider): Promise<void> {
  const probe = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Scanning {0}…', server.host) },
    async () => {
      try {
        const [res, homeRes] = await Promise.all([
          execRemote(server, buildDiscoveryScript(getSessionLimit())),
          execRemote(server, 'echo $HOME', 10_000),
        ]);
        const { sessions } = parseDiscoveryOutput(res.stdout);
        const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].sort();
        return { cwds, home: homeRes.stdout.trim() || '/' };
      } catch {
        return undefined;
      }
    },
  );
  if (probe === undefined) {
    vscode.window.showErrorMessage(
      t('Failed to scan {0} (check ssh key auth works non-interactively)', server.host),
    );
    return;
  }
  const result = await pickDirectory({
    title: t('Add directory on {0}', server.name),
    sessionDirs: probe.cwds,
    listSubdirs: remoteListSubdirs(server),
    homeDir: probe.home,
    // ssh 配置始终解析自客户端，任何服务器的添加目录流程都能转去「连接至其他服务器」
    extraAction: { label: `$(plug) ${t('Connect to another server…')}` },
  });
  if (!result) {
    return;
  }
  if (result.kind === 'action') {
    await addOtherServerFlow(provider);
    return;
  }
  await addServerFolders(server.name, [result.path]);
  vscode.window.showInformationMessage(t('Directory {0} added to {1}', result.path, server.name));
}

async function addOtherServerFlow(provider: WorkspaceProvider): Promise<void> {
  const ctx = getCurrentContext();
  // UI 侧运行时 ssh 配置读的是客户端的，占位提示需一致
  const picked = await pickOtherServer(ctx.isLocal || currentNeedsSsh(), ctx.sshHost);
  if (!picked) {
    return;
  }
  if (picked === 'manual') {
    await manualAddServerFlow(provider);
    return;
  }
  const server = await ensureServerSaved(picked);
  await addRemoteDirectory(server, provider);
}

async function addLocalDirectoryFlow(provider: WorkspaceProvider): Promise<void> {
  const { sessions } = await provider.store.sessionsFor(CURRENT_SERVER_KEY, undefined);
  const wsPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => uriFsPath(f.uri));
  const seen = new Set<string>();
  const cwds: string[] = [];
  for (const s of sessions) {
    if (!s.cwd || seen.has(s.cwd)) {
      continue;
    }
    seen.add(s.cwd);
    if (wsPaths.some((w) => s.cwd === w || s.cwd.startsWith(`${w}/`))) {
      continue;
    }
    cwds.push(s.cwd);
  }
  cwds.sort();

  const needsSsh = currentNeedsSsh();
  const currentServer = needsSsh ? currentServerConfig() : undefined;
  const result = await pickDirectory({
    title: t('Add directory (current server)'),
    sessionDirs: cwds,
    listSubdirs: currentServer ? remoteListSubdirs(currentServer) : localListSubdirs,
    homeDir: needsSsh ? await currentHomeDir() : os.homedir(),
    extraAction: { label: `$(plug) ${t('Connect to another server…')}` },
  });
  if (!result) {
    return;
  }
  if (result.kind === 'action') {
    await addOtherServerFlow(provider);
    return;
  }
  const ok = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
    uri: currentFileUri(result.path),
  });
  if (ok) {
    // 只重绘树、保留缓存：避免全量刷新让已展开的目录状态被重置（onDidChangeWorkspaceFolders 也会再触发一次）
    provider.refreshConfig();
  } else {
    vscode.window.showInformationMessage(t('Directory is already in the workspace'));
  }
}

function resolveTargetServer(provider: WorkspaceProvider, node?: ServerNode): ServerConfig | undefined {
  if (node?.server && !node.isCurrent) {
    return node.server;
  }
  const sel = provider.selectedNode;
  if (!sel) {
    return undefined;
  }
  const key = sel.kind === 'server' ? (sel.isCurrent ? undefined : sel.key) : 'serverKey' in sel ? sel.serverKey : undefined;
  if (!key || key === CURRENT_SERVER_KEY) {
    return undefined;
  }
  return getServers().find((s) => s.name === key);
}

async function addDirectoryFlow(provider: WorkspaceProvider, node?: ServerNode): Promise<void> {
  const target = resolveTargetServer(provider, node);
  if (target) {
    await addRemoteDirectory(target, provider);
    return;
  }
  await addLocalDirectoryFlow(provider);
}

export function registerCommands(context: vscode.ExtensionContext, provider: WorkspaceProvider): void {
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  setOnDidChange((serverName) => provider.refreshPorts(serverName));

  reg('agentDock.refresh', async () => {
    await ensureCurrentServerRegistered();
    provider.refresh();
  });

  reg('agentDock.addServer', (node?: ServerNode) => addDirectoryFlow(provider, node));

  reg('agentDock.removeServer', async (node: ServerNode) => {
    if (!node?.server) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      t('Remove server "{0}" from the list? (The server itself is unaffected)', node.server.name),
      { modal: true },
      t('Remove'),
    );
    if (ok) {
      // 先停掉该服务器的活跃转发（专用 ssh -N 子进程/master 转发），再删配置
      for (const f of node.server.forwards ?? []) {
        try {
          await stopForward(node.server, f);
        } catch (err) {
          log.child('forward').warn(`stop forward on remove failed: ${String(err)}`);
        }
      }
      await removeServer(node.server.name);
    }
  });

  reg('agentDock.connect', async (node: ServerNode) => {
    if (node?.server) {
      await connectToServer(node.server);
    }
  });

  reg('agentDock.connectTerminal', (node: ServerNode) => {
    if (!node?.server) {
      return;
    }
    if (currentNeedsSsh()) {
      openClientTerminal({
        name: `ssh: ${node.server.name}`,
        spec: sshSpawnSpec(node.server),
        persist: { name: `ssh: ${node.server.name}`, kind: 'ssh', serverName: node.server.name },
      });
      return;
    }
    const term = vscode.window.createTerminal({ name: `ssh: ${node.server.name}` });
    const port = node.server.port ? `-p ${node.server.port} ` : '';
    term.sendText(`ssh ${port}${sshDestination(node.server)}`);
    term.show();
  });

  reg('agentDock.openClientTerminal', () => {
    if (currentNeedsSsh()) {
      openClientTerminal({
        name: t('Client Terminal'),
        persist: { name: t('Client Terminal'), kind: 'shell' },
      });
    } else {
      // 本地窗口的原生终端本身就是客户端终端，走原生 profile 体验更好
      vscode.window.createTerminal({ name: t('Client Terminal') }).show();
    }
  });

  reg('agentDock.openSession', async (node: SessionNode) => {
    const target = node ? sessionTarget(node) : undefined;
    if (target) {
      await SessionPanel.show(target, resumeInTerminal);
    }
  });

  reg('agentDock.resumeSession', (node: SessionNode) => {
    const target = node ? sessionTarget(node) : undefined;
    if (target) {
      resumeInTerminal(target);
    }
  });

  reg('agentDock.copySessionId', async (node: SessionNode) => {
    if (node?.session) {
      await vscode.env.clipboard.writeText(node.session.id);
      vscode.window.showInformationMessage(t('Session ID copied: {0}', node.session.id));
    }
  });

  reg('agentDock.fsOpenSide', (node: FsEntryNode) => {
    if (node?.uri) {
      void vscode.commands.executeCommand('vscode.open', node.uri, { viewColumn: vscode.ViewColumn.Beside });
    }
  });

  reg('agentDock.fsCopyPath', async (node: FsEntryNode) => {
    if (node?.uri) {
      await vscode.commands.executeCommand('copyFilePath', node.uri);
    }
  });

  reg('agentDock.fsCopyRelativePath', async (node: FsEntryNode) => {
    if (node?.uri) {
      await vscode.commands.executeCommand('copyRelativeFilePath', node.uri);
    }
  });

  /** 复制本地文件/目录到扩展内剪贴板（配合「粘贴」使用）。 */
  reg('agentDock.fsCopy', (node: FsEntryNode) => {
    if (node?.kind !== 'fsEntry') {
      return;
    }
    copyClipboard = { kind: 'local', uri: node.uri, name: node.name, isDir: node.isDir };
    vscode.window.setStatusBarMessage(t('Copied {0}', node.name), 3000);
  });

  /** 把剪贴板里的本地条目粘贴到目标目录（fsDir 或 workspace 文件夹）。 */
  reg('agentDock.fsPaste', async (node: FsEntryNode | FolderNode) => {
    const dir = targetDirUri(node);
    if (!dir || !copyClipboard || copyClipboard.kind !== 'local') {
      vscode.window.showWarningMessage(t('Nothing copied yet'));
      return;
    }
    const target = vscode.Uri.joinPath(dir, copyClipboard.name);
    try {
      await vscode.workspace.fs.stat(target);
      const ok = await vscode.window.showWarningMessage(
        t('{0} already exists. Overwrite?', copyClipboard.name),
        { modal: true },
        t('Overwrite'),
      );
      if (!ok) {
        return;
      }
    } catch {
      // 目标不存在：正常粘贴
    }
    try {
      await vscode.workspace.fs.copy(copyClipboard.uri, target, { overwrite: true });
      provider.refreshFs();
      vscode.window.setStatusBarMessage(t('Pasted {0}', copyClipboard.name), 3000);
    } catch (err) {
      vscode.window.showErrorMessage(t('Failed to paste {0}: {1}', copyClipboard.name, String(err)));
    }
  });

  reg('agentDock.fsRevealOS', async (node: FsEntryNode) => {
    if (node?.uri) {
      try {
        await vscode.commands.executeCommand('revealFileInOS', node.uri);
      } catch (err) {
        vscode.window.showWarningMessage(t('Reveal in file manager is not available here: {0}', String(err)));
      }
    }
  });

  /** 下载当前服务器文件/目录到客户端磁盘（扩展跑在客户端，workspace.fs 直写本地）。 */
  reg('agentDock.fsDownload', async (node: FsEntryNode) => {
    if (node?.kind !== 'fsEntry') {
      return;
    }
    if (node.isDir) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: t('Download'),
        title: t('Download {0} to…', node.name),
      });
      const dir = picked?.[0];
      if (dir) {
        await copyCurrentToLocal(node.uri, node.name, dir);
      }
      return;
    }
    const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(node.name), saveLabel: t('Download') });
    if (!dest) {
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Downloading {0}', node.name), cancellable: false },
        async () => {
          await vscode.workspace.fs.writeFile(dest, await vscode.workspace.fs.readFile(node.uri));
        },
      );
      vscode.window.setStatusBarMessage(t('Downloaded {0}', node.name), 3000);
    } catch (err) {
      vscode.window.showErrorMessage(t('Failed to download {0}: {1}', node.name, String(err)));
    }
  });

  /** 从客户端选择文件/文件夹上传到当前服务器目录（拖放之外的保底路径）。 */
  reg('agentDock.fsUpload', async (node: FsEntryNode | FolderNode) => {
    const dir = targetDirUri(node);
    if (!dir) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: t('Upload'),
      title: t('Upload to {0}', node?.kind === 'fsEntry' ? node.name : node?.kind === 'folder' ? node.label : ''),
    });
    if (!picked || picked.length === 0) {
      return;
    }
    for (const src of picked) {
      const name = pathBasename(src.path);
      const dest = vscode.Uri.joinPath(dir, name);
      try {
        await vscode.workspace.fs.stat(dest);
        const ok = await vscode.window.showWarningMessage(t('{0} already exists. Overwrite?', name), { modal: true }, t('Overwrite'));
        if (!ok) {
          continue;
        }
      } catch {
        // 目标不存在：正常上传
      }
      try {
        await copyUriRecursive(src, dest);
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to copy {0}: {1}', name, String(err)));
      }
    }
    provider.refreshFs();
  });

  reg('agentDock.fsNewFile', async (node: FsEntryNode | FolderNode, name?: string) => {
    const dir = targetDirUri(node);
    if (!dir) {
      return;
    }
    const fileName = name ?? (await vscode.window.showInputBox({ prompt: t('New file name') }));
    if (!fileName) {
      return;
    }
    const target = vscode.Uri.joinPath(dir, fileName);
    await vscode.workspace.fs.writeFile(target, new Uint8Array());
    provider.refreshNode(node);
    await vscode.window.showTextDocument(target, { preview: false });
  });

  reg('agentDock.fsNewFolder', async (node: FsEntryNode | FolderNode, name?: string) => {
    const dir = targetDirUri(node);
    if (!dir) {
      return;
    }
    const folderName = name ?? (await vscode.window.showInputBox({ prompt: t('New folder name') }));
    if (!folderName) {
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, folderName));
    provider.refreshNode(node);
  });

  reg('agentDock.fsRename', async (node: FsEntryNode, newName?: string) => {
    if (node?.kind !== 'fsEntry') {
      return;
    }
    const name =
      newName ??
      (await vscode.window.showInputBox({ prompt: t('Rename to'), value: node.name }));
    if (!name || name === node.name) {
      return;
    }
    await vscode.workspace.fs.rename(node.uri, vscode.Uri.joinPath(parentUri(node.uri), name));
    if (node.parent) {
      provider.refreshNode(node.parent);
    } else {
      provider.refresh();
    }
  });

  reg('agentDock.fsDelete', async (node: FsEntryNode) => {
    if (node?.kind !== 'fsEntry') {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      t('Delete {0}? This cannot be undone.', node.name),
      { modal: true },
      t('Delete'),
    );
    if (ok) {
      await vscode.workspace.fs.delete(node.uri, { recursive: node.isDir });
      if (node.parent) {
        provider.refreshNode(node.parent);
      } else {
        provider.refresh();
      }
    }
  });

  reg('agentDock.fsOpenTerminal', (node: FsEntryNode | FolderNode) => {
    const dir = targetDirUri(node);
    if (dir) {
      // 原生终端（TerminalOptions）：VSCode persistent sessions 恢复终端本身，但 process revive
      // （完全重启）时名字回落到创建名——交由 trackNativeTerminal 记录并在 reload 后重放名字
      const term = vscode.window.createTerminal({ name: pathBasename(dir.fsPath) || dir.fsPath, cwd: dir.fsPath });
      trackNativeTerminal(term, dir.fsPath);
      term.show();
    }
  });

  reg('agentDock.createSession', async (node: FolderNode, agent?: 'opencode' | 'codex' | 'claude') => {
    if (node?.kind !== 'folder') {
      return;
    }
    const picked =
      agent ??
      (
        await vscode.window.showQuickPick(
          (['opencode', 'codex', 'claude'] as const).map((a) => ({ label: a, description: AGENT_CLI[a].hint })),
          { placeHolder: t('Select an agent backend') },
        )
      )?.label;
    if (!picked) {
      return;
    }
    const cli = AGENT_CLI[picked as 'opencode' | 'codex' | 'claude'].cmd;
    const isRemote = node.serverKey !== CURRENT_SERVER_KEY;
    if (isRemote) {
      const server = getServers().find((s) => s.name === node.serverKey);
      if (!server) {
        return;
      }
      const name = `new: ${picked} · ${pathBasename(node.path)}`;
      if (currentNeedsSsh()) {
        openClientTerminal({
          name,
          spec: sshSpawnSpec(server, `cd ${shq(node.path)} && ${cli}`),
          persist: { name, kind: 'ssh', serverName: server.name, remoteCommand: `cd ${shq(node.path)} && ${cli}` },
        });
        return;
      }
      const port = server.port ? `-p ${server.port} ` : '';
      const term = vscode.window.createTerminal({ name });
      term.sendText(`ssh -t ${port}${sshDestination(server)} ${shq(`cd ${shq(node.path)} && ${cli}`)}`);
      term.show();
    } else {
      const cwd = node.workspaceUri?.fsPath ?? node.path;
      const term = vscode.window.createTerminal({ name: `new: ${picked} · ${node.label}`, cwd });
      term.sendText(cli);
      term.show();
    }
  });

  reg('agentDock.fsRemoveFromWorkspace', (node: FolderNode): boolean => {    if (node?.kind !== 'folder' || !node.workspaceUri) {
      return false;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const index = folders.findIndex((f) => f.uri.toString() === node.workspaceUri!.toString());
    if (index < 0) {
      return false;
    }
    const ok = vscode.workspace.updateWorkspaceFolders(index, 1);
    if (ok) {
      vscode.window.showInformationMessage(t('Removed {0} from the workspace', node.label));
    } else {
      vscode.window.showWarningMessage(
        t('Could not remove {0} programmatically — use "Remove Folder from Workspace" in the Explorer instead', node.label),
      );
    }
    return ok;
  });

  /** 把远程服务器的固定目录从工作区移除（只取消固定，不删除服务器上的真实目录）。 */
  reg('agentDock.remoteFsRemoveFromWorkspace', async (node: FolderNode) => {
    if (node?.kind !== 'folder' || node.workspaceUri) {
      return;
    }
    const server = getServers().find((s) => s.name === node.serverKey);
    if (!server) {
      vscode.window.showErrorMessage(t('Server {0} not found in config', node.serverKey));
      return;
    }
    // 未固定的目录（如其他会话目录派生的 folder 节点）没有可移除的固定项
    if (!(server.folders ?? []).some((f) => normPath(f) === normPath(node.path))) {
      vscode.window.showInformationMessage(t('{0} is not pinned to the workspace of {1}', node.label, server.name));
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      t('Remove {0} from the workspace of {1}? (The directory itself is not deleted)', node.label, server.name),
      { modal: true },
      t('Remove'),
    );
    if (!ok) {
      return;
    }
    await removeServerFolders(node.serverKey, [node.path]);
    // 只重绘树、保留缓存：被移除的目录节点消失，其余目录展开状态不受影响
    provider.refreshConfig();
    vscode.window.showInformationMessage(t('Removed {0} from {1}', node.label, server.name));
  });

  reg('agentDock.portForwardAdd', async (node?: PortsRootNode | ServerNode) => {
    const key =
      node?.kind === 'portsRoot' ? node.serverKey : node?.kind === 'server' && !node.isCurrent ? node.key : undefined;
    const server = key ? getServers().find((s) => s.name === key) : resolveTargetServer(provider);
    if (!server) {
      return;
    }
    const input = await vscode.window.showInputBox({
      prompt: t('Forward spec: localPort:remotePort or localPort:remoteHost:remotePort'),
      placeHolder: '8080:80  ·  13306:db.internal:3306',
      validateInput: (v) =>
        /^\d+:(?:[\w.-]+:)?\d+$/.test(v.trim())
          ? undefined
          : t('Format: localPort:remotePort or localPort:remoteHost:remotePort'),
    });
    if (!input) {
      return;
    }
    const parts = input.trim().split(':');
    const forward: PortForward =
      parts.length === 2
        ? { localPort: Number(parts[0]), remotePort: Number(parts[1]) }
        : { localPort: Number(parts[0]), remoteHost: parts[1], remotePort: Number(parts[2]) };
    const forwards = server.forwards ?? [];
    if (forwards.some((f) => forwardSpec(f) === forwardSpec(forward))) {
      vscode.window.showInformationMessage(t('This forward already exists'));
      return;
    }
    await updateServerForwards(server.name, [...forwards, forward]);
    provider.refreshPorts(server.name);
  });

  reg('agentDock.portForwardStart', async (node: PortForwardNode) => {
    const server = node?.kind === 'portForward' ? getServers().find((s) => s.name === node.serverKey) : undefined;
    if (!server) {
      return;
    }
    const f = node.forward;
    try {
      await startForward(server, f);
      vscode.window.showInformationMessage(
        t(
          'Forwarding localhost:{0} to {1}:{2} via {3}',
          String(f.localPort),
          f.remoteHost ?? 'localhost',
          String(f.remotePort),
          server.name,
        ),
      );
    } catch (err) {
      vscode.window.showErrorMessage(t('Failed to start forwarding: {0}', String(err)));
    }
  });

  reg('agentDock.portForwardStop', async (node: PortForwardNode) => {
    const server = node?.kind === 'portForward' ? getServers().find((s) => s.name === node.serverKey) : undefined;
    if (server) {
      await stopForward(server, node.forward);
    }
  });

  reg('agentDock.portForwardRemove', async (node: PortForwardNode) => {
    const server = node?.kind === 'portForward' ? getServers().find((s) => s.name === node.serverKey) : undefined;
    if (!server) {
      return;
    }
    await stopForward(server, node.forward);
    const spec = forwardSpec(node.forward);
    await updateServerForwards(server.name, (server.forwards ?? []).filter((f) => forwardSpec(f) !== spec));
    provider.refreshPorts(server.name);
  });

  reg('agentDock.openSettings', async () => {
    await vscode.commands.executeCommand('agentDock.settings.focus');
  });

  reg('agentDock.showLog', () => {
    log.show();
  });

  /**
   * 右键远程文件「刷新文件内容」：派发变更事件让已打开的编辑器重读，
   * 并强制 revert（stat 未变化时 VSCode 不会自动重载，覆盖同秒内多次写入的情况）。
   */
  reg('agentDock.remoteFsRefreshFile', async (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry' || node.isDir) {
      return;
    }
    const uri = remoteUri(node.serverKey, node.path);
    remoteFsProvider.notifyChanged(uri);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      try {
        await vscode.window.showTextDocument(open.uri, { preview: false, preserveFocus: true });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      } catch (err) {
        log.child('fs').warn(`forced reload of ${uri.path} failed: ${String(err)}`);
      }
    }
    provider.refreshFs();
    vscode.window.setStatusBarMessage(t('Refreshed {0}', node.name), 3000);
  });

  /** 移动本地文件/目录到其他目录（选择目标目录后 rename；覆盖需确认）。 */
  reg('agentDock.fsMove', async (node: FsEntryNode) => {
    if (node?.kind !== 'fsEntry') {
      return;
    }
    const destDir = await pickLocalMoveTarget(node.name);
    if (!destDir) {
      return;
    }
    const result = await localMove(node.uri, node.name, node.isDir, vscode.Uri.file(destDir));
    if (result === 'ok') {
      provider.refreshFs();
    }
  });

  /** 右键远程目录「刷新」：清缓存重列该目录并重绘树。同时支持已 pin 的远程文件夹节点与本地 workspace 文件夹。 */
  reg('agentDock.remoteFsRefreshDir', async (node: RemoteFsEntryNode | FolderNode) => {
    if (!node) {
      return;
    }
    if (node.kind === 'remoteFsEntry' && node.isDir) {
      await provider.refreshRemoteDir(node.serverKey, node.path);
      return;
    }
    if (node.kind === 'folder') {
      if (node.workspaceUri) {
        // folder.workspace：本地 workspace 文件夹，重读目录并重绘
        provider.refreshFs();
      } else {
        // folder.remote：远程服务器的 pin 目录
        await provider.refreshRemoteDir(node.serverKey, node.path);
      }
    }
  });

  /** 解析远程目录目标：remoteFsDir 或 folder.remote 都适用。 */
  const remoteDirTarget = (node: RemoteFsEntryNode | FolderNode | undefined): { serverKey: string; path: string; name: string } | undefined => {
    if (!node) {
      return undefined;
    }
    if (node.kind === 'remoteFsEntry' && node.isDir) {
      return { serverKey: node.serverKey, path: node.path, name: node.name };
    }
    if (node.kind === 'folder' && !node.workspaceUri) {
      return { serverKey: node.serverKey, path: node.path, name: node.label };
    }
    return undefined;
  };

  /** 执行一条远程文件操作并刷新指定目录；返回 true 表示成功。 */
  const runRemoteFsOp = async (
    serverKey: string,
    refreshPath: string,
    script: string,
    errorMsg: (e: unknown) => string,
  ): Promise<boolean> => {
    const server = getServers().find((s) => s.name === serverKey);
    if (!server) {
      vscode.window.showErrorMessage(t('Server {0} not found in config', serverKey));
      return false;
    }
    try {
      const res = await execRemote(server, script, getSshTimeoutMs());
      if (res.code !== 0) {
        vscode.window.showErrorMessage(errorMsg(res.stderr.trim() || `exit ${res.code}`));
        return false;
      }
    } catch (err) {
      vscode.window.showErrorMessage(errorMsg(String(err)));
      return false;
    }
    await provider.refreshRemoteDir(serverKey, refreshPath);
    return true;
  };

  /** 在远程目录里新建文件（空文件，同名已存在则直接成功）。 */
  reg('agentDock.remoteFsNewFile', async (node: RemoteFsEntryNode | FolderNode) => {
    const target = remoteDirTarget(node);
    if (!target) {
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: t('New file name') });
    if (!name) {
      return;
    }
    await runRemoteFsOp(
      target.serverKey,
      target.path,
      `touch -- ${shq(joinRemotePath(target.path, name))}`,
      (e) => t('Failed to create {0}: {1}', name, String(e)),
    );
  });

  /** 在远程目录里新建文件夹。 */
  reg('agentDock.remoteFsNewFolder', async (node: RemoteFsEntryNode | FolderNode) => {
    const target = remoteDirTarget(node);
    if (!target) {
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: t('New folder name') });
    if (!name) {
      return;
    }
    await runRemoteFsOp(
      target.serverKey,
      target.path,
      `mkdir -p -- ${shq(joinRemotePath(target.path, name))}`,
      (e) => t('Failed to create {0}: {1}', name, String(e)),
    );
  });

  /** 重命名远程文件/目录（ssh mv）。 */
  reg('agentDock.remoteFsRename', async (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry') {
      return;
    }
    const name =
      (await vscode.window.showInputBox({ prompt: t('Rename to'), value: node.name }))?.trim() ?? '';
    if (!name || name === node.name) {
      return;
    }
    const target = joinRemotePath(remoteParentPath(node.path), name);
    await runRemoteFsOp(node.serverKey, remoteParentPath(node.path), `mv -- ${shq(node.path)} ${shq(target)}`, (e) =>
      t('Failed to rename {0}: {1}', node.name, String(e)),
    );
  });

  /** 移动远程文件/目录到同一服务器的其他目录（选择目标目录后 ssh mv；覆盖需确认）。 */
  reg('agentDock.remoteFsMove', async (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry') {
      return;
    }
    const server = getServers().find((s) => s.name === node.serverKey);
    if (!server) {
      vscode.window.showErrorMessage(t('Server {0} not found in config', node.serverKey));
      return;
    }
    const destDir = await pickRemoteMoveTarget(server, node.name);
    if (!destDir) {
      return;
    }
    const result = await remoteMove(node.serverKey, node.path, node.name, node.isDir, destDir);
    if (result === 'ok') {
      await provider.refreshRemoteDir(node.serverKey, remoteParentPath(node.path));
      await provider.refreshRemoteDir(node.serverKey, destDir);
    }
  });

  /** 删除远程文件/目录（ssh rm，带确认）。 */
  reg('agentDock.remoteFsDelete', async (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry') {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      t('Delete {0}? This cannot be undone.', node.name),
      { modal: true },
      t('Delete'),
    );
    if (!ok) {
      return;
    }
    const flag = node.isDir ? '-rf' : '-f';
    await runRemoteFsOp(node.serverKey, remoteParentPath(node.path), `rm ${flag} -- ${shq(node.path)}`, (e) =>
      t('Failed to delete {0}: {1}', node.name, String(e)),
    );
  });

  /** 复制远程文件/目录的完整路径。 */
  reg('agentDock.remoteFsCopyPath', async (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry') {
      return;
    }
    await vscode.env.clipboard.writeText(node.path);
    vscode.window.setStatusBarMessage(t('Copied {0}', node.path), 3000);
  });

  /** 复制远程文件/目录到扩展内剪贴板（配合「粘贴」使用）。 */
  reg('agentDock.remoteFsCopy', (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry') {
      return;
    }
    copyClipboard = { kind: 'remote', serverKey: node.serverKey, path: node.path, name: node.name, isDir: node.isDir };
    vscode.window.setStatusBarMessage(t('Copied {0}', node.name), 3000);
  });

  /** 把剪贴板里的远程条目粘贴到目标远程目录（remoteFsDir 或 folder.remote）。 */
  reg('agentDock.remoteFsPaste', async (node: RemoteFsEntryNode | FolderNode) => {
    const target = remoteDirTarget(node);
    if (!target) {
      return;
    }
    if (!copyClipboard || copyClipboard.kind !== 'remote') {
      vscode.window.showWarningMessage(t('Nothing copied yet'));
      return;
    }
    if (copyClipboard.serverKey !== target.serverKey) {
      vscode.window.showWarningMessage(t('Cannot paste across servers'));
      return;
    }
    const server = getServers().find((s) => s.name === target.serverKey);
    if (!server) {
      return;
    }
    const dest = joinRemotePath(target.path, copyClipboard.name);
    // 目标已存在时先询问是否覆盖（cp 默认直接覆盖）
    const check = await execRemote(server, `[ -e ${shq(dest)} ] && echo EXISTS || echo ABSENT`, 10_000, { quiet: true });
    if (check.stdout.trim() === 'EXISTS') {
      const overwrite = await vscode.window.showWarningMessage(
        t('{0} already exists. Overwrite?', copyClipboard.name),
        { modal: true },
        t('Overwrite'),
      );
      if (!overwrite) {
        return;
      }
    }
    const flag = copyClipboard.isDir ? '-r' : '';
    const done = await runRemoteFsOp(
      target.serverKey,
      target.path,
      `cp ${flag} -- ${shq(copyClipboard.path)} ${shq(dest)}`,
      (e) => t('Failed to paste {0}: {1}', copyClipboard!.name, String(e)),
    );
    if (done) {
      vscode.window.setStatusBarMessage(t('Pasted {0}', copyClipboard.name), 3000);
    }
  });

  /** 下载其他服务器文件/目录到客户端磁盘（SFTP 读 → 客户端写）。 */
  reg('agentDock.remoteFsDownload', async (node: RemoteFsEntryNode) => {
    if (node?.kind !== 'remoteFsEntry') {
      return;
    }
    if (node.isDir) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: t('Download'),
        title: t('Download {0} to…', node.name),
      });
      const dir = picked?.[0];
      if (dir) {
        await copyRemoteToLocal(node.serverKey, node.path, node.name, dir);
      }
      return;
    }
    const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(node.name), saveLabel: t('Download') });
    if (dest) {
      await downloadRemoteToUri(node.serverKey, node.path, dest);
    }
  });

  /** 从客户端选择文件/文件夹上传到其他服务器目录（拖放之外的保底路径）。 */
  reg('agentDock.remoteFsUpload', async (node: RemoteFsEntryNode | FolderNode) => {
    const target = remoteDirTarget(node);
    if (!target) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: t('Upload'),
      title: t('Upload to {0}', target.name),
    });
    if (!picked || picked.length === 0) {
      return;
    }
    for (const src of picked) {
      await copyLocalToRemote(target.serverKey, target.path, src, pathBasename(src.path));
    }
    await provider.refreshRemoteDir(target.serverKey, target.path);
  });

  /** 在远程目录打开客户端 ssh 终端。 */
  reg('agentDock.remoteFsOpenTerminal', (node: RemoteFsEntryNode | FolderNode) => {
    const target = remoteDirTarget(node);
    if (!target) {
      return;
    }
    const server = getServers().find((s) => s.name === target.serverKey);
    if (!server) {
      vscode.window.showErrorMessage(t('Server {0} not found in config', target.serverKey));
      return;
    }
    const name = `ssh: ${server.name} · ${target.name}`;
    const remoteCommand = `cd ${shq(target.path)} && exec "$SHELL" -l`;
    openClientTerminal({ name, spec: sshSpawnSpec(server, remoteCommand), persist: { name, kind: 'ssh', serverName: server.name, remoteCommand } });
  });
}
