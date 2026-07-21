import * as vscode from 'vscode';
import type { ServerConfig } from '../model';
import { execRemote, type ExecResult } from './remoteExec';

export interface SmartExecOptions {
  timeoutMs: number;
  title: string;
  /** 超过该毫秒数仍在执行才弹通知（可 Cancel 跳过）。 */
  showAfterMs?: number;
}

/**
 * 先静默执行；超过 showAfterMs 未完成则在右下角弹进度通知，
 * 用户点 Cancel 即 abort 对应 ssh 进程（结果 cancelled=true）。
 */
export async function execRemoteSmart(
  server: ServerConfig,
  script: string,
  opts: SmartExecOptions,
): Promise<ExecResult> {
  const controller = new AbortController();
  const task = execRemote(server, script, opts.timeoutMs, { signal: controller.signal });
  const showAfter = opts.showAfterMs ?? 3_000;
  const finished = await Promise.race([
    task.then(() => true as const),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), showAfter)),
  ]);
  if (finished) {
    return task;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: opts.title, cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => controller.abort());
      return task;
    },
  );
}
