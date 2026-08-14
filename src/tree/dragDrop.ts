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
import { copyLocalToRemote, copyRemoteToLocal, copyUriRecursive, localMove, remoteMove, remoteParentPath } from './moveOps';
import { joinRemotePath } from '../ssh/remoteFsParse';
import { remoteUri } from '../ssh/remoteFsProvider';
import { pathBasename } from '../paths';
import { t } from '../i18n';
import { log } from '../log';

/** 与树视图 id 绑定的 MIME 类型（VSCode 约定 application/vnd.code.tree.<treeId>）。 */
const DND_MIME = 'application/vnd.code.tree.agentDock.workspace';

/** 无本地 uri 的拖放文件只能 data() 全量读入内存，设上限防巨型文件撑爆扩展宿主。 */
const OS_DROP_BYTES_CAP = 64 * 1024 * 1024;

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

/** 目标已存在时弹覆盖确认；不存在直接放行。 */
async function confirmUriOverwrite(dest: vscode.Uri, name: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(dest);
  } catch {
    return true;
  }
  const ok = await vscode.window.showWarningMessage(t('{0} already exists. Overwrite?', name), { modal: true }, t('Overwrite'));
  return !!ok;
}

interface DroppedItem {
  name: string;
  uri?: vscode.Uri;
  file?: vscode.DataTransferFile;
}

/** 收集 OS 拖入的条目：uri-list 优先（URI.file() 产出的规范 file://），asFile() 兜底（无 uri-list 的平台）。 */
async function collectDroppedItems(dataTransfer: vscode.DataTransfer): Promise<DroppedItem[]> {
  const items: DroppedItem[] = [];
  const seen = new Set<string>();
  const uriList = dataTransfer.get('text/uri-list');
  if (uriList) {
    const text = await uriList.asString();
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) {
        continue;
      }
      try {
        const uri = vscode.Uri.parse(s);
        // 只接受客户端本地文件（树内拖动/编辑器标签的 uri-list 可能是别的 scheme）
        if (uri.scheme !== 'file') {
          continue;
        }
        const name = pathBasename(uri.path);
        items.push({ name, uri });
        seen.add(name);
      } catch {
        // 跳过无法解析的行
      }
    }
  }
  dataTransfer.forEach((item) => {
    const f = item.asFile();
    if (!f || seen.has(f.name)) {
      return;
    }
    // asFile().uri 仅在 file scheme 时才可信——Windows 上它可能是盘符当 scheme 的畸形 URI（URI.parse('C:\\…')）
    const uri = f.uri && f.uri.scheme === 'file' ? f.uri : undefined;
    items.push({ name: f.name, uri, file: f });
  });
  return items;
}

/**
 * 从 OS 文件管理器拖入的文件/文件夹上传到目标目录。
 * 有 uri（客户端本地路径）时走流式复制；无 uri（web 等）只能 data() 全量读入，受 OS_DROP_BYTES_CAP 限制。
 */
async function handleOsFileDrop(
  targetDir: DropTarget,
  dataTransfer: vscode.DataTransfer,
  provider: WorkspaceProvider,
): Promise<void> {
  const items = await collectDroppedItems(dataTransfer);
  if (items.length === 0) {
    const mimes: string[] = [];
    dataTransfer.forEach((_item, mime) => mimes.push(mime));
    log.child('dnd').debug(`os drop: no usable items (mimes: ${mimes.join(', ') || 'none'})`);
    return;
  }
  const skipped: string[] = [];
  let localChanged = false;
  let remoteChanged = false;
  for (const it of items) {
    try {
      if (targetDir.kind === 'remote') {
        if (it.uri) {
          // 流式 SFTP 上传，目录递归与覆盖确认内置
          const r = await copyLocalToRemote(targetDir.serverKey, targetDir.path, it.uri, it.name);
          remoteChanged = remoteChanged || r === 'ok';
        } else if (it.file) {
          const bytes = await it.file.data();
          if (bytes.length > OS_DROP_BYTES_CAP) {
            skipped.push(it.name);
            continue;
          }
          const dest = remoteUri(targetDir.serverKey, joinRemotePath(targetDir.path, it.name));
          if (!(await confirmUriOverwrite(dest, it.name))) {
            continue;
          }
          await vscode.workspace.fs.writeFile(dest, bytes);
          remoteChanged = true;
        }
      } else {
        const dest = vscode.Uri.joinPath(targetDir.uri, it.name);
        if (!(await confirmUriOverwrite(dest, it.name))) {
          continue;
        }
        if (it.uri) {
          await copyUriRecursive(it.uri, dest);
        } else if (it.file) {
          const bytes = await it.file.data();
          if (bytes.length > OS_DROP_BYTES_CAP) {
            skipped.push(it.name);
            continue;
          }
          await vscode.workspace.fs.writeFile(dest, bytes);
        }
        localChanged = true;
      }
    } catch (err) {
      // 无 uri 的目录 data() 会抛错（OS 拖入文件夹必须带 uri 才能递归）
      skipped.push(`${it.name} (${String(err)})`);
    }
  }
  if (skipped.length > 0) {
    vscode.window.showWarningMessage(t('Skipped {0}', skipped.join(', ')));
  }
  if (remoteChanged && targetDir.kind === 'remote') {
    await provider.refreshRemoteDir(targetDir.serverKey, targetDir.path);
  }
  if (localChanged) {
    provider.refreshFs();
  }
}

function dropTargetDir(node: Node | undefined): DropTarget | undefined {
  if (!node) {
    return undefined;
  }
  // 落在文件节点上 = 落到其父目录（与原生资源管理器一致），否则文件节点是无日志的死区
  if (node.kind === 'remoteFsEntry') {
    return { kind: 'remote', serverKey: node.serverKey, path: node.isDir ? node.path : remoteParentPath(node.path) };
  }
  if (node.kind === 'folder' && !node.workspaceUri) {
    return { kind: 'remote', serverKey: node.serverKey, path: node.path };
  }
  if (node.kind === 'fsEntry') {
    return { kind: 'local', uri: node.isDir ? node.uri : vscode.Uri.joinPath(node.uri, '..') };
  }
  if (node.kind === 'folder' && node.workspaceUri) {
    return { kind: 'local', uri: node.workspaceUri };
  }
  return undefined;
}

export function createDragAndDropController(provider: WorkspaceProvider): vscode.TreeDragAndDropController<Node> {
  return {
    dragMimeTypes: [DND_MIME],
    dropMimeTypes: [DND_MIME, 'files', 'text/uri-list'],
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
      const raw = dataTransfer.get(DND_MIME);
      if (!raw) {
        // 外部拖入（OS 文件管理器/其他窗口）：在任何 early return 前打日志，
        // 否则无法区分「VSCode 没调 handleDrop」与「落点无效被吞」
        const mimes: string[] = [];
        dataTransfer.forEach((_item, mime) => mimes.push(mime));
        log.child('dnd').debug(`os drop on ${target?.kind ?? 'empty'} mimes=[${mimes.join(', ')}]`);
      }
      const targetDir = dropTargetDir(target);
      if (!targetDir) {
        return;
      }
      if (!raw) {
        await handleOsFileDrop(targetDir, dataTransfer, provider);
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
