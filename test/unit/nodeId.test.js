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
const { nodeId, nodeParent, nodeFromId } = require('../../out/tree/workspaceProvider');

// 纯函数测试：稳定 id 与父节点推导（跨 reload 的展开状态恢复依赖它们）。
// 注意：vscode-stub 未实现 workspace.workspaceFolders，fsEntry 父推导走非 workspace 分支。

const baseNodes = {
  server: { kind: 'server', key: 'srv1', label: 'srv1', isCurrent: false },
  folder: { kind: 'folder', serverKey: 'srv1', path: '/data', label: 'data' },
  otherSessions: { kind: 'otherSessions', serverKey: 'srv1' },
  sessionsRoot: { kind: 'sessionsRoot', serverKey: 'srv1', folderPath: '/data' },
  session: {
    kind: 'session',
    serverKey: 'srv1',
    session: { agent: 'opencode', id: 'ses-1', title: 't', cwd: '/data', timeCreated: 0, timeUpdated: 1 },
  },
  fsEntry: { kind: 'fsEntry', uri: { scheme: 'file', authority: '', path: '/a/b.txt', fsPath: '/a/b.txt', toString: () => 'file:///a/b.txt' }, name: 'b.txt', isDir: false },
  remoteFsEntry: { kind: 'remoteFsEntry', serverKey: 'srv1', path: '/data/sub', name: 'sub', isDir: true },
  portsRoot: { kind: 'portsRoot', serverKey: 'srv1' },
  portForward: {
    kind: 'portForward',
    serverKey: 'srv1',
    forward: { localPort: 8080, remotePort: 80 },
  },
  info: { kind: 'info', label: 'x', severity: 'info' },
};

test('nodeId: stable and unique per node', () => {
  const ids = Object.values(baseNodes).map((n) => nodeId(n));
  assert.equal(new Set(ids).size, ids.length, 'all ids unique');
  // 同内容重建节点 id 不变（跨 reload 稳定）
  assert.equal(nodeId(baseNodes.remoteFsEntry), 'remoteFs:srv1:/data/sub');
  assert.equal(nodeId(baseNodes.session), 'session:srv1:ses-1');
  assert.equal(nodeId(baseNodes.fsEntry), `fs:${encodeURIComponent('file:///a/b.txt')}`);
});

test('nodeId: portForward distinguishes remoteHost', () => {
  const a = nodeId({ kind: 'portForward', serverKey: 's', forward: { localPort: 1, remotePort: 2 } });
  const b = nodeId({ kind: 'portForward', serverKey: 's', forward: { localPort: 1, remoteHost: 'db', remotePort: 2 } });
  assert.notEqual(a, b);
});

test('nodeParent: server / info have no parent', () => {
  assert.equal(nodeParent(baseNodes.server), undefined);
  assert.equal(nodeParent(baseNodes.info), undefined);
});

test('nodeParent: folder / otherSessions / portsRoot -> server', () => {
  for (const n of [baseNodes.folder, baseNodes.otherSessions, baseNodes.portsRoot]) {
    const p = nodeParent(n);
    assert.equal(p.kind, 'server');
    assert.equal(p.key, 'srv1');
    // 父节点的 id 能反推出子节点所在 server
    assert.equal(nodeId(p), 'server:srv1');
  }
});

test('nodeParent: sessionsRoot -> folder, session -> sessionsRoot or parent session', () => {
  const p = nodeParent(baseNodes.sessionsRoot);
  assert.equal(p.kind, 'folder');
  assert.equal(p.path, '/data');
  assert.equal(nodeId(p), 'folder:srv1:/data');

  const ps = nodeParent(baseNodes.session);
  assert.equal(ps.kind, 'sessionsRoot');

  const nested = {
    ...baseNodes.session,
    session: { ...baseNodes.session.session, parentId: 'ses-parent' },
  };
  const pp = nodeParent(nested);
  assert.equal(pp.kind, 'session');
  assert.equal(pp.session.id, 'ses-parent');
});

test('nodeParent: remoteFsEntry -> parent remote dir, root -> folder', () => {
  const p = nodeParent(baseNodes.remoteFsEntry);
  assert.equal(p.kind, 'remoteFsEntry');
  assert.equal(p.path, '/data');
  assert.equal(nodeId(p), 'remoteFs:srv1:/data');

  const root = { ...baseNodes.remoteFsEntry, path: '/data' };
  const pr = nodeParent(root);
  assert.equal(pr.kind, 'folder');
  assert.equal(pr.path, '/data');
});

test('nodeParent: fsEntry -> parent dir (non-workspace fallback)', () => {
  const p = nodeParent(baseNodes.fsEntry);
  assert.equal(p.kind, 'fsEntry');
  assert.equal(p.uri.toString(), 'file:///a');
});

test('nodeFromId: round-trips stable ids back to minimal nodes (reveal restore)', () => {
  for (const n of [
    baseNodes.server,
    baseNodes.folder,
    baseNodes.otherSessions,
    baseNodes.sessionsRoot,
    baseNodes.remoteFsEntry,
    baseNodes.portsRoot,
  ]) {
    const back = nodeFromId(nodeId(n));
    assert.ok(back, `nodeFromId(${nodeId(n)}) should return a node`);
    assert.equal(nodeId(back), nodeId(n), `id round-trip for ${nodeId(n)}`);
  }
});

test('nodeFromId: fsEntry round-trips file uri and vscode-remote uri (encoded id)', () => {
  // nodeId 对 fsEntry 输出 encodeURIComponent 后的完整 uri.toString()
  const local = nodeFromId(nodeId({ kind: 'fsEntry', uri: { scheme: 'file', authority: '', path: '/a/b.txt', fsPath: '/a/b.txt', toString: () => 'file:///a/b.txt' }, name: 'b.txt', isDir: true }));
  assert.equal(local.kind, 'fsEntry');
  assert.equal(local.uri.toString(), 'file:///a/b.txt');
  assert.equal(nodeId(local), nodeId({ kind: 'fsEntry', uri: { scheme: 'file', authority: '', path: '/a/b.txt', fsPath: '/a/b.txt', toString: () => 'file:///a/b.txt' }, name: 'b.txt', isDir: true }));

  // vscode-remote URI 含 : 端口 与 %2B——encode 后 split(':') 不再错位
  const uriStr = 'vscode-remote://ssh-host%2Bport:2222/home/u/x.txt';
  const remote = nodeFromId(nodeId({ kind: 'fsEntry', uri: { scheme: 'vscode-remote', authority: 'ssh-host%2Bport:2222', path: '/home/u/x.txt', fsPath: '', toString: () => uriStr }, name: 'x.txt', isDir: true }));
  assert.equal(remote.kind, 'fsEntry');
  assert.equal(remote.uri.toString(), uriStr);
});

test('nodeFromId: folder path with colon-safe serverKey round-trips', () => {
  const n = { kind: 'folder', serverKey: '__current__', path: '/mnt/hdd/x', label: 'x' };
  const back = nodeFromId(nodeId(n));
  assert.equal(back.kind, 'folder');
  assert.equal(back.serverKey, '__current__');
  assert.equal(back.path, '/mnt/hdd/x');
});
