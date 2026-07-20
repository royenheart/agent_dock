import * as vscode from 'vscode';
import { t } from '../i18n';
import { buildBrowseItems, expandTilde, splitPathInput } from './pathInput';

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
      const { base } = splitPathInput(expanded);
      qp.busy = true;
      const subs = await opts.listSubdirs(base);
      qp.busy = false;
      if (gen !== generation) {
        return;
      }
      qp.items = buildBrowseItems({
        input: qp.value,
        homeDir: opts.homeDir,
        subs,
        strings: {
          open: (p) => t('Open {0}', p),
          notExist: (p) => t('Directory does not exist: {0}', p),
        },
        extraActionLabel: opts.extraAction?.label,
      });
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
