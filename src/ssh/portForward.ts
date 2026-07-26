import { spawn, type ChildProcess } from 'node:child_process';
import type { PortForward, ServerConfig } from '../model';
import { execRemote, runSsh, sshDestination } from './remoteExec';
import { log } from '../log';

export function forwardSpec(f: PortForward): string {
  return `${f.localPort}:${f.remoteHost ?? 'localhost'}:${f.remotePort}`;
}

interface ActiveForward {
  mode: 'master' | 'process';
  child?: ChildProcess;
}

// 活跃转发只存在于内存：master 模式随主连接（ControlPersist）存活，process 模式随窗口存活
const active = new Map<string, ActiveForward>();
const keyOf = (serverName: string, f: PortForward): string => `${serverName}|${forwardSpec(f)}`;

export function isForwardActive(serverName: string, f: PortForward): boolean {
  return active.has(keyOf(serverName, f));
}

let onDidChange: (() => void) | undefined;

export function setOnDidChange(cb: () => void): void {
  onDidChange = cb;
}

export async function startForward(server: ServerConfig, f: PortForward): Promise<void> {
  const k = keyOf(server.name, f);
  if (active.has(k)) {
    return;
  }
  const spec = forwardSpec(f);
  const probe = await execRemote(server, 'true', 10_000);
  if (probe.code !== 0) {
    throw new Error(`ssh to ${server.name} failed: ${probe.stderr.trim().slice(0, 200) || `exit ${probe.code}`}`);
  }
  // 优先 -O forward：复用主连接下发转发，不新建进程，随 ControlPersist 存活
  const res = await runSsh(server, ['-O', 'forward', '-L', spec, sshDestination(server)]);
  if (res.code === 0) {
    active.set(k, { mode: 'master' });
    log.info(`[forward] up ${server.name} ${spec} (via ControlMaster)`);
    onDidChange?.();
    return;
  }
  log.debug(`[forward] -O forward unavailable on ${server.name}: ${res.stderr.trim().slice(0, 200)}`);
  // 回退：独立 ssh -N 进程（如连接复用被禁用或 OpenSSH < 6.7）
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-L', spec];
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server));
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 1500);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(stderr.trim().slice(0, 200) || `ssh exited ${code ?? -1}`));
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  child.on('exit', (code) => {
    if (active.get(k)?.child === child) {
      active.delete(k);
      log.warn(`[forward] down ${server.name} ${spec} (process exited ${code ?? -1})`);
      onDidChange?.();
    }
  });
  active.set(k, { mode: 'process', child });
  log.info(`[forward] up ${server.name} ${spec} (dedicated process)`);
  onDidChange?.();
}

export async function stopForward(server: ServerConfig, f: PortForward): Promise<void> {
  const k = keyOf(server.name, f);
  const cur = active.get(k);
  if (!cur) {
    return;
  }
  if (cur.mode === 'process') {
    cur.child?.kill('SIGTERM');
  } else {
    const res = await runSsh(server, ['-O', 'cancel', '-L', forwardSpec(f), sshDestination(server)]);
    if (res.code !== 0) {
      log.warn(`[forward] -O cancel failed on ${server.name}: ${res.stderr.trim().slice(0, 200)}`);
    }
  }
  active.delete(k);
  log.info(`[forward] down ${server.name} ${forwardSpec(f)}`);
  onDidChange?.();
}
