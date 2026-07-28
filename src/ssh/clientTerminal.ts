import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { buildClientShellSpawn, buildInteractiveSshArgs, buildPtySshArgs, type SpawnSpec, type TermDimensions } from './sshArgs';
import { t } from '../i18n';
import { log } from '../log';

const DEFAULT_DIMS: TermDimensions = { rows: 24, cols: 80 };

/** 终端打开时才知道初始尺寸与后端类型（真 pty / 管道），spawn 规格用工厂延迟求值。 */
export type SpawnSpecFactory = (dims: TermDimensions, realPty: boolean) => SpawnSpec;

/** ssh 跳板的 spawn 规格：在客户端直接起 ssh，不经任何本地 shell。 */
export function sshSpawnSpec(server: ServerConfig, remoteCommand?: string): SpawnSpecFactory {
  return (dims, realPty) => ({
    file: 'ssh',
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
 * 加载可选原生依赖 node-pty；未安装 / ABI 不符 / 被 AGENTDOCK_NO_NODE_PTY
 * 显式禁用（诊断与测试用）时返回 undefined，调用方退回管道后端。
 */
function loadNodePty(): NodePtyModule | undefined {
  if (process.env.AGENTDOCK_NO_NODE_PTY) {
    return undefined;
  }
  if (nodePtyCache !== undefined) {
    return nodePtyCache ?? undefined;
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
        this.lineBuf = [];
        this.writeEmitter.fire('^C\r\n');
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

/** 打开一个运行在客户端机器上的终端；不传 spec 时开客户端本机 shell。 */
export function openClientTerminal(opts: { name: string; spec?: SpawnSpecFactory }): vscode.Terminal {
  const term = vscode.window.createTerminal(clientTerminalOptions(opts.name, opts.spec));
  term.show();
  return term;
}
