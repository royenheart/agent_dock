import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { getCurrentContext } from '../config';
import { gatherSettings, type SettingsData } from './settingsData';

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentWorkspace.settings';
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.renderHtml(undefined);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'refresh') {
        await this.push();
      } else if (msg?.type === 'openFile' && typeof msg.path === 'string') {
        try {
          const stat = await fs.stat(msg.path);
          if (stat.isDirectory()) {
            await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.path));
          } else {
            await vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true });
          }
        } catch {
          vscode.window.showWarningMessage(`无法打开: ${msg.path}`);
        }
      }
    });
    void this.push();
  }

  async push(): Promise<void> {
    if (!this.view) {
      return;
    }
    const ctx = getCurrentContext();
    const serverLabel = ctx.isLocal ? '本机 (Local)' : (ctx.sshHost ?? ctx.remoteName ?? 'remote');
    const data = await gatherSettings(serverLabel);
    this.view.webview.html = this.renderHtml(data);
  }

  private renderHtml(data: SettingsData | undefined): string {
    const nonce = String(Math.floor(Math.random() * 1e9));
    const payload = data ? JSON.stringify(data).replace(/</g, '\\u003c') : 'null';
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; font-size: 12px; }
  .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .server { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 3px 8px; border-radius: 4px; cursor: pointer; }
  .tabs { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
  .tab { padding: 3px 10px; border-radius: 10px; cursor: pointer;
         background: var(--vscode-button-secondaryBackground); }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .section { margin: 10px 0 4px; font-weight: 600; color: var(--vscode-descriptionForeground);
             border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 2px; }
  .item { padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .item:hover { outline: 1px solid var(--vscode-focusBorder); cursor: pointer; }
  .name { font-weight: 600; word-break: break-all; }
  .detail { color: var(--vscode-descriptionForeground); margin-top: 2px; word-break: break-all; }
  .note { color: var(--vscode-descriptionForeground); font-style: italic; margin: 12px 4px; }
</style>
</head>
<body>
<div class="top"><span class="server" id="server"></span><button id="refresh">刷新</button></div>
<div class="tabs" id="tabs"></div>
<div id="content"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const data = ${payload};
  const TABS = [['claude','Claude Code'],['codex','Codex'],['opencode','opencode']];
  const SECTIONS = [['mcps','MCPs'],['skills','Skills'],['plugins','Plugins'],['hooks','Hooks']];
  let active = 'claude';
  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
  function total(b) { return SECTIONS.reduce((n, [k]) => n + ((b && b[k]) ? b[k].length : 0), 0); }
  function render() {
    if (!data) { document.getElementById('content').innerHTML = '<div class="note">加载中…</div>'; return; }
    document.getElementById('server').textContent = '当前服务器: ' + data.serverLabel;
    const tabsEl = document.getElementById('tabs');
    tabsEl.innerHTML = '';
    for (const [key, label] of TABS) {
      const t = document.createElement('span');
      t.className = 'tab' + (key === active ? ' active' : '');
      t.textContent = label + ' (' + total(data.byAgent ? data.byAgent[key] : null) + ')';
      t.onclick = () => { active = key; render(); };
      tabsEl.appendChild(t);
    }
    const c = document.getElementById('content');
    c.innerHTML = '';
    const bucket = data.byAgent ? data.byAgent[active] : null;
    let shown = 0;
    if (bucket) {
      for (const [key, label] of SECTIONS) {
        const items = bucket[key] || [];
        if (!items.length) { continue; }
        shown += items.length;
        const h = document.createElement('div');
        h.className = 'section';
        h.textContent = label + ' (' + items.length + ')';
        c.appendChild(h);
        for (const it of items) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML = '<span class="name">' + esc(it.name) + '</span>'
            + (it.detail ? '<div class="detail">' + esc(it.detail) + '</div>' : '');
          if (it.sourcePath) {
            div.title = it.sourcePath;
            div.onclick = () => vscode.postMessage({ type: 'openFile', path: it.sourcePath });
          }
          c.appendChild(div);
        }
      }
    }
    if (!shown) {
      c.innerHTML = '<div class="note">该 agent 在当前服务器暂无配置</div>'
        + (data.notes || []).map(n => '<div class="note">' + esc(n) + '</div>').join('');
    }
  }
  document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
  render();
</script>
</body>
</html>`;
  }
}
