import { spawn, type ChildProcess } from 'node:child_process';
import type { PortForward, ServerConfig } from '../model';
import { execRemote, runSsh, sshDestination } from './remoteExec';
import { parseListeners, type ListeningService } from './listeners';
import { log, tail } from '../log';

const flog = log.child('forward');

export { parseListeners, type ListeningService };

export function forwardSpec(f: PortForward): string {
  return `${f.localPort}:${f.remoteHost ?? 'localhost'}:${f.remotePort}`;
}

const SERVICE_TTL_MS = 30_000;
const serviceCache = new Map<string, { at: number; byPort: Map<number, ListeningService> }>();

/** 类似原生「端口」视图：探测服务器上各监听端口对应的进程，30 秒 TTL 缓存避免每次展开都 ssh。 */
export async function detectListeningServices(server: ServerConfig): Promise<Map<number, ListeningService>> {
  const cached = serviceCache.get(server.name);
  if (cached && Date.now() - cached.at < SERVICE_TTL_MS) {
    return cached.byPort;
  }
  const res = await execRemote(server, `(ss -tlnpH 2>/dev/null || netstat -tlnp 2>/dev/null) | head -300`, 10_000);
  const byPort = parseListeners(res.stdout);
  flog.debug(`services on ${server.name}: ${byPort.size} listening ports`);
  serviceCache.set(server.name, { at: Date.now(), byPort });
  return byPort;
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

let onDidChange: ((serverName: string) => void) | undefined;

export function setOnDidChange(cb: (serverName: string) => void): void {
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
    flog.warn(`probe failed on ${server.name}`, { code: probe.code, stderr: tail(probe.stderr) });
    throw new Error(`ssh to ${server.name} failed: ${probe.stderr.trim().slice(0, 200) || `exit ${probe.code}`}`);
  }
  // 优先 -O forward：复用主连接下发转发，不新建进程，随 ControlPersist 存活
  const res = await runSsh(server, ['-O', 'forward', '-L', spec, sshDestination(server)]);
  if (res.code === 0) {
    active.set(k, { mode: 'master' });
    flog.info(`up ${server.name} ${spec} (via ControlMaster)`);
    onDidChange?.(server.name);
    return;
  }
  flog.debug(`-O forward unavailable on ${server.name}, falling back to dedicated process`, { code: res.code, stderr: tail(res.stderr) });
  // 回退：独立 ssh -N 进程（如连接复用被禁用或 OpenSSH < 6.7）
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-L', spec];
  if (server.port) {
    args.push('-p', String(server.port));
  }
  args.push(sshDestination(server));
  flog.debug(`spawning dedicated forward process`, { argv: `ssh ${args.join(' ')}` });
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
      flog.warn(`down ${server.name} ${spec} (process exited ${code ?? -1})`);
      onDidChange?.(server.name);
    }
  });
  active.set(k, { mode: 'process', child });
  flog.info(`up ${server.name} ${spec} (dedicated process)`);
  onDidChange?.(server.name);
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
      flog.warn(`-O cancel failed on ${server.name}`, { code: res.code, stderr: tail(res.stderr) });
    }
  }
  active.delete(k);
  flog.info(`down ${server.name} ${forwardSpec(f)}`);
  onDidChange?.(server.name);
}
