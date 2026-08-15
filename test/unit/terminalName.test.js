const test = require('node:test');
const assert = require('node:assert/strict');
// out/ssh/clientTerminal → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const {
  clientTerminalOptions,
  flushClientTerminalPersistence,
  initClientTerminalPersistence,
  markClientTerminalsShuttingDown,
  syncAllTrackedTerminalNames,
  trackClientTerminal,
  untrackClientTerminal,
  syncTrackedTerminalName,
  isAgentDockTerminal,
  isTrackedTerminal,
} = require('../../out/ssh/clientTerminal');
const vscode = require('vscode');

// 最小 memento：记录 update 写入值，供断言
function makeMemento() {
  const store = {};
  return {
    store,
    get: (k, dflt) => (k in store ? store[k] : dflt),
    update: async (k, v) => {
      store[k] = v;
    },
  };
}

// 模拟 vscode.Terminal 的最小对象
function fakeTerminal(name) {
  return { name };
}

test('terminal name sync: rename is persisted so reload restores the new name', async () => {
  const memento = makeMemento();
  initClientTerminalPersistence(memento);

  const term = fakeTerminal('ssh: server1');
  const d = { name: 'ssh: server1', kind: 'ssh', serverName: 'server1' };
  trackClientTerminal(term, d);

  // 用户 rename：terminal.name 变了，sync 后持久化描述跟着变
  term.name = 'my custom name';
  syncTrackedTerminalName(term);
  await flushClientTerminalPersistence();

  const saved = memento.store['agentDock.clientTerminals.v1'];
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'my custom name', 'rename must be persisted');

  untrackClientTerminal(term);
});

test('terminal name poll sync: rename without state event is persisted', async () => {
  const memento = makeMemento();
  initClientTerminalPersistence(memento);

  const term = fakeTerminal('ssh: server1');
  trackClientTerminal(term, { name: 'ssh: server1', kind: 'ssh', serverName: 'server1' });
  // VSCode 对用户 rename 不保证派发 onDidChangeTerminalState：轮询兜底直接扫所有 tracked 终端
  term.name = 'my custom name';
  syncAllTrackedTerminalNames();
  await flushClientTerminalPersistence();

  const saved = memento.store['agentDock.clientTerminals.v1'];
  assert.equal(saved[0].name, 'my custom name', 'poll fallback must persist the rename');
  untrackClientTerminal(term);
});

test('terminal name sync: no-op when name unchanged or terminal untracked', async () => {
  const memento = makeMemento();
  initClientTerminalPersistence(memento);

  const term = fakeTerminal('same');
  trackClientTerminal(term, { name: 'same', kind: 'shell' });
  await flushClientTerminalPersistence();
  syncTrackedTerminalName(term); // 名字没变：不重写
  assert.equal(memento.store['agentDock.clientTerminals.v1'][0].name, 'same');

  const other = fakeTerminal('untracked');
  syncTrackedTerminalName(other); // 未跟踪的终端：不抛错、不写入
  assert.equal(memento.store['agentDock.clientTerminals.v1'].length, 1);

  untrackClientTerminal(term);
  syncTrackedTerminalName(term); // 已移除：不抛错
});

test('clientTerminalOptions carries the provided name', () => {
  const opts = clientTerminalOptions('my name');
  assert.equal(opts.name, 'my name');
  assert.ok(opts.pty, 'has pty');
});

test('isAgentDockTerminal: profile-created pty terminal is recognized', () => {
  const opts = clientTerminalOptions('Client Terminal'); // 与 profile 提供的一致
  const term = { name: 'Client Terminal', creationOptions: opts };
  assert.ok(isAgentDockTerminal(term), 'client pty terminal should be recognized');
});

test('isTrackedTerminal: track -> true, untrack -> false', () => {
  const memento = makeMemento();
  initClientTerminalPersistence(memento);
  const opts = clientTerminalOptions('x');
  const term = { name: 'x', creationOptions: opts };
  assert.equal(isTrackedTerminal(term), false);
  trackClientTerminal(term, { name: 'x', kind: 'shell' });
  assert.equal(isTrackedTerminal(term), true);
  untrackClientTerminal(term);
  assert.equal(isTrackedTerminal(term), false);
});

test('restore: same-name saved terminals are all rebuilt (dedupe uses pre-restore snapshot)', () => {
  const memento = makeMemento();
  memento.store['agentDock.clientTerminals.v1'] = [
    { name: 'Client Terminal', kind: 'shell' },
    { name: 'Client Terminal', kind: 'shell' },
  ];
  const prev = vscode.window.terminals;
  vscode.window.terminals = [];
  try {
    initClientTerminalPersistence(memento);
    // 两个同名条目都必须重建——重建出的终端不得反过来把后续同名条目判定为"已存在"
    assert.equal(vscode.window.terminals.length, 2);
    for (const term of vscode.window.terminals) {
      untrackClientTerminal(term);
    }
  } finally {
    vscode.window.terminals = prev;
  }
});

// 放在文件末尾：markClientTerminalsShuttingDown 会把模块级 shuttingDown 置真，
// 与真实 deactivate 一致，之后的测试不会再写 memento。
test('terminal name sync: shutdown does a final rename sync before persisting', async () => {
  const memento = makeMemento();
  initClientTerminalPersistence(memento);

  const term = fakeTerminal('ssh: server1');
  trackClientTerminal(term, { name: 'ssh: server1', kind: 'ssh', serverName: 'server1' });
  term.name = 'renamed-right-before-reload';
  markClientTerminalsShuttingDown();
  await flushClientTerminalPersistence();

  const saved = memento.store['agentDock.clientTerminals.v1'];
  assert.equal(saved[0].name, 'renamed-right-before-reload', 'deactivate final sync must capture the latest name');
  untrackClientTerminal(term);
});
