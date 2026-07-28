import type { PortForward, ServerConfig } from './model';

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

export function parseSshAuthority(sshHost: string): { user?: string; host: string; port?: number } {
  const m = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(sshHost);
  return {
    user: m?.groups?.user,
    host: m?.groups?.host ?? sshHost,
    port: m?.groups?.port ? Number(m.groups.port) : undefined,
  };
}

function parseForwards(raw: unknown): PortForward[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: PortForward[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.localPort !== 'number' || typeof r.remotePort !== 'number') {
      continue;
    }
    out.push({
      localPort: r.localPort,
      remotePort: r.remotePort,
      remoteHost: typeof r.remoteHost === 'string' ? r.remoteHost : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

export function parseServerList(raw: unknown): ServerConfig[] {
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
        forwards: parseForwards(r.forwards),
      });
    }
  }
  return out;
}

/** 合并远程列表进本地列表：按 name 去重，本地条目优先。 */
export function mergeServersByName(local: ServerConfig[], remote: ServerConfig[]): ServerConfig[] {
  const seen = new Set(local.map((s) => s.name));
  return [...local, ...remote.filter((s) => !seen.has(s.name))];
}

export type RegistrationPlan =
  | { action: 'skip'; reason: string }
  | { action: 'none' }
  | { action: 'sync-folders'; server: ServerConfig; folders: string[] }
  | { action: 'register'; server: ServerConfig };

/**
 * 决定当前窗口连接的服务器该如何写入配置（纯函数，供单测）。
 * 已登记且 workspace 为空时不动 folders，避免误清空。
 */
export function planRegistration(input: {
  isLocal: boolean;
  sshHost?: string;
  wsPaths: string[];
  servers: ServerConfig[];
}): RegistrationPlan {
  if (input.isLocal) {
    return { action: 'skip', reason: 'local window' };
  }
  if (!input.sshHost) {
    return { action: 'skip', reason: 'no ssh authority (empty workspace?)' };
  }
  const existing = findCurrentServer(input.servers, input.sshHost);
  if (existing) {
    if (input.wsPaths.length === 0) {
      return { action: 'none' };
    }
    const cur = [...(existing.folders ?? [])].sort();
    const next = [...input.wsPaths].sort();
    const same = cur.length === next.length && cur.every((v, i) => v === next[i]);
    return same ? { action: 'none' } : { action: 'sync-folders', server: existing, folders: input.wsPaths };
  }
  const { user, host, port } = parseSshAuthority(input.sshHost);
  const taken = new Set(input.servers.map((s) => s.name));
  let name = host;
  for (let i = 2; taken.has(name); i++) {
    name = `${host}-${i}`;
  }
  return { action: 'register', server: { name, host, user, port, folders: input.wsPaths } };
}
