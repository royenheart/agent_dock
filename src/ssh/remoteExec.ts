import { spawn } from 'node:child_process';
import type { ServerConfig } from '../model';
import { log } from '../log';

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

const SSH_BASE_ARGS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=8',
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPath=~/.ssh/agentdock-cm-%r@%h:%p',
  '-o',
  'ControlPersist=8h',
  '-T',
];

/**
 * Run a bash script on a remote server via the system ssh client.
 * The script is piped to `bash -s` over stdin, so no quoting is needed.
 * BatchMode disables interactive auth — failures come back fast.
 */
export async function execRemote(
  server: ServerConfig,
  script: string,
  timeoutMs = 60_000,
  opts?: ExecOptions,
): Promise<ExecResult> {
  const args = [...SSH_BASE_ARGS];
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server), 'bash', '-s');
  const dest = sshDestination(server);
  const started = Date.now();
  await sshSemaphore.acquire();
  try {
    log.debug(`[ssh] ${dest} ← ${scriptSummary(script)}`);
    const res = await spawnCollect('ssh', args, script, timeoutMs, opts?.signal);
    const ms = Date.now() - started;
    const status = res.cancelled ? 'cancelled' : res.timedOut ? 'timeout' : `code=${res.code}`;
    if (res.cancelled || res.timedOut || res.code !== 0) {
      log.warn(`[ssh] ${dest} ${status} in ${ms}ms`);
    } else {
      log.debug(`[ssh] ${dest} ${status} in ${ms}ms`);
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
  const args = [...SSH_BASE_ARGS];
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server), 'bash', '-s');
  const started = Date.now();
  await sshSemaphore.acquire();
  try {
    log.debug(`[ssh] ${sshDestination(server)} ← ${scriptSummary(script)} (binary)`);
    const res = await spawnCollect('ssh', args, script, timeoutMs, opts?.signal);
    log.debug(`[ssh] ${sshDestination(server)} code=${res.code} in ${Date.now() - started}ms`);
    return res;
  } finally {
    sshSemaphore.release();
  }
}

/** Run a bash script on the machine the extension host runs on (= current server). */
export async function execLocal(script: string, timeoutMs = 60_000): Promise<ExecResult> {
  const res = await spawnCollect('bash', ['-s'], script, timeoutMs);
  return { ...res, stdout: res.stdout.toString('utf8') };
}

/** Quote a string for inclusion inside a POSIX single-quoted context. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
