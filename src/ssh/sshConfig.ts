import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SshHostEntry {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
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
        }
      }
    }
  };

  await parseFile(path.join(home, '.ssh', 'config'), 0);
  return out;
}
