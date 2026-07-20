import * as vscode from 'vscode';
import type { AgentSession, RenderBlock, ServerConfig } from '../model';
import { AGENT_LABEL } from '../model';
import { buildTranscriptScript } from '../agents/discoveryScript';
import { formatTokens, renderTranscript, type TranscriptSummary } from '../agents/transcript';
import { execLocal, execRemote } from '../ssh/remoteExec';
import { t } from '../i18n';

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

let panelExtensionUri: vscode.Uri;

export class SessionPanel {
  private static readonly panels = new Map<string, vscode.WebviewPanel>();

  static init(extensionUri: vscode.Uri): void {
    panelExtensionUri = extensionUri;
  }

  static async show(target: SessionTarget, onResume: (t: SessionTarget) => void): Promise<void> {
    const key = `${target.serverKey}/${target.session.agent}/${target.session.id}`;
    const existing = SessionPanel.panels.get(key);
    if (existing) {
      existing.reveal();
    }

    const panel =
      existing ??
      vscode.window.createWebviewPanel(
        'vscoder.session',
        `${AGENT_LABEL[target.session.agent]} · ${target.session.title.slice(0, 40)}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [panelExtensionUri] },
      );
    SessionPanel.panels.set(key, panel);
    panel.onDidDispose(() => SessionPanel.panels.delete(key));

    const disposables: vscode.Disposable[] = [];
    const load = async (): Promise<void> => {
      panel.webview.html = renderPage(panel.webview, target, undefined, t('Loading session…'));
      try {
        const script = buildTranscriptScript(target.session);
        const res = target.server ? await execRemote(target.server, script) : await execLocal(script);
        if (res.timedOut) {
          panel.webview.html = renderPage(panel.webview, target, undefined, t('Timed out while fetching the session'));
          return;
        }
        const result = renderTranscript(target.session, res.stdout, {
          compactSummary: t('(compacted context summary — skipped)'),
          truncatedNotice: t('Session file is large; showing the last 6 MiB only (earlier messages not loaded)'),
          compactBoundary: t('— context compacted —'),
          redactedThinking: t('(redacted thinking)'),
          filesChanged: t('files changed'),
          attachment: t('attachment'),
          subtask: t('subtask'),
          subagent: t('(subagent)'),
        });
        if (result.blocks.length === 0 && res.code !== 0) {
          panel.webview.html = renderPage(
            panel.webview,
            target,
            undefined,
            t('Failed to read: {0}', res.stderr.slice(0, 400)),
            result.summary,
          );
          return;
        }
        panel.webview.html = renderPage(panel.webview, target, result.blocks, undefined, result.summary);
      } catch (err) {
        panel.webview.html = renderPage(panel.webview, target, undefined, String(err));
      }
    };
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'resume') {
          onResume(target);
        } else if (msg?.type === 'refresh') {
          void load();
        }
      },
      undefined,
      disposables,
    );
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));

    await load();
  }
}

function renderPage(
  webview: vscode.Webview,
  target: SessionTarget,
  blocks: RenderBlock[] | undefined,
  notice: string | undefined,
  summary?: TranscriptSummary,
): string {
  const s = target.session;
  const nonce = String(Math.floor(Math.random() * 1e9));
  const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(panelExtensionUri, 'media', 'vendor', 'marked.umd.js'));
  const purifyUri = webview.asWebviewUri(vscode.Uri.joinPath(panelExtensionUri, 'media', 'vendor', 'purify.min.js'));
  const summaryParts: string[] = [];
  if (summary?.model) {
    summaryParts.push(summary.model);
  }
  if (summary?.input) {
    summaryParts.push(`in ${formatTokens(summary.input)}`);
  }
  if (summary?.output) {
    summaryParts.push(`out ${formatTokens(summary.output)}`);
  }
  if (summary?.cacheRead) {
    summaryParts.push(t('cache read {0}', formatTokens(summary.cacheRead)));
  }
  if (summary?.cacheWrite) {
    summaryParts.push(t('cache write {0}', formatTokens(summary.cacheWrite)));
  }
  if (summary?.cost) {
    summaryParts.push(`$${summary.cost.toFixed(3)}`);
  }
  if (summary?.skillCalls) {
    summaryParts.push(`skills ${summary.skillCalls} ≈${formatTokens(summary.skillTokens ?? 0)}`);
  }
  const summaryLine = summaryParts.join(' · ');
  const payload = JSON.stringify({
    blocks: blocks ?? null,
    notice: notice ?? null,
    monitor: summary?.skills?.length
      ? {
          skills: summary.skills,
          calls: summary.skillCalls ?? 0,
          tokens: summary.skillTokens ?? 0,
        }
      : null,
    ui: {
      you: t('You'),
      agent: 'Agent',
      thinking: t('thinking'),
      input: t('input'),
      output: t('output'),
      empty: t('No renderable messages in this session'),
      monitor: t('Session monitor'),
      skillsUnit: t('calls'),
    },
  }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: data:;">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 0 16px 40px; }
  header { position: sticky; top: 0; z-index: 2; padding: 12px 0; background: var(--vscode-editor-background);
           border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 10px; align-items: center; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; white-space: nowrap;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  h1 { font-size: 15px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  .usage-line { color: var(--vscode-charts-blue); font-size: 11px; margin-top: 3px; font-family: var(--vscode-editor-font-family); }
  .meta-line { color: var(--vscode-descriptionForeground); font-size: 10px; margin-bottom: 4px; font-family: var(--vscode-editor-font-family); }
  .usage { margin: 6px auto; max-width: 900px; text-align: center; color: var(--vscode-descriptionForeground);
           font-size: 11px; font-family: var(--vscode-editor-font-family); opacity: 0.85; }
  .monitor { margin: 12px 0; max-width: 900px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px 12px; }
  .monitor summary { cursor: pointer; font-size: 12px; color: var(--vscode-textLink-foreground); }
  .mrow { display: flex; gap: 10px; align-items: center; margin: 5px 0; font-size: 12px; }
  .mname { min-width: 150px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mbar { flex: 1; height: 10px; border-radius: 5px; background: var(--vscode-editor-inactiveSelectionBackground); overflow: hidden; }
  .mbar-fill { display: block; height: 100%; background: var(--vscode-charts-blue); }
  .mval { min-width: 110px; text-align: right; color: var(--vscode-descriptionForeground);
          font-family: var(--vscode-editor-font-family); font-size: 11px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .msg { margin: 14px 0; max-width: 900px; }
  .role { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; text-transform: uppercase; }
  .bubble { padding: 10px 14px; border-radius: 8px; word-break: break-word; line-height: 1.55; font-size: 13px; }
  .bubble pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
  .bubble code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .bubble p { margin: 6px 0; } .bubble p:first-child { margin-top: 0; } .bubble p:last-child { margin-bottom: 0; }
  .bubble table { border-collapse: collapse; } .bubble th, .bubble td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .user .bubble { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .assistant .bubble { background: var(--vscode-editor-inactiveSelectionBackground); }
  .system .bubble { background: transparent; color: var(--vscode-descriptionForeground); font-style: italic; }
  details { margin: 8px 0; max-width: 900px; }
  details summary { cursor: pointer; font-size: 12px; color: var(--vscode-textLink-foreground); }
  details pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px;
                overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word;
                font-family: var(--vscode-editor-font-family); }
  details div { padding: 6px 0 0 12px; white-space: pre-wrap; word-break: break-word; color: var(--vscode-descriptionForeground); }
  .toolcard { margin: 8px 0; max-width: 900px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 12px; }
  .toolcard.error { border-color: var(--vscode-errorForeground); }
  .toolhead { display: flex; gap: 8px; align-items: center; font-size: 12px; }
  .toolname { font-weight: 600; }
  .toolstatus { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground); }
  .toolcard.error .toolstatus { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
  .toolcard details { margin: 4px 0 0; }
  .todolist { margin: 10px 0; max-width: 900px; border-left: 3px solid var(--vscode-charts-blue); padding: 4px 0 4px 12px; }
  .todolist .item { display: flex; gap: 8px; margin: 4px 0; font-size: 13px; }
  .todolist .marker { flex-shrink: 0; }
  .todolist .done { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .todolist .doing { font-weight: 600; }
  .notice { margin: 10px auto; max-width: 900px; text-align: center; color: var(--vscode-descriptionForeground);
            font-size: 12px; font-style: italic; }
  .big-notice { margin: 40px auto; max-width: 480px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <span class="badge">${escapeHtml(AGENT_LABEL[s.agent])}</span>
  <div style="flex:1;min-width:0">
    <h1>${escapeHtml(s.title)}</h1>
    <div class="meta">${escapeHtml(target.serverLabel)} · ${escapeHtml(s.cwd)} · ${s.timeUpdated ? new Date(s.timeUpdated).toLocaleString() : ''}</div>
    ${summaryLine ? `<div class="usage-line" title="${escapeHtml(t('cache read: tokens served from prompt cache · cache write: tokens newly cached · skills: estimated from injected content (chars/4)'))}">${escapeHtml(summaryLine)}</div>` : ''}
  </div>
  <button id="refresh">${escapeHtml(t('Refresh'))}</button>
  <button id="resume">${escapeHtml(t('Resume in terminal'))}</button>
</header>
<div id="content"></div>
<script nonce="${nonce}" src="${markedUri}"></script>
<script nonce="${nonce}" src="${purifyUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const payload = ${payload};
  const ui = payload.ui;
  const content = document.getElementById('content');
  document.getElementById('resume').addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function md(src) {
    return DOMPurify.sanitize(marked.parse(src || '', { breaks: true }), { ADD_ATTR: ['target', 'rel'] });
  }
  if (window.DOMPurify && DOMPurify.addHook) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    });
  }
  function renderText(b) {
    const w = el('div', 'msg ' + b.role);
    const roleRow = el('div', 'role', b.role === 'user' ? ui.you : b.role === 'assistant' ? ui.agent : '·');
    w.append(roleRow);
    if (b.meta) w.append(el('div', 'meta-line', b.meta));
    const bub = el('div', 'bubble');
    bub.innerHTML = md(b.markdown);
    w.append(bub);
    return w;
  }
  function renderUsage(b) {
    return el('div', 'usage', b.label);
  }
  function renderMonitor(m) {
    const det = el('details', 'monitor');
    det.append(el('summary', '', '📊 ' + ui.monitor + ' · skills ' + m.calls + ' ≈' + fmtT(m.tokens)));
    const body = el('div');
    const max = Math.max(...m.skills.map(s => s.estTokens));
    const sorted = m.skills.slice().sort((a, b) => b.estTokens - a.estTokens);
    for (const s of sorted) {
      const row = el('div', 'mrow');
      row.append(el('span', 'mname', s.name));
      const wrap = el('span', 'mbar');
      const fill = el('span', 'mbar-fill');
      fill.style.width = Math.max(3, Math.round((s.estTokens / max) * 100)) + '%';
      wrap.append(fill);
      row.append(wrap);
      row.append(el('span', 'mval', s.calls + ' ' + ui.skillsUnit + ' · ≈' + fmtT(s.estTokens)));
      body.append(row);
    }
    det.append(body);
    return det;
  }
  function renderThinking(b) {
    const d = el('details', 'thinking');
    d.append(el('summary', '', '💭 ' + ui.thinking));
    d.append(el('div', '', b.text));
    return d;
  }
  function fmtT(n) {
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(2) + 'M';
  }
  function renderTool(b) {
    const card = el('div', 'toolcard' + (b.isError ? ' error' : ''));
    const head = el('div', 'toolhead');
    head.append(el('span', '', b.name && b.name.startsWith('⚡') ? '' : '🔧'));
    head.append(el('span', 'toolname', b.name));
    if (b.status) head.append(el('span', 'toolstatus', b.status));
    if (b.estTokens) head.append(el('span', 'toolstatus', '≈' + fmtT(b.estTokens) + ' tok'));
    if (b.isError) head.append(el('span', 'toolstatus', 'error'));
    card.append(head);
    if (b.input) {
      const det = el('details');
      det.append(el('summary', '', ui.input));
      det.append(el('pre', '', b.input));
      card.append(det);
    }
    if (b.output) {
      const det = el('details');
      det.append(el('summary', '', ui.output));
      det.append(el('pre', '', b.output));
      card.append(det);
    }
    return card;
  }
  function renderTodo(b) {
    const w = el('div', 'todolist');
    for (const it of b.items) {
      const row = el('div', 'item');
      const done = it.status === 'completed';
      const doing = it.status === 'in_progress';
      row.append(el('span', 'marker', done ? '☑' : doing ? '◐' : '☐'));
      row.append(el('span', done ? 'done' : doing ? 'doing' : '', it.content));
      w.append(row);
    }
    return w;
  }
  function renderFiles(b) {
    return el('div', 'notice', '📁 ' + b.label + ': ' + b.files.join(', '));
  }
  function renderNotice(b) {
    return el('div', 'notice', b.text);
  }

  if (payload.notice) {
    content.append(el('div', 'big-notice', payload.notice));
  } else if (!payload.blocks || !payload.blocks.length) {
    content.append(el('div', 'big-notice', ui.empty));
  } else {
    if (payload.monitor) content.append(renderMonitor(payload.monitor));
    for (const b of payload.blocks) {
      if (b.kind === 'text') content.append(renderText(b));
      else if (b.kind === 'thinking') content.append(renderThinking(b));
      else if (b.kind === 'tool') content.append(renderTool(b));
      else if (b.kind === 'todo') content.append(renderTodo(b));
      else if (b.kind === 'files') content.append(renderFiles(b));
      else if (b.kind === 'usage') content.append(renderUsage(b));
      else content.append(renderNotice(b));
    }
  }
</script>
</body>
</html>`;
}
