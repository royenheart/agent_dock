const test = require('node:test');
const assert = require('node:assert/strict');
// out/tree/moveOps → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { remoteMoveGuard, remoteParentPath } = require('../../out/tree/moveOps');

// 移动守卫：拖放/移动到目标目录前拦截「原地移动」与「目录移入自身子树」。
test('remoteMoveGuard: same dir is detected', () => {
  assert.equal(remoteMoveGuard('/data/a.txt', false, '/data'), 'same');
  assert.equal(remoteMoveGuard('/data/sub', true, '/data'), 'same');
  // 目标带尾斜杠也视为同一目录
  assert.equal(remoteMoveGuard('/data/a.txt', false, '/data/'), 'same');
});

test('remoteMoveGuard: dir into its own subtree is blocked', () => {
  assert.equal(remoteMoveGuard('/a', true, '/a'), 'into-self');
  assert.equal(remoteMoveGuard('/a', true, '/a/b'), 'into-self');
  assert.equal(remoteMoveGuard('/a', true, '/a/b/c'), 'into-self');
  // 文件不可能包含目录，不算 into-self
  assert.equal(remoteMoveGuard('/a/b.txt', false, '/a/b'), undefined);
});

test('remoteMoveGuard: valid moves pass', () => {
  assert.equal(remoteMoveGuard('/data/a.txt', false, '/backup'), undefined);
  assert.equal(remoteMoveGuard('/data', true, '/other'), undefined);
  // 同名兄弟路径不是子树
  assert.equal(remoteMoveGuard('/a', true, '/ab'), undefined);
  // 根目录作为目标
  assert.equal(remoteMoveGuard('/data/a.txt', false, '/'), undefined);
});

test('remoteParentPath: parent and root handling', () => {
  assert.equal(remoteParentPath('/data/sub/file.txt'), '/data/sub');
  assert.equal(remoteParentPath('/file.txt'), '/');
  assert.equal(remoteParentPath('/'), '/');
});
