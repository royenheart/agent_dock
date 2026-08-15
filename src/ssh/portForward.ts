import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { PortForward, ServerConfig } from '../model';
import { getServers } from '../config';
import { execRemote, resolveSshCliTarget, runSsh, sshCliPortArgs } from './remoteExec';
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

// 活跃转发只存在于内存：master 模式随主连接（ControlPersist）存活，process 模式随窗口存活。
// 同时把「启动中的转发」写入 workspaceState，窗口 reload 后自动重启（见 restoreActiveForwards）。
const active = new Map<string, ActiveForward>();
const keyOf = (serverName: string, f: PortForward): string => `${serverName}|${forwardSpec(f)}`;

const FORWARD_STORE_KEY = 'agentDock.activeForwards.v1';
let forwardStore: vscode.Memento | undefined;

export function initForwardStore(memento: vscode.Memento): void {
  forwardStore = memento;
}

function persistActiveForwards(): void {
  if (!forwardStore) {
    return;
  }
  const list: { serverName: string; forward: PortForward }[] = [];
  for (const [k] of active) {
    const sep = k.indexOf('|');
    const serverName = k.slice(0, sep);
    const spec = k.slice(sep + 1);
    const server = getServers().find((s) => s.name === serverName);
    const forward = server?.forwards?.find((f) => forwardSpec(f) === spec);
    if (forward) {
      list.push({ serverName, forward });
    }
  }
  forwardStore.update(FORWARD_STORE_KEY, list).then(
    () => {},
    (err: unknown) => flog.warn(`forward persistence failed: ${String(err)}`),
  );
}

/** 窗口 reload 后自动重启上次仍在运行的端口转发。 */
export async function restoreActiveForwards(): Promise<void> {
  if (!forwardStore) {
    return;
  }
  const saved = forwardStore.get<{ serverName: string; forward: PortForward }[]>(FORWARD_STORE_KEY, []);
  for (const { serverName, forward } of saved) {
    const server = getServers().find((s) => s.name === serverName);
    if (!server) {
      continue;
    }
    try {
      await startForward(server, forward);
    } catch (err) {
      flog.warn(`restore forward ${serverName} ${forwardSpec(forward)} failed: ${String(err)}`);
    }
  }
}

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
  // host 命中 ssh config 别名时以当前配置为准，不用 servers 里旧缓存的端口
  const cli = await resolveSshCliTarget(server);
  // 优先 -O forward：复用主连接下发转发，不新建进程，随 ControlPersist 存活。
  // Windows 的 Win32-OpenSSH 不支持 ControlMaster（buildSshBaseArgs 已去掉 ControlPath），
  // -O 必然报 "No ControlPath specified"，直接跳过，避免每次启动转发都打一条失败日志。
  if (process.platform !== 'win32') {
    const res = await runSsh(server, ['-O', 'forward', '-L', spec, cli.destination]);
    if (res.code === 0) {
      active.set(k, { mode: 'master' });
      persistActiveForwards();
      flog.info(`up ${server.name} ${spec} (via ControlMaster)`);
      onDidChange?.(server.name);
      return;
    }
    flog.debug(`-O forward unavailable on ${server.name}, falling back to dedicated process`, { code: res.code, stderr: tail(res.stderr) });
  }
  // 回退：独立 ssh -N 进程（如连接复用被禁用、Windows、或 OpenSSH < 6.7）
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-L', spec];
  args.push(...sshCliPortArgs(cli), cli.destination);
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
      persistActiveForwards();
      flog.warn(`down ${server.name} ${spec} (process exited ${code ?? -1})`);
      onDidChange?.(server.name);
    }
  });
  active.set(k, { mode: 'process', child });
  persistActiveForwards();
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
    const cli = await resolveSshCliTarget(server);
    const res = await runSsh(server, ['-O', 'cancel', '-L', forwardSpec(f), cli.destination]);
    if (res.code !== 0) {
      flog.warn(`-O cancel failed on ${server.name}`, { code: res.code, stderr: tail(res.stderr) });
    }
  }
  active.delete(k);
  persistActiveForwards();
  flog.info(`down ${server.name} ${forwardSpec(f)}`);
  onDidChange?.(server.name);
}
