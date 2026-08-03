/**
 * 通用合并执行器：窗口期内的多次调用合并成一次 run，按输入顺序逐条对齐返回。
 * 远程无 ControlMaster 时每次 ssh 都是新 TCP+认证连接，合并是唯一的复用手段
 * （如文件装饰器逐路径 realpath 会引发 ssh 风暴）。
 */
export function createBatcher<T>(run: (items: T[]) => Promise<T[]>, windowMs = 75, maxItems = 200): (items: T[]) => Promise<T[]> {
  interface Pending {
    items: T[];
    resolve: (r: T[]) => void;
    reject: (e: unknown) => void;
  }
  let pending: Pending[] = [];
  let pendingCount = 0;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = pending;
    pending = [];
    pendingCount = 0;
    if (batch.length === 0) {
      return;
    }
    const flat = batch.flatMap((p) => p.items);
    // run 可能同步抛错（非 async 实现）：包一层 Promise 保证所有 pending 必然 settle
    Promise.resolve()
      .then(() => run(flat))
      .then(
        (results) => {
          if (results.length !== flat.length) {
            batch.forEach((p) => p.reject(new Error(`batcher: expected ${flat.length} results, got ${results.length}`)));
            return;
          }
          let offset = 0;
          for (const p of batch) {
            p.resolve(results.slice(offset, offset + p.items.length));
            offset += p.items.length;
          }
        },
        (err) => batch.forEach((p) => p.reject(err)),
      );
  };

  return (items: T[]) => {
    if (items.length === 0) {
      return Promise.resolve([]);
    }
    return new Promise<T[]>((resolve, reject) => {
      pending.push({ items, resolve, reject });
      pendingCount += items.length;
      if (pendingCount >= maxItems) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, windowMs);
      }
    });
  };
}

/**
 * 串行任务队列：同一时刻最多一个任务在跑，其余排队；前一个任务失败不阻塞后续。
 * 用于并发读-改-写/持久化场景，保证完成顺序与发起顺序一致，避免交错覆盖。
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
