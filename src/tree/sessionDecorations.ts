import * as vscode from 'vscode';
import type { SessionStore } from './workspaceProvider';
import { CURRENT_SERVER_KEY } from './workspaceProvider';
import { isUnder, uriFsPath } from '../paths';
import { realpathCurrent } from '../ssh/currentExec';
import { t } from '../i18n';

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
    // realpath 结果只与路径相关、不会因文件变化失效，缓存长留；
    // 这里只重发装饰请求，避免每次磁盘事件都清缓存重算
    this.emitter.fire(undefined);
  }

  private realpath(p: string): Promise<string> {
    let cached = this.realpathCache.get(p);
    if (!cached) {
      cached = realpathCurrent([p]).then(([r]) => r);
      this.realpathCache.set(p, cached);
    }
    return cached;
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return undefined;
    }
    // 缓存为空时不触发完整会话扫描（打开资源管理器不应隐式发起 ssh 发现），
    // 数据到达后树刷新自然会重发装饰请求
    if (!this.store.has(CURRENT_SERVER_KEY)) {
      return undefined;
    }
    const { sessions } = await this.store.sessionsFor(CURRENT_SERVER_KEY, undefined);
    const p = await this.realpath(uriFsPath(uri));
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
      tooltip: t('{0} agent sessions under this directory (see Agent Workspace view)', count),
      color: new vscode.ThemeColor('charts.blue'),
      propagate: false,
    };
  }
}
