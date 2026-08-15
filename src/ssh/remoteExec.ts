import { spawn } from 'node:child_process';
import type { ServerConfig } from '../model';
import { getSshConnectionPersist, getSshHostKeyMode, getSshTransport } from '../config';
import { buildSshBaseArgs, shq } from './sshArgs';
import { resolveServerConnection } from './sshConfig';
import { Semaphore } from './semaphore';
import { sessionFor } from './sshSession';
import { log, tail } from '../log';

export { shq, Semaphore };

const slog = log.child('ssh');

/** 进程级调用序号：发起与完成各打一条，多并发下能对上号。 */
let callSeq = 0;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** true when the process was killed for exceeding the timeout. */
  timedOut: boolean;
  cancelled?: boolean;
  /** true when stdout exceeded the output cap and the process was killed. */
  truncated?: boolean;
}

export interface ExecBufferResult {
  stdout: Buffer;
  stderr: string;
  code: number;
  timedOut: boolean;
  cancelled?: boolean;
  /** true when stdout exceeded the output cap and the process was killed. */
  truncated?: boolean;
}

export interface ExecOptions {
  signal?: AbortSignal;
  /** stdout 累计上限（字节），超过即 kill 子进程并以 truncated 返回。 */
  maxOutputBytes?: number;
  /** 周期轮询等高频静默调用：成功时跳过 debug 日志，仅在失败/超时/取消时记录。 */
  quiet?: boolean;
}

/** stdout 默认累计上限：防止失控远端脚本/大文件刷爆扩展宿主内存。 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result?: ExecResult,
  ) {
    super(message);
  }
}

function spawnCollect(
  command: string,
  args: string[],
  stdinData: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<ExecBufferResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ stdout: Buffer.alloc(0), stderr: '', code: -1, timedOut: false, cancelled: true });
      return;
    }
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new ExecError(`failed to spawn ${command}: ${String(err)}`));
      return;
    }
    const outChunks: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    // 子进程提前退出（ENOENT、连接被拒、SIGKILL 后仍在写）时管道写入会触发 EPIPE；
    // 无监听的 'error' 事件在 Node 中直接抛出，成为扩展宿主的未捕获异常，必须吞掉。
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    const kill = (): void => {
      // 先 SIGTERM 让 ssh 干净退出并清理 ControlMaster socket，短暂宽限后再 SIGKILL，
      // 避免直接 SIGKILL 杀掉共享 master 连接殃及同服务器其他并发操作。
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > maxOutputBytes) {
        truncated = true;
        kill();
        return;
      }
      outChunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ExecError(`failed to run ${command}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: Buffer.concat(outChunks), stderr, code: code ?? -1, timedOut, cancelled, truncated });
    });
    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

/**
 * 带取消的并发信号量：acquire(signal) 返回 true 表示拿到槽位；
 * 排队期间 signal 被 abort 则从队列移除并返回 false（不占用槽位）。
 * （实现移至 ./semaphore，此处仅保留导出兼容。）
 */

/** 全局 ssh 并发上限：spawn 降级路径与 runSsh 共用，避免超出 sshd/连接预算。 */
export const sshSemaphore = new Semaphore(4);

function scriptSummary(script: string): string {
  const first = script.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
  return first.slice(0, 60);
}

export function sshDestination(server: ServerConfig): string {
  return `${server.user ? `${server.user}@` : ''}${server.host}`;
}

export interface SshCliTarget {
  /** 传给 ssh 的目标（配置别名场景只传别名，让 ssh 自己读当前配置）。 */
  destination: string;
  /** servers 里填的 host（别名或主机名）。 */
  host: string;
  /** 仅当 host 不是 ssh config 别名时才显式传 -p；别名端口以当前 ssh config 为准。 */
  port?: number;
  configured: boolean;
}

/** 构造 spawn `ssh` 进程用的目标参数（异步解析 ~/.ssh/config，避免用 settings 里的旧端口）。 */
export async function resolveSshCliTarget(server: ServerConfig): Promise<SshCliTarget> {
  const resolved = await resolveServerConnection(server);
  return {
    destination: resolved.configured ? server.host : `${resolved.user ? `${resolved.user}@` : ''}${server.host}`,
    host: server.host,
    port: resolved.configured ? undefined : resolved.port,
    configured: resolved.configured,
  };
}

export function sshCliPortArgs(target: SshCliTarget): string[] {
  return target.port ? ['-p', String(target.port)] : [];
}

let muxDisabledLogged = false;

function sshBaseArgs(): string[] {
  if (process.platform === 'win32' && !muxDisabledLogged) {
    muxDisabledLogged = true;
    slog.info('ControlMaster disabled: Win32-OpenSSH does not support connection multiplexing');
  }
  return buildSshBaseArgs(getSshConnectionPersist(), process.platform);
}

/**
 * Run a bash script on a remote server via the system ssh client.
 * The script is piped to `bash -s` over stdin, so no quoting is needed.
 * BatchMode disables interactive auth — failures come back fast.
 */
/**
 * 发起/完成成对打日志（同一 id）：发起记录完整 argv，完成记录耗时与
 * stderr tail。getsockname 这类非致命报错 exit code 仍为 0，只有
 * stderr 里可见，所以成功路径也要在 debug 级输出 stderr。
 */
function logResult(id: number, dest: string, res: ExecBufferResult, ms: number): void {
  const status = res.cancelled ? 'cancelled' : res.timedOut ? 'timeout' : `code=${res.code}`;
  const fields = { ms, stderr: res.stderr.trim() ? tail(res.stderr) : undefined };
  if (res.cancelled || res.timedOut || res.code !== 0) {
    slog.warn(`#${id} ✗ ${dest} ${status}`, fields);
  } else {
    slog.debug(`#${id} ✓ ${dest} ${status}`, fields);
  }
}

function logSpawnError(id: number, dest: string, err: unknown): never {
  slog.error(`#${id} ✗ ${dest} spawn failed`, { error: String(err) });
  throw err;
}

export async function execRemote(
  server: ServerConfig,
  script: string,
  timeoutMs = 60_000,
  opts?: ExecOptions,
): Promise<ExecResult> {
  // 持久连接优先：同一服务器复用一条 SSH 连接（exec 通道），不每次 spawn ssh。
  // 连接/通道失败时降级到 spawn 路径（旧行为），保证可用性。
  if (getSshTransport() === 'persistent') {
    try {
      const res = await sessionFor(server, { hostKeyMode: getSshHostKeyMode() }).exec(script, timeoutMs, {
        signal: opts?.signal,
        maxOutputBytes: opts?.maxOutputBytes,
      });
      if (!opts?.quiet) {
        slog.debug(`#persistent ✓ ${sshDestination(server)} ← ${scriptSummary(script)}`);
      }
      return res;
    } catch (err) {
      slog.warn(`#persistent ✗ ${sshDestination(server)} fallback to spawn: ${String((err as Error)?.message ?? err)}`);
    }
  }
  const target = await resolveSshCliTarget(server);
  const args = sshBaseArgs();
  args.push(...sshCliPortArgs(target), target.destination, 'bash', '-s');
  const dest = target.destination;
  const id = ++callSeq;
  const enqueued = Date.now();
  const acquired = await sshSemaphore.acquire(opts?.signal);
  if (!acquired || opts?.signal?.aborted) {
    slog.debug(`#${id} ✗ ${dest} cancelled before spawn`);
    return { stdout: '', stderr: '', code: -1, timedOut: false, cancelled: true };
  }
  const started = Date.now();
  try {
    if (!opts?.quiet) {
      slog.debug(`#${id} → ${dest} ← ${scriptSummary(script)}`, { argv: `ssh ${args.join(' ')}`, scriptBytes: script.length, queueMs: started - enqueued || undefined });
    }
    const res = await spawnCollect('ssh', args, script, timeoutMs, opts?.signal, opts?.maxOutputBytes).catch((e) => logSpawnError(id, dest, e));
    if (!opts?.quiet) {
      logResult(id, dest, res, Date.now() - started);
    } else if (res.cancelled || res.timedOut || res.code !== 0) {
      logResult(id, dest, res, Date.now() - started);
    }
    return { ...res, stdout: res.stdout.toString('utf8') };
  } finally {
    sshSemaphore.release();
  }
}

export async function execRemoteBuffer(
  server: ServerConfig,
  script: string,
  timeoutMs = 60_000,
  opts?: ExecOptions,
): Promise<ExecBufferResult> {
  // 持久连接优先（exec 通道，stdout 保持二进制 Buffer）；失败降级 spawn。
  if (getSshTransport() === 'persistent') {
    try {
      const res = await sessionFor(server, { hostKeyMode: getSshHostKeyMode() }).execBuffer(script, timeoutMs, {
        signal: opts?.signal,
        maxOutputBytes: opts?.maxOutputBytes,
      });
      if (!opts?.quiet) {
        slog.debug(`#persistent ✓ ${sshDestination(server)} ← ${scriptSummary(script)} (binary)`);
      }
      return res;
    } catch (err) {
      slog.warn(`#persistent ✗ ${sshDestination(server)} fallback to spawn: ${String((err as Error)?.message ?? err)}`);
    }
  }
  const target = await resolveSshCliTarget(server);
  const args = sshBaseArgs();
  args.push(...sshCliPortArgs(target), target.destination, 'bash', '-s');
  const dest = target.destination;
  const id = ++callSeq;
  const enqueued = Date.now();
  const acquired = await sshSemaphore.acquire(opts?.signal);
  if (!acquired || opts?.signal?.aborted) {
    slog.debug(`#${id} ✗ ${dest} cancelled before spawn`);
    return { stdout: Buffer.alloc(0), stderr: '', code: -1, timedOut: false, cancelled: true };
  }
  const started = Date.now();
  try {
    if (!opts?.quiet) {
      slog.debug(`#${id} → ${dest} ← ${scriptSummary(script)} (binary)`, { queueMs: started - enqueued || undefined });
    }
    const res = await spawnCollect('ssh', args, script, timeoutMs, opts?.signal, opts?.maxOutputBytes).catch((e) => logSpawnError(id, dest, e));
    if (!opts?.quiet) {
      logResult(id, dest, res, Date.now() - started);
    } else if (res.cancelled || res.timedOut || res.code !== 0) {
      logResult(id, dest, res, Date.now() - started);
    }
    return res;
  } finally {
    sshSemaphore.release();
  }
}

/** Run ssh with raw trailing args (e.g. `-O forward` control commands); unlike execRemote nothing is piped to bash. */
export async function runSsh(server: ServerConfig, extraArgs: string[], timeoutMs = 15_000): Promise<ExecResult> {
  const target = await resolveSshCliTarget(server);
  const args = sshBaseArgs();
  args.push(...sshCliPortArgs(target));
  args.push(...extraArgs);
  const dest = target.destination;
  const id = ++callSeq;
  const started = Date.now();
  // 与其他远端调用共用全局并发上限，避免轮询/扫描占满时叠加出额外 ssh 进程
  const acquired = await sshSemaphore.acquire();
  if (!acquired) {
    return { stdout: '', stderr: '', code: -1, timedOut: false, cancelled: true };
  }
  try {
    slog.debug(`#${id} → ${dest} (raw)`, { argv: `ssh ${args.join(' ')}` });
    const res = await spawnCollect('ssh', args, undefined, timeoutMs).catch((e) => logSpawnError(id, dest, e));
    logResult(id, dest, res, Date.now() - started);
    return { ...res, stdout: res.stdout.toString('utf8') };
  } finally {
    sshSemaphore.release();
  }
}

/** Run a bash script on the machine the extension host runs on (= current server). */
export async function execLocal(script: string, timeoutMs = 60_000, opts?: ExecOptions): Promise<ExecResult> {
  const id = ++callSeq;
  const started = Date.now();
  slog.debug(`#${id} → local ← ${scriptSummary(script)}`, { scriptBytes: script.length });
  const res = await spawnCollect('bash', ['-s'], script, timeoutMs, opts?.signal, opts?.maxOutputBytes).catch((e) => logSpawnError(id, 'local', e));
  logResult(id, 'local', res, Date.now() - started);
  return { ...res, stdout: res.stdout.toString('utf8') };
}
