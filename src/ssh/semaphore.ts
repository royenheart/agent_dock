/**
 * 带取消的并发信号量：acquire(signal) 返回 true 表示拿到槽位；
 * 排队期间 signal 被 abort 则从队列移除并返回 false（不占用槽位）。
 * 独立成模块：remoteExec（spawn 路径）与 sshSession（持久连接路径）共用，
 * 避免两者互相 import 形成循环依赖。
 */
export class Semaphore {
  private running = 0;
  private readonly queue: {
    resolve: (v: boolean) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    settled?: boolean;
  }[] = [];

  constructor(private readonly max: number) {}

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.resolve(false);
    }
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const entry: { resolve: (v: boolean) => void; signal?: AbortSignal; onAbort?: () => void; settled?: boolean } = {
        resolve,
        signal,
      };
      if (signal) {
        entry.onAbort = (): void => {
          entry.settled = true;
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }
          resolve(false);
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.queue.push(entry);
      // 极端窗口：abort 在 addEventListener 与 push 之间派发时 onAbort 已 resolve，
      // 这里把残留的 entry 移出队列，避免永久占位导致槽位泄漏
      if (entry.settled) {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
        }
      }
    });
  }

  release(): void {
    this.running -= 1;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve(true);
      this.running += 1;
      return;
    }
  }
}
