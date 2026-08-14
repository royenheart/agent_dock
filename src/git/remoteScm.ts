import * as vscode from "vscode";
import type { GitStatusKind, RepoStatus } from "./types";
import { getGitStatusEnable, getServers } from "../config";
import { remoteGitStore } from "./remoteGit";
import { remoteUri } from "../ssh/remoteFsProvider";
import { pathBasename } from "../paths";
import { t } from "../i18n";

const LABEL: Record<GitStatusKind, string> = {
  conflict: t("Conflict"),
  deleted: t("Deleted"),
  modified: t("Modified"),
  added: t("Added"),
  renamed: t("Renamed"),
  copied: t("Copied"),
  untracked: t("Untracked"),
  ignored: t("Ignored"),
};

interface RemoteSource {
  sc: vscode.SourceControl;
  group: vscode.SourceControlResourceGroup;
}

/**
 * 把远端 git 仓库接入 VSCode 原生「源代码管理」视图（vscode.scm.createSourceControl）。
 * 每个已发现的远端仓库是一个独立 source control 分区，列出其变更文件；
 * 字母徽标 / 颜色复用 RemoteGitDecorationProvider（与树里的装饰一致）。
 */
export class RemoteScmController {
  private readonly sources = new Map<string, RemoteSource>();
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = remoteGitStore.onChange(() => this.refresh());
    // 首次激活后立刻同步一次（可能已有缓存）
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe();
    this.clearAll();
  }

  private clearAll(): void {
    for (const s of this.sources.values()) {
      s.sc.dispose();
    }
    this.sources.clear();
  }

  private refresh(): void {
    if (!getGitStatusEnable()) {
      this.clearAll();
      return;
    }
    const known = remoteGitStore.knownRoots();
    const seen = new Set<string>();
    for (const { serverKey, root } of known) {
      const id = serverKey + ":" + root;
      seen.add(id);
      const status = remoteGitStore.statusForRepo(serverKey, root);
      if (!status) {
        continue; // 尚未扫描：扫描完成后 onChange 会再次触发 refresh
      }
      const source = this.ensureSource(serverKey, root);
      this.populate(source, serverKey, status);
    }
    // 清理已消失（服务器被移除 / 目录不再被浏览）的 source control
    for (const [id, s] of this.sources) {
      if (!seen.has(id)) {
        s.sc.dispose();
        this.sources.delete(id);
      }
    }
  }

  private ensureSource(serverKey: string, root: string): RemoteSource {
    const id = serverKey + ":" + root;
    const existing = this.sources.get(id);
    if (existing) {
      return existing;
    }
    const server = getServers().find((s) => s.name === serverKey);
    const repoName = pathBasename(root);
    const label = server ? repoName + " (" + server.name + ")" : repoName;
    const sc = vscode.scm.createSourceControl("agentdock.git:" + id, label, remoteUri(serverKey, root));
    // v1 只读展示：隐藏提交输入框（远端 commit 尚未实现）
    sc.inputBox.visible = false;
    const group = sc.createResourceGroup("changes", t("Changes"));
    group.hideWhenEmpty = true;
    group.resourceStates = [];
    const source: RemoteSource = { sc, group };
    this.sources.set(id, source);
    return source;
  }

  private populate(source: RemoteSource, serverKey: string, status: RepoStatus): void {
    const states: vscode.SourceControlResourceState[] = [];
    const sorted = [...status.files.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) {
      if (f.kind === "ignored") {
        continue; // 忽略项不进入「源代码管理」变更列表（与原生 git 一致）
      }
      const uri = remoteUri(serverKey, f.path);
      const state: vscode.SourceControlResourceState = {
        resourceUri: uri,
        command:
          f.kind === "deleted"
            ? undefined
            : { command: "vscode.open", title: t("Open File"), arguments: [uri] },
        decorations: {
          strikeThrough: f.kind === "deleted",
          tooltip: LABEL[f.kind] + (f.originalPath ? " ← " + f.originalPath : ""),
        },
        contextValue: "agentdock.git.resource",
      };
      states.push(state);
    }
    source.group.resourceStates = states;
    source.sc.count = states.length;
  }
}

/** 便捷构造：由 extension.ts 创建并持有生命周期。 */
export function createRemoteScmController(): RemoteScmController {
  return new RemoteScmController();
}
