import * as vscode from 'vscode';
import type { ServerConfig } from './model';
import { addServer, getConnectInNewWindow, getServers, removeServer } from './config';
import { resumeCommand } from './agents/resume';
import { sshDestination, shq } from './ssh/remoteExec';
import { readSshConfigHosts, type SshHostEntry } from './ssh/sshConfig';
import { SessionPanel, type SessionTarget } from './views/sessionPanel';
import type { Node, WorkspaceProvider } from './tree/workspaceProvider';
import { CURRENT_SERVER_KEY } from './tree/workspaceProvider';

type ServerNode = Extract<Node, { kind: 'server' }>;
type SessionNode = Extract<Node, { kind: 'session' }>;

function sessionTarget(node: SessionNode): SessionTarget | undefined {
  const servers = getServers();
  const server = node.serverKey === CURRENT_SERVER_KEY ? undefined : servers.find((s) => s.name === node.serverKey);
  // 当前窗口可能连接的是配置里的某台服务器——此时"当前"节点用本地执行
  if (node.serverKey !== CURRENT_SERVER_KEY && !server) {
    return undefined;
  }
  const serverLabel = server
    ? `${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`
    : '当前服务器';
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
      '连接远程服务器需要安装 Remote-SSH 扩展',
      '安装 Remote-SSH',
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
    return '名称不能为空';
  }
  if (getServers().some((s) => s.name === v.trim())) {
    return '名称已存在';
  }
  return undefined;
}

async function saveServer(server: ServerConfig, provider: WorkspaceProvider, hint: string): Promise<void> {
  await addServer(server);
  provider.refresh();
  vscode.window.showInformationMessage(`已添加服务器 ${server.name}${hint}`);
}

async function addServerFlow(provider: WorkspaceProvider): Promise<void> {
  interface HostPick extends vscode.QuickPickItem {
    entry?: SshHostEntry;
  }
  const hosts = await readSshConfigHosts();
  const picks: HostPick[] = hosts.map((h) => ({
    label: h.host,
    description: [h.user ? `${h.user}@` : '', h.hostName ?? '', h.port ? `:${h.port}` : ''].join(''),
    entry: h,
  }));
  picks.push({ label: '$(pencil) 手动输入…', description: '不选择 ssh config 中的主机', alwaysShow: true });

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder:
      hosts.length > 0
        ? '从 ~/.ssh/config 选择主机（或手动输入）'
        : '未在 ~/.ssh/config 中找到主机，请选择手动输入',
    matchOnDescription: true,
  });
  if (!chosen) {
    return;
  }

  if (chosen.entry) {
    const e = chosen.entry;
    const name = await vscode.window.showInputBox({
      prompt: `服务器显示名称（host: ${e.host}）`,
      value: e.host,
      validateInput: validateServerName,
    });
    if (!name) {
      return;
    }
    await saveServer({ name: name.trim(), host: e.host, user: e.user, port: e.port }, provider, '（来自 ssh config）');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: '服务器显示名称（如：远程 server1）',
    placeHolder: 'server1',
    validateInput: validateServerName,
  });
  if (!name) {
    return;
  }
  const host = await vscode.window.showInputBox({
    prompt: 'SSH 主机（~/.ssh/config 中的 Host 别名，或主机名/IP）',
    placeHolder: '192.168.1.10 或 my-server',
    validateInput: (v) => (v.trim() ? undefined : '主机不能为空'),
  });
  if (!host) {
    return;
  }
  const user = await vscode.window.showInputBox({ prompt: 'SSH 用户名（可留空）', placeHolder: 'root' });
  if (user === undefined) {
    return;
  }
  const portStr = await vscode.window.showInputBox({
    prompt: 'SSH 端口（可留空，默认 22）',
    validateInput: (v) => (!v || /^\d+$/.test(v.trim()) ? undefined : '端口必须是数字'),
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
    '',
  );
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
      `确定从列表中移除服务器「${node.server.name}」？（不影响服务器本身）`,
      { modal: true },
      '移除',
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
      vscode.window.showInformationMessage(`已复制会话 ID: ${node.session.id}`);
    }
  });

  reg('agentWorkspace.openSettings', async () => {
    await vscode.commands.executeCommand('agentWorkspace.settings.focus');
  });
}
