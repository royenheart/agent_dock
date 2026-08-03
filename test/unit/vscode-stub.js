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
  },
  Uri: {
    from: (o) => ({ scheme: o.scheme, authority: o.authority, path: o.path, fsPath: o.path, toString: () => o.scheme + '://' + o.authority + o.path }),
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
