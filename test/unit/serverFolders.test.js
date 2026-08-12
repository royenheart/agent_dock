const test = require('node:test');
const assert = require('node:assert/strict');
// out/config → require('vscode')：解析到最小 stub
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
const { addServerFolders, removeServerFolders, getServers } = require('../../out/config');

// 配置读写走 vscode.workspace.getConfiguration().get/update：打桩成内存数组。
// 回归背景：给服务器固定目录只能 addServerFolders，缺少移除入口——
// removeServerFolders 只取消固定（改写 agentDock.servers 的 folders），不触碰服务器真实目录。
let servers = [];

function patchConfig() {
  const prev = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (section) => {
    if (section !== 'agentDock') {
      return { get: (_k, dflt) => dflt, update: async () => {} };
    }
    return {
      get: (k, dflt) => (k === 'servers' ? servers : dflt),
      update: async (k, v) => {
        if (k === 'servers') {
          servers = v;
        }
      },
    };
  };
  return () => {
    vscode.workspace.getConfiguration = prev;
  };
}

function makeServer(name, folders) {
  return { name, host: 'e2e-host', user: 'e2e', port: 2222, folders };
}

test('server folders: add then remove a pinned directory (config only, no fs touch)', async () => {
  const restore = patchConfig();
  try {
    servers = [makeServer('srv1', ['/data'])];
    await addServerFolders('srv1', ['/extra', '/data']); // 去重合并
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, ['/data', '/extra']);

    await removeServerFolders('srv1', ['/data']);
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, ['/extra']);

    await removeServerFolders('srv1', ['/extra']);
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, []);
    // 服务器本体仍在列表里（只移除目录，不移除服务器）
    assert.ok(getServers().some((s) => s.name === 'srv1'));
  } finally {
    restore();
  }
});

test('server folders: removing an unknown path or unknown server is a no-op', async () => {
  const restore = patchConfig();
  try {
    servers = [makeServer('srv1', ['/data'])];
    await removeServerFolders('srv1', ['/not-pinned']);
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, ['/data']);

    await removeServerFolders('ghost', ['/data']);
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, ['/data']);
  } finally {
    restore();
  }
});

test('server folders: removal matches despite trailing-slash differences (normPath)', async () => {
  const restore = patchConfig();
  try {
    // 配置里存的可能是带尾部斜杠的原始输入，树里展示的是归一后的路径
    servers = [makeServer('srv1', ['/data/', '/etc/'])];
    await removeServerFolders('srv1', ['/data']); // 树节点上的归一化路径
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, ['/etc/']);
    await removeServerFolders('srv1', ['/etc']);
    assert.deepEqual(getServers().find((s) => s.name === 'srv1').folders, []);
  } finally {
    restore();
  }
});
