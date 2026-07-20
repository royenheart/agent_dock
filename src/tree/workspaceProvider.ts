import * as vscode from 'vscode';
import type { AgentKind, AgentSession, ServerConfig } from '../model';
import { AGENT_LABEL } from '../model';
import { classifyServers, getCurrentContext, getCurrentDisplayName, getServers, getSessionLimit } from '../config';
import { buildDiscoveryScript } from '../agents/discoveryScript';
import { parseDiscoveryOutput } from '../agents/parse';
import { execLocal, execRemote } from '../ssh/remoteExec';
import { isUnder, normPath, pathBasename, realpathSafe } from '../paths';
import { groupByCwd, partitionSessions } from './structure';
import { t } from '../i18n';

export const CURRENT_SERVER_KEY = '__current__';

export type Node =
  | { kind: 'server'; key: string; label: string; isCurrent: boolean; server?: ServerConfig }
  | { kind: 'folder'; serverKey: string; path: string; label: string; workspaceUri?: vscode.Uri }
  | { kind: 'otherSessions'; serverKey: string }
  | { kind: 'sessionsRoot'; serverKey: string; folderPath: string }
  | { kind: 'session'; serverKey: string; session: AgentSession; children?: Node[] }
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
    return t('just now');
  }
  if (min < 60) {
    return t('{0} min ago', min);
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return t('{0} hours ago', hours);
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return t('{0} days ago', days);
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Caches per-server session scans; fetch happens lazily on first expand. */
export class SessionStore {
  private cache = new Map<string, AgentSession[]>();
  private errors = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();

  onDidSettle?: (key: string) => void;

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
      if (!server) {
        // 本机会话 cwd 做 realpath 归一，避免与 workspace 路径因符号链接不匹配
        await Promise.all(
          sessions.map(async (s) => {
            if (s.cwd) {
              s.cwd = await realpathSafe(s.cwd);
            }
          }),
        );
      }
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
      this.onDidSettle?.(key);
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
  selectedNode?: Node;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private wsPathsCache?: Promise<string[]>;

  refresh(key?: string): void {
    this.wsPathsCache = undefined;
    this.store.invalidate(key);
    this.onDidChangeEmitter.fire(undefined);
  }

  private currentWsPaths(): Promise<string[]> {
    if (!this.wsPathsCache) {
      this.wsPathsCache = Promise.all(
        (vscode.workspace.workspaceFolders ?? []).map((f) => realpathSafe(f.uri.fsPath)),
      );
    }
    return this.wsPathsCache;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'server': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.isCurrent ? 'remote-explorer' : 'server');
        item.contextValue = node.isCurrent ? 'server.current' : 'server.remote';
        item.description = node.isCurrent ? t('connected') : undefined;
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
      case 'otherSessions': {
        const item = new vscode.TreeItem(t('Sessions outside workspace'), vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'otherSessions';
        item.tooltip = t('Sessions whose working directory is not under any workspace folder');
        return item;
      }
      case 'session': {
        const s = node.session;
        const item = new vscode.TreeItem(
          s.title,
          node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(AGENT_ICON[s.agent]);
        item.contextValue = 'session';
        item.description = `${AGENT_LABEL[s.agent]} · ${formatRelative(s.timeUpdated)}${node.children?.length ? ` · ${t('{0} sub-sessions', node.children.length)}` : ''}`;
        item.tooltip = new vscode.MarkdownString(
          `**${s.title}**\n\n- agent: ${AGENT_LABEL[s.agent]}\n- id: \`${s.id}\`\n- cwd: \`${s.cwd}\`\n- ${t('updated')}: ${s.timeUpdated ? new Date(s.timeUpdated).toLocaleString() : '-'}`,
        );
        item.command = {
          command: 'agentDock.openSession',
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
        item.contextValue = node.isDir ? 'fsDir' : 'fsFile';
        // 只设 resourceUri：文件图标主题与全局装饰（git 状态、Problems、AI 徽标）自动生效
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
      case 'otherSessions':
        return this.otherSessionsChildren(node);
      case 'session':
        return node.children ?? [];
      case 'fsEntry':
        return node.isDir ? this.dirChildren(node.uri) : [];
      default:
        return [];
    }
  }

  private async rootNodes(): Promise<Node[]> {
    const servers = getServers();
    const { current, remotes } = classifyServers(servers);
    const nodes: Node[] = [];
    if (current) {
      nodes.push({ kind: 'server', key: current.name, label: current.name, isCurrent: true, server: current });
    } else {
      nodes.push({ kind: 'server', key: CURRENT_SERVER_KEY, label: getCurrentDisplayName(), isCurrent: true });
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
        { kind: 'info', label: t('Failed to load'), severity: 'error', tooltip: error },
        { kind: 'info', label: error.split('\n')[0].slice(0, 80), severity: 'warning', tooltip: error },
      ];
    }
    const pinnedPaths = (node.server?.folders ?? []).map(normPath);
    const nodes: Node[] = pinnedPaths.map((p) => ({
      kind: 'folder',
      serverKey: node.key,
      path: p,
      label: pathBasename(p) || p,
    }));
    const { others } = partitionSessions(sessions, pinnedPaths);
    if (others.length > 0) {
      nodes.push({ kind: 'otherSessions', serverKey: node.key });
    }
    if (error) {
      nodes.unshift({ kind: 'info', label: t('Partial data unavailable'), severity: 'warning', tooltip: error });
    }
    if (nodes.length === 0) {
      nodes.push({ kind: 'info', label: t('No agent sessions found'), severity: 'info' });
    }
    return nodes;
  }

  private async currentServerChildren(sessions: AgentSession[], error?: string): Promise<Node[]> {
    const nodes: Node[] = [];
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const wsPaths = await this.currentWsPaths();
    const { others } = partitionSessions(sessions, wsPaths);

    wsFolders.forEach((f, i) => {
      nodes.push({
        kind: 'folder',
        serverKey: CURRENT_SERVER_KEY,
        path: wsPaths[i],
        label: pathBasename(f.uri.fsPath),
        workspaceUri: f.uri,
      });
    });
    if (others.length > 0) {
      nodes.push({ kind: 'otherSessions', serverKey: CURRENT_SERVER_KEY });
    }

    if (error) {
      nodes.unshift({ kind: 'info', label: t('Session scan warnings'), severity: 'warning', tooltip: error });
    }
    if (nodes.length === 0) {
      nodes.push({ kind: 'info', label: t('No workspace folders and no sessions found'), severity: 'info' });
    }
    return nodes;
  }

  private async otherSessionsChildren(node: Extract<Node, { kind: 'otherSessions' }>): Promise<Node[]> {
    const server = node.serverKey === CURRENT_SERVER_KEY ? undefined : this.serverConfigFor(node.serverKey);
    const { sessions } = await this.store.sessionsFor(node.serverKey, server);
    const pinnedPaths =
      node.serverKey === CURRENT_SERVER_KEY
        ? await this.currentWsPaths()
        : (server?.folders ?? []).map(normPath);
    const { others } = partitionSessions(sessions, pinnedPaths);
    return groupByCwd(others).map((g) => ({
      kind: 'folder',
      serverKey: node.serverKey,
      path: g.folderPath,
      label: pathBasename(g.folderPath) || g.folderPath,
    }));
  }

  private async folderChildren(node: Extract<Node, { kind: 'folder' }>): Promise<Node[]> {
    const sessions = await this.sessionsUnder(node.serverKey, node.path);
    if (node.workspaceUri) {
      const entries = await this.dirChildren(node.workspaceUri);
      if (sessions.length > 0) {
        entries.push({ kind: 'sessionsRoot', serverKey: node.serverKey, folderPath: node.path });
      }
      return entries;
    }
    if (node.serverKey === CURRENT_SERVER_KEY) {
      return sessions.length > 0
        ? [{ kind: 'sessionsRoot', serverKey: node.serverKey, folderPath: node.path }]
        : [];
    }
    return sessions;
  }

  private async sessionsUnder(serverKey: string, folderPath: string): Promise<Node[]> {
    const server = serverKey === CURRENT_SERVER_KEY ? undefined : this.serverConfigFor(serverKey);
    const { sessions } = await this.store.sessionsFor(serverKey, server);
    const list = sessions
      .filter((s) => s.cwd && isUnder(s.cwd, folderPath))
      .sort((a, b) => b.timeUpdated - a.timeUpdated);
    const ids = new Set(list.map((s) => s.id));
    const childrenOf = new Map<string, Node[]>();
    const top: AgentSession[] = [];
    for (const s of list) {
      if (s.parentId && ids.has(s.parentId)) {
        const arr = childrenOf.get(s.parentId) ?? [];
        arr.push({ kind: 'session', serverKey, session: s });
        childrenOf.set(s.parentId, arr);
      } else {
        top.push(s);
      }
    }
    return top.map((s) => ({ kind: 'session', serverKey, session: s, children: childrenOf.get(s.id) }));
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
        out.push({ kind: 'info', label: t('… {0} entries in total, showing the first 500', entries.length), severity: 'info' });
      }
      return out;
    } catch {
      return [{ kind: 'info', label: t('Failed to read directory'), severity: 'warning' }];
    }
  }
}
