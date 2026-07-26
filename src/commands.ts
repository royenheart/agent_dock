import * as os from 'node:os';
import * as fsp from 'node:fs/promises';
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
  removeServer,
  updateServerForwards,
} from './config';
import { resumeCommand } from './agents/resume';
import { buildDiscoveryScript } from './agents/discoveryScript';
import { parseDiscoveryOutput } from './agents/parse';
import { execRemote, sshDestination, shq } from './ssh/remoteExec';
import { forwardSpec, setOnDidChange, startForward, stopForward } from './ssh/portForward';
import { readSshConfigHosts, type SshHostEntry } from './ssh/sshConfig';
import { pathBasename } from './paths';
import { pickDirectory } from './views/dirPicker';
import { SessionPanel, type SessionTarget } from './views/sessionPanel';
import type { Node, WorkspaceProvider } from './tree/workspaceProvider';
import { CURRENT_SERVER_KEY } from './tree/workspaceProvider';
import { t } from './i18n';
import { log } from './log';

type ServerNode = Extract<Node, { kind: 'server' }>;
type SessionNode = Extract<Node, { kind: 'session' }>;
type FsEntryNode = Extract<Node, { kind: 'fsEntry' }>;
type FolderNode = Extract<Node, { kind: 'folder' }>;
type PortsRootNode = Extract<Node, { kind: 'portsRoot' }>;
type PortForwardNode = Extract<Node, { kind: 'portForward' }>;

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
  const term = vscode.window.createTerminal({
    name: `${session.agent}: ${session.title.slice(0, 20)}`,
  });
  const full = session.cwd ? `cd ${shq(session.cwd)} && ${cmd}` : cmd;
  if (server) {
    const port = server.port ? `-p ${server.port} ` : '';
    term.sendText(`ssh -t ${port}${sshDestination(server)} ${shq(full)}`);
  } else {
    term.sendText(full);
  }
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
        log.warn(`[connect] workspace file write failed on ${server.name}: ${res.stderr.slice(0, 200)}`);
      }
    } catch (err) {
      log.warn(`[connect] workspace file write failed on ${server.name}: ${String(err)}`);
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

async function localListSubdirs(path: string): Promise<string[] | undefined> {
  try {
    const entries = await fsp.readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }
}

function remoteListSubdirs(server: ServerConfig): (path: string) => Promise<string[] | undefined> {
  return async (path: string) => {
    const res = await execRemote(server, `ls -1Ap ${shq(path)} 2>/dev/null | grep '/$' | sed 's|/$||'`, 15_000);
    if (res.code !== 0 && !res.stdout.trim()) {
      return undefined;
    }
    return res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  };
}

async function addRemoteDirectory(server: ServerConfig, _provider: WorkspaceProvider): Promise<void> {
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
  });
  if (!result || result.kind !== 'dir') {
    return;
  }
  await addServerFolders(server.name, [result.path]);
  vscode.window.showInformationMessage(t('Directory {0} added to {1}', result.path, server.name));
}

async function addOtherServerFlow(provider: WorkspaceProvider): Promise<void> {
  const ctx = getCurrentContext();
  const picked = await pickOtherServer(ctx.isLocal, ctx.sshHost);
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
  const wsPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
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

  const result = await pickDirectory({
    title: t('Add directory (current server)'),
    sessionDirs: cwds,
    listSubdirs: localListSubdirs,
    homeDir: os.homedir(),
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
    uri: vscode.Uri.file(result.path),
  });
  if (ok) {
    provider.refresh();
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

  setOnDidChange(() => provider.refreshFs());

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
    const term = vscode.window.createTerminal({ name: `ssh: ${node.server.name}` });
    const port = node.server.port ? `-p ${node.server.port} ` : '';
    term.sendText(`ssh ${port}${sshDestination(node.server)}`);
    term.show();
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

  reg('agentDock.fsRevealOS', async (node: FsEntryNode) => {
    if (node?.uri) {
      try {
        await vscode.commands.executeCommand('revealFileInOS', node.uri);
      } catch (err) {
        vscode.window.showWarningMessage(t('Reveal in file manager is not available here: {0}', String(err)));
      }
    }
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
      vscode.window.createTerminal({ cwd: dir.fsPath }).show();
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
      const port = server.port ? `-p ${server.port} ` : '';
      const term = vscode.window.createTerminal({ name: `new: ${picked} · ${pathBasename(node.path)}` });
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
    provider.refresh();
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
    provider.refresh();
  });

  reg('agentDock.openSettings', async () => {
    await vscode.commands.executeCommand('agentDock.settings.focus');
  });

  reg('agentDock.showLog', () => {
    log.show();
  });
}
