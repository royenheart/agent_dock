import * as vscode from 'vscode';
import { nodeFromId, nodeId, type Node } from './workspaceProvider';
import { log } from '../log';

/**
 * TreeView 展开状态持久化。
 *
 * VSCode 不会自动保存/恢复扩展 TreeView 的展开状态（官方讨论 #1071 确认）——
 * 必须自行记录展开/折叠节点，reload 后用 treeView.reveal(node, {expand:true}) 重放。
 *
 * reveal 对懒加载树很敏感：它要求目标节点的祖先链在 VSCode 的节点缓存里已就绪
 * （getChildren 完成注册），且 handle（= `1/${TreeItem.id}`）必须与 getChildren
 * 返回的真实节点一致。因此：
 * - 按深度分层：先 reveal 浅层，成功后再 reveal 深层（深层依赖父节点已展开）
 * - 失败进入待重试队列，由外部（onDidChangeTreeData）驱动下一轮，直到成功或超时
 *   （同一 id 连续失败 MAX_RESTORE_FAILURES 轮即放弃：目标可能已被删除/改名，
 *   若无上限，pending 永不清空、每轮重试都会走一遍 getParent 链刷屏）
 */

const STORE_KEY = 'agentDock.expandedNodes.v1';

/** 同一 id 连续 reveal 失败的轮数上限，达到即放弃（不删 expanded 记录，下次 reload 重新尝试）。 */
const MAX_RESTORE_FAILURES = 5;

/** 已展开节点的 nodeId 集合。 */
export class ExpansionState {
  private memento?: vscode.Memento;
  private readonly expanded = new Set<string>();
  private pending = new Set<string>();
  private attempt = 0;
  /** 每个 id 的连续失败轮数；成功清零，达到上限放弃后清零（onTreeChanged 重排时给全新预算）。 */
  private readonly failures = new Map<string, number>();

  init(memento: vscode.Memento): void {
    this.memento = memento;
    const saved = memento.get<string[]>(STORE_KEY, []);
    for (const id of saved) {
      this.expanded.add(id);
    }
    if (this.expanded.size > 0) {
      log.child('tree').info(`restored ${this.expanded.size} expanded node(s) from previous session`);
    }
  }

  /** 当前记录的已展开节点 id 集合（只读查询；e2e 跨窗口验证恢复用）。 */
  get ids(): string[] {
    return [...this.expanded];
  }

  /** 用户在界面上展开了某节点。 */
  onExpand(node: Node): void {
    const id = nodeId(node);
    if (!this.expanded.has(id)) {
      this.expanded.add(id);
      this.persist();
    }
  }

  /** 用户折叠了某节点（含其子节点隐含折叠，但只记录本节点）。 */
  onCollapse(node: Node): void {
    const id = nodeId(node);
    if (this.expanded.delete(id)) {
      this.pending.delete(id);
      this.failures.delete(id);
      this.persist();
    }
  }

  /**
   * 恢复展开状态：按深度从浅到深 reveal，失败的进入待重试队列。
   * 每轮结束后若还有 pending，返回 true 提示调用方在下一轮再试。
   */
  async restore(treeViews: vscode.TreeView<Node>[]): Promise<boolean> {
    if (this.expanded.size === 0) {
      return false;
    }
    // 首次：全部进待处理；之后只处理上轮失败的
    if (this.attempt === 0) {
      for (const id of this.expanded) {
        this.pending.add(id);
      }
    }
    this.attempt++;
    // 全部恢复完成（或已放弃）：后续树变化触发的空调度直接返回，不再空转一轮
    if (this.pending.size === 0) {
      return false;
    }
    const tlog = log.child('tree');
    tlog.debug(`restore round ${this.attempt}: pending=${this.pending.size}`);

    // 按深度排序：浅层优先（server=0 < folder=1 < fsEntry/remoteFsEntry=2 < ...）
    const depthOf = (id: string): number => {
      const kind = id.split(':')[0];
      return kind === 'server' ? 0 : kind === 'folder' ? 1 : kind === 'sessionsRoot' || kind === 'otherSessions' || kind === 'portsRoot' ? 2 : 3;
    };
    const ordered = [...this.pending].sort((a, b) => depthOf(a) - depthOf(b));
    this.pending.clear();

    const givenUp: string[] = [];
    for (const id of ordered) {
      const node = nodeFromId(id);
      if (!node) {
        tlog.debug(`restore skip ${id}: cannot reconstruct node`);
        this.failures.delete(id);
        continue;
      }
      let ok = true;
      for (const view of treeViews) {
        try {
          await view.reveal(node, { expand: true, select: false, focus: false });
        } catch (err) {
          ok = false;
          tlog.debug(`restore reveal ${id} failed: ${String(err)}`);
        }
      }
      if (ok) {
        this.failures.delete(id);
        continue;
      }
      const rounds = (this.failures.get(id) ?? 0) + 1;
      if (rounds >= MAX_RESTORE_FAILURES) {
        givenUp.push(id);
        this.failures.delete(id);
      } else {
        this.failures.set(id, rounds);
        this.pending.add(id);
      }
    }
    if (givenUp.length > 0) {
      tlog.warn(
        `restore: giving up on ${givenUp.length} node(s) after ${MAX_RESTORE_FAILURES} failed rounds (target dir may be gone): ${givenUp.join(', ')}`,
      );
    }
    if (this.pending.size > 0) {
      tlog.debug(`restore round ${this.attempt}: ${this.pending.size} still pending (will retry on next tree change)`);
      return true;
    }
    return false;
  }

  /** 树刷新（onDidChangeTreeData）后调用：重置重试计数，返回是否需要恢复。 */
  onTreeChanged(): boolean {
    this.attempt = 0;
    return this.expanded.size > 0;
  }

  private persist(): void {
    if (!this.memento) {
      return;
    }
    this.memento.update(STORE_KEY, [...this.expanded]).then(
      () => {},
      (err: unknown) => log.child('tree').warn(`expanded-state persist failed: ${String(err)}`),
    );
  }
}
