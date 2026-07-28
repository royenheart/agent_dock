import * as vscode from 'vscode';
import { WorkspaceProvider, type Node } from './tree/workspaceProvider';
import { SessionDecorationProvider } from './tree/sessionDecorations';
import { RemoteFsProvider, REMOTE_SCHEME } from './ssh/remoteFsProvider';
import { SettingsViewProvider } from './views/settingsView';
import { SessionPanel } from './views/sessionPanel';
import { registerCommands } from './commands';
import { ensureCurrentServerRegistered } from './config';
import { setExtensionKind } from './ssh/currentExec';
import { log } from './log';

export function activate(context: vscode.ExtensionContext): { provider: WorkspaceProvider; decorations: SessionDecorationProvider } {
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
  const treeExplorer = vscode.window.createTreeView('agentDock.workspaceExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const decorations = new SessionDecorationProvider(provider.store);
  provider.onDidChangeTreeData(() => decorations.refresh());
  const settings = new SettingsViewProvider(context.extensionUri);
  const syncSelection = (e: vscode.TreeViewSelectionChangeEvent<Node>): void => {
    [provider.selectedNode] = e.selection;
  };

  context.subscriptions.push(
    tree,
    treeExplorer,
    tree.onDidChangeSelection(syncSelection),
    treeExplorer.onDidChangeSelection(syncSelection),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, new RemoteFsProvider(), {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settings, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(context, provider);
  void ensureCurrentServerRegistered();

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

  return { provider, decorations };
}

export function deactivate(): void {
  // 无需清理：terminal 与 webview 由窗口生命周期托管
}
