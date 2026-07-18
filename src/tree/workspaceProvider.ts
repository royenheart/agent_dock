import * as vscode from 'vscode';
import type { AgentKind, AgentSession, ServerConfig } from '../model';
import { AGENT_LABEL } from '../model';
import { classifyServers, getCurrentContext, getServers, getSessionLimit } from '../config';
import { buildDiscoveryScript } from '../agents/discoveryScript';
import { parseDiscoveryOutput } from '../agents/parse';
import { execLocal, execRemote } from '../ssh/remoteExec';

export const CURRENT_SERVER_KEY = '__current__';

export type Node =
  | { kind: 'server'; key: string; label: string; isCurrent: boolean; server?: ServerConfig }
  | { kind: 'folder'; serverKey: string; path: string; label: string; workspaceUri?: vscode.Uri }
  | { kind: 'sessionsRoot'; serverKey: string; folderPath: string }
  | { kind: 'session'; serverKey: string; session: AgentSession }
  | { kind: 'fsEntry'; uri: vscode.Uri; name: string; isDir: boolean }
  | { kind: 'info'; label: string; severity: 'info' | 'warning' | 'error' | 'loading'; tooltip?: string };

const AGENT_ICON: Record<AgentKind, string> = {
  opencode: 'zap',
  codex: 'hubot',
  claude: 'sparkle',
};

function formatRelative(ms: number): string {
  if (!ms) {
    return '';
  }
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) {
    return '刚刚';
  }
  if (min < 60) {
    return `${min} 分钟前`;
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天前`;
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** Caches per-server session scans; fetch happens lazily on first expand. */
export class SessionStore {
  private cache = new Map<string, AgentSession[]>();
  private errors = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();

  async sessionsFor(key: string, server: ServerConfig | undefined): Promise<{ sessions: AgentSession[]; error?: string }> {
    if (this.cache.has(key)) {
      return { sessions: this.cache.get(key)!, error: this.errors.get(key) };
    }
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.fetch(key, server));
    }
    await this.inflight.get(key);
    return { sessions: this.cache.get(key) ?? [], error: this.errors.get(key) };
  }

  private async fetch(key: string, server: ServerConfig | undefined): Promise<void> {
    try {
      const script = buildDiscoveryScript(getSessionLimit());
      const res = server ? await execRemote(server, script) : await execLocal(script);
      if (res.timedOut) {
        this.errors.set(key, '扫描超时');
        this.cache.set(key, []);
        return;
      }
      const { sessions, notes } = parseDiscoveryOutput(res.stdout);
      this.cache.set(key, sessions);
      if (sessions.length === 0 && res.code !== 0) {
        this.errors.set(key, (res.stderr || res.stdout).slice(0, 500) || `exit code ${res.code}`);
      } else if (notes.length > 0) {
        this.errors.set(key, notes.join('\n'));
      }
    } catch (err) {
      this.errors.set(key, String(err));
      this.cache.set(key, []);
    } finally {
      this.inflight.delete(key);
    }
  }

  invalidate(key?: string): void {
    if (key === undefined) {
      this.cache.clear();
      this.errors.clear();
    } else {
      this.cache.delete(key);
      this.errors.delete(key);
    }
  }
}

export class WorkspaceProvider implements vscode.TreeDataProvider<Node> {
  readonly store = new SessionStore();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  refresh(key?: string): void {
    this.store.invalidate(key);
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'server': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.isCurrent ? 'remote-explorer' : 'server');
        item.contextValue = node.isCurrent ? 'server.current' : 'server.remote';
        item.description = node.isCurrent ? '当前连接' : undefined;
        item.tooltip = node.server
          ? `${node.server.user ? `${node.server.user}@` : ''}${node.server.host}${node.server.port ? `:${node.server.port}` : ''}`
          : node.label;
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = node.workspaceUri ? 'folder.workspace' : 'folder.remote';
        item.tooltip = node.path;
        return item;
      }
      case 'sessionsRoot': {
        const item = new vscode.TreeItem('sessions', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        item.contextValue = 'sessionsRoot';
        return item;
      }
      case 'session': {
        const s = node.session;
        const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(AGENT_ICON[s.agent]);
        item.contextValue = 'session';
        item.description = `${AGENT_LABEL[s.agent]} · ${formatRelative(s.timeUpdated)}`;
        item.tooltip = new vscode.MarkdownString(
          `**${s.title}**\n\n- agent: ${AGENT_LABEL[s.agent]}\n- id: \`${s.id}\`\n- cwd: \`${s.cwd}\`\n- 更新: ${s.timeUpdated ? new Date(s.timeUpdated).toLocaleString() : '-'}`,
        );
        item.command = {
          command: 'agentWorkspace.openSession',
          title: 'Open Transcript',
          arguments: [node],
        };
        return item;
      }
      case 'fsEntry': {
        const item = new vscode.TreeItem(
          node.name,
          node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = node.isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        item.contextValue = node.isDir ? 'fsDir' : 'fsFile';
        item.resourceUri = node.uri;
        if (!node.isDir) {
          item.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [node.uri],
          };
        }
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(
          node.severity === 'loading'
            ? 'loading~spin'
            : node.severity === 'error'
              ? 'error'
              : node.severity === 'warning'
                ? 'warning'
                : 'info',
        );
        item.contextValue = 'info';
        item.tooltip = node.tooltip;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.rootNodes();
    }
    switch (node.kind) {
      case 'server':
        return this.serverChildren(node);
      case 'folder':
        return this.folderChildren(node);
      case 'sessionsRoot':
        return this.sessionsUnder(node.serverKey, node.folderPath);
      case 'fsEntry':
        return node.isDir ? this.dirChildren(node.uri) : [];
      default:
        return [];
    }
  }

  private async rootNodes(): Promise<Node[]> {
    const servers = getServers();
    const { current, remotes } = classifyServers(servers);
    const ctx = getCurrentContext();
    const nodes: Node[] = [];
    if (current) {
      nodes.push({ kind: 'server', key: current.name, label: current.name, isCurrent: true, server: current });
    } else {
      const label = ctx.isLocal ? '本机 (Local)' : (ctx.sshHost ?? '当前服务器');
      nodes.push({ kind: 'server', key: CURRENT_SERVER_KEY, label, isCurrent: true });
    }
    for (const s of remotes) {
      nodes.push({ kind: 'server', key: s.name, label: s.name, isCurrent: false, server: s });
    }
    return nodes;
  }

  private serverConfigFor(key: string): ServerConfig | undefined {
    if (key === CURRENT_SERVER_KEY) {
      return undefined;
    }
    const ctx = getCurrentContext();
    const found = getServers().find((s) => s.name === key);
    // the "current" node may carry a configured server that matches this window
    if (found && ctx.sshHost) {
      const { current } = classifyServers(getServers());
      if (current && current.name === key) {
        return undefined;
      }
    }
    return found;
  }

  private async serverChildren(node: Extract<Node, { kind: 'server' }>): Promise<Node[]> {
    const server = node.isCurrent ? undefined : this.serverConfigFor(node.key);
    const { sessions, error } = await this.store.sessionsFor(node.isCurrent ? CURRENT_SERVER_KEY : node.key, server);

    if (node.isCurrent) {
      return this.currentServerChildren(sessions, error);
    }
    if (error && sessions.length === 0) {
      return [
        { kind: 'info', label: '加载失败', severity: 'error', tooltip: error },
        { kind: 'info', label: error.split('\n')[0].slice(0, 80), severity: 'warning', tooltip: error },
      ];
    }
    const folders = groupByCwd(sessions);
    const nodes: Node[] = folders.map(([cwd]) => ({
      kind: 'folder',
      serverKey: node.key,
      path: cwd,
      label: pathBasename(cwd) || cwd,
    }));
    if (error) {
      nodes.unshift({ kind: 'info', label: '部分数据不可用', severity: 'warning', tooltip: error });
    }
    if (nodes.length === 0) {
      nodes.push({ kind: 'info', label: '未发现 agent 会话', severity: 'info' });
    }
    return nodes;
  }

  private currentServerChildren(sessions: AgentSession[], error?: string): Node[] {
    const nodes: Node[] = [];
    const wsFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    const covered = new Set<string>();

    for (const uri of wsFolders) {
      const fsPath = uri.fsPath;
      const under = sessions.filter((s) => s.cwd && isUnder(s.cwd, fsPath));
      under.forEach((s) => covered.add(s.id + s.agent));
      nodes.push({ kind: 'folder', serverKey: CURRENT_SERVER_KEY, path: fsPath, label: pathBasename(fsPath), workspaceUri: uri });
    }

    const rest = sessions.filter((s) => !covered.has(s.id + s.agent));
    const extra = groupByCwd(rest);
    for (const [cwd] of extra) {
      nodes.push({ kind: 'folder', serverKey: CURRENT_SERVER_KEY, path: cwd, label: pathBasename(cwd) || cwd });
    }

    if (error) {
      nodes.unshift({ kind: 'info', label: '会话扫描警告', severity: 'warning', tooltip: error });
    }
    if (nodes.length === 0) {
      nodes.push({ kind: 'info', label: '无 workspace 目录，也未发现会话', severity: 'info' });
    }
    return nodes;
  }

  private async folderChildren(node: Extract<Node, { kind: 'folder' }>): Promise<Node[]> {
    if (node.workspaceUri) {
      const entries = await this.dirChildren(node.workspaceUri);
      const hasSessions = (await this.sessionsUnder(node.serverKey, node.path)).length > 0;
      if (hasSessions) {
        entries.push({ kind: 'sessionsRoot', serverKey: node.serverKey, folderPath: node.path });
      }
      return entries;
    }
    return this.sessionsUnder(node.serverKey, node.path);
  }

  private async sessionsUnder(serverKey: string, folderPath: string): Promise<Node[]> {
    const server = serverKey === CURRENT_SERVER_KEY ? undefined : this.serverConfigFor(serverKey);
    const { sessions } = await this.store.sessionsFor(serverKey, server);
    return sessions
      .filter((s) => s.cwd && isUnder(s.cwd, folderPath))
      .sort((a, b) => b.timeUpdated - a.timeUpdated)
      .map((s) => ({ kind: 'session', serverKey, session: s }));
  }

  private async dirChildren(uri: vscode.Uri): Promise<Node[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      type FsEntry = Extract<Node, { kind: 'fsEntry' }>;
      const dirs: FsEntry[] = [];
      const files: FsEntry[] = [];
      for (const [name, type] of entries.slice(0, 500)) {
        const child = vscode.Uri.joinPath(uri, name);
        const isDir = (type & vscode.FileType.Directory) !== 0;
        (isDir ? dirs : files).push({ kind: 'fsEntry', uri: child, name, isDir });
      }
      const cmp = (a: FsEntry, b: FsEntry): number => a.name.localeCompare(b.name);
      dirs.sort(cmp);
      files.sort(cmp);
      const out: Node[] = [...dirs, ...files];
      if (entries.length > 500) {
        out.push({ kind: 'info', label: `… 共 ${entries.length} 项，仅显示前 500`, severity: 'info' });
      }
      return out;
    } catch {
      return [{ kind: 'info', label: '目录读取失败', severity: 'warning' }];
    }
  }
}

function groupByCwd(sessions: AgentSession[]): [string, AgentSession[]][] {
  const map = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const key = s.cwd || '/';
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return [...map.entries()].sort(
    (a, b) => Math.max(...b[1].map((s) => s.timeUpdated)) - Math.max(...a[1].map((s) => s.timeUpdated)),
  );
}
