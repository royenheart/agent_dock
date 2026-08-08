/**
 * 用真实数据渲染演示用 HTML（README GIF 补帧）：
 * - settings.html：gatherSettings 的真实数据（MCPs / Skills / Plugins / Hooks）
 * - transcript.html：renderTranscript 渲染的真实会话（thinking / tool / todo / tokens）
 *
 * 用法：node scripts/render-demo-html.mjs <outDir> <homeDir>
 * 需要先 npm run compile（读 out/）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Module } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] || '/tmp/demo-html';
const home = process.argv[3] || process.env.HOME;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(root, 'test', 'unit', 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STYLE = `
  body { font-family: "Segoe UI", "WenQuanYi Micro Hei", sans-serif; background: #1e1e1e; color: #d4d4d4; padding: 16px 18px; font-size: 13px; margin: 0; }
  h1 { font-size: 15px; color: #fff; margin: 0 0 4px; }
  .sub { color: #9d9d9d; font-size: 12px; margin-bottom: 12px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab { padding: 4px 12px; border-radius: 12px; background: #3c3c3c; color: #ccc; }
  .tab.active { background: #0e639c; color: #fff; }
  .section { font-weight: 600; color: #9cdcfe; border-bottom: 1px solid #3c3c3c; padding-bottom: 3px; margin: 14px 0 6px; }
  .item { background: #252526; border: 1px solid #333; border-radius: 4px; padding: 7px 10px; margin-bottom: 5px; }
  .name { font-weight: 600; color: #fff; }
  .detail { color: #9d9d9d; margin-top: 2px; font-size: 12px; }
  .msg { margin-bottom: 12px; }
  .role { font-weight: 600; color: #569cd6; margin-bottom: 3px; font-size: 12px; }
  .text { white-space: pre-wrap; line-height: 1.45; }
  .thinking { background: #252526; border-left: 3px solid #6a9955; padding: 6px 10px; margin: 4px 0; color: #b5cea8; font-size: 12px; white-space: pre-wrap; }
  .tool { background: #252526; border-left: 3px solid #cca700; padding: 6px 10px; margin-top: 4px; font-size: 12px; }
  .tool-name { color: #dcdcaa; font-weight: 600; }
  .tool-in { color: #ce9178; margin-top: 2px; white-space: pre-wrap; max-height: 48px; overflow: hidden; }
  .tool-out { color: #9d9d9d; margin-top: 3px; white-space: pre-wrap; max-height: 72px; overflow: hidden; }
  .todo { background: #252526; border-left: 3px solid #4ec9b0; padding: 6px 10px; margin: 6px 0; font-size: 12px; }
  .todo li { margin: 2px 0; }
  .files { color: #c586c0; font-size: 12px; margin: 4px 0; }
  .notice { color: #9d9d9d; font-size: 12px; margin: 4px 0; }
  .summary { background: #2d2d30; border-radius: 4px; padding: 8px 10px; margin-bottom: 12px; font-size: 12px; color: #9cdcfe; }
`;

// ---------- settings.html ----------
const { gatherSettings } = await import(path.join(root, 'out', 'views', 'settingsData.js'));
// 第四参：项目目录（演示 workspace），让项目级 skill 也进画面
const projectDirs = process.argv[4] ? [process.argv[4]] : [];
const data = await gatherSettings('Local workstation', home, undefined, projectDirs);
const agentOrder = ['claude', 'codex', 'opencode'];
const agentLabel = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode' };
const sectionLabel = [['mcps', 'MCPs'], ['skills', 'Skills'], ['plugins', 'Plugins'], ['hooks', 'Hooks']];
// 默认展示 opencode：fixtures 给它配了 MCP + plugin，画面更满
const activeAgent = 'opencode';

const countOf = (agent) =>
  sectionLabel.reduce((n, [key]) => n + (data.byAgent?.[agent]?.[key]?.length ?? 0), 0);

const settingsHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<h1>Agent Dock · Agent 设置</h1>
<div class="sub">当前服务器：Local workstation</div>
<div class="tabs">${agentOrder.map((a) => `<span class="tab ${a === activeAgent ? 'active' : ''}">${agentLabel[a]} (${countOf(a)})</span>`).join('')}</div>
${sectionLabel
  .map(([key, label]) => {
    const items = data.byAgent?.[activeAgent]?.[key] ?? [];
    return `<div class="section">${label}（${items.length}）</div>` + (items.length
      ? items.slice(0, 6).map((it) => `<div class="item"><div class="name">${esc(it.name)}</div><div class="detail">${esc(it.detail || '')}</div></div>`).join('')
      : '<div class="item"><div class="name">—</div></div>');
  })
  .join('')}
</body></html>`;

// ---------- transcript.html ----------
const { execLocal } = await import(path.join(root, 'out', 'ssh', 'remoteExec.js'));
const { buildTranscriptScript, buildDiscoveryScript } = await import(path.join(root, 'out', 'agents', 'discoveryScript.js'));
const { renderTranscript } = await import(path.join(root, 'out', 'agents', 'transcript.js'));
const { parseDiscoveryOutput } = await import(path.join(root, 'out', 'agents', 'parse.js'));

// HOME 指向 fixture home，使 execLocal 扫到演示会话
process.env.HOME = home;
let session;
try {
  const res = await execLocal(buildDiscoveryScript(20), 60_000);
  const { sessions } = parseDiscoveryOutput(res.stdout);
  session = sessions.find((s) => s.agent === 'opencode' && /性能|API/.test(s.title))
    || sessions.find((s) => s.agent === 'opencode')
    || sessions[0];
} catch {
  session = undefined;
}

let transcriptHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<h1>会话 Transcript</h1>`;
if (session) {
  transcriptHtml += `<div class="sub">${esc(session.agent)} · ${esc(session.title)}</div>`;
  const tres = await execLocal(buildTranscriptScript(session), 60_000);
  const { blocks, summary } = renderTranscript(session, tres.stdout);
  if (summary) {
    const bits = [];
    if (summary.model) bits.push(String(summary.model));
    if (summary.input != null) bits.push(`in ${summary.input}`);
    if (summary.output != null) bits.push(`out ${summary.output}`);
    if (summary.skillCalls) bits.push(`skills ×${summary.skillCalls}`);
    if (bits.length) transcriptHtml += `<div class="summary">${esc(bits.join(' · '))}</div>`;
  }
  for (const b of blocks.slice(0, 14)) {
    if (b.kind === 'text') {
      transcriptHtml += `<div class="msg"><div class="role">${b.role === 'user' ? 'User' : 'Assistant'}${b.meta ? ' · ' + esc(b.meta) : ''}</div><div class="text">${esc(b.markdown)}</div></div>`;
    } else if (b.kind === 'thinking') {
      transcriptHtml += `<div class="thinking">thinking · ${esc(b.text)}</div>`;
    } else if (b.kind === 'tool') {
      transcriptHtml += `<div class="tool"><span class="tool-name">${esc(b.name)}</span>${b.input ? `<div class="tool-in">${esc(b.input)}</div>` : ''}${b.output ? `<div class="tool-out">${esc(b.output)}</div>` : ''}</div>`;
    } else if (b.kind === 'todo') {
      transcriptHtml += `<div class="todo">待办<ul>${b.items.map((i) => `<li>${esc(i.content)} <span style="color:#9d9d9d">[${esc(i.status)}]</span></li>`).join('')}</ul></div>`;
    } else if (b.kind === 'files') {
      transcriptHtml += `<div class="files">${esc(b.label)}: ${b.files.map(esc).join(', ')}</div>`;
    } else if (b.kind === 'notice') {
      transcriptHtml += `<div class="notice">${esc(b.label || b.text || '')}</div>`;
    }
  }
} else {
  transcriptHtml += `<div class="item"><div class="name">（无可演示会话）</div></div>`;
}
transcriptHtml += '</body></html>';

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'settings.html'), settingsHtml);
fs.writeFileSync(path.join(outDir, 'transcript.html'), transcriptHtml);
console.log(`rendered: ${path.join(outDir, 'settings.html')} + transcript.html (session=${session?.title || 'none'})`);
