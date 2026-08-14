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
  Uri: {
    from: (o) => ({ scheme: o.scheme, authority: o.authority, path: o.path, fsPath: o.path, toString: () => o.scheme + '://' + o.authority + o.path }),
    parse: (s) => { const i = s.indexOf('://'); const j = s.indexOf('/', i + 3); return { scheme: s.slice(0, i), authority: s.slice(i + 3, j), path: s.slice(j), fsPath: s.slice(j), toString: () => s }; },
  },
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
const REPO2 = path.join(os.tmpdir(), 'agentdock-git-e2e-repo2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
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
    echo one > a.txt && printf 'l1\nl2\nl3\n' > e.txt && echo x > f.txt && echo g > g.txt
    git add a.txt e.txt f.txt g.txt && git commit -qm init
    echo two >> a.txt
    printf 'l1\nl3\n' > e.txt
    printf 'X\n' > f.txt
    echo new > b.txt
    echo nested > sub/c.txt
  `);
  // 第二个仓库：全程不经树 request，专门验证「首开编辑器踢解析管线」
  await execRemote(server, `
    rm -rf ${JSON.stringify(REPO2)} && mkdir -p ${JSON.stringify(REPO2)}
    cd ${JSON.stringify(REPO2)}
    git init -q && git config user.email a@b.c && git config user.name t
    echo k > k.txt && git add k.txt && git commit -qm init
    echo k2 >> k.txt
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

  // 4. HEAD 内容供给（编辑器 gutter diff / SCM diff 视图依赖）：modified 有原始资源，untracked 没有
  const { gitHeadProvider, GIT_HEAD_SCHEME } = require('../out/git/gitHeadContent');
  const remoteA = { scheme: 'agentdock-remote', authority: SERVER, path: REPO + '/a.txt' };
  const orig = gitHeadProvider.provideOriginalResource(remoteA);
  assert.equal(orig.scheme, GIT_HEAD_SCHEME, 'modified a.txt has HEAD original');
  assert.equal(orig.path, REPO + '/a.txt');
  const head = await gitHeadProvider.provideTextDocumentContent(orig);
  assert.equal(head, 'one\n', 'HEAD content of a.txt (工作区追加的两行不在其中)');
  assert.equal(
    gitHeadProvider.provideOriginalResource({ scheme: 'agentdock-remote', authority: SERVER, path: REPO + '/b.txt' }),
    undefined,
    'untracked b.txt has no HEAD original',
  );
  assert.equal(gitHeadProvider.provideOriginalResource({ scheme: 'file', authority: '', path: REPO + '/a.txt' }), undefined);
  assert.equal(remoteGitStore.repoRootFor(SERVER, REPO + '/sub/c.txt'), REPO, 'repoRootFor longest prefix');
  assert.equal(remoteGitStore.repoRootFor(SERVER, os.tmpdir()), undefined, 'repoRootFor outside repo');

  // 5. 干净的已跟踪文件也给 HEAD 原文；行级改动数据源（git diff HEAD -U0，自绘 gutter 用）
  const cleanOrig = gitHeadProvider.provideOriginalResource({ scheme: 'agentdock-remote', authority: SERVER, path: REPO + '/g.txt' });
  assert.equal(cleanOrig.scheme, GIT_HEAD_SCHEME, 'clean tracked g.txt has HEAD original');
  assert.equal(await gitHeadProvider.provideTextDocumentContent(cleanOrig), 'g\n', 'HEAD content of g.txt');
  const { fetchDirtyHunks } = require('../out/git/gitDirtyDiff');
  assert.deepEqual(await fetchDirtyHunks(SERVER, REPO + '/a.txt'), [{ kind: 'added', startLine: 1, lineCount: 1, lines: ['+two'] }], 'a.txt appended-line hunk');
  assert.deepEqual(await fetchDirtyHunks(SERVER, REPO + '/e.txt'), [{ kind: 'deleted', startLine: 0, lineCount: 0, lines: ['-l2'] }], 'e.txt deleted-line hunk');
  assert.deepEqual(await fetchDirtyHunks(SERVER, REPO + '/f.txt'), [{ kind: 'modified', startLine: 0, lineCount: 1, lines: ['-x', '+X'] }], 'f.txt modified hunk');
  assert.equal(await fetchDirtyHunks(SERVER, REPO + '/b.txt'), undefined, 'untracked file skipped');
  assert.equal(await fetchDirtyHunks(SERVER, os.tmpdir()), undefined, 'path outside repo skipped');

  // 5b. 共享缓存（gutter 装饰与 CodeLens 的数据源）：冷 → warm → 热
  const { warmDirtyHunks, cachedDirtyHunks } = require('../out/git/gitDirtyDiff');
  assert.equal(cachedDirtyHunks(SERVER, REPO + '/a.txt'), undefined, 'hunk cache cold');
  const warmed = await warmDirtyHunks(SERVER, REPO + '/a.txt');
  assert.equal(warmed.length, 1, 'warm fetches hunks');
  assert.equal(cachedDirtyHunks(SERVER, REPO + '/a.txt')?.length, 1, 'hunk cache warm');

  // 6. 首开编辑器踢解析管线：REPO2 全程未经树 request，fetchDirtyHunks 首次返回 undefined 但触发解析
  assert.equal(await fetchDirtyHunks(SERVER, REPO2 + '/k.txt'), undefined, 'unknown root → no hunks yet');
  await waitFor(() => remoteGitStore.repoRootFor(SERVER, REPO2 + '/k.txt') === REPO2, 10000, 'kick resolves REPO2 root');
  await waitFor(
    async () => (await fetchDirtyHunks(SERVER, REPO2 + '/k.txt'))?.length === 1,
    10000,
    'hunks available after kicked scan',
  );
  assert.deepEqual(await fetchDirtyHunks(SERVER, REPO2 + '/k.txt'), [{ kind: 'added', startLine: 1, lineCount: 1, lines: ['+k2'] }], 'k.txt hunk');

  console.log("GIT STORE INTEGRATION OK");
  remoteGitStore.dispose();
  await execRemote(server, `rm -rf ${JSON.stringify(REPO)} ${JSON.stringify(REPO2)}`);
  process.exit(0);
})().catch((e) => {
  console.error("GIT STORE INTEGRATION FAILED:", e.message);
  process.exit(1);
});
