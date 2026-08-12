const test = require('node:test');
const assert = require('node:assert/strict');
// out/autoSave → require('vscode')：解析到最小 stub
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
const { AutoSaveManager } = require('../../out/autoSave');
const { getAutoSaveMode, getAutoSaveDelayMs } = require('../../out/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可变的配置存储：getConfiguration 返回它，测试里直接改值模拟设置变更
const configStore = {};

function patchConfig() {
  const prev = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (k, dflt) => (k in configStore ? configStore[k] : dflt),
    update: async () => {},
  });
  return () => {
    vscode.workspace.getConfiguration = prev;
  };
}

/** 捕获 AutoSaveManager 注册的全部事件处理器，返回可 restore 的句柄。 */
function captureEvents() {
  const handlers = {};
  const prev = {};
  const events = {
    'workspace.onDidChangeTextDocument': 'text',
    'workspace.onDidSaveTextDocument': 'save',
    'workspace.onDidCloseTextDocument': 'close',
    'workspace.onDidChangeConfiguration': 'config',
    'window.onDidChangeActiveTextEditor': 'activeEditor',
    'window.onDidChangeActiveTerminal': 'activeTerminal',
    'window.onDidChangeWindowState': 'windowState',
  };
  for (const [nsKey, hk] of Object.entries(events)) {
    const [ns, key] = nsKey.split('.');
    prev[nsKey] = vscode[ns][key];
    vscode[ns][key] = (cb) => {
      handlers[hk] = cb;
      return { dispose() {} };
    };
  }
  const restore = () => {
    for (const [nsKey, fn] of Object.entries(prev)) {
      const [ns, key] = nsKey.split('.');
      vscode[ns][key] = fn;
    }
  };
  return { handlers, restore };
}

function remoteDoc(p, { dirty = true } = {}) {
  const doc = {
    uri: { scheme: 'agentdock-remote', authority: 'srv', path: p, toString: () => 'agentdock-remote://srv' + p },
    isDirty: dirty,
    saves: 0,
  };
  doc.save = async () => {
    doc.saves++;
    doc.isDirty = false;
    return true;
  };
  return doc;
}

function localDoc(p) {
  const doc = { uri: { scheme: 'file', authority: '', path: p, toString: () => 'file://' + p }, isDirty: true, saves: 0 };
  doc.save = async () => {
    doc.saves++;
    doc.isDirty = false;
    return true;
  };
  return doc;
}

const editorFor = (doc) => ({ document: doc });

/** 每个用例独立上下文：config 可改、事件可触发、所有创建的 manager 统一释放。 */
function run(fn) {
  return async () => {
    const restoreConfig = patchConfig();
    const { handlers, restore } = captureEvents();
    const created = [];
    try {
      await fn({
        handlers,
        makeManager: () => {
          const m = new AutoSaveManager();
          created.push(m);
          return m;
        },
      });
    } finally {
      for (const m of created) {
        m.dispose();
      }
      restore();
      restoreConfig();
    }
  };
}

test('config: getAutoSaveMode normalizes value', () => {
  const restore = patchConfig();
  try {
    configStore['autoSave'] = 'off';
    assert.equal(getAutoSaveMode(), 'off');
    configStore['autoSave'] = 'afterDelay';
    assert.equal(getAutoSaveMode(), 'afterDelay');
    configStore['autoSave'] = 'onFocusChange';
    assert.equal(getAutoSaveMode(), 'onFocusChange');
    configStore['autoSave'] = 'onWindowChange';
    assert.equal(getAutoSaveMode(), 'onWindowChange');
    // 非法值回退 off
    configStore['autoSave'] = 'bogus';
    assert.equal(getAutoSaveMode(), 'off');
    // 未设置时走默认 off
    delete configStore['autoSave'];
    assert.equal(getAutoSaveMode(), 'off');
  } finally {
    restore();
  }
});

test('config: getAutoSaveDelayMs clamps to [0, 60000] with default 1000', () => {
  const restore = patchConfig();
  try {
    delete configStore['autoSaveDelay'];
    assert.equal(getAutoSaveDelayMs(), 1000);
    configStore['autoSaveDelay'] = 250;
    assert.equal(getAutoSaveDelayMs(), 250);
    configStore['autoSaveDelay'] = -5;
    assert.equal(getAutoSaveDelayMs(), 0);
    configStore['autoSaveDelay'] = 999999;
    assert.equal(getAutoSaveDelayMs(), 60000);
  } finally {
    restore();
  }
});

test(
  'autoSave afterDelay: saves delay ms after the last edit',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'afterDelay';
    configStore['autoSaveDelay'] = 120;
    makeManager();
    const doc = remoteDoc('/a.txt');
    handlers.text({ document: doc });
    await sleep(60);
    assert.equal(doc.saves, 0, 'must not save before the delay elapses');
    await sleep(100); // 共 160 > 120
    assert.equal(doc.saves, 1, 'must save after the delay');
  }),
);

test(
  'autoSave afterDelay: further edits reset the timer (debounced)',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'afterDelay';
    configStore['autoSaveDelay'] = 150;
    makeManager();
    const doc = remoteDoc('/a.txt');
    handlers.text({ document: doc });
    await sleep(80); // 未到 150
    handlers.text({ document: doc }); // 重新计时
    await sleep(90); // 距第一次 170，距第二次仅 90
    assert.equal(doc.saves, 0, 'editing again must reset the timer');
    await sleep(100); // 距第二次 190 > 150
    assert.equal(doc.saves, 1);
  }),
);

test(
  'autoSave afterDelay: only agentdock-remote docs are auto-saved',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'afterDelay';
    configStore['autoSaveDelay'] = 30;
    makeManager();
    const local = localDoc('/l.txt');
    handlers.text({ document: local });
    await sleep(80);
    assert.equal(local.saves, 0, 'file:// docs must be left to native auto-save');
  }),
);

test(
  'autoSave afterDelay: dirty remote doc already open at activation is scheduled',
  run(async ({ makeManager }) => {
    configStore['autoSave'] = 'afterDelay';
    configStore['autoSaveDelay'] = 40;
    const doc = remoteDoc('/pre.txt');
    const prev = vscode.workspace.textDocuments;
    vscode.workspace.textDocuments = [doc];
    try {
      makeManager();
      await sleep(100);
      assert.equal(doc.saves, 1, 'pre-existing dirty remote doc must be saved too');
    } finally {
      vscode.workspace.textDocuments = prev;
    }
  }),
);

test(
  'autoSave afterDelay: closing the doc cancels the pending save',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'afterDelay';
    configStore['autoSaveDelay'] = 100;
    makeManager();
    const doc = remoteDoc('/a.txt');
    handlers.text({ document: doc });
    handlers.close(doc);
    await sleep(150);
    assert.equal(doc.saves, 0);
  }),
);

test(
  'autoSave onFocusChange: switching editors saves the previously active remote doc',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'onFocusChange';
    makeManager();
    const a = remoteDoc('/a.txt');
    const b = remoteDoc('/b.txt');
    handlers.activeEditor(editorFor(a));
    assert.equal(a.saves, 0, 'becoming active must not save');
    handlers.activeEditor(editorFor(b));
    assert.equal(a.saves, 1, 'a lost focus → saved');
    assert.equal(b.saves, 0);
    handlers.activeEditor(editorFor(a));
    assert.equal(b.saves, 1, 'b lost focus → saved');
    assert.equal(a.saves, 1, 'a already clean → not re-saved');
  }),
);

test(
  'autoSave onFocusChange: focusing a terminal saves the active remote doc',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'onFocusChange';
    makeManager();
    const a = remoteDoc('/a.txt');
    handlers.activeEditor(editorFor(a));
    handlers.activeTerminal();
    assert.equal(a.saves, 1);
  }),
);

test(
  'autoSave onWindowChange: window blur saves all dirty remote docs',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'onWindowChange';
    makeManager();
    const a = remoteDoc('/a.txt');
    const local = localDoc('/l.txt');
    const prev = vscode.workspace.textDocuments;
    vscode.workspace.textDocuments = [a, local];
    try {
      handlers.windowState({ focused: false });
      assert.equal(a.saves, 1);
      assert.equal(local.saves, 0, 'local docs are not touched');
      handlers.windowState({ focused: true });
      assert.equal(a.saves, 1, 'gaining focus must not save');
    } finally {
      vscode.workspace.textDocuments = prev;
    }
  }),
);

test(
  'autoSave onFocusChange: window blur also saves dirty remote docs',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'onFocusChange';
    makeManager();
    const a = remoteDoc('/a.txt');
    const prev = vscode.workspace.textDocuments;
    vscode.workspace.textDocuments = [a];
    try {
      handlers.windowState({ focused: false });
      assert.equal(a.saves, 1);
    } finally {
      vscode.workspace.textDocuments = prev;
    }
  }),
);

test(
  'autoSave off: nothing is saved automatically',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'off';
    makeManager();
    const a = remoteDoc('/a.txt');
    const prev = vscode.workspace.textDocuments;
    vscode.workspace.textDocuments = [a];
    try {
      handlers.text({ document: a });
      handlers.windowState({ focused: false });
      handlers.activeTerminal();
      await sleep(80);
      assert.equal(a.saves, 0);
    } finally {
      vscode.workspace.textDocuments = prev;
    }
  }),
);

test(
  'autoSave: switching the setting to off cancels pending timers',
  run(async ({ handlers, makeManager }) => {
    configStore['autoSave'] = 'afterDelay';
    configStore['autoSaveDelay'] = 100;
    makeManager();
    const a = remoteDoc('/a.txt');
    handlers.text({ document: a });
    configStore['autoSave'] = 'off';
    handlers.config({ affectsConfiguration: (k) => k === 'agentDock.autoSave' });
    await sleep(150);
    assert.equal(a.saves, 0, 'timer must be cancelled once the mode becomes off');
  }),
);
