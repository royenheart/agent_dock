/**
 * ~/.ssh/known_hosts 的解析与主机密钥校验（纯函数，不依赖 vscode/ssh2）。
 * 支持：普通条目、|1|salt|hash 哈希条目、逗号分隔模式、'*'/'?' 通配、'!' 否定。
 * 校验算法与 OpenSSH 一致：哈希条目 = HMAC-SHA1(key=salt, msg=hostname)。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export interface KnownHostEntry {
  /** 原始 hosts 字段（可能含逗号、通配、否定前缀、或 |1| 哈希）。 */
  hosts: string;
  keyType: string;
  keyBase64: string;
  hashed: boolean;
  salt?: Buffer;
  hash?: Buffer;
}

export function parseKnownHosts(content: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // @cert-authority / @revoked / @marker 开头：本扩展不校验证书，跳过
    if (line.startsWith('@')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const hosts = parts[0];
    const keyType = parts[1];
    const keyBase64 = parts[2];
    if (hosts.startsWith('|1|')) {
      const seg = hosts.split('|');
      if (seg.length >= 4) {
        try {
          out.push({
            hosts,
            keyType,
            keyBase64,
            hashed: true,
            salt: Buffer.from(seg[2], 'base64'),
            hash: Buffer.from(seg[3], 'base64'),
          });
        } catch {
          // 非法 base64：跳过该条
        }
      }
    } else {
      out.push({ hosts, keyType, keyBase64, hashed: false });
    }
  }
  return out;
}

/** hosts 模式（支持 * ?）转正则。 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** 单条 hosts 字段（逗号分隔）是否匹配目标主机名（含 '!' 否定识别）。 */
function hostsFieldMatches(hosts: string, hostname: string): { matched: boolean; negated: boolean } {
  for (const raw of hosts.split(',')) {
    const p = raw.trim();
    if (!p) {
      continue;
    }
    const negated = p.startsWith('!');
    const pattern = negated ? p.slice(1) : p;
    if (patternToRegExp(pattern).test(hostname)) {
      return { matched: true, negated };
    }
  }
  return { matched: false, negated: false };
}

function hashedHostMatches(salt: Buffer, hash: Buffer, hostname: string): boolean {
  const h = crypto.createHmac('sha1', salt).update(hostname, 'utf8').digest();
  return h.equals(hash);
}

/**
 * 校验一组已知条目里是否存在能证明 hostname 的 key 的条目。
 * 语义对齐 OpenSSH：先扫否定（任意 '!' 模式命中 → 直接拒绝，与条目顺序无关），
 * 再扫肯定（普通条目 key 相等，或哈希条目 host 哈希命中且 key 相等）。
 */
export function checkHostKey(entries: KnownHostEntry[], hostnames: string[], key: Buffer): boolean {
  for (const e of entries) {
    if (e.hashed) {
      continue;
    }
    for (const host of hostnames) {
      const { matched, negated } = hostsFieldMatches(e.hosts, host);
      if (matched && negated) {
        return false;
      }
    }
  }
  for (const e of entries) {
    for (const host of hostnames) {
      if (e.hashed) {
        if (e.salt && e.hash && hashedHostMatches(e.salt, e.hash, host) && Buffer.from(e.keyBase64, 'base64').equals(key)) {
          return true;
        }
        continue;
      }
      const { matched, negated } = hostsFieldMatches(e.hosts, host);
      if (matched && !negated && Buffer.from(e.keyBase64, 'base64').equals(key)) {
        return true;
      }
    }
  }
  return false;
}

export type HostKeyMode = 'yes' | 'accept-new' | 'no';

/**
 * 构造 ssh2 connect 用的 hostVerifier。'yes'：known_hosts 必须已包含该主机；
 * 'accept-new'：未知主机自动追加到 ~/.ssh/known_hosts 后接受（等价 OpenSSH
 * StrictHostKeyChecking=accept-new）；'no'：跳过校验（不推荐）。
 */
export function buildHostKeyVerifier(
  knownHostsFiles: string[],
  hostnames: string[],
  mode: HostKeyMode,
  options?: { writeFile?: (path: string, data: string) => void },
): (key: Buffer) => boolean {
  if (mode === 'no') {
    return () => true;
  }
  const fsWrite = options?.writeFile;
  const readAll = (): KnownHostEntry[] => {
    const out: KnownHostEntry[] = [];
    for (const f of knownHostsFiles) {
      try {
        out.push(...parseKnownHosts(fs.readFileSync(f, 'utf8')));
      } catch {
        // 文件不存在/不可读：跳过
      }
    }
    return out;
  };
  return (key: Buffer): boolean => {
    const entries = readAll();
    if (checkHostKey(entries, hostnames, key)) {
      return true;
    }
    if (mode === 'accept-new') {
      // 追加一条普通条目（主机名取第一个候选；含通配/哈希的主机名按原样记录，
      // OpenSSH 本身也会对非纯主机名做哈希，这里简化为普通条目）
      const hostname = hostnames[0] ?? '';
      const line = `${hostname} ${'ssh-rsa'} ${key.toString('base64')}\n`;
      try {
        if (fsWrite) {
          fsWrite(knownHostsFiles[0], line);
        } else {
          fs.appendFileSync(knownHostsFiles[0], line);
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
}
