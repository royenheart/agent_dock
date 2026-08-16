import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { PortForward, ServerConfig } from '../model';
import { getServers } from '../config';
import { execRemote, resolveSshCliTarget, sshCliPortArgs } from './remoteExec';
import { parseListeners, type ListeningService } from './listeners';
import { log, tail } from '../log';

const flog = log.child('forward');

export { parseListeners, type ListeningService };

export function forwardSpec(f: PortForward): string {
  return `${f.localPort}:${f.remoteHost ?? 'localhost'}:${f.remotePort}`;
}

/** 意外断线后的重试退避：1s → 2s → 4s → 8s → 16s → 30s（封顶）。 */
export function forwardRetryDelayMs(attempt: number): number {
  const exp = Math.min(Math.max(0, Math.floor(attempt)), 5);
  return Math.min(1000 * 2 ** exp, 30_000);
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
  child?: ChildProcess;
  server: ServerConfig;
  forward: PortForward;
  key: string;
  /** 连续失败次数（决定退避间隔；成功启动后归零）。 */
  attempt: number;
  restartTimer?: NodeJS.Timeout;
  stopping?: boolean;
  starting?: boolean;
}

// 与原生端口转发保持同样语义：只要窗口还活着、用户没有手动停掉，转发就应持续存在。
// 这里统一用“每转发一个受监控的 ssh -N 独立进程”，进程意外退出后按指数退避自动重启；
// 用户停止前不从 active 删除，因此树上的状态不会因为网络抖动而反复回落到 inactive。
const active = new Map<string, ActiveForward>();
const keyOf = (serverName: string, f: PortForward): string => `${serverName}|${forwardSpec(f)}`;

const FORWARD_STORE_KEY = 'agentDock.activeForwards.v1';
let forwardStore: vscode.Memento | undefined;

/** reload 后自动重启上一窗口仍在运行的转发；启动失败的条目退避重试。 */
const pendingRestores = new Map<string, { server: ServerConfig; forward: PortForward; attempt: number; timer?: NodeJS.Timeout }>();
let shuttingDown = false;

export function initForwardStore(memento: vscode.Memento): void {
  forwardStore = memento;
}

function persistActiveForwards(): void {
  if (!forwardStore || shuttingDown) {
    return;
  }
  const list: { serverName: string; forward: PortForward }[] = [];
  for (const entry of active.values()) {
    const server = getServers().find((s) => s.name === entry.server.name);
    const forward = server?.forwards?.find((f) => forwardSpec(f) === forwardSpec(entry.forward));
    if (forward) {
      list.push({ serverName: entry.server.name, forward });
    }
  }
  forwardStore.update(FORWARD_STORE_KEY, list).then(
    () => {},
    (err: unknown) => flog.warn(`forward persistence failed: ${String(err)}`),
  );
}

function clearPendingRestore(k: string): void {
  const pending = pendingRestores.get(k);
  if (pending?.timer) {
    clearTimeout(pending.timer);
  }
  pendingRestores.delete(k);
}

function scheduleRestoreRetry(server: ServerConfig, forward: PortForward): void {
  const k = keyOf(server.name, forward);
  if (shuttingDown || active.has(k) || pendingRestores.has(k)) {
    return;
  }
  const pending = { server, forward, attempt: 0, timer: undefined as NodeJS.Timeout | undefined };
  pendingRestores.set(k, pending);
  armRestoreRetry(pending);
}

function armRestoreRetry(pending: { server: ServerConfig; forward: PortForward; attempt: number; timer?: NodeJS.Timeout }): void {
  if (shuttingDown) {
    return;
  }
  const delay = forwardRetryDelayMs(pending.attempt);
  pending.attempt += 1;
  pending.timer = setTimeout(() => {
    pending.timer = undefined;
    startForward(pending.server, pending.forward)
      .then(() => clearPendingRestore(keyOf(pending.server.name, pending.forward)))
      .catch(() => armRestoreRetry(pending));
  }, delay);
  pending.timer.unref?.();
}

/** 窗口 reload 后自动重启上次仍在运行的端口转发；失败会退避重试直到窗口关闭。 */
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
    void startForward(server, forward).catch((err) => {
      flog.warn(`restore forward ${serverName} ${forwardSpec(forward)} failed: ${String(err)}`);
      scheduleRestoreRetry(server, forward);
    });
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
  clearPendingRestore(k);
  if (active.has(k)) {
    return;
  }
  const probe = await execRemote(server, 'true', 10_000);
  if (probe.code !== 0) {
    flog.warn(`probe failed on ${server.name}`, { code: probe.code, stderr: tail(probe.stderr) });
    throw new Error(`ssh to ${server.name} failed: ${probe.stderr.trim().slice(0, 200) || `exit ${probe.code}`}`);
  }
  const entry: ActiveForward = { server, forward: f, key: k, attempt: 0 };
  active.set(k, entry);
  try {
    await spawnForwardProcess(entry);
  } catch (err) {
    active.delete(k);
    throw err;
  }
  entry.attempt = 0;
  persistActiveForwards();
  flog.info(`up ${server.name} ${forwardSpec(f)} (monitored process)`);
  onDidChange?.(server.name);
}

/** 启动/重启一个 ssh -N -L 进程；启动窗口内失败会抛错，之后退出交给 exit handler 自动重启。 */
async function spawnForwardProcess(entry: ActiveForward): Promise<void> {
  if (shuttingDown || entry.stopping) {
    return;
  }
  const server = getServers().find((s) => s.name === entry.server.name) ?? entry.server;
  const cli = await resolveSshCliTarget(server);
  const spec = forwardSpec(entry.forward);
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-N',
    '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', spec,
    ...sshCliPortArgs(cli),
    cli.destination,
  ];
  flog.debug(`spawning monitored forward process`, { argv: `ssh ${args.join(' ')}` });
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  entry.child = child;
  entry.starting = true;
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (entry.starting) {
        entry.starting = false;
        resolve();
      }
    }, 2500);
    child.once('error', (err) => {
      if (entry.starting) {
        entry.starting = false;
        entry.child = undefined;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.once('exit', (code) => {
      if (entry.starting) {
        entry.starting = false;
        entry.child = undefined;
        clearTimeout(timer);
        reject(new Error(stderr.trim().slice(0, 200) || `ssh exited ${code ?? -1}`));
      }
    });
  });
  entry.starting = false;
  if (shuttingDown || entry.stopping || active.get(entry.key) !== entry) {
    child.kill('SIGTERM');
    return;
  }
  if (child.exitCode !== null) {
    entry.child = undefined;
    handleUnexpectedExit(entry, child.exitCode);
    return;
  }
  child.on('exit', (code) => {
    if (entry.child === child) {
      entry.child = undefined;
      handleUnexpectedExit(entry, code ?? -1);
    }
  });
  child.on('error', (err) => {
    if (entry.child === child) {
      entry.child = undefined;
      flog.warn(`forward process error on ${entry.server.name}: ${String(err)}`);
    }
  });
}

function handleUnexpectedExit(entry: ActiveForward, code: number): void {
  if (shuttingDown || entry.stopping || active.get(entry.key) !== entry) {
    return;
  }
  flog.warn(`down ${entry.server.name} ${forwardSpec(entry.forward)} (process exited ${code}), restarting`);
  onDidChange?.(entry.server.name);
  scheduleRestart(entry);
}

function scheduleRestart(entry: ActiveForward): void {
  if (shuttingDown || entry.stopping || entry.restartTimer || active.get(entry.key) !== entry) {
    return;
  }
  const delay = forwardRetryDelayMs(entry.attempt);
  entry.attempt += 1;
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = undefined;
    void restartEntry(entry);
  }, delay);
  entry.restartTimer.unref?.();
}

async function restartEntry(entry: ActiveForward): Promise<void> {
  if (shuttingDown || entry.stopping || active.get(entry.key) !== entry) {
    return;
  }
  const server = getServers().find((s) => s.name === entry.server.name);
  if (!server) {
    active.delete(entry.key);
    persistActiveForwards();
    onDidChange?.(entry.server.name);
    return;
  }
  try {
    await spawnForwardProcess(entry);
    entry.attempt = 0;
    flog.info(`up ${entry.server.name} ${forwardSpec(entry.forward)} (restarted)`);
    onDidChange?.(entry.server.name);
  } catch (err) {
    flog.warn(`restart forward ${entry.server.name} ${forwardSpec(entry.forward)} failed: ${String(err)}`);
    scheduleRestart(entry);
  }
}

export async function stopForward(server: ServerConfig, f: PortForward): Promise<void> {
  const k = keyOf(server.name, f);
  const entry = active.get(k);
  if (!entry) {
    return;
  }
  entry.stopping = true;
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = undefined;
  }
  entry.child?.kill('SIGTERM');
  entry.child = undefined;
  active.delete(k);
  persistActiveForwards();
  flog.info(`down ${server.name} ${forwardSpec(f)}`);
  onDidChange?.(server.name);
}

/** 窗口 reload 的销毁序列：杀进程/清定时器，但保留 workspaceState 里的 active 列表供下一窗口重启。 */
export function markForwardsShuttingDown(): void {
  shuttingDown = true;
  for (const entry of active.values()) {
    entry.stopping = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.child?.kill('SIGTERM');
    entry.child = undefined;
  }
  for (const pending of pendingRestores.values()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }
  pendingRestores.clear();
}
