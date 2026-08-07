/* 最小 vscode API stub：仅覆盖 out/ 模块顶层加载所需（config/log 等）与单元测试路径。 */
const noop = () => ({ dispose() {} });

module.exports = {
  workspace: {
    getConfiguration: () => ({ get: (_k, dflt) => dflt, update: async () => {} }),
    onDidChangeConfiguration: noop,
    onDidChangeWorkspaceFolders: noop,
    createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} }),
    fs: {},
    textDocuments: [],
  },
  env: { language: 'en', remoteName: undefined, machineId: 'unit-test' },
  window: {
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showErrorMessage() {},
    showWarningMessage() {},
    showInformationMessage() {},
    setStatusBarMessage: () => ({ dispose() {} }),
    terminals: [],
    createTerminal: (opts) => {
      const t = { name: opts.name, creationOptions: opts, show() {} };
      module.exports.window.terminals.push(t);
      return t;
    },
  },
  Uri: {
    from: (o) => ({ scheme: o.scheme, authority: o.authority, path: o.path, fsPath: o.path, toString: () => o.scheme + '://' + o.authority + o.path }),
    parse: (s) => {
      // 最小实现：解析 scheme://authority/path（仅测试 nodeFromId 用）
      const m = s.match(/^([a-z-]+):\/\/([^/]*)(\/.*)$/);
      if (!m) {
        return { scheme: 'file', authority: '', path: s, fsPath: s, toString: () => s };
      }
      return { scheme: m[1], authority: m[2], path: m[3], fsPath: m[3], toString: () => s };
    },
    joinPath: (base, ...segs) => {
      // 最小实现：支持 '..' 与 name 追加（仅测试 nodeParent 推导用）
      let p = base.path ?? base.fsPath ?? '';
      for (const s of segs) {
        if (s === '..') {
          const idx = p.lastIndexOf('/');
          p = idx <= 0 ? '/' : p.slice(0, idx);
        } else {
          p = p.endsWith('/') ? p + s : p + '/' + s;
        }
      }
      return { scheme: base.scheme, authority: base.authority, path: p, fsPath: p, toString: () => base.scheme + '://' + (base.authority ?? '') + p };
    },
  },
  EventEmitter: class {
    constructor() {
      this.event = noop;
    }
    fire() {}
  },
  Disposable: class {
    constructor(fn) {
      this.dispose = fn;
    }
  },
  ThemeIcon: { Folder: 'folder', File: 'file' },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Created: 1, Changed: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  FileSystemError: class FileSystemError extends Error {
    static FileNotFound = (u) => new FileSystemError('nf ' + u);
    static Unavailable = (m) => new FileSystemError(m);
    static NoPermissions = () => new FileSystemError('noperm');
  },
  commands: { executeCommand: async () => {} },
  l10n: { t: (s) => s },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
};
