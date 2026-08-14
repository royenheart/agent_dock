/**
 * Agent Workspace 树内的拖放（TreeDragAndDropController）。
 *
 * 语义与原生资源管理器一致：
 * - 远程 → 远程（同一服务器）：移动（ssh mv）；
 * - 远程 → 远程（不同服务器）：拒绝（与「粘贴」一致，不支持跨服务器移动）；
 * - 本地 → 本地：移动（rename）；
 * - 远程 ↔ 本地：复制（下载/上传，保留原件）。
 *
 * 拖动源只接受文件/目录节点（remoteFsEntry / fsEntry）；落点接受目录类节点
 * （remoteFsDir / folder.remote / fsDir / folder.workspace）。
 */
import * as vscode from 'vscode';
import type { Node, WorkspaceProvider } from './workspaceProvider';
import { copyLocalToRemote, copyRemoteToLocal, localMove, remoteMove, remoteParentPath } from './moveOps';
import { t } from '../i18n';
import { log } from '../log';

/** 与树视图 id 绑定的 MIME 类型（VSCode 约定 application/vnd.code.tree.<treeId>）。 */
const DND_MIME = 'application/vnd.code.tree.agentDock.workspace';

interface DraggedFs {
  kind: 'remoteFsEntry' | 'fsEntry';
  serverKey?: string;
  path?: string;
  uri?: string;
  name: string;
  isDir: boolean;
}

type DropTarget =
  | { kind: 'remote'; serverKey: string; path: string }
  | { kind: 'local'; uri: vscode.Uri };

function dropTargetDir(node: Node | undefined): DropTarget | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === 'remoteFsEntry' && node.isDir) {
    return { kind: 'remote', serverKey: node.serverKey, path: node.path };
  }
  if (node.kind === 'folder' && !node.workspaceUri) {
    return { kind: 'remote', serverKey: node.serverKey, path: node.path };
  }
  if (node.kind === 'fsEntry' && node.isDir) {
    return { kind: 'local', uri: node.uri };
  }
  if (node.kind === 'folder' && node.workspaceUri) {
    return { kind: 'local', uri: node.workspaceUri };
  }
  return undefined;
}

export function createDragAndDropController(provider: WorkspaceProvider): vscode.TreeDragAndDropController<Node> {
  return {
    dragMimeTypes: [DND_MIME],
    dropMimeTypes: [DND_MIME],
    handleDrag(source: readonly Node[], dataTransfer: vscode.DataTransfer): void {
      const items: DraggedFs[] = [];
      for (const n of source) {
        if (n.kind === 'remoteFsEntry') {
          items.push({ kind: 'remoteFsEntry', serverKey: n.serverKey, path: n.path, name: n.name, isDir: n.isDir });
        } else if (n.kind === 'fsEntry') {
          items.push({ kind: 'fsEntry', uri: n.uri.toString(), name: n.name, isDir: n.isDir });
        }
      }
      if (items.length > 0) {
        // DataTransferItem 的 asString() 对对象做 JSON 序列化，handleDrop 里原样解析回来
        dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ items }));
      }
    },
    async handleDrop(target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
      const targetDir = dropTargetDir(target);
      const raw = dataTransfer.get(DND_MIME);
      if (!targetDir || !raw) {
        return;
      }
      let payload: { items: DraggedFs[] };
      try {
        payload = JSON.parse(await raw.asString()) as { items: DraggedFs[] };
      } catch (err) {
        log.child('dnd').warn(`bad drop payload: ${String(err)}`);
        return;
      }
      if (!Array.isArray(payload?.items) || payload.items.length === 0) {
        return;
      }
      // 收集需刷新的远程目录（同一目录被多个条目命中时只刷一次），本地变化最后统一重绘
      const remoteDirs = new Map<string, Set<string>>();
      const addRemoteRefresh = (serverKey: string, path: string): void => {
        let set = remoteDirs.get(serverKey);
        if (!set) {
          set = new Set();
          remoteDirs.set(serverKey, set);
        }
        set.add(path);
      };
      let localChanged = false;
      let crossServerWarned = false;

      for (const item of payload.items) {
        if (item.kind === 'remoteFsEntry' && item.serverKey && item.path) {
          if (targetDir.kind === 'remote') {
            if (targetDir.serverKey !== item.serverKey) {
              if (!crossServerWarned) {
                vscode.window.showWarningMessage(t('Cannot move across servers'));
                crossServerWarned = true;
              }
              continue;
            }
            const r = await remoteMove(item.serverKey, item.path, item.name, item.isDir, targetDir.path);
            if (r === 'ok') {
              addRemoteRefresh(item.serverKey, remoteParentPath(item.path));
              addRemoteRefresh(targetDir.serverKey, targetDir.path);
            }
          } else {
            const r = await copyRemoteToLocal(item.serverKey, item.path, item.name, targetDir.uri);
            if (r === 'ok') {
              localChanged = true;
            }
          }
          continue;
        }
        if (item.kind === 'fsEntry' && item.uri) {
          const uri = vscode.Uri.parse(item.uri);
          if (targetDir.kind === 'local') {
            const r = await localMove(uri, item.name, item.isDir, targetDir.uri);
            if (r === 'ok') {
              localChanged = true;
            }
          } else {
            const r = await copyLocalToRemote(targetDir.serverKey, targetDir.path, uri, item.name);
            if (r === 'ok') {
              addRemoteRefresh(targetDir.serverKey, targetDir.path);
            }
          }
        }
      }

      for (const [serverKey, paths] of remoteDirs) {
        for (const p of paths) {
          await provider.refreshRemoteDir(serverKey, p);
        }
      }
      if (localChanged) {
        provider.refreshFs();
      }
    },
  };
}
