import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SshHostEntry {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  /** IdentityFile 指令（保持出现顺序，已展开 ~）。 */
  identityFiles?: string[];
}

const MAX_INCLUDE_DEPTH = 3;

async function expandInclude(pattern: string, baseDir: string): Promise<string[]> {
  let p = pattern.replace(/^~(?=\/|$)/, os.homedir());
  if (!path.isAbsolute(p)) {
    p = path.join(baseDir, p);
  }
  if (!/[*?]/.test(p)) {
    try {
      const st = await fs.stat(p);
      return st.isFile() ? [p] : [];
    } catch {
      return [];
    }
  }
  const dir = path.dirname(p);
  const escaped = path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 解析 ~/.ssh/config（含 Include 指令）中的主机别名。
 * 跳过通配符 Host（* ? !）与 Match 块；同一字段首现值优先（与 OpenSSH 一致）。
 * homeDir 可注入以便测试；默认取扩展宿主机（=当前连接机器）的 home。
 */
export async function readSshConfigHosts(homeDir?: string): Promise<SshHostEntry[]> {
  const home = homeDir ?? os.homedir();
  const out: SshHostEntry[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();

  const parseFile = async (file: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH || visited.has(file)) {
      return;
    }
    visited.add(file);
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    let current: SshHostEntry[] = [];
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) {
        continue;
      }
      const sp = line.search(/[\s=]/);
      const keyword = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
      const value = sp < 0 ? '' : line.slice(sp + 1).replace(/^[\s=]+/, '').trim();
      if (keyword === 'host') {
        current = [];
        for (const alias of value.split(/\s+/)) {
          if (!alias || /[*?!]/.test(alias) || seen.has(alias)) {
            continue;
          }
          seen.add(alias);
          const entry: SshHostEntry = { host: alias };
          out.push(entry);
          current.push(entry);
        }
        continue;
      }
      if (keyword === 'match') {
        current = [];
        continue;
      }
      if (keyword === 'include') {
        for (const inc of value.split(/\s+/)) {
          if (!inc) {
            continue;
          }
          for (const f of await expandInclude(inc, path.dirname(file))) {
            await parseFile(f, depth + 1);
          }
        }
        continue;
      }
      for (const entry of current) {
        if (keyword === 'hostname' && !entry.hostName) {
          entry.hostName = value;
        } else if (keyword === 'user' && !entry.user) {
          entry.user = value;
        } else if (keyword === 'port' && !entry.port) {
          const n = Number(value);
          if (Number.isInteger(n) && n > 0) {
            entry.port = n;
          }
        } else if (keyword === 'identityfile') {
          // 多条 IdentityFile 按序尝试（与 OpenSSH 一致）；~ 展开为 home
          const expanded = value.replace(/^~(?=\/|$)/, home);
          if (!entry.identityFiles) {
            entry.identityFiles = [];
          }
          if (!entry.identityFiles.includes(expanded)) {
            entry.identityFiles.push(expanded);
          }
        }
      }
    }
  };

  await parseFile(path.join(home, '.ssh', 'config'), 0);
  return out;
}

export interface ResolvedSshHost {
  /** 连接的别名（用户在 servers 配置里填的 host）。 */
  alias: string;
  /** 解析后的实际主机名（HostName 或别名本身）。 */
  hostName: string;
  user?: string;
  port?: number;
  /** 按序排列的 IdentityFile（含默认私钥兜底）。 */
  identityFiles: string[];
  /** 是否命中 ~/.ssh/config 的 Host 别名（命中时以配置文件为权威，忽略 servers 里旧缓存的 user/port）。 */
  configured: boolean;
}

/**
 * 解析某个别名（servers 配置里的 host）的完整连接选项：
 * ~/.ssh/config 的 HostName/User/Port/IdentityFile（含 Include），
 * 别名无配置时回落默认值。identityFiles 追加 ~/.ssh/id_* 默认私钥兜底。
 */
export async function resolveSshHostOptions(alias: string, homeDir?: string): Promise<ResolvedSshHost> {
  const home = homeDir ?? os.homedir();
  const entries = await readSshConfigHosts(home);
  // ssh 主机名大小写不敏感（DNS 层面），按小写匹配
  const match = entries.find((e) => e.host.toLowerCase() === alias.toLowerCase());
  const identityFiles = [...(match?.identityFiles ?? [])];
  const defaults = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa']
    .map((f) => path.join(home, '.ssh', f))
    .filter((f) => !identityFiles.includes(f));
  identityFiles.push(...defaults);
  return {
    alias,
    hostName: match?.hostName || alias,
    user: match?.user,
    port: match?.port,
    identityFiles,
    configured: !!match,
  };
}

/**
 * 解析 servers 配置项的实际连接参数。
 *
 * 背景：早期版本把从 ~/.ssh/config 解析出的 user/port 一并写进 agentDock.servers，
 * 用户随后修改 ssh config（如换端口）时，settings 里的旧值会把新配置覆盖掉。
 * 因此这里约定：host 命中 ssh config 的 Host 别名时，以“当前” ssh config 为准，
 * 忽略 servers 里缓存的 user/port；只有 host 不是别名（直接填 IP/主机名）时，
 * servers 里的 user/port 才作为命令行/ssh2 的显式参数生效。
 */
export async function resolveServerConnection(
  server: { host: string; user?: string; port?: number },
  homeDir?: string,
): Promise<ResolvedSshHost> {
  const resolved = await resolveSshHostOptions(server.host, homeDir);
  if (resolved.configured) {
    return resolved;
  }
  return {
    ...resolved,
    user: server.user ?? resolved.user,
    port: server.port ?? resolved.port,
  };
}
