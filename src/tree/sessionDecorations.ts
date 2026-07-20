import * as vscode from 'vscode';
import type { SessionStore } from './workspaceProvider';
import { CURRENT_SERVER_KEY } from './workspaceProvider';
import { isUnder, realpathSafe } from '../paths';

/**
 * 在内置资源管理器（及本扩展的文件节点）上，为包含 agent 会话的目录加 AI 徽标。
 * 只统计当前服务器（扩展宿主机）的会话。
 */
export class SessionDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidProvideFileDecoration = this.emitter.event;
  private readonly realpathCache = new Map<string, Promise<string>>();

  constructor(private readonly store: SessionStore) {}

  refresh(): void {
    this.realpathCache.clear();
    this.emitter.fire(undefined);
  }

  private realpath(p: string): Promise<string> {
    let cached = this.realpathCache.get(p);
    if (!cached) {
      cached = realpathSafe(p);
      this.realpathCache.set(p, cached);
    }
    return cached;
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return undefined;
    }
    const { sessions } = await this.store.sessionsFor(CURRENT_SERVER_KEY, undefined);
    const p = await this.realpath(uri.fsPath);
    let count = 0;
    for (const s of sessions) {
      if (s.cwd && isUnder(s.cwd, p)) {
        count += 1;
      }
    }
    if (count === 0) {
      return undefined;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return {
      badge: 'AI',
      tooltip: `该目录下有 ${count} 个 agent 会话（见 Agent Workspace 视图）`,
      color: new vscode.ThemeColor('charts.blue'),
      propagate: false,
    };
  }
}
