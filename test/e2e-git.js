/* RemoteGitStore 端到端集成：用 PATH 注入的 fake ssh（把 execRemote 的脚本在本地执行）
 * 验证「仓库定位 → 状态扫描 → 缓存 → 目录滚标 → invalidate 重扫」全链路，
 * 不依赖真实 sshd（AGENTS.md：其他服务器目标必须是本地沙箱；fake ssh 即其一）。
 *
 * Run: node test/e2e-git.js   （需要先 npm run compile 产出 out/git/*.js）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

// --- fake ssh：把 execRemote 的脚本在本机执行（spawn 路径跑 ssh → 这里直接 bash -s） ---
const fakebin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-fakessh-'));
fs.writeFileSync(path.join(fakebin, 'ssh'), '#!/bin/sh\nexec bash -s\n', { mode: 0o755 });
process.env.PATH = fakebin + ':' + process.env.PATH;

// --- vscode stub（spawn 传输 + 本机 git，与 e2e-provider.js 同思路） ---
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-stub-'));
const stubFile = path.join(stubDir, 'vscode.js');
fs.writeFileSync(
  stubFile,
  `const noop = () => ({ dispose() {} });
const SERVERS = [{ name: 'e2e', host: 'localhost', user: 'u', port: 22, folders: [] }];
module.exports = {
  workspace: {
    getConfiguration: () => ({ get: (key, dflt) => (key === 'servers' ? SERVERS : key === 'sshTransport' ? 'spawn' : key === 'sshConnectionPersist' ? '0' : dflt), update: async () => {} }),
    onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop,
    createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} }),
    fs: {}, textDocuments: [],
  },
  env: { language: 'en', remoteName: undefined, machineId: 'e2e' },
  window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }), showErrorMessage() {}, showWarningMessage() {}, showInformationMessage() {}, setStatusBarMessage: () => ({ dispose() {} }) },
  Uri: { from: (o) => ({ scheme: o.scheme, authority: o.authority, path: o.path, fsPath: o.path, toString: () => o.scheme + '://' + o.authority + o.path }) },
  EventEmitter: class { constructor() { this.event = noop; } fire() {} },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  ThemeIcon: { Folder: 'folder', File: 'file' },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Created: 1, Changed: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  FileSystemError: class extends Error { static FileNotFound = (u) => new Error('nf ' + u); static Unavailable = (m) => new Error(m); static NoPermissions = () => new Error('noperm'); static FileExists = (u) => new Error('exists ' + u); },
  commands: { executeCommand: async () => {} },
  l10n: { t: (s) => s },
  ConfigurationTarget: { Global: 1 },
};
`,
);

const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return stubFile;
  return origResolve.call(this, request, ...args);
};

const { remoteGitStore } = require('../out/git/remoteGit');
const { execRemote } = require('../out/ssh/remoteExec');

const SERVER = 'e2e';
const server = { name: SERVER, host: 'localhost', user: 'u', port: 22, folders: [] };
const REPO = path.join(os.tmpdir(), 'agentdock-git-e2e-repo');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error("timeout waiting for " + what);
}

(async () => {
  // 1. 本地构造一个真实 git 仓库（经 execRemote → fake ssh → 本机 bash）
  await execRemote(server, `
    rm -rf ${JSON.stringify(REPO)} && mkdir -p ${JSON.stringify(REPO)}/sub
    cd ${JSON.stringify(REPO)}
    git init -q && git config user.email a@b.c && git config user.name t
    echo one > a.txt && git add a.txt && git commit -qm init
    echo two >> a.txt
    echo new > b.txt
    echo nested > sub/c.txt
  `);

  // 2. 从嵌套子目录发起 request：应向上定位到仓库根并扫描整仓
  remoteGitStore.request(SERVER, REPO + "/sub");
  await waitFor(
    () => remoteGitStore.statusForPath(SERVER, REPO + "/sub/c.txt") === "untracked",
    10000,
    "untracked sub/c.txt",
  );

  assert.equal(remoteGitStore.statusForPath(SERVER, REPO + "/a.txt"), "modified", "a.txt modified");
  assert.equal(remoteGitStore.statusForPath(SERVER, REPO + "/b.txt"), "untracked", "b.txt untracked");
  assert.equal(remoteGitStore.statusForPath(SERVER, REPO + "/sub"), "untracked", "dir sub rollup untracked");
  assert.equal(remoteGitStore.statusForPath(SERVER, REPO), "modified", "repo root rollup modified");
  assert.equal(remoteGitStore.statusForPath(SERVER, os.tmpdir()), undefined, "non-repo path has no status");

  // 3. invalidate 触发重扫：新增 d.txt 后应能追踪到
  await execRemote(server, `echo d > ${JSON.stringify(REPO)}/d.txt`);
  remoteGitStore.invalidate(SERVER, REPO + "/sub");
  await waitFor(
    () => remoteGitStore.statusForPath(SERVER, REPO + "/d.txt") === "untracked",
    10000,
    "d.txt after invalidate",
  );

  console.log("GIT STORE INTEGRATION OK");
  remoteGitStore.dispose();
  await execRemote(server, `rm -rf ${JSON.stringify(REPO)}`);
  process.exit(0);
})().catch((e) => {
  console.error("GIT STORE INTEGRATION FAILED:", e.message);
  process.exit(1);
});
