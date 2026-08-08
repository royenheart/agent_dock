/**
 * 持久 SSH 连接 + SFTP 传输层（ssh2）。
 * 每个服务器保持一条长连接：文件操作走 SFTP 子系统，shell 脚本走 exec 通道，
 * 全部复用同一条 TCP/SSH 连接——不再每次操作 spawn 一个 ssh 进程。
 * 认证：优先 ssh-agent（SSH_AUTH_SOCK），其次 ~/.ssh/config 的 IdentityFile 与默认私钥。
 * 主机密钥：默认按 ~/.ssh/known_hosts 严格校验（OpenSSH 语义），可配 accept-new。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, SFTPWrapper, type ConnectConfig } from 'ssh2';
import type { ServerConfig } from '../model';
import { resolveSshHostOptions, type ResolvedSshHost } from './sshConfig';
import { buildHostKeyVerifier, type HostKeyMode } from './knownHosts';
import { Semaphore } from './semaphore';
import { log } from '../log';

/** 单条 exec 通道 stdout 累计上限（与 spawn 路径一致，防失控远端刷爆内存）。 */
export const SESSION_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface SessionExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  cancelled?: boolean;
  truncated?: boolean;
}

export interface SessionExecBufferResult {
  stdout: Buffer;
  stderr: string;
  code: number;
  timedOut: boolean;
  cancelled?: boolean;
  truncated?: boolean;
}

export interface SessionExecOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

/** 连接/传输层失败（区别于远端命令非零退出）。触发 spawn 降级。 */
export class SshTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface SshSessionOptions {
  /** 主机密钥校验模式：yes | accept-new | no（默认 yes）。 */
  hostKeyMode?: HostKeyMode;
  knownHostsFiles?: string[];
  /** 覆盖私钥候选（测试/调试用）。 */
  identityFiles?: string[];
  /** 覆盖 agent socket（默认 SSH_AUTH_SOCK）。 */
  agentSocket?: string;
  keepaliveIntervalMs?: number;
  readyTimeoutMs?: number;
  /** 单连接并发 exec 通道上限（防 sshd MaxSessions）。 */
  channelLimit?: number;
}

/** 认证候选：agent 或单个私钥路径。 */
interface AuthCandidate {
  agent?: string;
  privateKeyPath?: string;
}

function isAuthFailure(err: unknown): boolean {
  const e = err as { level?: string; message?: string };
  return (
    e?.level === 'client-authentication' ||
    /authentication|password|key exchange failed/i.test(e?.message ?? '')
  );
}

/** 主机密钥校验失败 / 未知主机拒绝。 */
function isHostKeyFailure(err: unknown): boolean {
  const e = err as { level?: string; message?: string };
  return e?.level === 'client-timeout' || /host key|hostkey/i.test(e?.message ?? '');
}

export class SshSession {
  private client?: Client;
  private sftpInst?: SFTPWrapper;
  private connecting?: Promise<void>;
  private ready = false;
  private disposed = false;
  private readonly channels: Semaphore;
  /** 连接失败后的退避：避免对不可达服务器每轮轮询都发起一次 10s 超时连接。 */
  private backoffMs = 0;
  private nextRetryAt = 0;

  constructor(
    readonly server: ServerConfig,
    private readonly opts: SshSessionOptions = {},
  ) {
    this.channels = new Semaphore(opts.channelLimit ?? 4);
  }

  /** 供 spawn 降级判定：传输层是否处于可用状态。 */
  get isReady(): boolean {
    return this.ready && !!this.client;
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new SshTransportError(`session for ${this.server.name} is disposed`);
    }
    if (this.ready && this.client) {
      return;
    }
    if (Date.now() < this.nextRetryAt) {
      throw new SshTransportError(
        `connection to ${this.server.name} unavailable (backoff ${this.backoffMs}ms)`,
      );
    }
    if (!this.connecting) {
      this.connecting = this.connect();
    }
    try {
      await this.connecting;
    } catch (err) {
      this.nextRetryAt = Date.now() + this.backoffMs;
      throw err;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<void> {
    const home = os.homedir();
    const resolved = await resolveSshHostOptions(this.server.host, home);
    const identityFiles = this.opts.identityFiles ?? resolved.identityFiles;
    const candidates = await this.authCandidates(identityFiles);
    if (candidates.length === 0) {
      throw new SshTransportError(
        `no auth method for ${this.server.name}: set ssh-agent or an identity file in ~/.ssh/config`,
      );
    }
    let lastErr: unknown;
    for (const cand of candidates) {
      if (this.disposed) {
        throw new SshTransportError(`session for ${this.server.name} disposed during connect`);
      }
      const client = new Client();
      try {
        await this.tryConnect(client, cand, resolved);
        this.client = client;
        this.ready = true;
        this.backoffMs = 0;
        this.nextRetryAt = 0;
        // 连接断开后标记失效：下次操作自动重连
        client.on('close', () => {
          this.ready = false;
          this.sftpInst = undefined;
        });
        client.on('error', () => {
          this.ready = false;
        });
        log.child('ssh').debug(`persistent session ready: ${this.server.name} (${resolved.hostName}:${this.server.port ?? resolved.port ?? 22})`);
        return;
      } catch (err) {
        lastErr = err;
        try {
          client.end();
        } catch {
          // ignore
        }
        // 认证失败（非 key 问题）继续试下一个候选；其它错误直接抛出
        if (!isAuthFailure(err) && !isHostKeyFailure(err)) {
          break;
        }
      }
    }
    this.backoffMs = this.backoffMs === 0 ? 1_000 : Math.min(this.backoffMs * 2, 30_000);
    log.child('ssh').warn(`persistent connect failed for ${this.server.name} (backoff ${this.backoffMs}ms): ${String((lastErr as Error)?.message ?? lastErr)}`);
    if (isHostKeyFailure(lastErr)) {
      throw new SshTransportError(
        `host key verification failed for ${this.server.name} (add the host to ~/.ssh/known_hosts or set agentDock.sshHostKeyMode=accept-new)`,
        lastErr,
      );
    }
    throw new SshTransportError(`failed to connect to ${this.server.name}: ${String((lastErr as Error)?.message ?? lastErr)}`, lastErr);
  }

  private async tryConnect(client: Client, cand: AuthCandidate, resolved: ResolvedSshHost): Promise<void> {
    const cfg = await this.buildConnectConfig(cand, resolved);
    return new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        client.removeListener('ready', onReady);
        reject(err);
      };
      client.once('ready', onReady);
      client.once('error', onError);
      try {
        client.connect(cfg);
      } catch (err) {
        reject(err);
      }
    });
  }

  private async buildConnectConfig(cand: AuthCandidate, resolved: ResolvedSshHost): Promise<ConnectConfig> {
    const home = os.homedir();
    // known_hosts 匹配候选：非默认端口时 OpenSSH 记录为 `[host]:port` 形式
    // （哈希条目同样以 `[host]:port` 为输入），必须把带端口形式一并作为候选，
    // 否则 22 之外端口的服务器永远 Host denied。
    const port = this.server.port ?? resolved.port ?? 22;
    const hostnames: string[] = [];
    const addHost = (h: string | undefined): void => {
      if (!h || hostnames.includes(h)) {
        return;
      }
      hostnames.push(h);
    };
    for (const h of [this.server.host, resolved.hostName]) {
      if (!h) {
        continue;
      }
      if (port !== 22) {
        addHost(`[${h}]:${port}`);
      }
      addHost(h);
    }
    const mode = this.opts.hostKeyMode ?? 'yes';
    const knownHostsFiles = this.opts.knownHostsFiles ?? [path.join(home, '.ssh', 'known_hosts'), '/etc/ssh/ssh_known_hosts'];
    const cfg: ConnectConfig = {
      host: resolved.hostName,
      port,
      username: this.server.user ?? resolved.user ?? os.userInfo().username,
      readyTimeout: this.opts.readyTimeoutMs ?? 10_000,
      keepaliveInterval: this.opts.keepaliveIntervalMs ?? 15_000,
      hostVerifier: buildHostKeyVerifier(knownHostsFiles, hostnames, mode),
    };
    if (cand.agent) {
      cfg.agent = cand.agent;
    } else if (cand.privateKeyPath) {
      const { readFile } = await import('node:fs/promises');
      cfg.privateKey = await readFile(cand.privateKeyPath);
    }
    return cfg;
  }

  /** 认证候选：agent 优先，然后按序的私钥（仅保留存在的文件）。 */
  private async authCandidates(identityFiles: string[]): Promise<AuthCandidate[]> {
    const out: AuthCandidate[] = [];
    const agent = this.opts.agentSocket ?? process.env.SSH_AUTH_SOCK;
    if (agent) {
      out.push({ agent });
    }
    const { stat } = await import('node:fs/promises');
    for (const f of identityFiles) {
      try {
        const st = await stat(f);
        if (st.isFile()) {
          out.push({ privateKeyPath: f });
        }
      } catch {
        // 文件不存在：跳过
      }
    }
    return out;
  }

  /** 惰性打开 SFTP 子系统（连接建立后只开一次）。 */
  async sftp(): Promise<SFTPWrapper> {
    await this.ensureConnected();
    if (this.sftpInst) {
      return this.sftpInst;
    }
    this.sftpInst = await new Promise<SFTPWrapper>((resolve, reject) => {
      this.client!.sftp((err, sftp) => (err ? reject(new SshTransportError(`sftp on ${this.server.name} failed: ${err.message}`, err)) : resolve(sftp)));
    });
    return this.sftpInst;
  }

  /** 在持久连接上执行一条 bash 脚本（bash -s 通道）。 */
  async exec(script: string, timeoutMs = 60_000, opts: SessionExecOptions = {}): Promise<SessionExecResult> {
    await this.ensureConnected();
    const acquired = await this.channels.acquire(opts.signal);
    if (!acquired) {
      return { stdout: '', stderr: '', code: -1, timedOut: false, cancelled: true };
    }
    try {
      return await this.execChannel(script, timeoutMs, opts, false) as SessionExecResult;
    } finally {
      this.channels.release();
    }
  }

  /** 同 exec，但 stdout 保留二进制 Buffer。 */
  async execBuffer(script: string, timeoutMs = 60_000, opts: SessionExecOptions = {}): Promise<SessionExecBufferResult> {
    await this.ensureConnected();
    const acquired = await this.channels.acquire(opts.signal);
    if (!acquired) {
      return { stdout: Buffer.alloc(0), stderr: '', code: -1, timedOut: false, cancelled: true };
    }
    try {
      return await this.execChannel(script, timeoutMs, opts, true) as SessionExecBufferResult;
    } finally {
      this.channels.release();
    }
  }

  private execChannel(
    script: string,
    timeoutMs: number,
    opts: SessionExecOptions,
    buffer: boolean,
  ): Promise<SessionExecResult | SessionExecBufferResult> {
    return new Promise((resolve, reject) => {
      this.client!.exec('bash -s', (err, stream) => {
        if (err) {
          reject(new SshTransportError(`exec on ${this.server.name} failed: ${err.message}`, err));
          return;
        }
        const outChunks: Buffer[] = [];
        let outBytes = 0;
        let stderr = '';
        let timedOut = false;
        let truncated = false;
        let cancelled = false;
        const maxOut = opts.maxOutputBytes ?? SESSION_MAX_OUTPUT_BYTES;
        let settled = false;
        const makeResult = (code: number): SessionExecResult | SessionExecBufferResult => {
          const stdout = Buffer.concat(outChunks);
          if (buffer) {
            return { stdout, stderr, code, timedOut, cancelled, truncated };
          }
          return { stdout: stdout.toString('utf8'), stderr, code, timedOut, cancelled, truncated };
        };
        // 只允许 settle 一次：超时/截断/取消时立刻返回（不等到远端命令自然退出），
        // 随后通道真正的 close 事件被忽略，调用方不会被挂住
        const finish = (code: number): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          resolve(makeResult(code));
        };
        const kill = (): void => {
          // 先给远端命令发信号（channel 级，不切断整条持久连接），短暂宽限后再销毁通道
          try {
            stream.signal('SIGTERM');
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              stream.destroy();
            } catch {
              // ignore
            }
          }, 500).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
          finish(-1);
        }, timeoutMs);
        const onAbort = (): void => {
          cancelled = true;
          kill();
          finish(-1);
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        stream.on('data', (d: Buffer) => {
          outBytes += d.length;
          if (outBytes > maxOut) {
            truncated = true;
            kill();
            finish(-1);
            return;
          }
          outChunks.push(d);
        });
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        stream.on('error', (e: Error) => {
          if (settled) {
            return;
          }
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          reject(new SshTransportError(`exec channel on ${this.server.name} failed: ${e.message}`, e));
        });
        stream.on('close', (code: number | undefined) => {
          finish(code ?? -1);
        });
        stream.end(script);
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.sftpInst = undefined;
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // ignore
      }
      this.client = undefined;
    }
    this.ready = false;
  }
}

/** 每个服务器一个持久会话（池）。 */
const sessions = new Map<string, SshSession>();

export function sessionFor(server: ServerConfig, opts?: SshSessionOptions): SshSession {
  let s = sessions.get(server.name);
  if (!s) {
    s = new SshSession(server, opts);
    sessions.set(server.name, s);
  }
  return s;
}

export async function disposeSshSessions(): Promise<void> {
  for (const s of sessions.values()) {
    s.dispose();
  }
  sessions.clear();
}
