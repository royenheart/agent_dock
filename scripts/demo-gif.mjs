/**
 * 把 demo-record.mjs 抓到的连续 JPEG 帧按场景 marker 切分，合成 README 演示 GIF。
 *
 * 用法：node scripts/demo-gif.mjs <framesDir> <outDir>
 *
 * 处理管线：
 *   1. 读 frames.jsonl + segments.json，按 marker wall 时间把帧划入各场景
 *   2. 定 fps 重采样（默认 8）+ 折叠连续静态帧
 *   3. ImageMagick：缩放、底部中文标注、OptimizeFrame → docs/demo/*.gif
 *   4. 总览轮播 GIF（各场景首帧）
 *
 * 依赖：magick（ImageMagick 7）+ 中文字体（wqy-microhei 或 Noto Sans CJK）。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const framesDir = process.argv[2];
const outDir = process.argv[3];
if (!framesDir || !outDir) {
  console.error('usage: node scripts/demo-gif.mjs <framesDir> <outDir>');
  process.exit(2);
}

const TARGET_FPS = Number(process.env.DEMO_GIF_FPS || 8);
const MAX_WIDTH = Number(process.env.DEMO_GIF_WIDTH || 960);
const MAX_HEIGHT = Number(process.env.DEMO_GIF_HEIGHT || 600); // 内容区高度（不含标注条）
const LABEL_H = 40;
const MAX_HOLD = Number(process.env.DEMO_GIF_MAX_HOLD || 12);
const MAX_SCENE_FRAMES = Number(process.env.DEMO_GIF_MAX_SCENE || 80);
const DELAY_CS = Math.round(100 / TARGET_FPS);

/** 输出产物定义。pair 表示把两个连续场景并进同一个 GIF（远程编辑 A→B）。
 *  htmlExtra: framesDir 下的补帧图（Xvfb 下 webview 不绘制时用 headless Chrome 截的真实数据）。 */
const SCENES = [
  { id: 'tree', out: 'demo-multi-server.gif', label: '多服务器 Agent Workspace 树' },
  { id: 'edit-a', out: 'demo-remote-edit.gif', label: '远程文件编辑保存（SFTP）· 服务器 A → B', pair: 'edit-b' },
  { id: 'sessions', out: 'demo-sessions.gif', label: 'Sessions 聚合 · Transcript（thinking / 工具卡 / todo）', htmlExtra: 'transcript-html.png', htmlHold: 24 },
  { id: 'resume', out: 'demo-resume.gif', label: '会话一键「在终端中继续」', minHold: 3 },
  { id: 'settings', out: 'demo-skills.gif', label: 'Agent 设置：MCPs · Skills · Plugins · Hooks', htmlExtra: 'settings-html.png', htmlHold: 20, liveOptional: true },
];

const FONT_CANDIDATES = [
  '/usr/share/fonts/wqy-microhei-fonts/wqy-microhei.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
];
const FONT = FONT_CANDIDATES.find((f) => fs.existsSync(f));
if (!FONT) {
  console.error('FATAL: no CJK font found; install wqy-microhei or Noto Sans CJK');
  process.exit(1);
}

const index = fs
  .readFileSync(path.join(framesDir, 'frames.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const meta = JSON.parse(fs.readFileSync(path.join(framesDir, 'segments.json'), 'utf8'));
const segs = meta.segments || {};
console.log(`[gif] frames=${index.length} scenes=${Object.keys(segs).join(',') || '(none)'} font=${path.basename(FONT)}`);

/** 按时间排序的已记录场景列表。 */
const orderedScenes = Object.entries(segs).sort((a, b) => a[1] - b[1]);

/** 场景 id 的 [startWall, endWall]（end 为下一场景开始，或最后一帧）。 */
function rangeOf(id) {
  const start = segs[id];
  if (start == null) return null;
  const idx = orderedScenes.findIndex(([k]) => k === id);
  const next = orderedScenes[idx + 1];
  const end = next ? next[1] - 1 : (index[index.length - 1]?.wall ?? start);
  return { start, end };
}

function frameSig(file) {
  try {
    const buf = fs.readFileSync(file);
    return `${buf.length}:${buf[100]}:${buf[Math.floor(buf.length / 2)]}:${buf[buf.length - 50]}`;
  } catch {
    return file;
  }
}

/** 定 fps 重采样 + 折叠连续静态帧。返回 [{file, hold}]。 */
function pickFrames(range) {
  if (!range) return [];
  const inRange = index.filter((e) => e.wall >= range.start && e.wall <= range.end);
  if (inRange.length === 0) return [];
  const t0 = inRange[0].wall;
  const t1 = inRange[inRange.length - 1].wall;
  const duration = Math.max(t1 - t0, 200);
  const nIdeal = Math.max(1, Math.round((duration / 1000) * TARGET_FPS));
  const n = Math.min(nIdeal, MAX_SCENE_FRAMES, inRange.length);
  const picked = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + (i / Math.max(n - 1, 1)) * (t1 - t0);
    let best = inRange[0];
    let bestD = Math.abs(best.wall - t);
    for (const e of inRange) {
      const d = Math.abs(e.wall - t);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    if (picked.length === 0 || picked[picked.length - 1].f !== best.f) picked.push(best);
  }
  const out = [];
  let prevSig = '';
  for (const e of picked) {
    const p = path.join(framesDir, e.f);
    const sig = frameSig(p);
    if (sig === prevSig && out.length > 0) {
      out[out.length - 1].hold = Math.min(MAX_HOLD, out[out.length - 1].hold + 1);
    } else {
      out.push({ file: p, hold: 1 });
      prevSig = sig;
    }
  }
  return out;
}

function makeLabeled(src, label, dest) {
  // 统一画布：先把内容缩放到 MAX_WIDTH×MAX_HEIGHT（contain + 居中填充），
  // 再拼底部标注条——避免 live 帧与 HTML 补帧尺寸不一致导致 OptimizeFrame 失败
  execFileSync(
    'magick',
    [
      src,
      '-resize',
      `${MAX_WIDTH}x${MAX_HEIGHT}`,
      '-background',
      '#1e1e1e',
      '-gravity',
      'center',
      '-extent',
      `${MAX_WIDTH}x${MAX_HEIGHT}`,
      '-gravity',
      'south',
      '-background',
      '#1e1e1e',
      '-splice',
      `0x${LABEL_H}`,
      '-fill',
      'white',
      '-font',
      FONT,
      '-pointsize',
      '20',
      '-annotate',
      '+0+10',
      label,
      dest,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function writeGif(frames, label, outPath) {
  if (frames.length === 0) {
    console.warn(`[gif] skip empty → ${path.basename(outPath)}`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adgif-'));
  try {
    const seq = [];
    let i = 0;
    for (const fr of frames) {
      const dest = path.join(tmp, `f${String(i++).padStart(4, '0')}.png`);
      makeLabeled(fr.file, label, dest);
      for (let h = 0; h < fr.hold; h++) seq.push(dest);
    }
    execFileSync(
      'magick',
      [...seq, '-delay', String(DELAY_CS), '-loop', '0', '-layers', 'OptimizeFrame', outPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const mb = (fs.statSync(outPath).size / 1048576).toFixed(2);
    console.log(`[gif] ${path.basename(outPath)} frames=${seq.length} ${mb} MB`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

fs.mkdirSync(outDir, { recursive: true });
const montageFirsts = [];

for (const s of SCENES) {
  let frames;
  if (s.pair) {
    frames = [...pickFrames(rangeOf(s.id)), ...pickFrames(rangeOf(s.pair))];
  } else {
    frames = pickFrames(rangeOf(s.id));
  }
  // 补帧：真实数据 HTML 截图（sessions transcript / settings）
  if (s.htmlExtra) {
    const extra = path.join(framesDir, s.htmlExtra);
    if (fs.existsSync(extra)) {
      const hold = s.htmlHold || 16;
      if (s.liveOptional && frames.length < 4) {
        frames = [{ file: extra, hold }];
      } else {
        frames = [...frames, { file: extra, hold }];
      }
    } else {
      console.warn(`[gif] missing html extra: ${s.htmlExtra}`);
    }
  }
  if (s.minHold) {
    frames = frames.map((f) => ({ ...f, hold: Math.max(f.hold, s.minHold) }));
  }
  writeGif(frames, s.label, path.join(outDir, s.out));
  // 总览优先用补帧（更有信息量），否则用场景首帧
  const cover = s.htmlExtra && fs.existsSync(path.join(framesDir, s.htmlExtra))
    ? path.join(framesDir, s.htmlExtra)
    : frames[0]?.file;
  if (cover) montageFirsts.push({ file: cover, label: s.label });
}

// 总览轮播
if (montageFirsts.length > 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adall-'));
  try {
    const hold = Math.round(TARGET_FPS * 1.5);
    const seq = [];
    montageFirsts.forEach((m, i) => {
      const d = path.join(tmp, `c${i}.png`);
      makeLabeled(m.file, m.label, d);
      for (let h = 0; h < hold; h++) seq.push(d);
    });
    const out = path.join(outDir, 'agent-dock-demo.gif');
    execFileSync(
      'magick',
      [...seq, '-delay', String(DELAY_CS), '-loop', '0', '-layers', 'OptimizeFrame', out],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(`[gif] agent-dock-demo.gif (overview) ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('[gif] done');
