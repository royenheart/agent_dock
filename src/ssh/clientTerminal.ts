import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { buildClientShellSpawn, buildInteractiveSshArgs, buildPtySshArgs, type SpawnSpec, type TermDimensions } from './sshArgs';
import { createSerialQueue } from '../batch';
import { getServers } from '../config';
import { t } from '../i18n';
import { log } from '../log';

const DEFAULT_DIMS: TermDimensions = { rows: 24, cols: 80 };

/** 终端打开时才知道初始尺寸与后端类型（真 pty / 管道），spawn 规格用工厂延迟求值。 */
export type SpawnSpecFactory = (dims: TermDimensions, realPty: boolean) => SpawnSpec;

/**
 * 客户端 ssh 可执行文件名：node-pty 的 Windows 实现（path_util.cc）在 PATH 里
 * 只拼文件名、不补 .exe 扩展名，传 'ssh' 会得到 "File not found: "（空路径），
 * 导致 Windows 上客户端终端永远退回管道模式。这里按平台补全扩展名。
 */
function sshExecutable(): string {
  return process.platform === 'win32' ? 'ssh.exe' : 'ssh';
}

/** ssh 跳板的 spawn 规格：在客户端直接起 ssh，不经任何本地 shell。 */
export function sshSpawnSpec(server: ServerConfig, remoteCommand?: string): SpawnSpecFactory {
  return (dims, realPty) => ({
    file: sshExecutable(),
    args: realPty ? buildPtySshArgs(server, remoteCommand) : buildInteractiveSshArgs(server, dims, remoteCommand),
  });
}

export const clientShellSpec: SpawnSpecFactory = (dims, realPty) => {
  if (realPty) {
    return process.platform === 'win32'
      ? { file: 'powershell.exe', args: ['-NoLogo'] }
      : { file: process.env.SHELL ?? '/bin/sh', args: [] };
  }
  return buildClientShellSpawn(process.platform, dims);
};

/** script(1) 缺失时的降级：直起 shell。无 pty，行编辑/颜色不可用，靠 dumb 模式手动回显。 */
export const directShellSpec: SpawnSpecFactory = () => ({
  file: process.env.SHELL ?? '/bin/sh',
  args: ['-i'],
  dumb: { enter: '\n' },
});

/** 本机 shell 的降级 spec：Windows 退回 cmd（PowerShell 启动失败时），POSIX 直起 $SHELL。 */
function shellFallbackSpec(): SpawnSpecFactory {
  return process.platform === 'win32'
    ? () => ({ file: process.env.COMSPEC ?? 'cmd.exe', args: [], dumb: { enter: '\r\n' } })
    : directShellSpec;
}

// ---------- node-pty 后端（可选原生依赖） ----------

/** node-pty 的最小类型面（仅用到的部分）；模块是可选原生依赖，运行时才 require。 */
interface NodePtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): NodePtyProcess;
}

let nodePtyCache: NodePtyModule | null | undefined;

/**
 * 预检 node-pty 的原生二进制是否完好（存在且非空）。
 * Windows 上更新 vsix 时旧扩展宿主仍加载着 .node 文件（文件锁），新文件可能
 * 替换不完整/被截断为 0 字节；此时 require 一个损坏的原生模块可能直接崩掉
 * 扩展宿主进程（VSCode 因此"暂时禁用所有已安装的扩展"）。预检不通过就降级
 * 管道后端，绝不 require。
 */
function nodePtyBinariesIntact(): boolean {
  try {
    // require.resolve('node-pty/package.json') 只解析 JSON，不加载原生模块
    const pkgDir = path.dirname(require.resolve('node-pty/package.json'));
    const archDir = `prebuilds/${process.platform}-${process.arch}`;
    // 与 node-pty lib/utils.js loadNativeModule 的目录顺序一致：
    // build/Release → build/Debug → prebuilds/<platform>-<arch>
    const names = process.platform === 'win32' ? ['conpty.node', 'conpty_console_list.node', 'pty.node'] : ['pty.node'];
    const candidates: string[] = [];
    for (const sub of ['build/Release', 'build/Debug', archDir]) {
      for (const n of names) {
        candidates.push(path.join(pkgDir, sub, n));
      }
    }
    const intact = candidates.some((f) => {
      try {
        return fs.statSync(f).size > 0;
      } catch {
        return false;
      }
    });
    if (!intact) {
      log.child('term').warn(`node-pty native binaries missing or empty; checked: ${candidates.join(', ')}`);
    }
    return intact;
  } catch {
    // node-pty 未安装
    return false;
  }
}

/**
 * 加载可选原生依赖 node-pty；未安装 / ABI 不符 / 原生二进制不完整 / 被
 * AGENTDOCK_NO_NODE_PTY 显式禁用（诊断与测试用）时返回 undefined，调用方退回管道后端。
 */
function loadNodePty(): NodePtyModule | undefined {
  if (process.env.AGENTDOCK_NO_NODE_PTY) {
    return undefined;
  }
  if (nodePtyCache !== undefined) {
    return nodePtyCache ?? undefined;
  }
  if (!nodePtyBinariesIntact()) {
    nodePtyCache = null;
    log.child('term').warn('node-pty binaries not intact, client terminals fall back to pipe mode');
    return undefined;
  }
  try {
    // 可选依赖：vsix 里带预编译二进制则命中，缺失时 catch 进管道降级
    nodePtyCache = require('node-pty') as NodePtyModule;
    log.child('term').info('node-pty loaded — client terminals use a real pty');
  } catch (err) {
    nodePtyCache = null;
    log.child('term').warn(`node-pty unavailable, client terminals fall back to pipe mode: ${String(err)}`);
  }
  return nodePtyCache ?? undefined;
}

/** 管道子进程没有 pty 的 ONLCR 转换，把裸 \n 补成 \r\n（已是 \r\n 的幂等）。 */
function toCrlf(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/**
 * 跑在扩展宿主进程里的伪终端。扩展以 UI 侧运行时，即使窗口连着远程，
 * 这里的子进程也落在客户端机器上 —— 远程窗口的原生终端跑在被连服务器上，
 * 跨服务器 ssh（B 够不到 A）只能靠它从客户端发起。
 * 后端优先 node-pty（Windows ConPTY / POSIX forkpty，行编辑与 resize 全原生），
 * 拿不到原生模块时退化为管道 + 本地行缓冲（dumb 模式）。
 */
class ClientPty implements vscode.Pseudoterminal {
  /** 标记本 pty 属于 Agent Dock 客户端终端：profile 下拉创建的终端也靠它识别并纳入持久化。 */
  readonly agentDockPty = true;
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private child?: ChildProcess;
  private ptyProc?: NodePtyProcess;
  /** 进程异常退出后保持终端可读（错误留在屏幕上），任意按键关闭。 */
  private holding = false;
  /** 当前 spec 的退化模式：无 pty 时本地行缓冲 + 手动回显（Windows PowerShell / 降级 shell）。 */
  private dumb?: { enter: '\r\n' | '\n' };
  /** dumb 模式的行缓冲（按码点存）：退格本地编辑，回车才整行发给子进程。 */
  private lineBuf: string[] = [];
  /** 正在累积的转义序列（方向键等）：dumb 模式整体吞掉，不回显也不转发。 */
  private escBuf: string | undefined;
  private spawned = false;
  private triedFallback = false;
  private dims: TermDimensions = DEFAULT_DIMS;

  constructor(
    private readonly spec: SpawnSpecFactory,
    private readonly fallback?: SpawnSpecFactory,
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.dims = initialDimensions ? { rows: initialDimensions.rows, cols: initialDimensions.columns } : DEFAULT_DIMS;
    const ptyMod = loadNodePty();
    if (ptyMod && this.startNodePty(ptyMod)) {
      return;
    }
    this.startSpec(this.spec, false);
  }

  /** 返回 false 表示 spawn 失败，调用方继续走管道后端。 */
  private startNodePty(ptyMod: NodePtyModule): boolean {
    const { file, args } = this.spec(this.dims, true);
    let proc: NodePtyProcess;
    try {
      proc = ptyMod.spawn(file, args, {
        name: 'xterm-256color',
        cols: this.dims.cols,
        rows: this.dims.rows,
        cwd: os.homedir(),
        env: process.env,
      });
    } catch (err) {
      log.child('term').warn(`node-pty spawn failed (${String(err)}); falling back to pipe mode`);
      return false;
    }
    log.child('term').debug(`client terminal spawn (node-pty): ${file} ${args.join(' ')}`);
    this.ptyProc = proc;
    proc.onData((d) => this.writeEmitter.fire(d));
    proc.onExit(({ exitCode }) => {
      if (this.holding) {
        return;
      }
      if (exitCode === 0) {
        this.closeEmitter.fire(0);
      } else {
        this.hold(t('Process exited with code {0} — press any key to close', String(exitCode)));
      }
    });
    return true;
  }

  private startSpec(spec: SpawnSpecFactory, isFallback: boolean): void {
    const { file, args, dumb } = spec(this.dims, false);
    this.dumb = dumb;
    log.child('term').debug(`client terminal spawn: ${file} ${args.join(' ')}`);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: os.homedir(), env: process.env });
    } catch (err) {
      this.onSpawnError(String(err), isFallback);
      return;
    }
    this.child = child;
    this.spawned = false;
    // 事件按 child 实例过滤：主 spawn 失败后 fallback 已接管，旧进程的 error/close 不得再改状态
    const isCurrent = (): boolean => this.child === child;
    // 子进程提前退出后向 stdin 写入会触发 EPIPE；无监听的 'error' 会抛成未捕获异常
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer) => {
      if (isCurrent()) {
        this.writeEmitter.fire(toCrlf(d.toString('utf8')));
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (isCurrent()) {
        this.writeEmitter.fire(toCrlf(d.toString('utf8')));
      }
    });
    child.once('spawn', () => {
      if (isCurrent()) {
        this.spawned = true;
      }
    });
    child.on('error', (err) => {
      if (isCurrent()) {
        this.onSpawnError(err.message, isFallback);
      }
    });
    child.on('close', (code) => {
      if (!isCurrent() || this.holding) {
        return;
      }
      if (code === 0) {
        this.closeEmitter.fire(0);
      } else {
        this.hold(t('Process exited with code {0} — press any key to close', String(code ?? -1)));
      }
    });
  }

  private onSpawnError(message: string, isFallback: boolean): void {
    if (!this.spawned && !isFallback && !this.triedFallback && this.fallback) {
      this.triedFallback = true;
      log.child('term').warn(`primary spawn failed (${message}); falling back to direct shell`);
      this.startSpec(this.fallback, true);
      return;
    }
    this.hold(t('Failed to start client process: {0}', message));
  }

  private hold(message: string): void {
    this.holding = true;
    this.writeEmitter.fire(`\r\n\x1b[33m${message}\x1b[0m\r\n`);
  }

  handleInput(data: string): void {
    if (this.holding) {
      this.closeEmitter.fire(1);
      return;
    }
    if (this.ptyProc) {
      this.ptyProc.write(data);
      return;
    }
    // 子进程已退出（exitCode 非 null）时跳过写入，配合 stdin error 监听避免 EPIPE 抛异常
    if (this.child && this.child.exitCode !== null) {
      return;
    }
    if (!this.dumb) {
      this.child?.stdin?.write(data);
      return;
    }
    // 管道子进程不做行编辑，退格/回车都在这里消化，回车时整行下发
    for (const ch of data) {
      if (this.escBuf !== undefined) {
        this.escBuf += ch;
        if (/^[a-zA-Z~]$/.test(ch)) {
          this.escBuf = undefined;
        }
        continue;
      }
      if (ch === '\x1b') {
        this.escBuf = ch;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const line = this.lineBuf.join('');
        this.lineBuf = [];
        this.writeEmitter.fire('\r\n');
        this.child?.stdin?.write(line + this.dumb.enter);
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuf.length > 0) {
          this.lineBuf.pop();
          this.writeEmitter.fire('\b \b');
        }
        continue;
      }
      if (ch === '\x03') {
        // Ctrl+C：清空本地行缓冲，并把中断转发给子进程。
        // - pty 包装的子进程（script(1) / ssh -tt）经 stdin 收到 \x03 后由 tty 行规程生成 SIGINT
        // - 无 pty 的降级 shell（directShellSpec 等）只能直接向子进程发 SIGINT
        this.lineBuf = [];
        this.writeEmitter.fire('^C\r\n');
        if (this.child && this.child.exitCode === null) {
          if (this.dumb && process.platform !== 'win32') {
            try {
              this.child.kill('SIGINT');
            } catch {
              // 子进程已退出：忽略
            }
          } else {
            this.child.stdin?.write('\x03');
          }
        }
        continue;
      }
      if (ch < ' ') {
        continue;
      }
      this.lineBuf.push(ch);
      this.writeEmitter.fire(ch);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    // 管道子进程收不到尺寸变化（初始尺寸经 stty 注入）；真 pty 直接 resize
    this.ptyProc?.resize(dimensions.columns, dimensions.rows);
  }

  close(): void {
    this.ptyProc?.kill();
    this.child?.kill();
  }
}

export function clientTerminalOptions(name: string, spec?: SpawnSpecFactory): vscode.ExtensionTerminalOptions {
  const isShell = spec === undefined;
  return { name, pty: new ClientPty(spec ?? clientShellSpec, isShell ? shellFallbackSpec() : undefined) };
}

// ---------- 终端持久化：窗口/扩展重载后按保存的描述重建 ----------

/** 可持久化的客户端终端描述：重启 VSCode 后据此重建终端。 */
export interface SavedClientTerminal {
  name: string;
  kind: 'shell' | 'ssh';
  /** kind === 'ssh' 时的服务器名（getServers 里查配置）。 */
  serverName?: string;
  /** kind === 'ssh' 时附带执行的远程命令（如 resume/新建会话）。 */
  remoteCommand?: string;
}

const TERMINAL_STORE_KEY = 'agentDock.clientTerminals.v1';
let terminalMemento: vscode.Memento | undefined;
const liveTerminals = new Map<vscode.Terminal, SavedClientTerminal>();
/** 持久化写入串行化：reload 前最后一次改名不会与旧快照竞争，完成顺序与调用顺序一致。 */
const persistQueue = createSerialQueue();
let lastPersist: Promise<void> = Promise.resolve();
/** VSCode 对用户 rename 不一定派发 onDidChangeTerminalState（实测改名后事件为空），
 *  因此按 1s 轮询 tracked 终端的 name，作为事件同步的兜底。 */
let namePollTimer: ReturnType<typeof setInterval> | undefined;
const NAME_POLL_MS = 1000;

/**
 * 窗口 reload 时 VSCode 会以 Shutdown reason 销毁所有扩展 pty 终端（pty 活在扩展宿主里，
 * 无法重连），并向扩展派发 onDidCloseTerminal。此时若把清空后的列表写回 workspaceState，
 * 保存的终端描述就被抹掉，reload 后无终端可重建 —— shutdown 期间禁止删记录与落盘。
 * 残余窗口：close 事件早于 deactivate 超过防抖时长时仍会写入一次，VSCode 不暴露关闭原因，
 * 无法彻底消除，只能靠防抖缩小 —— 不要"简化"掉这套防护。
 */
let shuttingDown = false;
/** untrack 触发的落盘做防抖：正常关闭 2s 后写入；紧跟着进入 shutdown 则由标记取消。 */
let untrackPersistTimer: ReturnType<typeof setTimeout> | undefined;
const UNTRACK_PERSIST_DEBOUNCE_MS = 2000;

/** 扩展 deactivate 时调用：先补一轮名称同步，之后的 close 事件与持久化写入一律忽略。 */
export function markClientTerminalsShuttingDown(): void {
  // 用户可能刚 rename 完立刻 reload：轮询还没到下一拍，deactivate 里兜底同步一次
  syncAllTrackedTerminalNames();
  shuttingDown = true;
  if (namePollTimer) {
    clearInterval(namePollTimer);
    namePollTimer = undefined;
  }
  if (untrackPersistTimer) {
    clearTimeout(untrackPersistTimer);
    untrackPersistTimer = undefined;
  }
}

/** 等待已入队的终端描述持久化完成（deactivate 时使用）。 */
export async function flushClientTerminalPersistence(): Promise<void> {
  await lastPersist;
}

/** 注入持久化存储（workspaceState），并在窗口重载后重建已保存的客户端终端。 */
export function initClientTerminalPersistence(memento: vscode.Memento): void {
  terminalMemento = memento;
  const saved = memento.get<SavedClientTerminal[]>(TERMINAL_STORE_KEY, []);
  const tlog = log.child('term');
  tlog.debug(`initClientTerminalPersistence: saved=${saved.length}`, { saved: saved.map((d) => d.name) });
  // 快照必须在重建循环之前取（且是拷贝）：循环里新建的终端会进入 window.terminals，
  // 直接查会把后一个同名 saved 条目误判成"已存在"而跳过（同名终端每次 reload 塌缩成一个）
  const preexisting = [...vscode.window.terminals];
  for (const d of saved) {
    try {
      // 扩展宿主 reload（非窗口 reload）时旧终端可能仍存活，按名去重避免重复；
      // 只认 agent-dock pty 终端——同名的原生终端（如 fsOpenTerminal 恢复的）不得挡路
      const survivor = preexisting.find((t) => t.name === d.name && isAgentDockTerminal(t));
      if (survivor) {
        tlog.debug(`skip restoring "${d.name}": a terminal with that name already exists`);
        // 存活终端不在本进程的 liveTerminals 里：补记，否则它的 rename/close 都同步不到
        liveTerminals.set(survivor, d);
        continue;
      }
      const term = createTerminalFromSaved(d);
      if (term) {
        liveTerminals.set(term, d);
        term.show(true); // 恢复到终端面板，但不抢编辑器焦点
        tlog.debug(`restored terminal "${d.name}" kind=${d.kind} server=${d.serverName ?? '-'}`);
      }
    } catch (err) {
      // 单个终端恢复失败（如 node-pty 不可用、配置缺失）不拖垮整个 activate
      tlog.warn(`failed to restore terminal "${d.name}": ${String(err)}`);
    }
  }
  if (liveTerminals.size > 0) {
    tlog.info(`restored ${liveTerminals.size} client terminal(s) from previous session`);
  } else if (saved.length > 0) {
    tlog.info(`no client terminal restored (${saved.length} saved, none rebuilt)`);
  } else {
    tlog.debug('no saved client terminals to restore');
  }
  if (!namePollTimer) {
    namePollTimer = setInterval(() => syncAllTrackedTerminalNames(), NAME_POLL_MS);
    namePollTimer.unref?.();
  }
}

function createTerminalFromSaved(d: SavedClientTerminal): vscode.Terminal | undefined {
  if (d.kind === 'ssh' && d.serverName) {
    const server = getServers().find((s) => s.name === d.serverName);
    if (!server) {
      log.child('term').warn(`skip restoring terminal "${d.name}": server "${d.serverName}" not in config`);
      return undefined;
    }
    return vscode.window.createTerminal(clientTerminalOptions(d.name, sshSpawnSpec(server, d.remoteCommand)));
  }
  return vscode.window.createTerminal(clientTerminalOptions(d.name));
}

function persistTerminals(): void {
  if (shuttingDown) {
    return;
  }
  if (!terminalMemento) {
    log.child('term').debug('persistTerminals skipped: no memento (initClientTerminalPersistence not called?)');
    return;
  }
  // 浅拷贝快照：描述对象之后可能被 sync 改名，避免异步 update 落盘时已被改写
  const snapshot = [...liveTerminals.values()].map((d) => ({ ...d }));
  log.child('term').debug(`persistTerminals: writing ${snapshot.length} terminal(s)`, {
    names: snapshot.map((d) => d.name),
  });
  const memento = terminalMemento;
  lastPersist = persistQueue(async () => {
    await memento.update(TERMINAL_STORE_KEY, snapshot);
  }).catch((err: unknown) => {
    log.child('term').warn(`terminal persistence failed: ${String(err)}`);
  });
}

/** 记录一个应持久化的客户端终端（打开时调用）。 */
export function trackClientTerminal(term: vscode.Terminal, d: SavedClientTerminal): void {
  liveTerminals.set(term, d);
  log.child('term').debug(`tracked terminal "${d.name}" kind=${d.kind} server=${d.serverName ?? '-'}`);
  persistTerminals();
}

/** 终端被用户关闭时移除持久化记录。 */
export function untrackClientTerminal(term: vscode.Terminal): void {
  if (shuttingDown) {
    return;
  }
  if (liveTerminals.delete(term)) {
    log.child('term').debug(`untracked terminal "${term.name}"`);
    if (untrackPersistTimer) {
      clearTimeout(untrackPersistTimer);
    }
    untrackPersistTimer = setTimeout(() => {
      untrackPersistTimer = undefined;
      persistTerminals();
    }, UNTRACK_PERSIST_DEBOUNCE_MS);
  }
}

/**
 * 同步终端的当前显示名到持久化描述：VSCode 会因用户 rename 或 shell 标题变化
 * 更新 terminal.name（主进程通过 $acceptTerminalTitleChange 推送，onDidChangeTerminalState
 * 会触发）。不监听的话 reload 后重建用的是创建时的名字，用户 rename 过的名字会丢。
 */
export function syncTrackedTerminalName(term: vscode.Terminal): void {
  const d = liveTerminals.get(term);
  if (!d) {
    return;
  }
  if (syncName(d, term)) {
    persistTerminals();
  }
}

/**
 * 轮询兜底：onDidChangeTerminalState 不一定在用户 rename 时触发
 * （实测 renameWithArg/rename 只更新 Terminal.name，不派发该事件），
 * 因此定时把 tracked 终端的当前显示名刷回描述。
 */
export function syncAllTrackedTerminalNames(): void {
  let changed = false;
  for (const [term, d] of liveTerminals) {
    if (syncName(d, term)) {
      changed = true;
    }
  }
  if (changed) {
    persistTerminals();
  }
}

/** 单条同步：返回名字是否发生变化。 */
function syncName(d: SavedClientTerminal, term: vscode.Terminal): boolean {
  if (!term.name) {
    return false;
  }
  if (d.name === term.name) {
    return false;
  }
  log.child('term').debug(`sync name: "${d.name}" -> "${term.name}"`);
  d.name = term.name;
  return true;
}

/** 打开一个运行在客户端机器上的终端；不传 spec 时开客户端本机 shell。 */
export function openClientTerminal(opts: {
  name: string;
  spec?: SpawnSpecFactory;
  /** 提供后该终端会在 VSCode 重启/窗口重载后自动重建。 */
  persist?: SavedClientTerminal;
}): vscode.Terminal {
  const term = vscode.window.createTerminal(clientTerminalOptions(opts.name, opts.spec));
  if (opts.persist) {
    trackClientTerminal(term, opts.persist);
  }
  term.show();
  return term;
}

/**
 * 判断一个已打开的终端是否是 Agent Dock 客户端终端（profile 下拉创建的也命中）。
 * 用于 onDidOpenTerminal：profile 路径没有 track 调用，需要在这里补记。
 */
export function isAgentDockTerminal(term: vscode.Terminal): boolean {
  const opts = term.creationOptions;
  return !!(opts && 'pty' in opts && (opts as vscode.ExtensionTerminalOptions).pty instanceof ClientPty);
}

/** 该终端是否已在持久化跟踪列表中（避免 profile 补记覆盖 restore 的 ssh 描述）。 */
export function isTrackedTerminal(term: vscode.Terminal): boolean {
  return liveTerminals.has(term);
}
