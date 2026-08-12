import * as vscode from 'vscode';
import type { AgentKind, AgentSession, PortForward, ServerConfig } from '../model';
import { AGENT_LABEL } from '../model';
import { classifyServers, getCurrentContext, getCurrentDisplayName, getServers, getSessionLimit, getSshTimeoutMs } from '../config';
import { buildDiscoveryScript } from '../agents/discoveryScript';
import { parseDiscoveryOutput } from '../agents/parse';
import { execRemote, shq } from '../ssh/remoteExec';
import { execRemoteSmart } from '../ssh/progress';
import { getRemoteAutoRefresh, getRemoteWatchIntervalMs } from '../config';
import { currentWindowId, execCurrent, realpathCurrent } from '../ssh/currentExec';
import { detectListeningServices, isForwardActive, type ListeningService } from '../ssh/portForward';
import { joinRemotePath, remoteUri } from '../ssh/remoteFsProvider';
import { parseLsAp } from '../ssh/remoteFsParse';
import { parseDirMtimeLine } from '../ssh/remoteFsPoll';
import { isUnder, normPath, pathBasename, uriFsPath } from '../paths';
import { buildSessionTree, groupByCwd, partitionSessions, touchLru, type SessionTreeNode } from './structure';
import { createSerialQueue } from '../batch';
import { t } from '../i18n';
import { log } from '../log';

export const CURRENT_SERVER_KEY = '__current__';

export type Node =
  | { kind: 'server'; key: string; label: string; isCurrent: boolean; server?: ServerConfig }
  | { kind: 'folder'; serverKey: string; path: string; label: string; workspaceUri?: vscode.Uri }
  | { kind: 'otherSessions'; serverKey: string }
  | { kind: 'sessionsRoot'; serverKey: string; folderPath: string }
  | { kind: 'session'; serverKey: string; session: AgentSession; children?: Node[] }
  | { kind: 'fsEntry'; uri: vscode.Uri; name: string; isDir: boolean; parent?: Node }
  | { kind: 'remoteFsEntry'; serverKey: string; path: string; name: string; isDir: boolean; parent?: Node }
  | { kind: 'portsRoot'; serverKey: string }
  | { kind: 'portForward'; serverKey: string; forward: PortForward; service?: string; parent?: Node }
  | { kind: 'info'; label: string; severity: 'info' | 'warning' | 'error' | 'loading'; tooltip?: string };

/**
 * 每个节点的稳定唯一 id（跨 reload 不变）。VSCode 用 TreeItem.id 保留展开/选中状态，
 * 未提供时按 label 生成——label 一变状态就丢；这里显式给出与内容绑定的 id。
 */
export function nodeId(node: Node): string {
  switch (node.kind) {
    case 'server':
      return `server:${node.key}`;
    case 'folder':
      return `folder:${node.serverKey}:${node.path}`;
    case 'otherSessions':
      return `otherSessions:${node.serverKey}`;
    case 'sessionsRoot':
      return `sessionsRoot:${node.serverKey}:${node.folderPath}`;
    case 'session':
      return `session:${node.serverKey}:${node.session.id}`;
    case 'fsEntry':
      // 整个 uri.toString() 做 encodeURIComponent：nodeFromId 还原时保证与
      // joinPath 生成的原始字符串完全一致（避免 Uri.parse 的编码规范化导致 handle 失配）
      return `fs:${encodeURIComponent(node.uri.toString())}`;
    case 'remoteFsEntry':
      return `remoteFs:${node.serverKey}:${node.path}`;
    case 'portsRoot':
      return `portsRoot:${node.serverKey}`;
    case 'portForward':
      return `portForward:${node.serverKey}:${forwardSpecId(node.forward)}`;
    case 'info':
      return `info:${node.label}:${node.severity}`;
  }
}

function forwardSpecId(f: PortForward): string {
  return `${f.localPort}:${f.remoteHost ?? 'localhost'}:${f.remotePort}`;
}

/**
 * 从 nodeId 反解出最小 Node 对象（供 reveal 恢复展开状态用）。
 * nodeId 是稳定的，但可能含 ':' —— 用前缀 + 定界解析。
 */
export function nodeFromId(id: string): Node | undefined {
  const [kind, ...rest] = id.split(':');
  switch (kind) {
    case 'server':
      return { kind: 'server', key: rest.join(':'), label: rest.join(':'), isCurrent: rest.join(':') === CURRENT_SERVER_KEY };
    case 'folder':
      return { kind: 'folder', serverKey: rest[0], path: rest.slice(1).join(':'), label: pathBasename(rest.slice(1).join(':')) };
    case 'otherSessions':
      return { kind: 'otherSessions', serverKey: rest.join(':') };
    case 'sessionsRoot':
      return { kind: 'sessionsRoot', serverKey: rest[0], folderPath: rest.slice(1).join(':') };
    case 'remoteFs':
      return { kind: 'remoteFsEntry', serverKey: rest[0], path: rest.slice(1).join(':'), name: pathBasename(rest.slice(1).join(':')), isDir: true };
    case 'fs': {
      // id 里 fs 段是 encodeURIComponent 后的完整 uri.toString()，原样还原
      const uriStr = decodeURIComponent(rest.join(':'));
      const uri = vscode.Uri.parse(uriStr);
      return { kind: 'fsEntry', uri, name: pathBasename(uriFsPath(uri)), isDir: true };
    }
    case 'portsRoot':
      return { kind: 'portsRoot', serverKey: rest.join(':') };
    default:
      return undefined;
  }
}

/** 从节点自身推导父节点（getParent 用；父节点只需携带足够的 id 信息供 getTreeItem 渲染）。 */
export function nodeParent(node: Node): Node | undefined {
  switch (node.kind) {
    case 'server':
      return undefined;
    case 'folder':
      return {
        kind: 'server',
        key: node.serverKey,
        label: node.serverKey === CURRENT_SERVER_KEY ? t('Current server') : node.serverKey,
        isCurrent: node.serverKey === CURRENT_SERVER_KEY,
      };
    case 'otherSessions':
      return { kind: 'server', key: node.serverKey, label: node.serverKey, isCurrent: node.serverKey === CURRENT_SERVER_KEY };
    case 'sessionsRoot':
      return { kind: 'folder', serverKey: node.serverKey, path: node.folderPath, label: pathBasename(node.folderPath) || node.folderPath };
    case 'session': {
      if (node.session.parentId) {
        return {
          kind: 'session',
          serverKey: node.serverKey,
          session: { ...node.session, id: node.session.parentId, title: '', cwd: node.session.cwd },
        };
      }
      return { kind: 'sessionsRoot', serverKey: node.serverKey, folderPath: node.session.cwd ?? node.serverKey };
    }
    case 'fsEntry': {
      const parentUri = vscode.Uri.joinPath(node.uri, '..');
      const wsFolder = vscode.workspace.workspaceFolders?.find((f) => f.uri.toString() === parentUri.toString());
      if (wsFolder) {
        return {
          kind: 'folder',
          serverKey: CURRENT_SERVER_KEY,
          path: uriFsPath(parentUri),
          label: pathBasename(uriFsPath(parentUri)),
          workspaceUri: parentUri,
        };
      }
      return { kind: 'fsEntry', uri: parentUri, name: pathBasename(uriFsPath(parentUri)), isDir: true };
    }
    case 'remoteFsEntry': {
      const parentPath = remoteParentOf(node.path);
      if (parentPath === undefined) {
        // 已在远程目录顶层：父是 pin 的 folder 节点（serverKey + 根路径）
        return { kind: 'folder', serverKey: node.serverKey, path: node.path, label: pathBasename(node.path) || node.path };
      }
      return { kind: 'remoteFsEntry', serverKey: node.serverKey, path: parentPath, name: pathBasename(parentPath), isDir: true };
    }
    case 'portsRoot':
      return { kind: 'server', key: node.serverKey, label: node.serverKey, isCurrent: node.serverKey === CURRENT_SERVER_KEY };
    case 'portForward':
      return { kind: 'portsRoot', serverKey: node.serverKey };
    case 'info':
      return undefined;
  }
}

/** 远程路径的父目录（根路径返回 undefined 表示已是顶层，父为 folder 节点）。 */
function remoteParentOf(path: string): string | undefined {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? undefined : path.slice(0, idx);
}

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
  private stale = new Set<string>();
  private memento?: vscode.Memento;
  /** 持久化串行化：并发 update 完成顺序不定会以旧快照覆盖新快照 */
  private readonly persistQueue = createSerialQueue();

  onDidSettle?: (key: string) => void;

  initPersistence(memento: vscode.Memento): void {
    this.memento = memento;
    const savedWindowId = memento.get<string>('agentDock.currentWindowId.v1');
    const saved = memento.get<Record<string, { sessions: AgentSession[]; error?: string }>>('agentDock.sessionCache.v1', {});
    for (const [key, entry] of Object.entries(saved)) {
      // 全局态存于客户端后 __current__ 快照会跨窗口共享，仅当它属于本窗口所属机器时才恢复
      if (key === CURRENT_SERVER_KEY && savedWindowId !== undefined && savedWindowId !== currentWindowId()) {
        continue;
      }
      if (Array.isArray(entry.sessions) && entry.sessions.length > 0) {
        this.cache.set(key, entry.sessions);
        this.stale.add(key);
        if (entry.error) {
          this.errors.set(key, entry.error);
        }
      }
    }
    if (this.stale.size > 0) {
      log.child('cache').info(`restored session snapshots for ${this.stale.size} server(s)`);
    }
  }

  async persist(): Promise<void> {
    if (!this.memento) {
      return;
    }
    const out: Record<string, { sessions: AgentSession[]; error?: string }> = {};
    for (const [key, sessions] of this.cache) {
      out[key] = { sessions: sessions.slice(0, 300), error: this.errors.get(key) };
    }
    const memento = this.memento;
    return this.persistQueue(async () => {
      await memento.update('agentDock.sessionCache.v1', out);
      await memento.update('agentDock.currentWindowId.v1', currentWindowId());
    }).catch((err) => log.child('cache').warn(`session cache persist failed: ${String(err)}`));
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  isStale(key: string): boolean {
    return this.stale.has(key);
  }

  revalidate(key: string, server: ServerConfig | undefined): void {
    if (this.inflight.has(key)) {
      return;
    }
    log.child('cache').debug(`revalidating ${key}`);
    this.inflight.set(key, this.fetch(key, server));
  }

  isLoading(key: string): boolean {
    return this.inflight.has(key);
  }

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
    const started = Date.now();
    try {
      const script = buildDiscoveryScript(getSessionLimit());
      const res = server
        ? await execRemoteSmart(server, script, {
            timeoutMs: getSshTimeoutMs(),
            title: t('Scanning sessions on {0}…', server.name),
          })
        : await execCurrent(script, getSshTimeoutMs());
      if (res.cancelled) {
        this.errors.set(key, t('Scan skipped by user'));
        this.cache.set(key, []);
        return;
      }
      if (res.timedOut) {
        this.errors.set(key, t('Scan timed out'));
        this.cache.set(key, []);
        return;
      }
      const { sessions, notes } = parseDiscoveryOutput(res.stdout);
      if (!server) {
        // 本机会话 cwd 做 realpath 归一，避免与 workspace 路径因符号链接不匹配
        const cwds = sessions.map((s) => s.cwd).filter((c): c is string => !!c);
        const resolved = await realpathCurrent(cwds);
        let i = 0;
        for (const s of sessions) {
          if (s.cwd) {
            s.cwd = resolved[i++];
          }
        }
      }
      this.cache.set(key, sessions);
      void this.persist();
      if (sessions.length === 0 && res.code !== 0) {
        this.errors.set(key, (res.stderr || res.stdout).slice(0, 500) || `exit code ${res.code}`);
      } else if (notes.length > 0) {
        this.errors.set(key, notes.join('\n'));
      }
      const byAgent = sessions.reduce<Record<string, number>>((m, s) => {
        m[s.agent] = (m[s.agent] ?? 0) + 1;
        return m;
      }, {});
      log.info(
        `[scan] ${server ? server.name : 'local'} → ${sessions.length} sessions (${Object.entries(byAgent)
          .map(([a, n]) => `${a}:${n}`)
          .join(', ')}) in ${Date.now() - started}ms`,
      );
    } catch (err) {
      log.child('scan').error(`${server ? server.name : 'local'} failed: ${String(err)}`);
      this.errors.set(key, String(err));
      this.cache.set(key, []);
    } finally {
      this.stale.delete(key);
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
    void this.persist();
  }
}

export class WorkspaceProvider implements vscode.TreeDataProvider<Node> {
  readonly store = new SessionStore();
  selectedNode?: Node;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private wsPathsCache?: Promise<string[]>;

  constructor() {
    this.store.onDidSettle = () => this.onDidChangeEmitter.fire(undefined);
  }

  refresh(key?: string): void {
    this.wsPathsCache = undefined;
    this.remoteDirCache.clear();
    this.dirMtimes.clear();
    void this.persistRemoteDirCache();
    this.store.invalidate(key);
    void this.store.persist();
    this.onDidChangeEmitter.fire(undefined);
  }

  /**
   * 配置变更专用刷新：保留会话缓存与远程目录缓存（folders/forwards/服务器列表的变化
   * 由 getChildren 重新读取配置即可），只重绘树。相比 refresh() 不触发会话重扫与
   * 远程目录全量重拉——否则「添加目录」等配置写入会让已展开的目录状态被重置
   * （子树短暂消失 / 展开态丢失）。
   */
  refreshConfig(): void {
    this.wsPathsCache = undefined;
    this.onDidChangeEmitter.fire(undefined);
  }

  refreshNode(node?: Node): void {
    this.onDidChangeEmitter.fire(node);
  }

  /**
   * 端口子树局部刷新：TreeView 的 onDidChangeTreeData(element) 按对象身份匹配现存节点，
   * 而节点每次 getChildren 都重建、无法跨调用保持实例，新建字面量会被静默忽略；
   * 这里回退为全量重绘，保证转发启停/增删后状态图标可靠更新。
   */
  refreshPorts(serverKey: string): void {
    void serverKey;
    this.onDidChangeEmitter.fire(undefined);
  }

  /** 文件系统变化专用：只重绘树，不触碰会话缓存与远程目录缓存（配合 FileSystemWatcher 实时刷新） */
  refreshFs(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  private currentWsPaths(): Promise<string[]> {
    if (!this.wsPathsCache) {
      this.wsPathsCache = realpathCurrent((vscode.workspace.workspaceFolders ?? []).map((f) => uriFsPath(f.uri)));
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
        item.id = nodeId(node);
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = node.workspaceUri ? 'folder.workspace' : 'folder.remote';
        item.tooltip = node.path;
        item.id = nodeId(node);
        return item;
      }
      case 'sessionsRoot': {
        const item = new vscode.TreeItem('sessions', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        item.contextValue = 'sessionsRoot';
        item.id = nodeId(node);
        return item;
      }
      case 'otherSessions': {
        const item = new vscode.TreeItem(t('Sessions outside workspace'), vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'otherSessions';
        item.tooltip = t('Sessions whose working directory is not under any workspace folder');
        item.id = nodeId(node);
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
        item.id = nodeId(node);
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
        item.id = nodeId(node);
        return item;
      }
      case 'remoteFsEntry': {
        const item = new vscode.TreeItem(
          node.name,
          node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = node.isDir ? 'remoteFsDir' : 'remoteFsFile';
        item.iconPath = node.isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        item.tooltip = t('Live file on {0} (auto-refreshes, editable)', node.serverKey);
        if (!node.isDir) {
          const uri = remoteUri(node.serverKey, node.path);
          item.resourceUri = uri;
          item.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
        }
        item.id = nodeId(node);
        return item;
      }
      case 'portsRoot': {
        const item = new vscode.TreeItem(t('Port forwards'), vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('plug');
        item.contextValue = 'portsRoot';
        item.tooltip = t('SSH local port forwarding via {0}', node.serverKey);
        item.id = nodeId(node);
        return item;
      }
      case 'portForward': {
        const f = node.forward;
        const target = `${f.remoteHost ?? 'localhost'}:${f.remotePort}`;
        const local = `localhost:${f.localPort}`;
        const activeNow = isForwardActive(node.serverKey, f);
        const item = new vscode.TreeItem(`${target} → ${local}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('radio-tower');
        item.contextValue = activeNow ? 'portForward.active' : 'portForward.inactive';
        item.description = [activeNow ? t('forwarding') : undefined, node.service].filter(Boolean).join(' · ') || undefined;
        // MarkdownString 走 workbench 富文本 hover，悬停期间持续显示（纯字符串 tooltip 会一闪而过）
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${target} → ${local}**\n\n`);
        md.appendMarkdown(`- ${t('Server')}: ${node.serverKey}\n`);
        md.appendMarkdown(`- ${t('Local address')}: \`${local}\`\n`);
        md.appendMarkdown(`- ${t('Target')}: \`${target}\` ${t('(via {0})', node.serverKey)}\n`);
        md.appendMarkdown(`- ${t('Status')}: ${activeNow ? t('forwarding') : t('not started')}\n`);
        if (node.service) {
          md.appendMarkdown(`- ${t('Service')}: \`${node.service}\`\n`);
        }
        item.tooltip = md;
        item.id = nodeId(node);
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
        item.id = nodeId(node);
        return item;
      }
    }
  }

  /**
   * 展开状态恢复的基石：VSCode 在 reload 后靠 TreeItem.id + getParent 重建展开路径。
   * 节点每次 getChildren 都是新对象，必须用稳定 id（nodeId）而非对象身份匹配。
   */
  getParent(node: Node): Node | undefined {
    const p = nodeParent(node);
    log.child('tree').debug(`getParent ${node.kind} id=${nodeId(node)} -> ${p ? `${p.kind} id=${nodeId(p)}` : 'undefined'}`);
    return p;
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
        return node.isDir ? this.dirChildren(node.uri, node) : [];
      case 'remoteFsEntry':
        return node.isDir ? this.remoteDirChildren(node.serverKey, node.path, node) : [];
      case 'portsRoot':
        return this.portsChildren(node);
      default:
        return [];
    }
  }

  private async rootNodes(): Promise<Node[]> {
    const servers = getServers();
    const { current, remotes } = classifyServers(servers);
    const nodes: Node[] = [];
    // 当前服务器的 key 恒为 CURRENT_SERVER_KEY：folder/otherSessions/portsRoot 的 serverKey
    // 都是它，nodeParent 推导的父 server id 才能与树中实际 server 节点一致（reveal 恢复展开状态的前提）
    const currentServer: Node = {
      kind: 'server',
      key: CURRENT_SERVER_KEY,
      label: current ? current.name : getCurrentDisplayName(),
      isCurrent: true,
      server: current,
    };
    nodes.push(currentServer);
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
    const key = node.isCurrent ? CURRENT_SERVER_KEY : node.key;
    if (!this.store.has(key)) {
      if (!this.store.isLoading(key)) {
        void this.store.sessionsFor(key, server);
      }
      return [{ kind: 'info', label: t('Loading sessions…'), severity: 'loading' }];
    }
    if (this.store.isStale(key)) {
      this.store.revalidate(key, server);
    }
    const { sessions, error } = await this.store.sessionsFor(key, server);

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
    // 当前服务器的转发由原生「端口」视图负责，这里只给远程服务器挂转发管理
    nodes.push({ kind: 'portsRoot', serverKey: node.key });
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
        label: pathBasename(uriFsPath(f.uri)),
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

  private async portsChildren(node: Extract<Node, { kind: 'portsRoot' }>): Promise<Node[]> {
    const server = this.serverConfigFor(node.serverKey);
    const forwards = server?.forwards ?? [];
    if (forwards.length === 0) {
      return [{ kind: 'info', label: t('No port forwards (right-click to add)'), severity: 'info' }];
    }
    let services = new Map<number, ListeningService>();
    if (server) {
      try {
        services = await detectListeningServices(server);
      } catch (err) {
        log.child('forward').debug(`service detection failed on ${server.name}: ${String(err)}`);
      }
    }
    // 目标是其他主机时服务不在本服务器上，无法从 ss 输出识别
    return forwards.map((forward) => ({
      kind: 'portForward',
      serverKey: node.serverKey,
      forward,
      service: forward.remoteHost ? undefined : services.get(forward.remotePort)?.name || undefined,
      parent: node,
    }));
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
      const entries = await this.dirChildren(node.workspaceUri, node);
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
    const entries = await this.remoteDirChildren(node.serverKey, node.path, node);
    if (sessions.length > 0) {
      entries.push({ kind: 'sessionsRoot', serverKey: node.serverKey, folderPath: node.path });
    }
    return entries;
  }

  private async sessionsUnder(serverKey: string, folderPath: string): Promise<Node[]> {
    const server = serverKey === CURRENT_SERVER_KEY ? undefined : this.serverConfigFor(serverKey);
    const { sessions } = await this.store.sessionsFor(serverKey, server);
    const list = sessions
      .filter((s) => s.cwd && isUnder(s.cwd, folderPath))
      .sort((a, b) => b.timeUpdated - a.timeUpdated);
    // 递归树：深度 ≥2 的嵌套会话不再丢失
    const toNode = (n: SessionTreeNode): Node => ({
      kind: 'session',
      serverKey,
      session: n.session,
      children: n.children.map(toNode),
    });
    return buildSessionTree(list).map(toNode);
  }

  private remoteDirCache = new Map<string, Node[]>();
  private staleDirs = new Set<string>();
  private memento?: vscode.Memento;

  /** 最近展开的远程目录：轮询其 mtime 检测条目增删，变化即重列并重绘树。 */
  private expandedDirs = new Map<string, { serverKey: string; path: string }>();
  private dirMtimes = new Map<string, number>();
  private dirPollTimer?: NodeJS.Timeout;
  private dirPolling = false;
  /** 树视图是否可见：不可见时暂停目录轮询，避免后台无谓的 ssh 流量与日志刷屏。 */
  private viewVisible = true;
  /** 展开目录 LRU 上限：折叠目录经 onDidCollapseElement 移除，上限仅作内存兜底。 */
  private static readonly MAX_EXPANDED_DIRS = 1000;
  private readonly persistDirCacheQueue = createSerialQueue();
  private lastPersistedDirCacheJson = '';

  /** 视图可见性变化：不可见立即停表，恢复可见时重新调度（配合 onDidChangeVisibility）。 */
  setViewVisible(visible: boolean): void {
    this.viewVisible = visible;
    if (!visible) {
      if (this.dirPollTimer) {
        clearTimeout(this.dirPollTimer);
        this.dirPollTimer = undefined;
      }
    } else {
      this.ensureDirPolling();
    }
  }

  /** 目录被折叠：移出轮询集合，后续不再为其发 stat 请求（TreeView 有 onDidCollapseElement 回调）。 */
  onCollapse(node: Node): void {
    let key: string | undefined;
    if (node.kind === 'remoteFsEntry' && node.isDir) {
      key = `${node.serverKey}:${node.path}`;
    } else if (node.kind === 'folder' && !node.workspaceUri) {
      key = `${node.serverKey}:${node.path}`;
    }
    if (key !== undefined) {
      this.expandedDirs.delete(key);
      this.dirMtimes.delete(key);
    }
  }

  private touchExpandedDir(serverKey: string, path: string): void {
    const key = `${serverKey}:${path}`;
    const evicted = touchLru(this.expandedDirs, key, { serverKey, path }, WorkspaceProvider.MAX_EXPANDED_DIRS);
    if (evicted !== undefined) {
      this.dirMtimes.delete(evicted);
    }
  }

  initPersistence(memento: vscode.Memento): void {
    this.memento = memento;
    this.store.initPersistence(memento);
    const saved = memento.get<Record<string, Node[]>>('agentDock.remoteDirCache.v1', {});
    for (const [key, nodes] of Object.entries(saved)) {
      if (Array.isArray(nodes)) {
        this.remoteDirCache.set(key, nodes);
        this.staleDirs.add(key);
      }
    }
  }

  private async persistRemoteDirCache(): Promise<void> {
    if (!this.memento) {
      return;
    }
    const entries = [...this.remoteDirCache.entries()]
      .slice(-200)
      .map(([key, nodes]) => [key, nodes.slice(0, 200)] as const);
    const json = JSON.stringify(Object.fromEntries(entries));
    if (json === this.lastPersistedDirCacheJson) {
      return; // 无变化不写，避免每次目录拉取都全量落盘
    }
    this.lastPersistedDirCacheJson = json;
    const memento = this.memento;
    return this.persistDirCacheQueue(async () => {
      await memento.update('agentDock.remoteDirCache.v1', Object.fromEntries(entries));
    }).catch((err) => log.child('fs').warn(`remote dir cache persist failed: ${String(err)}`));
  }

  private async remoteDirChildren(serverKey: string, path: string, parent?: Node): Promise<Node[]> {
    const cacheKey = `${serverKey}:${path}`;
    // 该目录正处于展开状态：纳入目录轮询，条目变化时自动重列（配合 FileSystemWatcher 实时刷新）
    this.touchExpandedDir(serverKey, path);
    this.ensureDirPolling();
    const cached = this.remoteDirCache.get(cacheKey);
    if (cached) {
      if (this.staleDirs.delete(cacheKey)) {
        void this.fetchRemoteDir(serverKey, path).then(() => this.onDidChangeEmitter.fire(undefined));
      }
      if (parent) {
        return cached.map((n) => (n.kind === 'remoteFsEntry' ? { ...n, parent } : n));
      }
      return cached;
    }
    return this.fetchRemoteDir(serverKey, path, parent);
  }

  /**
   * 手动刷新远程目录：清缓存 → 重新拉取 → 重绘。右键菜单与内部轮询共用。
   * 直接 fetchRemoteDir 而非走 remoteDirChildren，避免展开状态/轮询副作用。
   */
  async refreshRemoteDir(serverKey: string, path: string): Promise<void> {
    const cacheKey = `${serverKey}:${path}`;
    this.remoteDirCache.delete(cacheKey);
    this.dirMtimes.delete(cacheKey);
    await this.fetchRemoteDir(serverKey, path);
    this.onDidChangeEmitter.fire(undefined);
  }

  private ensureDirPolling(): void {
    if (this.dirPollTimer || this.expandedDirs.size === 0 || !getRemoteAutoRefresh() || !this.viewVisible) {
      return;
    }
    this.dirPollTimer = setTimeout(() => void this.pollExpandedDirs(), getRemoteWatchIntervalMs());
  }

  /** 每轮对展开中的远程目录做一次轻量 stat（按服务器合并为一条 ssh 调用），mtime 变化才重列。 */
  private async pollExpandedDirs(): Promise<void> {
    this.dirPollTimer = undefined;
    if (this.dirPolling || this.expandedDirs.size === 0) {
      return;
    }
    if (!getRemoteAutoRefresh()) {
      this.expandedDirs.clear();
      return;
    }
    if (!this.viewVisible) {
      return; // 视图不可见：跳过本轮，恢复可见时 ensureDirPolling 重新调度
    }
    this.dirPolling = true;
    try {
      const byServer = new Map<string, { serverKey: string; dirs: { key: string; path: string }[] }>();
      for (const [key, d] of this.expandedDirs) {
        const g = byServer.get(d.serverKey) ?? { serverKey: d.serverKey, dirs: [] };
        g.dirs.push({ key, path: d.path });
        byServer.set(d.serverKey, g);
      }
      const changedKeys: string[] = [];
      // 各服务器并发探测（全局 ssh 信号量已限并发），避免一台慢服务器拖长整轮
      await Promise.all(
        [...byServer.values()].map(async (g) => {
          const server = this.serverConfigFor(g.serverKey);
          if (!server) {
            return;
          }
          try {
            const script = g.dirs
              .map((d) => `printf '%s|' ${shq(d.path)}; stat -c '%Y' -- ${shq(d.path)} 2>/dev/null || echo -`)
              .join('\n');
            const res = await execRemote(server, script, 15_000, { quiet: true });
            if (res.code !== 0) {
              return; // 瞬时失败：下一轮再试
            }
            for (const line of res.stdout.split('\n')) {
              const parsed = parseDirMtimeLine(line);
              if (!parsed) {
                continue;
              }
              const key = `${g.serverKey}:${parsed.path}`;
              const prev = this.dirMtimes.get(key);
              if (prev !== undefined && prev !== parsed.mtimeSec) {
                changedKeys.push(key);
              }
              this.dirMtimes.set(key, parsed.mtimeSec);
            }
          } catch (err) {
            log.child('fs').debug(`dir poll ${g.serverKey} failed: ${String(err)}`);
          }
        }),
      );
      if (changedKeys.length > 0) {
        for (const key of changedKeys) {
          const d = this.expandedDirs.get(key);
          if (d) {
            await this.fetchRemoteDir(d.serverKey, d.path, undefined, true);
          }
        }
        log.child('fs').debug(`dir poll: ${changedKeys.length} remote dir(s) changed → tree refreshed`);
        this.onDidChangeEmitter.fire(undefined);
      }
    } catch (err) {
      log.child('fs').debug(`dir poll failed: ${String(err)}`);
    } finally {
      this.dirPolling = false;
      this.ensureDirPolling();
    }
  }

  private async fetchRemoteDir(serverKey: string, path: string, parent?: Node, quiet = false): Promise<Node[]> {
    const cacheKey = `${serverKey}:${path}`;
    const server = this.serverConfigFor(serverKey);
    if (!server) {
      return [{ kind: 'info', label: t('Server not found in config'), severity: 'warning' }];
    }
    const res = quiet
      ? await execRemote(server, `ls -1Ap --color=never ${shq(path)}`, getSshTimeoutMs(), { quiet: true })
      : await execRemoteSmart(server, `ls -1Ap --color=never ${shq(path)}`, {
          timeoutMs: getSshTimeoutMs(),
          title: t('Reading {0} on {1}…', path, server.name),
        });
    if (res.cancelled) {
      return [{ kind: 'info', label: t('Skipped'), severity: 'info' }];
    }
    if (res.code !== 0) {
      return [
        {
          kind: 'info',
          label: t('Failed to read remote directory'),
          severity: 'warning',
          tooltip: res.stderr.slice(0, 300) || `exit ${res.code}`,
        },
      ];
    }
    log.child('fs').debug(`${server.name}:${path} → ${res.stdout.split('\n').length - 1} entries`);
    const entries = parseLsAp(res.stdout);
    const dirs: Node[] = [];
    const files: Node[] = [];
    for (const e of entries.slice(0, 500)) {
      const child: Node = {
        kind: 'remoteFsEntry',
        serverKey,
        path: joinRemotePath(path, e.name),
        name: e.name,
        isDir: e.isDir,
      };
      (e.isDir ? dirs : files).push(child);
    }
    const cmp = (a: Extract<Node, { kind: 'remoteFsEntry' }>, b: Extract<Node, { kind: 'remoteFsEntry' }>): number =>
      a.name.localeCompare(b.name);
    (dirs as Extract<Node, { kind: 'remoteFsEntry' }>[]).sort(cmp);
    (files as Extract<Node, { kind: 'remoteFsEntry' }>[]).sort(cmp);
    const nodes: Node[] = [...dirs, ...files];
    if (entries.length > 500) {
      nodes.push({ kind: 'info', label: t('… {0} entries in total, showing the first 500', entries.length), severity: 'info' });
    }
    this.remoteDirCache.set(cacheKey, nodes);
    void this.persistRemoteDirCache();
    if (parent) {
      return nodes.map((n) => (n.kind === 'remoteFsEntry' ? { ...n, parent } : n));
    }
    return nodes;
  }

  private async dirChildren(uri: vscode.Uri, parent?: Node): Promise<Node[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      type FsEntry = Extract<Node, { kind: 'fsEntry' }>;
      const dirs: FsEntry[] = [];
      const files: FsEntry[] = [];
      for (const [name, type] of entries.slice(0, 500)) {
        const child = vscode.Uri.joinPath(uri, name);
        const isDir = (type & vscode.FileType.Directory) !== 0;
        (isDir ? dirs : files).push({ kind: 'fsEntry', uri: child, name, isDir, parent });
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
