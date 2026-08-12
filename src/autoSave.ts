import * as vscode from 'vscode';
import { REMOTE_SCHEME } from './ssh/remoteFsProvider';
import { getAutoSaveDelayMs, getAutoSaveMode, type AutoSaveMode } from './config';
import { log } from './log';

function isRemoteDoc(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === REMOTE_SCHEME;
}

/**
 * agentdock-remote 文档的自动保存。
 *
 * 其他服务器的文件由自定义 FileSystemProvider（agentdock-remote）提供，编辑器里可
 * 修改、Ctrl+S 可保存，但离开文件焦点后不会自动落盘。这里提供与原生 files.autoSave
 * 相同的三种策略，通过 agentDock.autoSave 配置，可独立于原生设置开启：
 *
 * - afterDelay：每次编辑后延迟 agentDock.autoSaveDelay 毫秒保存（连续输入重置计时）
 * - onFocusChange：编辑器失焦时保存（切换编辑器 / 聚焦终端 / 窗口失焦）
 * - onWindowChange：VSCode 窗口失焦时保存
 *
 * 只作用于 agentdock-remote 方案的文档；本地与原生远程文件仍由 VSCode 自身的
 * files.autoSave 处理。
 */
export class AutoSaveManager implements vscode.Disposable {
  private mode: AutoSaveMode;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastActiveEditor?: vscode.TextEditor;

  constructor() {
    this.mode = getAutoSaveMode();
    this.lastActiveEditor = vscode.window.activeTextEditor;
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onTextChanged(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.clearTimer(doc.uri)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.clearTimer(doc.uri);
        if (this.lastActiveEditor?.document === doc) {
          this.lastActiveEditor = undefined;
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((e) => this.onActiveEditorChanged(e)),
      vscode.window.onDidChangeActiveTerminal(() => this.onFocusLeftEditor()),
      vscode.window.onDidChangeWindowState((state) => this.onWindowStateChanged(state)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentDock.autoSave')) {
          this.applyMode();
        }
      }),
    );
    // 激活时已处于脏状态的远程文档（如 reload 前未保存的改动）也纳入延时保存
    if (this.mode === 'afterDelay') {
      for (const doc of vscode.workspace.textDocuments) {
        if (isRemoteDoc(doc) && doc.isDirty) {
          this.schedule(doc);
        }
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  private applyMode(): void {
    this.mode = getAutoSaveMode();
    if (this.mode === 'off') {
      for (const t of this.timers.values()) {
        clearTimeout(t);
      }
      this.timers.clear();
    }
  }

  private onTextChanged(doc: vscode.TextDocument): void {
    if (!isRemoteDoc(doc) || !doc.isDirty || this.mode !== 'afterDelay') {
      return;
    }
    this.schedule(doc);
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.save(doc);
      }, getAutoSaveDelayMs()),
    );
  }

  private clearTimer(uri: vscode.Uri): void {
    const key = uri.toString();
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  private onActiveEditorChanged(next: vscode.TextEditor | undefined): void {
    if (this.mode === 'onFocusChange') {
      const prev = this.lastActiveEditor;
      if (prev && prev.document !== next?.document && isRemoteDoc(prev.document) && prev.document.isDirty) {
        void this.save(prev.document);
      }
    }
    this.lastActiveEditor = next;
  }

  /** 聚焦到终端：编辑器失焦，保存此前活跃的远程文档。 */
  private onFocusLeftEditor(): void {
    if (this.mode !== 'onFocusChange') {
      return;
    }
    const prev = this.lastActiveEditor;
    if (prev && isRemoteDoc(prev.document) && prev.document.isDirty) {
      void this.save(prev.document);
    }
  }

  /** 窗口失焦：onWindowChange 与 onFocusChange 都保存所有脏的远程文档。 */
  private onWindowStateChanged(state: vscode.WindowState): void {
    if (state.focused || (this.mode !== 'onWindowChange' && this.mode !== 'onFocusChange')) {
      return;
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (isRemoteDoc(doc) && doc.isDirty) {
        void this.save(doc);
      }
    }
  }

  private async save(doc: vscode.TextDocument): Promise<void> {
    if (!doc.isDirty) {
      return;
    }
    this.clearTimer(doc.uri);
    try {
      const ok = await doc.save();
      if (!ok && doc.isDirty) {
        log.child('autoSave').warn(`save failed for ${doc.uri.path}`);
      }
    } catch (err) {
      log.child('autoSave').warn(`save error for ${doc.uri.path}: ${String(err)}`);
    }
  }
}
