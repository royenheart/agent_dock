import * as vscode from 'vscode';
import { log } from '../log';

/**
 * fsOpenTerminal 打开的原生终端（TerminalOptions + cwd）的名字持久化。
 *
 * 终端本身由 VSCode persistent sessions 恢复，但名字不一定：
 * - reload（进程重连）：VSCode 会恢复用户 rename 过的标题（attachPersistentProcess.title）
 * - 完全重启（process revive）：进程按原始 launch config 重新拉起，名字回落到创建名
 * 且 VSCode 没有公开 API 可 rename 已有终端（Terminal.name 只读），只有内部命令
 * workbench.action.terminal.renameWithArg（作用于当前活跃终端）。
 * 因此扩展自行记录 {creationName, cwd, name}，reload 后按 creationOptions 匹配并重放名字。
 */
export interface SavedNativeTerminal {
  /** 创建时的名字（reload 后用它匹配 creationOptions.name，不受用户 rename 影响）。 */
  creationName: string;
  /** 创建时的 cwd（fsPath），与 creationName 一起做匹配键。 */
  cwd: string;
  /** 当前显示名：用户 rename 后经 onDidChangeTerminalState 同步进来。 */
  name: string;
}

const STORE_KEY = 'agentDock.nativeTerminals.v1';
let memento: vscode.Memento | undefined;
const liveTerminals = new Map<vscode.Terminal, SavedNativeTerminal>();

/**
 * 与 clientTerminal 同理：窗口 reload 的销毁序列里可能派发 close 事件，
 * shutdown 期间禁止删记录与落盘，否则保存的名字被抹掉。
 */
let shuttingDown = false;
let untrackPersistTimer: ReturnType<typeof setTimeout> | undefined;
const UNTRACK_PERSIST_DEBOUNCE_MS = 2000;

/** 扩展 deactivate 时调用：之后的 close 事件与持久化写入一律忽略。 */
export function markNativeTerminalsShuttingDown(): void {
  shuttingDown = true;
  if (untrackPersistTimer) {
    clearTimeout(untrackPersistTimer);
    untrackPersistTimer = undefined;
  }
}

const keyOf = (creationName: string, cwd: string): string => `${creationName}\n${cwd}`;

function persist(): void {
  if (!memento || shuttingDown) {
    return;
  }
  const out: Record<string, SavedNativeTerminal> = {};
  for (const d of liveTerminals.values()) {
    out[keyOf(d.creationName, d.cwd)] = d;
  }
  memento.update(STORE_KEY, out).then(
    () => {},
    (err: unknown) => log.child('term').warn(`native terminal persistence failed: ${String(err)}`),
  );
}

/** fsOpenTerminal 创建原生终端后调用：纳入名字跟踪。 */
export function trackNativeTerminal(term: vscode.Terminal, cwd: string): void {
  const d: SavedNativeTerminal = { creationName: term.name, cwd, name: term.name };
  liveTerminals.set(term, d);
  log.child('term').debug(`tracked native terminal "${d.name}" cwd=${cwd}`);
  persist();
}

/** 用户 rename 后同步当前显示名（挂在 onDidChangeTerminalState）。 */
export function syncNativeTerminalName(term: vscode.Terminal): void {
  const d = liveTerminals.get(term);
  if (!d || !term.name || d.name === term.name) {
    return;
  }
  log.child('term').debug(`sync native name: "${d.name}" -> "${term.name}"`);
  d.name = term.name;
  persist();
}

/** 用户关闭终端时移除记录（防抖落盘，理由同 clientTerminal）。 */
export function untrackNativeTerminal(term: vscode.Terminal): void {
  if (shuttingDown) {
    return;
  }
  if (liveTerminals.delete(term)) {
    log.child('term').debug(`untracked native terminal "${term.name}"`);
    if (untrackPersistTimer) {
      clearTimeout(untrackPersistTimer);
    }
    untrackPersistTimer = setTimeout(() => {
      untrackPersistTimer = undefined;
      persist();
    }, UNTRACK_PERSIST_DEBOUNCE_MS);
  }
}

/**
 * 把一个已存在的原生终端纳入跟踪并按需回放保存的名字。
 * 两条路径都会调它：activate 时的全量 reconcile，以及 onDidOpenTerminal——
 * 重连/复活的终端可能在 activate 之后才出现（workbench 异步重建终端列表），
 * 只扫一次会漏掉迟到者（名字不恢复、后续 rename 也同步不到）。
 * 已在跟踪表里的直接返回：fsOpenTerminal 新建终端同 tick 已 track，不会误回放别人的名字。
 */
export function reconcileNativeTerminal(term: vscode.Terminal): void {
  if (!memento || liveTerminals.has(term)) {
    return;
  }
  const opts = term.creationOptions;
  // 扩展 pty 终端由 clientTerminal 体系负责，这里只处理原生终端
  if (!opts || 'pty' in opts) {
    return;
  }
  const o = opts as vscode.TerminalOptions;
  const cwd = typeof o.cwd === 'string' ? o.cwd : o.cwd?.fsPath;
  if (!o.name || !cwd) {
    return;
  }
  const store = memento.get<Record<string, SavedNativeTerminal>>(STORE_KEY, {});
  const saved = store[keyOf(o.name, cwd)];
  if (!saved) {
    return;
  }
  // 同目录开多个终端时共享同一描述（键相同）：名字互相覆盖，有界且可接受
  liveTerminals.set(term, saved);
  if (term.name && term.name !== saved.name) {
    queueRename(term, saved.name);
  }
}

/** 注入持久化存储，并在窗口重载后恢复被重置的终端名（全量 reconcile 一轮）。 */
export function initNativeTerminalPersistence(m: vscode.Memento): void {
  memento = m;
  for (const term of vscode.window.terminals) {
    reconcileNativeTerminal(term);
  }
  log.child('term').debug(`initNativeTerminalPersistence: reconciled ${vscode.window.terminals.length} terminal(s)`);
}

/**
 * renameWithArg 只作用于当前活跃终端：先 show(true) 激活它（不抢编辑器焦点）再改名。
 * 多个回放必须串行——show→rename 不是原子的，并发会让 A 的名字贴到 B 上；
 * show 之后留 50ms，等活跃终端切换经 IPC 落地再发 rename 命令。
 */
let renameQueue: Promise<void> = Promise.resolve();

function queueRename(term: vscode.Terminal, name: string): void {
  renameQueue = renameQueue.then(() => enforceName(term, name));
}

async function enforceName(term: vscode.Terminal, name: string): Promise<void> {
  try {
    term.show(true);
    await new Promise((r) => setTimeout(r, 50));
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
    log.child('term').debug(`restored native terminal name "${name}"`);
  } catch (err) {
    log.child('term').warn(`restore native terminal name "${name}" failed: ${String(err)}`);
  }
}
