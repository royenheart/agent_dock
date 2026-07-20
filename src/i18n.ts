import * as vscode from 'vscode';

/** 代码内字符串统一入口：默认英文，l10n/bundle.l10n.<lang>.json 提供翻译。 */
export const t = vscode.l10n.t;

export function isZh(): boolean {
  return vscode.env.language.toLowerCase().startsWith('zh');
}
