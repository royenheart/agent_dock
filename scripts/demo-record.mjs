/**
 * CDP 录屏器：连接 VS Code（Electron）的 --remote-debugging-port，对 workbench
 * 页面 Page.startScreencast 连续抓帧；同时监视 demo.ts 写的 /tmp/demo-step-*.marker，
 * 记录每个场景的开始时间，供 demo-gif.mjs 把连续录像切成分场景 GIF。
 *
 * 零依赖（Node 24 内置 WebSocket/fetch）；帧存 <OUT_DIR>/fNNNNN.jpg，
 * 索引 <OUT_DIR>/frames.jsonl（每行 {f, wall}），分段 <OUT_DIR>/segments.json。
 *
 * 环境变量：
 *   CDP_PORT     调试端口（默认 9223）
 *   OUT_DIR      帧输出目录（默认 /tmp/agentdock-demo/frames，会被清空重建）
 *   DONE_MARKER  完成标记文件（默认 /tmp/demo-done.marker）
 *   MAX_SECONDS  最长录制秒数（默认 180，超时也落盘已抓帧）
 *   TAIL_MS      done 标记出现后继续录的收尾毫秒（默认 1500）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9223);
const OUT = process.env.OUT_DIR || '/tmp/agentdock-demo/frames';
const DONE = process.env.DONE_MARKER || '/tmp/demo-done.marker';
const STEP_DIR = path.dirname(DONE);
const STEP_PREFIX = path.join(STEP_DIR, 'demo-step-');
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 180);
const TAIL_MS = Number(process.env.TAIL_MS || 1500);
const MAX_FRAMES = 6000;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 等 workbench 页面目标出现（VS Code 启动需要十几秒）----
let targets;
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
    if (targets.some((t) => t.url.includes('workbench.html'))) break;
  } catch {
    // 端口还没起来
  }
  await sleep(500);
}
const page = (targets || []).find((t) => t.url.includes('workbench.html'));
if (!page) {
  console.error(`FAIL: no workbench.html target on :${PORT}; got:`, (targets || []).map((t) => t.url));
  process.exit(1);
}
console.log(`[record] target: ${page.url}`);

// ---- CDP WebSocket ----
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++mid;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const index = []; // {f, wall}
const writes = [];
let frameNo = 0;
const t0 = Date.now();
const segments = {}; // scene -> first-seen wall ms

ws.onmessage = async (ev) => {
  let text;
  try {
    text = typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString('utf8');
  } catch {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Page.screencastFrame') {
    const { data, sessionId } = msg.params;
    if (frameNo < MAX_FRAMES) {
      frameNo++;
      const name = `f${String(frameNo).padStart(5, '0')}.jpg`;
      index.push({ f: name, wall: Date.now() });
      writes.push(fs.promises.writeFile(path.join(OUT, name), Buffer.from(data, 'base64')));
    }
    send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('cdp websocket error'));
});
await send('Page.enable');
await send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
console.log('[record] screencast started');

// ---- 场景 marker 轮询 ----
const markerTimer = setInterval(() => {
  let files;
  try {
    files = fs.readdirSync(STEP_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (f.startsWith(path.basename(STEP_PREFIX)) && f.endsWith('.marker')) {
      const scene = f.slice(path.basename(STEP_PREFIX).length, -'.marker'.length);
      if (!(scene in segments)) {
        segments[scene] = Date.now();
        console.log(`[record] marker: ${scene} @ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
  }
}, 100);

// ---- 等待 done / 超时 ----
let reason = 'timeout';
for (let i = 0; i < MAX_SECONDS * 10; i++) {
  if (fs.existsSync(DONE)) {
    reason = 'done';
    break;
  }
  await sleep(100);
}
await sleep(TAIL_MS);
clearInterval(markerTimer);
await send('Page.stopScreencast').catch(() => {});
await Promise.allSettled(writes);

fs.writeFileSync(
  path.join(OUT, 'frames.jsonl'),
  index.map((e) => JSON.stringify(e)).join('\n') + '\n',
);
fs.writeFileSync(
  path.join(OUT, 'segments.json'),
  JSON.stringify({ t0, reason, frames: frameNo, segments }, null, 2) + '\n',
);
const secs = (Date.now() - t0) / 1000;
console.log(`[record] stop (${reason}) frames=${frameNo} secs=${secs.toFixed(1)} fps=${(frameNo / secs).toFixed(1)} scenes=${Object.keys(segments).join(',') || '(none)'}`);
process.exit(reason === 'done' ? 0 : 3);
