export interface ListeningService {
  name: string;
  pid?: number;
}

/** 解析 `ss -tlnpH` / `netstat -tlnp` 输出：监听端口 → 进程（无权限时只有端口没有进程名）。 */
export function parseListeners(out: string): Map<number, ListeningService> {
  const map = new Map<number, ListeningService>();
  for (const line of out.split('\n')) {
    if (!/LISTEN/i.test(line)) {
      continue;
    }
    const portMatch = /:(\d+)\s/.exec(line);
    if (!portMatch) {
      continue;
    }
    const port = Number(portMatch[1]);
    if (map.has(port)) {
      continue;
    }
    const ssProc = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    const nsProc = /LISTEN\s+(\d+)\/([\w.@+-]+)/.exec(line);
    map.set(port, {
      name: ssProc?.[1] ?? nsProc?.[2] ?? '',
      pid: ssProc?.[2] ? Number(ssProc[2]) : nsProc?.[1] ? Number(nsProc[1]) : undefined,
    });
  }
  return map;
}
