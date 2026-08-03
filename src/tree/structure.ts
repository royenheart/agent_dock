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

export interface SessionTreeNode {
  session: AgentSession;
  children: SessionTreeNode[];
}

/**
 * 按 parentId 构建递归会话树：深度 ≥2 的嵌套会话（子会话的子会话）也完整挂接。
 * parent 不在列表中的会话视为顶层。
 */
export function buildSessionTree(sessions: AgentSession[]): SessionTreeNode[] {
  const ids = new Set(sessions.map((s) => s.id));
  const childrenOf = new Map<string, SessionTreeNode[]>();
  const top: AgentSession[] = [];
  for (const s of sessions) {
    if (s.parentId && ids.has(s.parentId)) {
      const arr = childrenOf.get(s.parentId) ?? [];
      arr.push({ session: s, children: [] });
      childrenOf.set(s.parentId, arr);
    } else {
      top.push(s);
    }
  }
  const attach = (node: SessionTreeNode): void => {
    node.children = childrenOf.get(node.session.id) ?? [];
    for (const c of node.children) {
      attach(c);
    }
  };
  return top.map((s) => {
    const node: SessionTreeNode = { session: s, children: [] };
    attach(node);
    return node;
  });
}

/** LRU 触摸：key 移到末尾（最近使用），超过 max 淘汰最旧并返回其 key。 */
export function touchLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): K | undefined {
  map.delete(key);
  map.set(key, value);
  let evicted: K | undefined;
  while (map.size > max) {
    const first = map.keys().next().value as K | undefined;
    if (first === undefined) {
      break;
    }
    map.delete(first);
    evicted = first;
  }
  return evicted;
}
