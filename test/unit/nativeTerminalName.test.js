const test = require('node:test');
const assert = require('node:assert/strict');
// out/ssh/nativeTerminal → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const vscode = require('vscode');
const {
  initNativeTerminalPersistence,
  trackNativeTerminal,
  syncNativeTerminalName,
  untrackNativeTerminal,
  markNativeTerminalsShuttingDown,
} = require('../../out/ssh/nativeTerminal');

const STORE_KEY = 'agentDock.nativeTerminals.v1';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('native terminal: track persists creationName+cwd, rename sync updates store', async () => {
  const memento = makeMemento();
  initNativeTerminalPersistence(memento);

  const term = { name: 'mydir', show() {} };
  trackNativeTerminal(term, '/home/u/mydir');

  let saved = memento.store[STORE_KEY];
  assert.deepEqual(saved['mydir\n/home/u/mydir'], { creationName: 'mydir', cwd: '/home/u/mydir', name: 'mydir' });

  term.name = 'custom name';
  syncNativeTerminalName(term);
  saved = memento.store[STORE_KEY];
  // 匹配键保持创建名不变，当前名跟随 rename
  assert.equal(saved['mydir\n/home/u/mydir'].name, 'custom name');

  await untrackNativeTerminal(term);
});

test('native terminal: untrack removes the entry after debounce', async () => {
  const memento = makeMemento();
  initNativeTerminalPersistence(memento);

  const term = { name: 'd2', show() {} };
  trackNativeTerminal(term, '/x/d2');
  assert.ok(memento.store[STORE_KEY]['d2\n/x/d2']);

  untrackNativeTerminal(term);
  await sleep(2100); // 防抖 2000ms 后落盘
  assert.equal(memento.store[STORE_KEY]['d2\n/x/d2'], undefined);
});

test('native terminal: reload reconcile re-tracks and replays the saved name', async () => {
  const memento = makeMemento();
  memento.store[STORE_KEY] = {
    'mydir\n/home/u/mydir': { creationName: 'mydir', cwd: '/home/u/mydir', name: 'custom name' },
  };

  const calls = [];
  const origExec = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (cmd, arg) => {
    calls.push([cmd, arg]);
  };
  try {
    // 模拟 reload 后 VSCode 复活的原生终端：creationOptions 保留创建名+cwd，显示名被重置
    const revived = { name: 'mydir', creationOptions: { name: 'mydir', cwd: '/home/u/mydir' }, show() {} };
    const ptyTerm = { name: 'Client Terminal', creationOptions: { name: 'Client Terminal', pty: {} }, show() {} };
    const prev = vscode.window.terminals;
    vscode.window.terminals = [revived, ptyTerm];
    try {
      initNativeTerminalPersistence(memento);
      // 回放经串行队列 + 50ms 稳定延迟，等它落地
      await sleep(150);
    } finally {
      vscode.window.terminals = prev;
    }

    assert.equal(calls.length, 1, 'pty terminals must be skipped; only the matching native terminal is renamed');
    assert.deepEqual(calls[0], ['workbench.action.terminal.renameWithArg', { name: 'custom name' }]);

    // reload 后的新 Terminal 对象已重新纳入跟踪：rename 能继续同步
    revived.name = 'renamed again';
    syncNativeTerminalName(revived);
    assert.equal(memento.store[STORE_KEY]['mydir\n/home/u/mydir'].name, 'renamed again');

    await untrackNativeTerminal(revived);
  } finally {
    vscode.commands.executeCommand = origExec;
  }
});

// 必须放最后：shutdown 标记是模块级状态，置位后持久化全部关闭
test('native terminal: shutdown guard blocks writes and untrack', async () => {
  const memento = makeMemento();
  initNativeTerminalPersistence(memento);

  const term = { name: 'd3', show() {} };
  trackNativeTerminal(term, '/x/d3');
  assert.ok(memento.store[STORE_KEY]['d3\n/x/d3']);

  markNativeTerminalsShuttingDown();
  untrackNativeTerminal(term);
  await sleep(2100);
  assert.ok(memento.store[STORE_KEY]['d3\n/x/d3'], 'shutdown 期间的 untrack 不得抹掉记录');
});
