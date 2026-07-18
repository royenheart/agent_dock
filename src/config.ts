import * as vscode from 'vscode';
import type { ServerConfig } from './model';

const SECTION = 'agentWorkspace';

export function getServers(): ServerConfig[] {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const raw = cfg.get<unknown>('servers', []);
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

export async function removeServer(name: string): Promise<void> {
  const servers = getServers().filter((s) => s.name !== name);
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('servers', servers, vscode.ConfigurationTarget.Global);
}

export function getSessionLimit(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>('sessionLimit', 100);
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
  const current = servers.find((s) => hostMatches(ctx.sshHost!, s));
  return {
    current,
    remotes: current ? servers.filter((s) => s !== current) : servers,
  };
}
