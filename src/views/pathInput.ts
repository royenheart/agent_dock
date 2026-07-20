export function expandTilde(value: string, homeDir: string): string {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/')) {
    return homeDir.replace(/\/$/, '') + value.slice(1);
  }
  return value;
}

export function splitPathInput(value: string): { base: string; segment: string } {
  if (value.endsWith('/')) {
    return { base: value, segment: '' };
  }
  const idx = value.lastIndexOf('/');
  return { base: value.slice(0, idx + 1) || '/', segment: value.slice(idx + 1) };
}

export function parentDir(base: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx + 1);
}

export interface BrowseItemSpec {
  label: string;
  description?: string;
  nav?: string;
  accept?: string;
  action?: boolean;
  noOp?: boolean;
  alwaysShow?: boolean;
}

// 所有项必须 alwaysShow=true：QuickPick 内置过滤会隐藏不含输入文本的子目录项（踩过的坑）
export function buildBrowseItems(opts: {
  input: string;
  homeDir: string;
  subs: string[] | undefined;
  strings: { open: (p: string) => string; notExist: (p: string) => string };
  extraActionLabel?: string;
}): BrowseItemSpec[] {
  const { input, homeDir, subs, strings, extraActionLabel } = opts;
  const expanded = expandTilde(input, homeDir);
  const { base, segment } = splitPathInput(expanded);
  if (subs === undefined) {
    return [{ label: `$(error) ${strings.notExist(base)}`, noOp: true, alwaysShow: true }];
  }
  const items: BrowseItemSpec[] = [];
  const exact = expanded.endsWith('/') ? base : subs.includes(segment) ? `${base}${segment}/` : undefined;
  if (exact) {
    items.push({ label: `$(check) ${strings.open(exact)}`, accept: exact, alwaysShow: true });
  } else if (segment === '') {
    items.push({ label: `$(check) ${strings.open(base)}`, accept: base, alwaysShow: true });
  }
  if (base !== '/') {
    items.push({ label: '$(folder) ..', description: parentDir(base), nav: parentDir(base), alwaysShow: true });
  }
  for (const name of subs.filter((s) => s.startsWith(segment)).sort()) {
    items.push({ label: `$(folder) ${name}`, description: `${base}${name}/`, nav: `${base}${name}/`, alwaysShow: true });
  }
  if (extraActionLabel) {
    items.push({ label: extraActionLabel, action: true, alwaysShow: true });
  }
  return items;
}
