import type { AgentSession } from '../model';
import { isUnder } from '../paths';

export interface SessionGroup {
  folderPath: string;
  sessions: AgentSession[];
}

/**
 * 将会话分配到 workspace 目录：每个会话归到包含其 cwd 的**最深** workspace 目录；
 * 不属于任何 workspace 目录的进入 others。
 */
export function partitionSessions(
  sessions: AgentSession[],
  workspacePaths: string[],
): { byFolder: Map<string, AgentSession[]>; others: AgentSession[] } {
  const byFolder = new Map<string, AgentSession[]>();
  for (const p of workspacePaths) {
    byFolder.set(p, []);
  }
  const others: AgentSession[] = [];
  for (const s of sessions) {
    let best: string | undefined;
    if (s.cwd) {
      for (const p of workspacePaths) {
        if (isUnder(s.cwd, p) && (best === undefined || p.length > best.length)) {
          best = p;
        }
      }
    }
    if (best !== undefined) {
      byFolder.get(best)!.push(s);
    } else {
      others.push(s);
    }
  }
  return { byFolder, others };
}

/** 按 cwd 分组，按组内最近更新排序。 */
export function groupByCwd(sessions: AgentSession[]): SessionGroup[] {
  const map = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const key = s.cwd || '/';
    const list = map.get(key);
    if (list) {
      list.push(s);
    } else {
      map.set(key, [s]);
    }
  }
  return [...map.entries()]
    .map(([folderPath, group]) => ({ folderPath, sessions: group }))
    .sort(
      (a, b) =>
        Math.max(...b.sessions.map((s) => s.timeUpdated)) - Math.max(...a.sessions.map((s) => s.timeUpdated)),
    );
}
