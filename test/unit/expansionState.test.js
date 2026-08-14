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
  assert.ok(es.ids.includes('folder:__current__:/tmp/x'));
  assert.deepEqual(m._store['agentDock.expandedNodes.v1'], ['folder:__current__:/tmp/x']);
  // 折叠删除并持久化
  es.onCollapse(node);
  assert.equal(es.ids.length, 0);
  assert.deepEqual(m._store['agentDock.expandedNodes.v1'], []);
});

test('ExpansionState: restore reveals shallow nodes first (server → folder → fsEntry)', async () => {
  const m = fakeMemento({
    'agentDock.expandedNodes.v1': [FS_ID, 'folder:__current__:/tmp/x', 'server:__current__'],
  });
  const es = new ExpansionState();
  es.init(m);
  const order = [];
  const view = {
    reveal: async (node) => {
      order.push(node.kind);
    },
  };
  const hasPending = await es.restore([view]);
  assert.equal(hasPending, false);
  assert.deepEqual(order, ['server', 'folder', 'fsEntry'], 'reveal must go shallow → deep');
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
