import * as vscode from 'vscode';
import { WorkspaceProvider } from './tree/workspaceProvider';
import { SessionDecorationProvider } from './tree/sessionDecorations';
import { SettingsViewProvider } from './views/settingsView';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): { provider: WorkspaceProvider; decorations: SessionDecorationProvider } {
  const provider = new WorkspaceProvider();
  const tree = vscode.window.createTreeView('agentWorkspace.workspace', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const treeExplorer = vscode.window.createTreeView('agentWorkspace.workspaceExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const decorations = new SessionDecorationProvider(provider.store);
  provider.store.onDidSettle = () => decorations.refresh();
  provider.onDidChangeTreeData(() => decorations.refresh());
  const settings = new SettingsViewProvider(context.extensionUri);

  context.subscriptions.push(
    tree,
    treeExplorer,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settings, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(context, provider);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentWorkspace')) {
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
