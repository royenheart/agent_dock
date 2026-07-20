import * as vscode from 'vscode';
import type { ServerConfig } from './model';
import { addServer, getConnectInNewWindow, getCurrentContext, getServers, hostMatches, removeServer } from './config';
import { resumeCommand } from './agents/resume';
import { sshDestination, shq } from './ssh/remoteExec';
import { readSshConfigHosts, type SshHostEntry } from './ssh/sshConfig';
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

async function confirmAndSave(entry: SshHostEntry, provider: WorkspaceProvider): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: t('Server display name (host: {0})', entry.host),
    value: entry.host,
    validateInput: validateServerName,
  });
  if (!name) {
    return;
  }
  await saveServer({ name: name.trim(), host: entry.host, user: entry.user, port: entry.port }, provider);
}

async function addServerFlow(provider: WorkspaceProvider): Promise<void> {
  const ctx = getCurrentContext();
  const currentUnsaved = !ctx.isLocal && ctx.sshHost && !getServers().some((s) => hostMatches(ctx.sshHost!, s));

  // 一级：当前连接的服务器 + 底部「连接至其他服务器」
  if (currentUnsaved && ctx.sshHost) {
    const at = ctx.sshHost.indexOf('@');
    const currentEntry: SshHostEntry = {
      host: at >= 0 ? ctx.sshHost.slice(at + 1) : ctx.sshHost,
      user: at >= 0 ? ctx.sshHost.slice(0, at) : undefined,
    };
    const chosen = await vscode.window.showQuickPick(
      [
        { label: `$(remote) ${ctx.sshHost}`, description: t('Currently connected'), entry: currentEntry },
        { label: `$(plug) ${t('Connect to another server…')}`, alwaysShow: true, manual: true },
      ] as HostPick[],
      { placeHolder: t('Select a server to add') },
    );
    if (!chosen) {
      return;
    }
    if (chosen.entry) {
      await confirmAndSave(chosen.entry, provider);
      return;
    }
  }

  const picked = await pickOtherServer(ctx.isLocal, ctx.sshHost);
  if (!picked) {
    return;
  }
  if (picked === 'manual') {
    await manualAddServerFlow(provider);
    return;
  }
  await confirmAndSave(picked, provider);
}

export function registerCommands(context: vscode.ExtensionContext, provider: WorkspaceProvider): void {
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  reg('agentWorkspace.refresh', () => provider.refresh());

  reg('agentWorkspace.addServer', () => addServerFlow(provider));

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
