import * as vscode from 'vscode';
import { WorkspaceProvider, type Node } from './tree/workspaceProvider';
import { SessionDecorationProvider } from './tree/sessionDecorations';
import { RemoteFsProvider, REMOTE_SCHEME } from './ssh/remoteFsProvider';
import { SettingsViewProvider } from './views/settingsView';
import { SessionPanel } from './views/sessionPanel';
import { registerCommands } from './commands';
import { log } from './log';

export function activate(context: vscode.ExtensionContext): { provider: WorkspaceProvider; decorations: SessionDecorationProvider } {
  log.init();
  log.info('Agent Dock activated');
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentDock')) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  );

  return { provider, decorations };
}

export function deactivate(): void {
  // 无需清理：terminal 与 webview 由窗口生命周期托管
}
