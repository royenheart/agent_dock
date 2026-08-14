import * as vscode from "vscode";
import { getGitStatusEnable, getServers } from "../config";
import { remoteGitStore } from "./remoteGit";
import { gitHeadProvider } from "./gitHeadContent";
import { remoteUri } from "../ssh/remoteFsProvider";
import { pathBasename } from "../paths";

/**
 * ⚠️ 保留但不使用（unimplemented 预留）：不在 extension.ts 实例化。
 *
 * 这是"quickDiffProvider 路线"的载体：VS Code 编辑器的原生 gutter 改动标记 / 点击弹 peek /
 * 行内 revert 只从挂在 SourceControl 上的 quickDiffProvider 取数（无独立注册 API）。
 * 理论上 quickDiff 按 rootUri（scheme 敏感）匹配，agentdock-remote 与当前服务器的
 * file/vscode-remote 互不交叉——但实测启用后当前连接服务器的原生 git 编辑器改动显示
 * 仍被破坏，原因未查明（疑似 VS Code 版本间 quickDiff/SCM 行为差异），用户决定回退。
 *
 * 现行实现是 gitDirtyDiff.ts 的自绘 gutter（零接触原生 git）。本文件待后续排查清楚
 * 或 VS Code 提供独立 quickDiff 注册 API 后再评估启用（见 README TODO）。
 */
export class RemoteScmController {
  private readonly sources = new Map<string, vscode.SourceControl>();
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = remoteGitStore.onChange(() => this.refresh());
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe();
    this.clearAll();
  }

  private clearAll(): void {
    for (const sc of this.sources.values()) {
      sc.dispose();
    }
    this.sources.clear();
  }

  private refresh(): void {
    if (!getGitStatusEnable()) {
      this.clearAll();
      return;
    }
    const seen = new Set<string>();
    for (const { serverKey, root } of remoteGitStore.knownRoots()) {
      const id = serverKey + ":" + root;
      seen.add(id);
      if (this.sources.has(id) || !remoteGitStore.statusForRepo(serverKey, root)) {
        continue; // 已创建，或尚未扫描（扫描完成后 onChange 会再次触发 refresh）
      }
      const server = getServers().find((s) => s.name === serverKey);
      const repoName = pathBasename(root);
      // SCM 视图不支持分组：用 [服务器] 前缀让多个服务器的仓库一眼可辨
      const label = server ? "[" + server.name + "] " + repoName : repoName;
      const sc = vscode.scm.createSourceControl("agentdock.git:" + id, label, remoteUri(serverKey, root));
      // 远端 commit 等操作预留（unimplemented）：隐藏提交输入框，不建任何资源分组
      sc.inputBox.visible = false;
      sc.quickDiffProvider = gitHeadProvider;
      this.sources.set(id, sc);
    }
    // 清理已消失（服务器被移除 / 目录不再被浏览）的 source control
    for (const [id, sc] of this.sources) {
      if (!seen.has(id)) {
        sc.dispose();
        this.sources.delete(id);
      }
    }
  }
}

/** 便捷构造：由 extension.ts 创建并持有生命周期。 */
export function createRemoteScmController(): RemoteScmController {
  return new RemoteScmController();
}
