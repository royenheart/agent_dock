import * as vscode from 'vscode';
import { nodeFromId, nodeId, nodeParent, type Node } from './workspaceProvider';
import { createSerialQueue } from '../batch';
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
  /** 持久化写入串行化：memento.update 完成顺序与调用顺序一致，reload 前最后一次折叠不会被子节点/祖先的旧写入覆盖。 */
  private readonly persistQueue = createSerialQueue();
  private lastPersist: Promise<void> = Promise.resolve();
  /** deactivate 后忽略 VSCode 在树销毁阶段补发的 expand/collapse 事件，避免它们把已保存的状态改坏。 */
  private shuttingDown = false;

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
    if (this.shuttingDown) {
      return;
    }
    const id = nodeId(node);
    if (!this.expanded.has(id)) {
      this.expanded.add(id);
      this.persist();
    }
  }

  /**
   * 用户在界面上折叠了某节点。
   * 除本节点外，已记录的后代展开态也一并删除：折叠父节点后子树不可见，
   * reload 时若仍按后代 id 去 reveal，VSCode 会隐式把父节点重新展开。
   */
  onCollapse(node: Node): void {
    if (this.shuttingDown) {
      return;
    }
    const id = nodeId(node);
    const removed: string[] = [];
    if (this.expanded.delete(id)) {
      removed.push(id);
    }
    for (const other of this.expanded) {
      if (this.isDescendantOf(other, id)) {
        this.expanded.delete(other);
        removed.push(other);
      }
    }
    if (removed.length === 0) {
      return;
    }
    for (const removedId of removed) {
      this.pending.delete(removedId);
      this.failures.delete(removedId);
    }
    this.persist();
  }

  /** id 是否是 ancestorId 的后代（沿 nodeParent 链上溯）。 */
  private isDescendantOf(id: string, ancestorId: string): boolean {
    let cur = nodeFromId(id);
    for (let depth = 0; cur && depth < 64; depth++) {
      const parent = nodeParent(cur);
      if (!parent) {
        return false;
      }
      if (nodeId(parent) === ancestorId) {
        return true;
      }
      cur = parent;
    }
    return false;
  }

  /** 该 id 的所有祖先是否都处于展开状态（server 根节点默认展开，直接放行）。 */
  private isRevealable(id: string): boolean {
    let cur = nodeFromId(id);
    for (let depth = 0; cur && depth < 64; depth++) {
      const parent = nodeParent(cur);
      if (!parent) {
        return true;
      }
      if (parent.kind === 'server') {
        return true;
      }
      if (!this.expanded.has(nodeId(parent))) {
        return false;
      }
      cur = parent;
    }
    return false;
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  /** 等待已入队的持久化写入完成（deactivate 时调用，避免 reload 读取旧快照）。 */
  async flush(): Promise<void> {
    await this.lastPersist;
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

    // 按真实祖先链深度排序：先 reveal 父节点（server < folder < 子目录 < 孙节点…），
    // 同一种类下的父子顺序也稳定，避免 reveal 子节点时父链尚未在 VSCode 缓存里就绪。
    const depthOf = (id: string): number => {
      let depth = 0;
      let cur = nodeFromId(id);
      for (let guard = 0; cur && guard < 64; guard++) {
        const parent = nodeParent(cur);
        if (!parent) {
          break;
        }
        depth++;
        cur = parent;
      }
      return depth;
    };
    const ordered = [...this.pending].sort((a, b) => depthOf(a) - depthOf(b));
    this.pending.clear();
    // 只 reveal 祖先链完整展开的节点：若某个父节点已被用户折叠，恢复其后代会把父节点
    // 隐式重新展开（并触发 onDidExpandElement 把父节点写回持久化状态），这正是
    // “折叠 A 再 reload，A 又打开了”的来源之一。
    const revealable = ordered.filter((id) => this.isRevealable(id));
    if (revealable.length === 0) {
      return false;
    }

    const givenUp: string[] = [];
    for (const id of revealable) {
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

  /** 树刷新（onDidChangeTreeData）/用户重新展开父节点后调用：重置重试预算，返回是否需要恢复。 */
  onTreeChanged(): boolean {
    this.attempt = 0;
    this.failures.clear();
    return this.expanded.size > 0;
  }

  private persist(): void {
    if (!this.memento) {
      return;
    }
    const snapshot = [...this.expanded];
    const memento = this.memento;
    this.lastPersist = this.persistQueue(async () => {
      await memento.update(STORE_KEY, snapshot);
    }).catch((err: unknown) => {
      log.child('tree').warn(`expanded-state persist failed: ${String(err)}`);
    });
  }
}
