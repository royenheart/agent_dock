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
