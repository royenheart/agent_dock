import * as vscode from 'vscode';
import { WorkspaceProvider, type Node } from './tree/workspaceProvider';
import { ExpansionState } from './tree/expansionState';
import { SessionDecorationProvider } from './tree/sessionDecorations';
import { remoteFsProvider, REMOTE_SCHEME } from './ssh/remoteFsProvider';
import { disposeSshSessions } from './ssh/sshSession';
import { SettingsViewProvider } from './views/settingsView';
import { SessionPanel } from './views/sessionPanel';
import { registerCommands } from './commands';
import { ensureCurrentServerRegistered } from './config';
import { setExtensionKind } from './ssh/currentExec';
import { clientTerminalOptions, initClientTerminalPersistence, isAgentDockTerminal, isTrackedTerminal, markClientTerminalsShuttingDown, syncTrackedTerminalName, trackClientTerminal, untrackClientTerminal } from './ssh/clientTerminal';
import { initNativeTerminalPersistence, markNativeTerminalsShuttingDown, reconcileNativeTerminal, syncNativeTerminalName, untrackNativeTerminal } from './ssh/nativeTerminal';
import { initForwardStore, restoreActiveForwards } from './ssh/portForward';
import { t } from './i18n';
import { log } from './log';

export interface AgentDockApi {
  provider: WorkspaceProvider;
  decorations: SessionDecorationProvider;
  /** 展开状态持久化实例（e2e 跨 reload 验证用；生产代码同样使用）。 */
  expansion: ExpansionState;
  /** workspaceState（e2e 验证跨窗口持久化用）。 */
  workspaceState: vscode.Memento;
}

export function activate(context: vscode.ExtensionContext): AgentDockApi {
  log.init();
  setExtensionKind(context.extension.extensionKind);
  log.info('Agent Dock activated', {
    version: (context.extension.packageJSON as { version?: string }).version,
    extensionKind: context.extension.extensionKind === vscode.ExtensionKind.UI ? 'ui' : 'workspace',
    remote: vscode.env.remoteName ?? 'none',
    logLevel: vscode.workspace.getConfiguration('agentDock').get<string>('logLevel', 'info'),
  });
  SessionPanel.init(context.extensionUri);
  const provider = new WorkspaceProvider();
  provider.initPersistence(context.globalState);
  const tree = vscode.window.createTreeView('agentDock.workspace', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const decorations = new SessionDecorationProvider(provider.store);
  provider.onDidChangeTreeData(() => decorations.refresh());
  const settings = new SettingsViewProvider(context.extensionUri);
  const syncSelection = (e: vscode.TreeViewSelectionChangeEvent<Node>): void => {
    [provider.selectedNode] = e.selection;
  };

  // 视图可见性：不可见时暂停远程目录轮询，折叠时移出轮询集合
  const onVisibility = (e: vscode.TreeViewVisibilityChangeEvent): void => {
    provider.setViewVisible(e.visible);
  };
  const onCollapse = (e: vscode.TreeViewExpansionEvent<Node>): void => {
    provider.onCollapse(e.element);
    expansionState.onCollapse(e.element);
  };

  // 展开状态持久化：VSCode 不自动保存扩展 TreeView 的展开状态（官方讨论 #1071），
  // 需自行记录并在 reload/刷新后 reveal 恢复。
  const expansionState = new ExpansionState();
  expansionState.init(context.workspaceState);
  const onExpand = (e: vscode.TreeViewExpansionEvent<Node>): void => expansionState.onExpand(e.element);
  // 树刷新（含全量重绘）后界面展开被清空，需按持久化集合重放。
  // 懒加载树首次渲染/扫描可能耗时数秒，reveal 需等父链就绪：restore 返回还有 pending
  // 时（上轮有节点因未就绪失败）自动再排一轮，防抖 1.5s 等扫描/加载完成。
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRestore = (delay = 1500): void => {
    if (restoreTimer) {
      clearTimeout(restoreTimer);
    }
    restoreTimer = setTimeout(() => {
      void expansionState.restore([tree]).then((hasPending) => {
        if (hasPending) {
          scheduleRestore(2000); // 还有节点没恢复成功：下一轮再试
        }
      });
    }, delay);
  };

  context.subscriptions.push(
    tree,
    tree.onDidChangeSelection(syncSelection),
    tree.onDidChangeVisibility(onVisibility),
    tree.onDidCollapseElement(onCollapse),
    tree.onDidExpandElement(onExpand),
    { dispose: () => restoreTimer && clearTimeout(restoreTimer) },
    provider.onDidChangeTreeData(() => scheduleRestore()),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, remoteFsProvider, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    { dispose: () => remoteFsProvider.disposeAll() },
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settings, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // 「客户端终端」出现在终端面板 + 下拉：pty 跑在 UI 侧扩展宿主，即客户端机器
    vscode.window.registerTerminalProfileProvider('agentDock.clientTerminal', {
      provideTerminalProfile: () => new vscode.TerminalProfile(clientTerminalOptions(t('Client Terminal'))),
    }),
    // 窗口/扩展重载后按保存的描述重建客户端终端；关闭时移除记录；
    // 用户 rename 或 shell 改标题时同步名字（否则 reload 后还原成创建时名字）
    vscode.window.onDidCloseTerminal((term) => {
      untrackClientTerminal(term);
      untrackNativeTerminal(term);
    }),
    vscode.window.onDidChangeTerminalState((term) => {
      syncTrackedTerminalName(term);
      syncNativeTerminalName(term);
    }),
    // 终端面板下拉（profile）创建的客户端终端没有 track 调用，靠 onDidOpenTerminal 补记；
    // restore 已 track 的（ssh/带 remoteCommand）跳过，避免覆盖成 shell 类型。
    // 原生终端：重连/复活可能晚于 activate，在这里补 reconcile（回放被重置的名字）
    vscode.window.onDidOpenTerminal((term) => {
      if (isAgentDockTerminal(term)) {
        if (!isTrackedTerminal(term)) {
          trackClientTerminal(term, { name: term.name || t('Client Terminal'), kind: 'shell' });
        }
      } else {
        reconcileNativeTerminal(term);
      }
    }),
  );

  registerCommands(context, provider);
  void ensureCurrentServerRegistered();
  initClientTerminalPersistence(context.workspaceState);
  // fsOpenTerminal 的原生终端由 VSCode 自己恢复，这里只补记跟踪并回放被重置的名字
  initNativeTerminalPersistence(context.workspaceState);
  // 窗口 reload 后自动重启上次仍在运行的端口转发（需要在 registerCommands 之后，
  // 以便 startForward 的 onDidChange 能触发树刷新）
  initForwardStore(context.workspaceState);
  void restoreActiveForwards();
  // 树首次渲染后恢复上次的展开状态（onDidChangeTreeData 只覆盖后续刷新）
  scheduleRestore();

  // 与原生资源管理器同理：watcher 监听当前窗口（本地或远程）磁盘变化，防抖后只重绘树
  const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  let fsTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleFsRefresh = (): void => {
    if (fsTimer) {
      clearTimeout(fsTimer);
    }
    fsTimer = setTimeout(() => provider.refreshFs(), 300);
  };

  context.subscriptions.push(
    fsWatcher,
    fsWatcher.onDidCreate(scheduleFsRefresh),
    fsWatcher.onDidChange(scheduleFsRefresh),
    fsWatcher.onDidDelete(scheduleFsRefresh),
    { dispose: () => clearTimeout(fsTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentDock')) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void ensureCurrentServerRegistered();
      provider.refresh();
    }),
  );

  return { provider, decorations, expansion: expansionState, workspaceState: context.workspaceState };
}

export function deactivate(): void {
  // reload 的销毁序列会向扩展派发终端 close 事件；标记后两套终端持久化都不再删记录/落盘
  markClientTerminalsShuttingDown();
  markNativeTerminalsShuttingDown();
  // 关闭所有持久 SSH 会话（SFTP/exec 通道所在的长连接）
  void disposeSshSessions();
}
