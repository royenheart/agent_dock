import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ServerConfig } from './model';
import { log } from './log';

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
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ServerConfig[] = [];
  for (const item of raw) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      typeof (item as Record<string, unknown>).host === 'string'
    ) {
      const r = item as Record<string, unknown>;
      out.push({
        name: r.name as string,
        host: r.host as string,
        user: typeof r.user === 'string' ? r.user : undefined,
        port: typeof r.port === 'number' ? r.port : undefined,
        folders: Array.isArray(r.folders) ? (r.folders as unknown[]).filter((f): f is string => typeof f === 'string') : undefined,
      });
    }
  }
  return out;
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
  const ctx = getCurrentContext();
  if (ctx.isLocal || !ctx.sshHost) {
    return;
  }
  const wsPaths = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'vscode-remote')
    .map((f) => f.uri.path);
  const servers = getServers();
  const existing = findCurrentServer(servers, ctx.sshHost);
  if (existing) {
    // workspace 为空时不动已 pin 的目录，避免误清空
    const same =
      wsPaths.length > 0 &&
      (existing.folders ?? []).length === wsPaths.length &&
      [...(existing.folders ?? [])].sort().every((v, i) => v === [...wsPaths].sort()[i]);
    if (wsPaths.length > 0 && !same) {
      await upsertServer({ ...existing, folders: wsPaths });
      log.info(`[config] synced ${existing.name} folders from workspace (${wsPaths.length})`);
    }
    return;
  }
  const m = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(ctx.sshHost);
  let name = m?.groups?.host ?? bareHost(ctx.sshHost);
  const names = new Set(servers.map((s) => s.name));
  for (let i = 2; names.has(name); i++) {
    name = `${m?.groups?.host ?? bareHost(ctx.sshHost)}-${i}`;
  }
  await upsertServer({
    name,
    host: m?.groups?.host ?? ctx.sshHost,
    user: m?.groups?.user,
    port: m?.groups?.port ? Number(m.groups.port) : undefined,
    folders: wsPaths,
  });
  log.info(`[config] registered current server as ${name}`);
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

/** Loose match: authority host may carry user@ / :port decorations. */
export function hostMatches(authorityHost: string, server: ServerConfig): boolean {
  if (authorityHost === server.host) {
    return true;
  }
  if (server.user && authorityHost === `${server.user}@${server.host}`) {
    return true;
  }
  // strip trailing :port from authority candidate
  const noPort = authorityHost.replace(/:\d+$/, '');
  if (noPort === server.host) {
    return true;
  }
  if (server.user && noPort === `${server.user}@${server.host}`) {
    return true;
  }
  return false;
}

function bareHost(sshHost: string): string {
  return sshHost.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
}

/**
 * 在配置里找当前窗口对应的服务器。除 host 外兜底比较 name：经 ssh config
 * 别名连接时 authority 是别名而非配置的 host，只靠 hostMatches 会漏配。
 */
export function findCurrentServer(servers: ServerConfig[], sshHost: string): ServerConfig | undefined {
  const bare = bareHost(sshHost);
  return servers.find((s) => hostMatches(sshHost, s) || s.name === sshHost || s.name === bare);
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
