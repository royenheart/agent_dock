import * as os from 'node:os';
import * as vscode from 'vscode';
import type { PortForward, ServerConfig } from './model';
import { findCurrentServer, hostMatches, mergeServersByName, parseServerList, planRegistration } from './serverRegistration';
import { log } from './log';

export { findCurrentServer, hostMatches };

const SECTION = 'agentDock';
const LEGACY_SECTIONS = ['vscoder', 'agentWorkspace'];

export function getServers(): ServerConfig[] {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  let raw = cfg.get<unknown>('servers', []);
  if (!Array.isArray(raw) || raw.length === 0) {
    for (const legacySection of LEGACY_SECTIONS) {
      const legacy = vscode.workspace.getConfiguration(legacySection).get<unknown>('servers', []);
      if (Array.isArray(legacy) && legacy.length > 0) {
        raw = legacy;
        break;
      }
    }
  }
  return parseServerList(raw);
}

export async function addServer(server: ServerConfig): Promise<void> {
  const servers = [...getServers(), server];
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('servers', servers, vscode.ConfigurationTarget.Global);
}

async function upsertServer(server: ServerConfig): Promise<void> {
  const servers = getServers();
  const idx = servers.findIndex((s) => s.name === server.name);
  if (idx >= 0) {
    servers[idx] = server;
  } else {
    servers.push(server);
  }
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('servers', servers, vscode.ConfigurationTarget.Global);
}

/**
 * 把当前窗口连接的服务器登记进配置，并让其 folders 镜像原生 workspace。
 * 扩展只有"添加其他服务器"的入口，当前服务器永远不进 settings，导致切到
 * 别的机器后这台服务器在 AW 里消失或以别名/配置项两种形态重复出现。
 * 登记后每台机器的配置都会补全为全集，谁当前谁走原生 API。
 */
export async function ensureCurrentServerRegistered(): Promise<void> {
  await migrateRemoteServersToLocal();

  const ctx = getCurrentContext();
  const wsPaths = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'vscode-remote')
    .map((f) => f.uri.path);
  const plan = planRegistration({ isLocal: ctx.isLocal, sshHost: ctx.sshHost, wsPaths, servers: getServers() });
  switch (plan.action) {
    case 'skip':
      log.child('config').debug(`register-current skipped: ${plan.reason}`);
      return;
    case 'none':
      return;
    case 'sync-folders':
      await upsertServer({ ...plan.server, folders: plan.folders });
      log.child('config').info(`synced ${plan.server.name} folders from workspace (${plan.folders.length})`);
      return;
    case 'register':
      await upsertServer(plan.server);
      log.child('config').info(`registered current server as ${plan.server.name}`);
      return;
  }
}

let migrationAttempted = false;

/**
 * Global(USER) 写入有粘滞性（VS Code configurationService.toEditableConfigurationTarget）：
 * key 在远程 user settings 已有值时写入落到远程机的 settings，客户端 settings.json
 * 看不到，且读取时 remote 覆盖 local。这里把远程列表合并进客户端列表并删除远程值，
 * 之后写入即回落到客户端单一来源。
 */
async function migrateRemoteServersToLocal(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const insp = cfg.inspect<unknown>('servers');
  // globalLocalValue/globalRemoteValue 存在于运行时而未出现在 1.96 类型定义里，做带守卫的运行时探测
  const rec = insp as unknown as Record<string, unknown> | undefined;
  const hasScopeFields = rec !== undefined && ('globalRemoteValue' in rec || 'globalLocalValue' in rec);
  const local = hasScopeFields && Array.isArray(rec.globalLocalValue) ? parseServerList(rec.globalLocalValue) : undefined;
  const remote = hasScopeFields && Array.isArray(rec.globalRemoteValue) ? parseServerList(rec.globalRemoteValue) : undefined;
  log.child('config').info(
    `servers scopes: local=${local ? local.length : '—'} remote=${remote ? remote.length : '—'}${hasScopeFields ? '' : ' (scope fields unavailable)'}`,
  );
  if (hasScopeFields && (!remote || remote.length === 0)) {
    return;
  }
  // 旧运行时探测不到分层字段：每会话做一次删除+重写兜底（无粘滞时等价于原样重写）
  if (!hasScopeFields) {
    if (migrationAttempted) {
      return;
    }
    migrationAttempted = true;
  }
  const merged = remote && remote.length > 0 ? mergeServersByName(local ?? getServers(), remote) : getServers();
  await cfg.update('servers', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('servers', merged, vscode.ConfigurationTarget.Global);
  log.child('config').info(`migrated servers into client user settings (${merged.length} entries)`);
}

export async function removeServer(name: string): Promise<void> {
  const servers = getServers().filter((s) => s.name !== name);
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('servers', servers, vscode.ConfigurationTarget.Global);
}

export async function addServerFolders(name: string, folders: string[]): Promise<void> {
  const servers = getServers();
  const idx = servers.findIndex((s) => s.name === name);
  if (idx < 0) {
    return;
  }
  const existing = new Set(servers[idx].folders ?? []);
  for (const f of folders) {
    existing.add(f);
  }
  servers[idx] = { ...servers[idx], folders: [...existing] };
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('servers', servers, vscode.ConfigurationTarget.Global);
}

export async function updateServerForwards(name: string, forwards: PortForward[]): Promise<void> {
  const servers = getServers();
  const idx = servers.findIndex((s) => s.name === name);
  if (idx < 0) {
    return;
  }
  servers[idx] = { ...servers[idx], forwards };
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('servers', servers, vscode.ConfigurationTarget.Global);
}

export function getSessionLimit(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>('sessionLimit', 100);
}

export function getSshTimeoutMs(): number {
  const seconds = vscode.workspace.getConfiguration(SECTION).get<number>('sshTimeoutSeconds', 20);
  return Math.min(Math.max(seconds, 5), 120) * 1000;
}

export function getSshConnectionPersist(): string {
  const raw = vscode.workspace.getConfiguration(SECTION).get<string>('sshConnectionPersist', '8h').trim();
  return /^(\d+[smh]?|yes|0)$/.test(raw) ? raw : '8h';
}

export function getConnectInNewWindow(): boolean {
  return vscode.workspace
    .getConfiguration(SECTION)
    .get<boolean>('connectInNewWindow', false);
}

export interface CurrentContext {
  /** true when the window is a plain local window (no remote). */
  isLocal: boolean;
  remoteName?: string;
  /** For ssh-remote windows: the host part of the remote authority. */
  sshHost?: string;
}

/**
 * Identify what the current window is connected to.
 * For Remote-SSH windows the workspace folder authority looks like
 * `ssh-remote+<host>` (host may include user@ / :port, URL-encoded).
 */
export function getCurrentContext(): CurrentContext {
  const remoteName = vscode.env.remoteName;
  if (!remoteName) {
    return { isLocal: true };
  }
  if (remoteName !== 'ssh-remote') {
    return { isLocal: false, remoteName };
  }
  const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '';
  const plus = authority.indexOf('+');
  const sshHost = plus >= 0 ? decodeURIComponent(authority.slice(plus + 1)) : undefined;
  return { isLocal: false, remoteName, sshHost };
}

// 远程窗口下扩展宿主就在远程机上，authority 不可得时用 os.hostname() 即远程机名
export function getCurrentDisplayName(): string {
  const ctx = getCurrentContext();
  if (ctx.isLocal) {
    return os.hostname() || 'Local';
  }
  if (ctx.sshHost) {
    const match = findCurrentServer(getServers(), ctx.sshHost);
    return match?.name ?? ctx.sshHost;
  }
  return os.hostname() || ctx.remoteName || 'remote';
}

/**
 * Split the configured server list into the entry matching the current
 * window (if any) and the remaining remote entries.
 */
export function classifyServers(servers: ServerConfig[]): {
  current?: ServerConfig;
  remotes: ServerConfig[];
} {
  const ctx = getCurrentContext();
  if (ctx.isLocal || !ctx.sshHost) {
    return { remotes: servers };
  }
  const current = findCurrentServer(servers, ctx.sshHost);
  return {
    current,
    remotes: current ? servers.filter((s) => s !== current && s.name !== current.name) : servers,
  };
}
