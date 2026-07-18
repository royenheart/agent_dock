import * as vscode from 'vscode';
import type { AgentSession, ChatMessage, ServerConfig } from '../model';
import { AGENT_LABEL } from '../model';
import { buildTranscriptScript } from '../agents/discoveryScript';
import { renderTranscript } from '../agents/transcript';
import { execLocal, execRemote } from '../ssh/remoteExec';

export interface SessionTarget {
  serverKey: string;
  server?: ServerConfig;
  serverLabel: string;
  session: AgentSession;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class SessionPanel {
  private static readonly panels = new Map<string, vscode.WebviewPanel>();

  static async show(target: SessionTarget, onResume: (t: SessionTarget) => void): Promise<void> {
    const key = `${target.serverKey}/${target.session.agent}/${target.session.id}`;
    const existing = SessionPanel.panels.get(key);
    if (existing) {
      existing.reveal();
    }

    const panel =
      existing ??
      vscode.window.createWebviewPanel(
        'agentWorkspace.session',
        `${AGENT_LABEL[target.session.agent]} · ${target.session.title.slice(0, 40)}`,
        vscode.ViewColumn.Active,
        { enableScripts: true },
      );
    SessionPanel.panels.set(key, panel);
    panel.onDidDispose(() => SessionPanel.panels.delete(key));

    const disposables: vscode.Disposable[] = [];
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'resume') {
          onResume(target);
        }
      },
      undefined,
      disposables,
    );
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));

    panel.webview.html = renderPage(target, undefined, '加载会话内容…');

    try {
      const script = buildTranscriptScript(target.session);
      const res = target.server ? await execRemote(target.server, script) : await execLocal(script);
      if (res.timedOut) {
        panel.webview.html = renderPage(target, undefined, '拉取会话超时');
        return;
      }
      const messages = renderTranscript(target.session, res.stdout);
      if (messages.length === 0 && res.code !== 0) {
        panel.webview.html = renderPage(target, undefined, `读取失败: ${res.stderr.slice(0, 400)}`);
        return;
      }
      panel.webview.html = renderPage(target, messages, undefined);
    } catch (err) {
      panel.webview.html = renderPage(target, undefined, String(err));
    }
  }
}

function renderPage(target: SessionTarget, messages: ChatMessage[] | undefined, notice: string | undefined): string {
  const s = target.session;
  const nonce = String(Math.floor(Math.random() * 1e9));
  const body = notice
    ? `<div class="notice">${escapeHtml(notice)}</div>`
    : (messages ?? []).map(renderMessage).join('\n');
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 0 16px 40px; }
  header { position: sticky; top: 0; padding: 12px 0; background: var(--vscode-editor-background);
           border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 10px; align-items: center; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  h1 { font-size: 15px; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .msg { margin: 14px 0; max-width: 860px; }
  .role { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; text-transform: uppercase; }
  .bubble { padding: 10px 14px; border-radius: 8px; white-space: pre-wrap; word-break: break-word;
            line-height: 1.55; font-size: 13px; }
  .user .bubble { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .assistant .bubble { background: var(--vscode-editor-inactiveSelectionBackground); }
  .system .bubble { background: transparent; color: var(--vscode-descriptionForeground); font-style: italic; }
  details.tool summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 12px; }
  details.tool pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px;
                     overflow-x: auto; font-size: 12px; }
  .notice { margin: 40px auto; max-width: 480px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <span class="badge">${escapeHtml(AGENT_LABEL[s.agent])}</span>
  <div style="flex:1;min-width:0">
    <h1>${escapeHtml(s.title)}</h1>
    <div class="meta">${escapeHtml(target.serverLabel)} · ${escapeHtml(s.cwd)} · ${s.timeUpdated ? new Date(s.timeUpdated).toLocaleString() : ''}</div>
  </div>
  <button id="resume">在终端中继续会话</button>
</header>
${body}
<script nonce="${nonce}">
  document.getElementById('resume').addEventListener('click', () => {
    acquireVsCodeApi().postMessage({ type: 'resume' });
  });
</script>
</body>
</html>`;
}

function renderMessage(m: ChatMessage): string {
  const text = escapeHtml(m.text);
  if (m.role === 'tool') {
    return `<div class="msg tool"><details class="tool"><summary>🔧 ${escapeHtml(m.toolName ?? 'tool')}</summary><pre>${text}</pre></details></div>`;
  }
  const roleLabel = m.role === 'user' ? '你' : m.role === 'assistant' ? 'Agent' : '·';
  return `<div class="msg ${m.role}"><div class="role">${roleLabel}</div><div class="bubble">${text}</div></div>`;
}
