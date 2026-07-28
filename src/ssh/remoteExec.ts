import { spawn } from 'node:child_process';
import type { ServerConfig } from '../model';
import { getSshConnectionPersist } from '../config';
import { buildSshBaseArgs, shq } from './sshArgs';
import { log, tail } from '../log';

export { shq };

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
}

export interface ExecBufferResult {
  stdout: Buffer;
  stderr: string;
  code: number;
  timedOut: boolean;
  cancelled?: boolean;
}

export interface ExecOptions {
  signal?: AbortSignal;
}

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
): Promise<ExecBufferResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new ExecError(`failed to spawn ${command}: ${String(err)}`));
      return;
    }
    const outChunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
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
      resolve({ stdout: Buffer.concat(outChunks), stderr, code: code ?? -1, timedOut, cancelled });
    });
    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running += 1;
  }

  release(): void {
    this.running -= 1;
    this.queue.shift()?.();
  }
}

const sshSemaphore = new Semaphore(4);

function scriptSummary(script: string): string {
  const first = script.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
  return first.slice(0, 60);
}

export function sshDestination(server: ServerConfig): string {
  return `${server.user ? `${server.user}@` : ''}${server.host}`;
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
  const args = sshBaseArgs();
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server), 'bash', '-s');
  const dest = sshDestination(server);
  const id = ++callSeq;
  const enqueued = Date.now();
  await sshSemaphore.acquire();
  const started = Date.now();
  try {
    slog.debug(`#${id} → ${dest} ← ${scriptSummary(script)}`, { argv: `ssh ${args.join(' ')}`, scriptBytes: script.length, queueMs: started - enqueued || undefined });
    const res = await spawnCollect('ssh', args, script, timeoutMs, opts?.signal).catch((e) => logSpawnError(id, dest, e));
    logResult(id, dest, res, Date.now() - started);
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
  const args = sshBaseArgs();
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server), 'bash', '-s');
  const id = ++callSeq;
  const enqueued = Date.now();
  await sshSemaphore.acquire();
  const started = Date.now();
  try {
    slog.debug(`#${id} → ${sshDestination(server)} ← ${scriptSummary(script)} (binary)`, { queueMs: started - enqueued || undefined });
    const res = await spawnCollect('ssh', args, script, timeoutMs, opts?.signal).catch((e) => logSpawnError(id, sshDestination(server), e));
    logResult(id, sshDestination(server), res, Date.now() - started);
    return res;
  } finally {
    sshSemaphore.release();
  }
}

/** Run ssh with raw trailing args (e.g. `-O forward` control commands); unlike execRemote nothing is piped to bash. */
export async function runSsh(server: ServerConfig, extraArgs: string[], timeoutMs = 15_000): Promise<ExecResult> {
  const args = sshBaseArgs();
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(...extraArgs);
  const id = ++callSeq;
  const started = Date.now();
  slog.debug(`#${id} → ${sshDestination(server)} (raw)`, { argv: `ssh ${args.join(' ')}` });
  const res = await spawnCollect('ssh', args, undefined, timeoutMs).catch((e) => logSpawnError(id, sshDestination(server), e));
  logResult(id, sshDestination(server), res, Date.now() - started);
  return { ...res, stdout: res.stdout.toString('utf8') };
}

/** Run a bash script on the machine the extension host runs on (= current server). */
export async function execLocal(script: string, timeoutMs = 60_000): Promise<ExecResult> {
  const id = ++callSeq;
  const started = Date.now();
  slog.debug(`#${id} → local ← ${scriptSummary(script)}`, { scriptBytes: script.length });
  const res = await spawnCollect('bash', ['-s'], script, timeoutMs).catch((e) => logSpawnError(id, 'local', e));
  logResult(id, 'local', res, Date.now() - started);
  return { ...res, stdout: res.stdout.toString('utf8') };
}
