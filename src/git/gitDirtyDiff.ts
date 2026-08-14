import * as vscode from "vscode";
import { getGitStatusEnable, getGitStatusTimeoutMs, getServers } from "../config";
import { execRemote, shq } from "../ssh/remoteExec";
import { REMOTE_SCHEME, remoteUri } from "../ssh/remoteFsProvider";
import { parentPosix, parseUnifiedZeroHunks, type DirtyHunk } from "./parse";
import { gitHeadUri } from "./gitHeadContent";
import { remoteGitStore } from "./remoteGit";
import { pathBasename } from "../paths";
import { t } from "../i18n";
import { log } from "../log";

/**
 * 取远端文件相对 HEAD 的行级改动（编辑器 gutter 装饰的数据源）。
 * 返回 undefined 表示无需打标（untracked/added/deleted/ignored、远端失败）；
 * 仓库根未知时顺带触发解析+扫描管线（首开编辑器场景），扫描完成后 store onChange 驱动重试。
 */
export async function fetchDirtyHunks(serverKey: string, path: string): Promise<DirtyHunk[] | undefined> {
  const kind = remoteGitStore.statusForPath(serverKey, path);
  // untracked/added 整文件皆新增，deleted 无法在编辑器打开——与原生 git 一致不打 gutter
  if (kind === "untracked" || kind === "added" || kind === "deleted" || kind === "ignored") {
    return undefined;
  }
  const server = getServers().find((s) => s.name === serverKey);
  if (!server) {
    return undefined;
  }
  const root = remoteGitStore.repoRootFor(serverKey, path);
  if (!root) {
    remoteGitStore.request(serverKey, parentPosix(path) ?? path);
    return undefined;
  }
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  try {
    const res = await execRemote(
      server,
      `git -C ${shq(root)} diff HEAD --unified=0 -- ${shq(rel)}`,
      getGitStatusTimeoutMs(),
      { quiet: true },
    );
    if (res.code !== 0) {
      return undefined;
    }
    return parseUnifiedZeroHunks(res.stdout);
  } catch (err) {
    log.child("git").debug(`diff HEAD ${serverKey}:${rel} failed: ${String(err)}`);
    return undefined;
  }
}

/* ---------- hunk 共享缓存（装饰器与 CodeLens 共用，store 重扫时整体失效） ---------- */

const hunkCache = new Map<string, DirtyHunk[]>();
const hunkEmitter = new vscode.EventEmitter<void>();

/** hunk 缓存填充/失效都会触发——gutter 装饰与 CodeLens 各自据此重取。 */
export const onDidChangeDirtyHunks = hunkEmitter.event;

function hunkKey(serverKey: string, path: string): string {
  return serverKey + ":" + path;
}

export function cachedDirtyHunks(serverKey: string, path: string): DirtyHunk[] | undefined {
  return hunkCache.get(hunkKey(serverKey, path));
}

/** 缓存命中即返回（空数组 = 查过无需打标）；miss 时拉取回填并广播。 */
export async function warmDirtyHunks(serverKey: string, path: string): Promise<DirtyHunk[]> {
  const key = hunkKey(serverKey, path);
  const cached = hunkCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const hunks = (await fetchDirtyHunks(serverKey, path)) ?? [];
  hunkCache.set(key, hunks);
  hunkEmitter.fire();
  return hunks;
}

remoteGitStore.onChange(() => {
  hunkCache.clear();
  hunkEmitter.fire();
});

/** gutterIconPath 不支持 ThemeColor，用 VS Code 默认 git gutter 色的 SVG data URI。 */
function gutterBar(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="16"><rect width="4" height="16" fill="${color}"/></svg>`;
  return vscode.Uri.parse("data:image/svg+xml;utf8," + encodeURIComponent(svg));
}

function gutterTriangle(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><polygon points="4,7 12,7 8,2" fill="${color}"/></svg>`;
  return vscode.Uri.parse("data:image/svg+xml;utf8," + encodeURIComponent(svg));
}

/**
 * 其他服务器文件的编辑器 gutter 改动标记——自绘实现（TextEditorDecorationType），
 * 不注册任何 SourceControl，零接触原生 git。
 *
 * 性能要点：
 * - hunk 结果走模块级共享缓存，切标签页/重开编辑器即时命中（零 ssh）；
 * - 缓存只在 remoteGitStore.onChange（仓库重扫完成）时整体失效；
 * - 首开编辑器（仓库根未解析）踢 request() 管线，扫描完成后 onChange 自动补标记；
 * - 编辑器事件用 50ms 短去抖，hunk 变化事件用 300ms（多仓库连续扫描合并）。
 *
 * 已知限制：gutter 图标无公开点击事件 API（点击查看改动由 CodeLens 承担）；
 * 用户编辑后标记要等保存→远程轮询→重扫才刷新（不做逐键 diff，每键一次 ssh 不可接受）。
 */
export class GitDirtyDiffDecorator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly modifiedType: vscode.TextEditorDecorationType;
  private readonly addedType: vscode.TextEditorDecorationType;
  private readonly deletedType: vscode.TextEditorDecorationType;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.modifiedType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterBar("#0C7D9D"),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.addedType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterBar("#587C0C"),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.deletedType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterTriangle("#94151B"),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.disposables.push(
      this.modifiedType,
      this.addedType,
      this.deletedType,
      onDidChangeDirtyHunks(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(50)),
      vscode.commands.registerCommand("agentDock.openGitDiff", (serverKey: string, path: string) => {
        void vscode.commands.executeCommand(
          "vscode.diff",
          gitHeadUri(serverKey, path),
          remoteUri(serverKey, path),
          pathBasename(path) + " (HEAD ↔ " + t("Working Tree") + ")",
        );
      }),
    );
    this.schedule(0);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private schedule(delayMs = 300): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delayMs);
  }

  private async refresh(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === REMOTE_SCHEME) {
        await this.refreshEditor(editor);
      }
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.modifiedType, []);
    editor.setDecorations(this.addedType, []);
    editor.setDecorations(this.deletedType, []);
  }

  private async refreshEditor(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (!getGitStatusEnable()) {
      this.clear(editor);
      return;
    }
    const cached = cachedDirtyHunks(doc.uri.authority, doc.uri.path);
    if (cached !== undefined) {
      this.apply(editor, cached);
      return;
    }
    const version = doc.version;
    const hunks = await warmDirtyHunks(doc.uri.authority, doc.uri.path);
    // 等待期间文档被编辑过：行号已漂移，丢弃本轮结果，由下一轮重算
    if (doc.version !== version || doc.isClosed) {
      return;
    }
    this.apply(editor, hunks);
  }

  private apply(editor: vscode.TextEditor, hunks: DirtyHunk[]): void {
    if (hunks.length === 0) {
      this.clear(editor);
      return;
    }
    const doc = editor.document;
    const byKind: Record<DirtyHunk["kind"], vscode.DecorationOptions[]> = { modified: [], added: [], deleted: [] };
    for (const h of hunks) {
      const firstLine = Math.min(h.startLine, doc.lineCount - 1);
      const lastLine = Math.min(h.startLine + Math.max(h.lineCount, 1) - 1, doc.lineCount - 1);
      if (firstLine < 0) {
        continue;
      }
      const range = new vscode.Range(firstLine, 0, lastLine, doc.lineAt(lastLine).text.length);
      byKind[h.kind].push({ range });
    }
    editor.setDecorations(this.modifiedType, byKind.modified);
    editor.setDecorations(this.addedType, byKind.added);
    editor.setDecorations(this.deletedType, byKind.deleted);
  }
}

/**
 * 每个改动块上方的「打开更改」CodeLens——gutter 图标无公开点击事件，
 * 这是自绘方案里唯一可靠的点击查看改动入口（点击开 HEAD↔工作区 diff）。
 * 数据与 gutter 装饰共享同一份 hunk 缓存。
 */
export class GitDirtyDiffCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = onDidChangeDirtyHunks;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== REMOTE_SCHEME || !getGitStatusEnable()) {
      return [];
    }
    const hunks = cachedDirtyHunks(doc.uri.authority, doc.uri.path);
    if (hunks === undefined) {
      void warmDirtyHunks(doc.uri.authority, doc.uri.path);
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (const h of hunks) {
      const line = Math.min(h.startLine, doc.lineCount - 1);
      if (line < 0) {
        continue;
      }
      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: "$(diff) " + t("Open Changes"),
          command: "agentDock.openGitDiff",
          arguments: [doc.uri.authority, doc.uri.path],
        }),
      );
    }
    return lenses;
  }
}
