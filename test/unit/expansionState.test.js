const test = require('node:test');
const assert = require('node:assert/strict');
// out/tree/expansionState → out/tree/workspaceProvider → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { ExpansionState } = require('../../out/tree/expansionState');
const { nodeId } = require('../../out/tree/workspaceProvider');

function fakeMemento(initial = {}) {
  const store = { ...initial };
  return {
    get: (k, dflt) => (k in store ? store[k] : dflt),
    update: async (k, v) => {
      store[k] = v;
    },
    _store: store,
  };
}

const FS_ID = 'fs:' + encodeURIComponent('file:///tmp/x/a.txt');
const FS_PARENT_ID = 'fs:' + encodeURIComponent('file:///tmp/x');

test('ExpansionState: init restores saved ids from memento', () => {
  const m = fakeMemento({ 'agentDock.expandedNodes.v1': ['server:__current__', 'folder:__current__:/tmp/x'] });
  const es = new ExpansionState();
  es.init(m);
  assert.deepEqual(es.ids.sort(), ['folder:__current__:/tmp/x', 'server:__current__']);
});

test('ExpansionState: onExpand persists, onCollapse removes', async () => {
  const m = fakeMemento();
  const es = new ExpansionState();
  es.init(m);
  const node = { kind: 'folder', serverKey: '__current__', path: '/tmp/x', label: 'x' };
  es.onExpand(node);
  await es.flush();
  assert.ok(es.ids.includes('folder:__current__:/tmp/x'));
  assert.deepEqual(m._store['agentDock.expandedNodes.v1'], ['folder:__current__:/tmp/x']);
  // 折叠删除并持久化
  es.onCollapse(node);
  await es.flush();
  assert.equal(es.ids.length, 0);
  assert.deepEqual(m._store['agentDock.expandedNodes.v1'], []);
});

test('ExpansionState: restore reveals shallow nodes first (server → folder → fsEntry)', async () => {
  // 让 /tmp 成为 workspace folder：/tmp/x 和 /tmp/x/a.txt 的祖先链才完整
  const vscodeStub = require('./vscode-stub.js');
  vscodeStub.workspace.workspaceFolders = [{ uri: vscodeStub.Uri.parse('file:///tmp'), name: 'tmp', index: 0 }];
  try {
    const m = fakeMemento({
      'agentDock.expandedNodes.v1': [FS_ID, FS_PARENT_ID, 'folder:__current__:/tmp', 'server:__current__'],
    });
    const es = new ExpansionState();
    es.init(m);
    const order = [];
    const view = {
      reveal: async (node) => {
        order.push(nodeId(node));
      },
    };
    const hasPending = await es.restore([view]);
    assert.equal(hasPending, false);
    assert.deepEqual(
      order,
      ['server:__current__', 'folder:__current__:/tmp', FS_PARENT_ID, FS_ID],
      'reveal must go shallow → deep and include the full ancestor chain',
    );
  } finally {
    vscodeStub.workspace.workspaceFolders = undefined;
  }
});

test('ExpansionState: collapsing a node also removes recorded descendants', async () => {
  const m = fakeMemento();
  const es = new ExpansionState();
  es.init(m);
  const parentNode = { kind: 'fsEntry', uri: { scheme: 'file', authority: '', path: '/tmp/x', fsPath: '/tmp/x', toString: () => 'file:///tmp/x' }, name: 'x', isDir: true };
  const childNode = { kind: 'fsEntry', uri: { scheme: 'file', authority: '', path: '/tmp/x/a.txt', fsPath: '/tmp/x/a.txt', toString: () => 'file:///tmp/x/a.txt' }, name: 'a.txt', isDir: false };
  es.onExpand(parentNode);
  es.onExpand(childNode);
  await es.flush();
  assert.deepEqual(es.ids.sort(), [FS_ID, FS_PARENT_ID].sort());

  es.onCollapse(parentNode);
  await es.flush();
  assert.equal(es.ids.length, 0, 'parent collapse must remove descendant records too');
  assert.deepEqual(m._store['agentDock.expandedNodes.v1'], []);
});

test('ExpansionState: restore skips nodes whose parent is collapsed (no implicit re-expand)', async () => {
  const m = fakeMemento({ 'agentDock.expandedNodes.v1': [FS_ID] });
  const es = new ExpansionState();
  es.init(m);
  const revealed = [];
  const view = {
    reveal: async (node) => {
      revealed.push(nodeId(node));
    },
  };
  assert.equal(await es.restore([view]), false, 'orphan child must not trigger a reveal');
  assert.deepEqual(revealed, [], 'parent path is absent → child stays hidden');
  assert.deepEqual(es.ids, [FS_ID], 'saved record is kept for when the parent is expanded again');
});

test('ExpansionState: reopening a parent alone does not re-reveal filtered children', async () => {
  const vscodeStub = require('./vscode-stub.js');
  vscodeStub.workspace.workspaceFolders = [{ uri: vscodeStub.Uri.parse('file:///tmp'), name: 'tmp', index: 0 }];
  try {
    const m = fakeMemento({ 'agentDock.expandedNodes.v1': [FS_ID] });
    const es = new ExpansionState();
    es.init(m);
    const revealed = [];
    const view = { reveal: async (node) => revealed.push(nodeId(node)) };
    assert.equal(await es.restore([view]), false, 'parent collapsed → child not revealed');

    const folder = { kind: 'folder', serverKey: '__current__', path: '/tmp', label: 'tmp' };
    const parent = { kind: 'fsEntry', uri: vscodeStub.Uri.parse('file:///tmp/x'), name: 'x', isDir: true };
    es.onExpand(folder);
    es.onExpand(parent);
    // onExpand 只记录父节点自身；扩展层不再在 onExpand 里 scheduleRestore，
    // 因此重新打开父目录不会把之前保存过的子目录批量展开。
    assert.deepEqual(revealed, [], 'onExpand must not trigger any reveal by itself');
  } finally {
    vscodeStub.workspace.workspaceFolders = undefined;
  }
});

test('ExpansionState: restore retries failed reveals on next round', async () => {
  const m = fakeMemento({ 'agentDock.expandedNodes.v1': ['server:__current__'] });
  const es = new ExpansionState();
  es.init(m);
  let calls = 0;
  const view = {
    reveal: async () => {
      calls++;
      if (calls === 1) {
        throw new Error('not ready');
      }
    },
  };
  const first = await es.restore([view]);
  assert.equal(first, true, 'failed reveal should leave pending');
  const second = await es.restore([view]);
  assert.equal(second, false, 'retry round should clear pending');
  assert.equal(calls, 2);
});

test('ExpansionState: onTreeChanged resets retry counter', async () => {
  const m = fakeMemento({ 'agentDock.expandedNodes.v1': ['server:__current__'] });
  const es = new ExpansionState();
  es.init(m);
  let calls = 0;
  const view = {
    reveal: async () => {
      calls++;
      if (calls === 1 || calls === 3) {
        throw new Error('not ready');
      }
    },
  };
  await es.restore([view]); // round 1: fail
  es.onTreeChanged(); // 树刷新：attempt 归零（pending 仍保留）
  await es.restore([view]); // round 2 (attempt reset): fail
  assert.equal(es.ids.length, 1, 'id stays recorded');
});

test('ExpansionState: restore gives up after consecutive failures (no infinite retry)', async () => {
  const m = fakeMemento({ 'agentDock.expandedNodes.v1': ['server:__current__'] });
  const es = new ExpansionState();
  es.init(m);
  let calls = 0;
  const view = {
    reveal: async () => {
      calls++;
      throw new Error('gone');
    },
  };
  let hasPending = true;
  let rounds = 0;
  while (hasPending && rounds < 20) {
    hasPending = await es.restore([view]);
    rounds++;
  }
  assert.equal(hasPending, false, 'must stop retrying after the failure cap');
  assert.equal(calls, 5, 'exactly MAX_RESTORE_FAILURES reveal attempts');
  assert.equal(es.ids.length, 1, 'given-up id stays recorded (not destructive; reload retries)');
  // 放弃后再调度（树变化触发）是空调度：不再 reveal、不再报 pending
  assert.equal(await es.restore([view]), false);
  assert.equal(calls, 5, 'no further reveal calls after give-up');
});

test('ExpansionState: permanent failure of one node does not block another from retrying', async () => {
  const m = fakeMemento({ 'agentDock.expandedNodes.v1': ['server:__current__', 'folder:__current__:/tmp/x'] });
  const es = new ExpansionState();
  es.init(m);
  let folderCalls = 0;
  const view = {
    reveal: async (node) => {
      if (node.kind === 'server') {
        throw new Error('gone');
      }
      folderCalls++;
      if (folderCalls === 1) {
        throw new Error('not ready');
      }
    },
  };
  await es.restore([view]); // server fail(1), folder fail(1) → both pending
  const second = await es.restore([view]); // server fail(2), folder ok → folder cleared
  assert.equal(second, true, 'server still pending');
  await es.restore([view]);
  await es.restore([view]);
  const fifth = await es.restore([view]); // server 第 5 次失败 → 放弃
  assert.equal(fifth, false, 'server given up, nothing pending');
  assert.equal(folderCalls, 2, 'folder succeeded on its second round');
  assert.deepEqual(es.ids.sort(), ['folder:__current__:/tmp/x', 'server:__current__']);
});
