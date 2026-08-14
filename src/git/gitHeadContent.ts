import * as vscode from "vscode";
import { getGitStatusEnable, getGitStatusTimeoutMs, getServers } from "../config";
import { execRemote, shq } from "../ssh/remoteExec";
import { REMOTE_SCHEME } from "../ssh/remoteFsProvider";
import { parentPosix } from "./parse";
import { remoteGitStore } from "./remoteGit";
import { log } from "../log";

/** 远端文件 HEAD 版本的只读 scheme：authority = serverKey，path = 文件绝对路径。 */
export const GIT_HEAD_SCHEME = "agentdock-git-head";

export function gitHeadUri(serverKey: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_HEAD_SCHEME, authority: serverKey, path });
}

/**
 * 为 agentdock-remote 文件提供 HEAD 原始内容：
 * - 作为 QuickDiffProvider：编辑器 gutter 显示增删行（与原生 git 一致）；
 * - 作为 TextDocumentContentProvider：diff 视图的左侧（HEAD）内容。
 * 内容来自 `git -C <root> show HEAD:<rel>`；带缓存，仓库状态重扫后失效（外部可能已 commit）。
 */
export class GitHeadProvider implements vscode.TextDocumentContentProvider, vscode.QuickDiffProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly cache = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = remoteGitStore.onChange(() => {
      if (this.cache.size === 0) {
        return;
      }
      const uris = [...this.cache.keys()].map((k) => vscode.Uri.parse(k));
      this.cache.clear();
      for (const uri of uris) {
        this.emitter.fire(uri);
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.emitter.dispose();
  }

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== REMOTE_SCHEME || !getGitStatusEnable()) {
      return undefined;
    }
    const kind = remoteGitStore.statusForPath(uri.authority, uri.path);
    // untracked/added/ignored 没有 HEAD 版本，给原文会让整个文件误标为新增（与原生 git 一致不给）
    if (kind === "untracked" || kind === "added" || kind === "ignored") {
      return undefined;
    }
    if (kind === undefined) {
      const root = remoteGitStore.repoRootFor(uri.authority, uri.path);
      if (!root) {
        // 仓库根还没解析（首开编辑器、目录未在树里展开）：触发解析+扫描，
        // 扫描完成后 RemoteScmController 注册 provider，VS Code 会重新查询本方法
        remoteGitStore.request(uri.authority, parentPosix(uri.path) ?? uri.path);
        return undefined;
      }
      if (!remoteGitStore.statusForRepo(uri.authority, root)) {
        return undefined; // 根已知但状态未扫完（statusForPath 已顺带触发扫描），等 onChange
      }
      // 已扫描且不在变更集 → 干净的已跟踪文件：也给 HEAD 原文，
      // 之后用户编辑时 VS Code 用本地 diff 即时打出 gutter（不额外走 ssh）
    }
    return gitHeadUri(uri.authority, uri.path);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cacheKey = uri.toString();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const server = getServers().find((s) => s.name === uri.authority);
    const root = server ? remoteGitStore.repoRootFor(uri.authority, uri.path) : undefined;
    if (!server || !root) {
      return "";
    }
    // rename/copy 的 HEAD 内容在原路径下
    const original = remoteGitStore.statusForRepo(uri.authority, root)?.files.get(uri.path)?.originalPath;
    const headPath = original ?? uri.path;
    const rel = headPath.startsWith(root + "/") ? headPath.slice(root.length + 1) : headPath;
    try {
      const res = await execRemote(server, `git -C ${shq(root)} show ${shq("HEAD:" + rel)}`, getGitStatusTimeoutMs(), {
        quiet: true,
      });
      const content = res.code === 0 ? res.stdout : "";
      this.cache.set(cacheKey, content);
      return content;
    } catch (err) {
      log.child("git").debug(`show HEAD:${rel} on ${uri.authority} failed: ${String(err)}`);
      return "";
    }
  }
}

/** 单例：quick diff 与 diff 视图共用同一份 HEAD 内容缓存。 */
export const gitHeadProvider = new GitHeadProvider();
