import * as vscode from 'vscode';
import { t } from '../i18n';
import { expandTilde, parentDir, splitPathInput } from './pathInput';

export interface DirPickOptions {
  title: string;
  /** 空输入时展示的候选目录（如会话扫描发现的 cwd）。 */
  sessionDirs: string[];
  /** 返回 path 下的子目录名（不含路径分隔符）；目录不存在/失败时返回 undefined。 */
  listSubdirs: (path: string) => Promise<string[] | undefined>;
  /** ~ 展开用的 home；远程传远程 home。 */
  homeDir: string;
  extraAction?: { label: string };
}

export type DirPickResult = { kind: 'dir'; path: string } | { kind: 'action' } | undefined;

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

interface Item extends vscode.QuickPickItem {
  path?: string;
  nav?: string;
  accept?: string;
  action?: boolean;
  noOp?: boolean;
}

export function pickDirectory(opts: DirPickOptions): Promise<DirPickResult> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = opts.title;
    qp.placeholder = t('Type a path to browse its subdirectories');
    let debounce: NodeJS.Timeout | undefined;
    let generation = 0;
    let done = false;
    const finish = (r: DirPickResult): void => {
      if (!done) {
        done = true;
        qp.hide();
        resolve(r);
      }
    };

    const sessionItems = (): Item[] => {
      const items: Item[] = opts.sessionDirs.map((p) => ({
        label: `$(folder) ${basename(p)}`,
        description: p,
        path: p,
      }));
      if (opts.extraAction) {
        items.push({ label: opts.extraAction.label, alwaysShow: true, action: true });
      }
      return items;
    };

    const refreshBrowse = async (): Promise<void> => {
      const gen = ++generation;
      const expanded = expandTilde(qp.value, opts.homeDir);
      const { base, segment } = splitPathInput(expanded);
      qp.busy = true;
      const subs = await opts.listSubdirs(base);
      qp.busy = false;
      if (gen !== generation) {
        return;
      }
      if (subs === undefined) {
        qp.items = [{ label: `$(error) ${t('Directory does not exist: {0}', base)}`, noOp: true }];
        return;
      }
      const items: Item[] = [];
      const exact = expanded.endsWith('/') ? base : subs.includes(segment) ? `${base}${segment}/` : undefined;
      if (exact) {
        items.push({ label: `$(check) ${t('Open {0}', exact)}`, accept: exact });
      } else if (segment === '') {
        items.push({ label: `$(check) ${t('Open {0}', base)}`, accept: base });
      }
      if (base !== '/') {
        items.push({ label: '$(folder) ..', nav: parentDir(base) });
      }
      for (const name of subs.filter((s) => s.startsWith(segment)).sort()) {
        items.push({ label: `$(folder) ${name}`, nav: `${base}${name}/` });
      }
      if (opts.extraAction) {
        items.push({ label: opts.extraAction.label, alwaysShow: true, action: true });
      }
      qp.items = items;
    };

    qp.items = sessionItems();
    qp.onDidChangeValue((v) => {
      if (debounce) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => {
        if (v.startsWith('/') || v.startsWith('~')) {
          void refreshBrowse();
        } else {
          qp.items = sessionItems();
        }
      }, 200);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (!item || item.noOp) {
        return;
      }
      if (item.nav) {
        qp.value = item.nav;
        void refreshBrowse();
        return;
      }
      if (item.action) {
        finish({ kind: 'action' });
        return;
      }
      const path = (item.accept ?? item.path)?.replace(/\/+$/, '');
      if (path) {
        finish({ kind: 'dir', path });
      }
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}
