import * as vscode from "vscode";
import type { GitStatusKind } from "./types";
import { getGitStatusEnable } from "../config";
import { remoteGitStore } from "./remoteGit";
import { REMOTE_SCHEME } from "../ssh/remoteFsProvider";
import { t } from "../i18n";

const BADGE: Record<GitStatusKind, string> = {
  conflict: "C",
  deleted: "D",
  modified: "M",
  added: "A",
  renamed: "R",
  copied: "C",
  untracked: "U",
  ignored: "!",
};

const TOOLTIP: Record<GitStatusKind, string> = {
  conflict: t("Conflict"),
  deleted: t("Deleted"),
  modified: t("Modified"),
  added: t("Added"),
  renamed: t("Renamed"),
  copied: t("Copied"),
  untracked: t("Untracked"),
  ignored: t("Ignored"),
};

// 复用原生 git 装饰的主题色，保证与用户主题下的原生 git 状态颜色一致
const COLOR: Record<GitStatusKind, string> = {
  conflict: "gitDecoration.conflictingResourceForeground",
  deleted: "gitDecoration.deletedResourceForeground",
  modified: "gitDecoration.modifiedResourceForeground",
  added: "gitDecoration.addedResourceForeground",
  renamed: "gitDecoration.renamedResourceForeground",
  copied: "gitDecoration.renamedResourceForeground",
  untracked: "gitDecoration.untrackedResourceForeground",
  ignored: "gitDecoration.ignoredResourceForeground",
};

export function decorationFor(kind: GitStatusKind): vscode.FileDecoration {
  const dec = new vscode.FileDecoration(BADGE[kind], TOOLTIP[kind], new vscode.ThemeColor(COLOR[kind]));
  // 目录聚合已由 buildRepoStatus 显式向上滚标，无需再向上传播（避免污染仓库外的父节点）
  dec.propagate = false;
  return dec;
}

/**
 * 为 agentdock-remote 资源提供 git 状态装饰（与原生 git 插件一致的字母徽标 + 主题色）。
 * 状态读取走 RemoteGitStore 缓存；扫描完成时 store 触发 onChange → 这里重发装饰事件。
 */
export class RemoteGitDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = remoteGitStore.onChange(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.unsubscribe();
    this.emitter.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== REMOTE_SCHEME) {
      return undefined;
    }
    if (!getGitStatusEnable()) {
      return undefined;
    }
    const kind = remoteGitStore.statusForPath(uri.authority, uri.path);
    return kind === undefined ? undefined : decorationFor(kind);
  }
}
