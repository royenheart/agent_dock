import * as os from 'node:os';
import * as fsp from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ServerConfig } from './model';
import {
  addServer,
  addServerFolders,
  getConnectInNewWindow,
  getCurrentContext,
  getServers,
  getSessionLimit,
  removeServer,
} from './config';
import { resumeCommand } from './agents/resume';
import { buildDiscoveryScript } from './agents/discoveryScript';
import { parseDiscoveryOutput } from './agents/parse';
import { execRemote, sshDestination, shq } from './ssh/remoteExec';
import { readSshConfigHosts, type SshHostEntry } from './ssh/sshConfig';
import { pathBasename } from './paths';
import { pickDirectory } from './views/dirPicker';
import { SessionPanel, type SessionTarget } from './views/sessionPanel';
import type { Node, WorkspaceProvider } from './tree/workspaceProvider';
import { CURRENT_SERVER_KEY } from './tree/workspaceProvider';
import { t } from './i18n';

type ServerNode = Extract<Node, { kind: 'server' }>;
type SessionNode = Extract<Node, { kind: 'session' }>;
type FsEntryNode = Extract<Node, { kind: 'fsEntry' }>;
type FolderNode = Extract<Node, { kind: 'folder' }>;

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
  const sshExt = vscode.extensions.getExtension('ms-vscode-remote.remote-ssh');
  if (!sshExt) {
    const choice = await vscode.window.showInformationMessage(
      t('Connecting to remote servers requires the Remote-SSH extension'),
      t('Install Remote-SSH'),
    );
    if (choice) {
      await vscode.env.openExternal(vscode.Uri.parse('vscode:extension/ms-vscode-remote.remote-ssh'));
    }
    return;
  }
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
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority, path: home });
  await vscode.commands.executeCommand('vscode.openFolder', uri, {
    forceNewWindow: getConnectInNewWindow(),
  });
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
  await addServer(server);
  provider.refresh();
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
  });
  if (!result || result.kind !== 'dir') {
    return;
  }
  await addServerFolders(server.name, [result.path]);
  provider.refresh();
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
  provider.refresh();
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

  reg('agentWorkspace.refresh', () => provider.refresh());

  reg('agentWorkspace.addServer', (node?: ServerNode) => addDirectoryFlow(provider, node));

  reg('agentWorkspace.removeServer', async (node: ServerNode) => {
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
      provider.refresh();
    }
  });

  reg('agentWorkspace.connect', async (node: ServerNode) => {
    if (node?.server) {
      await connectToServer(node.server);
    }
  });

  reg('agentWorkspace.connectTerminal', (node: ServerNode) => {
    if (!node?.server) {
      return;
    }
    const term = vscode.window.createTerminal({ name: `ssh: ${node.server.name}` });
    const port = node.server.port ? `-p ${node.server.port} ` : '';
    term.sendText(`ssh ${port}${sshDestination(node.server)}`);
    term.show();
  });

  reg('agentWorkspace.openSession', async (node: SessionNode) => {
    const target = node ? sessionTarget(node) : undefined;
    if (target) {
      await SessionPanel.show(target, resumeInTerminal);
    }
  });

  reg('agentWorkspace.resumeSession', (node: SessionNode) => {
    const target = node ? sessionTarget(node) : undefined;
    if (target) {
      resumeInTerminal(target);
    }
  });

  reg('agentWorkspace.copySessionId', async (node: SessionNode) => {
    if (node?.session) {
      await vscode.env.clipboard.writeText(node.session.id);
      vscode.window.showInformationMessage(t('Session ID copied: {0}', node.session.id));
    }
  });

  reg('agentWorkspace.fsOpenSide', (node: FsEntryNode) => {
    if (node?.uri) {
      void vscode.commands.executeCommand('vscode.open', node.uri, { viewColumn: vscode.ViewColumn.Beside });
    }
  });

  reg('agentWorkspace.fsCopyPath', async (node: FsEntryNode) => {
    if (node?.uri) {
      await vscode.commands.executeCommand('copyFilePath', node.uri);
    }
  });

  reg('agentWorkspace.fsCopyRelativePath', async (node: FsEntryNode) => {
    if (node?.uri) {
      await vscode.commands.executeCommand('copyRelativeFilePath', node.uri);
    }
  });

  reg('agentWorkspace.fsRevealOS', async (node: FsEntryNode) => {
    if (node?.uri) {
      try {
        await vscode.commands.executeCommand('revealFileInOS', node.uri);
      } catch (err) {
        vscode.window.showWarningMessage(t('Reveal in file manager is not available here: {0}', String(err)));
      }
    }
  });

  reg('agentWorkspace.fsNewFile', async (node: FsEntryNode | FolderNode, name?: string) => {
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
    provider.refresh();
    await vscode.window.showTextDocument(target, { preview: false });
  });

  reg('agentWorkspace.fsNewFolder', async (node: FsEntryNode | FolderNode, name?: string) => {
    const dir = targetDirUri(node);
    if (!dir) {
      return;
    }
    const folderName = name ?? (await vscode.window.showInputBox({ prompt: t('New folder name') }));
    if (!folderName) {
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, folderName));
    provider.refresh();
  });

  reg('agentWorkspace.fsRename', async (node: FsEntryNode, newName?: string) => {
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
    provider.refresh();
  });

  reg('agentWorkspace.fsDelete', async (node: FsEntryNode) => {
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
      provider.refresh();
    }
  });

  reg('agentWorkspace.fsOpenTerminal', (node: FsEntryNode | FolderNode) => {
    const dir = targetDirUri(node);
    if (dir) {
      vscode.window.createTerminal({ cwd: dir.fsPath }).show();
    }
  });

  reg('agentWorkspace.createSession', async (node: FolderNode, agent?: 'opencode' | 'codex' | 'claude') => {
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

  reg('agentWorkspace.fsRemoveFromWorkspace', (node: FolderNode): boolean => {    if (node?.kind !== 'folder' || !node.workspaceUri) {
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

  reg('agentWorkspace.openSettings', async () => {
    await vscode.commands.executeCommand('agentWorkspace.settings.focus');
  });
}
