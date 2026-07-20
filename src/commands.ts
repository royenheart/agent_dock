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
import { SessionPanel, type SessionTarget } from './views/sessionPanel';
import type { Node, WorkspaceProvider } from './tree/workspaceProvider';
import { CURRENT_SERVER_KEY } from './tree/workspaceProvider';
import { t } from './i18n';

type ServerNode = Extract<Node, { kind: 'server' }>;
type SessionNode = Extract<Node, { kind: 'session' }>;

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
  const authority = `ssh-remote+${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`;
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority, path: '/' });
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

async function confirmAndSave(
  entry: SshHostEntry,
  provider: WorkspaceProvider,
  folders?: string[],
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: t('Server display name (host: {0})', entry.host),
    value: entry.host,
    validateInput: validateServerName,
  });
  if (!name) {
    return;
  }
  await saveServer({ name: name.trim(), host: entry.host, user: entry.user, port: entry.port, folders }, provider);
}

async function addRemoteDirectoryFlow(entry: SshHostEntry, provider: WorkspaceProvider): Promise<void> {
  const server: ServerConfig = { name: entry.host, host: entry.host, user: entry.user, port: entry.port };
  const dirs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Scanning {0}…', entry.host) },
    async () => {
      try {
        const res = await execRemote(server, buildDiscoveryScript(getSessionLimit()));
        const { sessions } = parseDiscoveryOutput(res.stdout);
        return [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].sort();
      } catch {
        return undefined;
      }
    },
  );
  if (dirs === undefined) {
    vscode.window.showErrorMessage(
      t('Failed to scan {0} (check ssh key auth works non-interactively)', entry.host),
    );
    return;
  }
  const existing = getServers().find((s) => s.host === entry.host && s.user === entry.user);

  if (dirs.length === 0) {
    if (!existing) {
      await confirmAndSave(entry, provider);
    } else {
      vscode.window.showInformationMessage(t('No sessions found on {0}', entry.host));
    }
    return;
  }

  const chosen = await vscode.window.showQuickPick(
    dirs.map((p) => ({ label: `$(folder) ${pathBasename(p)}`, description: p, dir: p })),
    { placeHolder: t('Select a directory on {0}', entry.host) },
  );
  if (!chosen) {
    return;
  }
  if (existing) {
    await addServerFolders(existing.name, [chosen.dir]);
    provider.refresh();
    vscode.window.showInformationMessage(t('Directory {0} added to {1}', chosen.dir, existing.name));
  } else {
    await confirmAndSave(entry, provider, [chosen.dir]);
  }
}

interface DirPick extends vscode.QuickPickItem {
  dir?: string;
  other?: boolean;
}

async function addDirectoryFlow(provider: WorkspaceProvider): Promise<void> {
  const ctx = getCurrentContext();

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

  const picks: DirPick[] = cwds.map((p) => ({ label: `$(folder) ${pathBasename(p)}`, description: p, dir: p }));
  picks.push({ label: `$(plug) ${t('Connect to another server…')}`, alwaysShow: true, other: true });

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: t('Add a directory of the current server to the workspace'),
  });
  if (!chosen) {
    return;
  }
  if (chosen.dir) {
    const ok = vscode.workspace.updateWorkspaceFolders(cwds.length ? (vscode.workspace.workspaceFolders?.length ?? 0) : 0, 0, {
      uri: vscode.Uri.file(chosen.dir),
    });
    if (ok) {
      provider.refresh();
    } else {
      vscode.window.showInformationMessage(t('Directory is already in the workspace'));
    }
    return;
  }

  // 二级：其他服务器（ssh config 主机列表 / 手动输入）
  const picked = await pickOtherServer(ctx.isLocal, ctx.sshHost);
  if (!picked) {
    return;
  }
  if (picked === 'manual') {
    await manualAddServerFlow(provider);
    return;
  }
  await addRemoteDirectoryFlow(picked, provider);
}

export function registerCommands(context: vscode.ExtensionContext, provider: WorkspaceProvider): void {
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  reg('agentWorkspace.refresh', () => provider.refresh());

  reg('agentWorkspace.addServer', () => addDirectoryFlow(provider));

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

  reg('agentWorkspace.openSettings', async () => {
    await vscode.commands.executeCommand('agentWorkspace.settings.focus');
  });
}
