const test = require('node:test');
const assert = require('node:assert/strict');
// out/tree/workspaceProvider → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { WorkspaceProvider } = require('../../out/tree/workspaceProvider');
const { remoteGitStore } = require('../../out/git/remoteGit');

// TS 的 private 在编译产物里是普通属性：直接种缓存验证刷新语义。
// 回归背景：配置变更（如「给服务器添加目录」→ agentDock.servers 写入 → onDidChangeConfiguration）
// 之前一律走 refresh()，会清空会话缓存 + 远程目录缓存并全量重拉，已展开的目录状态被重置。
// refreshConfig() 只重绘树、保留缓存——目录树与展开状态不受影响。
test('refreshConfig preserves caches while refresh() clears them', () => {
  const p = new WorkspaceProvider();
  p.store.cache.set('srv1', []);
  p.remoteDirCache.set('srv1:/data', [{ kind: 'info', label: 'x', severity: 'info' }]);
  p.dirMtimes.set('srv1:/data', 123);

  p.refreshConfig();
  assert.ok(p.store.cache.has('srv1'), 'refreshConfig must keep the session cache');
  assert.ok(p.remoteDirCache.has('srv1:/data'), 'refreshConfig must keep the remote dir cache');
  assert.ok(p.dirMtimes.has('srv1:/data'), 'refreshConfig must keep dir mtimes');

  p.refresh();
  assert.equal(p.store.cache.has('srv1'), false, 'refresh() clears the session cache');
  assert.equal(p.remoteDirCache.size, 0, 'refresh() clears the remote dir cache');
  assert.equal(p.dirMtimes.size, 0, 'refresh() clears dir mtimes');
});

test('refreshRemoteDir invalidates the directory git status before refetching', async () => {
  const p = new WorkspaceProvider();
  const calls = [];
  const orig = remoteGitStore.invalidate;
  remoteGitStore.invalidate = (serverKey, dir) => {
    calls.push([serverKey, dir]);
  };
  try {
    await p.refreshRemoteDir('srv1', '/data');
  } finally {
    remoteGitStore.invalidate = orig;
  }
  assert.deepEqual(calls, [['srv1', '/data']], 'manual refresh must invalidate cached git decorations');
});
