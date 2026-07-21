import { spawn } from 'node:child_process';
import type { ServerConfig } from '../model';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** true when the process was killed for exceeding the timeout. */
  timedOut: boolean;
}

export interface ExecBufferResult {
  stdout: Buffer;
  stderr: string;
  code: number;
  timedOut: boolean;
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      outChunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ExecError(`failed to run ${command}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(outChunks), stderr, code: code ?? -1, timedOut });
    });
    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
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
  'ControlPersist=10m',
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
): Promise<ExecResult> {
  const args = [...SSH_BASE_ARGS];
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server), 'bash', '-s');
  const res = await spawnCollect('ssh', args, script, timeoutMs);
  return { ...res, stdout: res.stdout.toString('utf8') };
}

export async function execRemoteBuffer(
  server: ServerConfig,
  script: string,
  timeoutMs = 60_000,
): Promise<ExecBufferResult> {
  const args = [...SSH_BASE_ARGS];
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server), 'bash', '-s');
  return spawnCollect('ssh', args, script, timeoutMs);
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
