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

// copyUriRecursive：全走 workspace.fs 的递归复制（下载/上传共用的纯数据路径）。
test('copyUriRecursive: file + nested dir copy via workspace.fs', async () => {
  const stub = require('./vscode-stub.js');
  const mem = new Map(); // path → { dir: true } | { data: Uint8Array }
  const norm = (u) => u.path;
  mem.set('/src', { dir: true });
  mem.set('/src/a.txt', { data: new TextEncoder().encode('hello') });
  mem.set('/src/sub', { dir: true });
  mem.set('/src/sub/b.txt', { data: new TextEncoder().encode('world') });
  const FileType = { File: 1, Directory: 2 };
  stub.workspace.fs = {
    stat: async (u) => {
      const e = mem.get(norm(u));
      if (!e) throw new Error('not found: ' + norm(u));
      return { type: e.dir ? FileType.Directory : FileType.File };
    },
    readDirectory: async (u) => {
      const prefix = norm(u) + '/';
      const out = [];
      for (const [p, e] of mem) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
          out.push([p.slice(prefix.length), e.dir ? FileType.Directory : FileType.File]);
        }
      }
      return out;
    },
    createDirectory: async (u) => {
      const p = norm(u);
      if (mem.has(p)) throw new Error('exists');
      mem.set(p, { dir: true });
    },
    readFile: async (u) => {
      const e = mem.get(norm(u));
      if (!e || e.dir) throw new Error('not a file');
      return e.data;
    },
    writeFile: async (u, content) => {
      mem.set(norm(u), { data: content });
    },
  };
  delete require.cache[require.resolve('../../out/tree/moveOps')];
  const { copyUriRecursive } = require('../../out/tree/moveOps');
  const uri = (p) => ({ scheme: 'file', path: p });
  await copyUriRecursive(uri('/src'), uri('/dst'));
  assert.equal(new TextDecoder().decode(mem.get('/dst/a.txt').data), 'hello');
  assert.equal(new TextDecoder().decode(mem.get('/dst/sub/b.txt').data), 'world');
  assert.ok(mem.get('/dst').dir && mem.get('/dst/sub').dir, 'dirs created');
});

// pumpStreams：流式泵必须真正搬运数据（0.2.4/0.2.5 漏 rs.pipe(ws) 导致下载/上传只建空文件）
test('pumpStreams: pipes bytes end-to-end and reports byte progress', async () => {
  const { Readable, Writable } = require('node:stream');
  delete require.cache[require.resolve('../../out/tree/moveOps')];
  const { pumpStreams } = require('../../out/tree/moveOps');
  const rs = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
  let received = Buffer.alloc(0);
  const ws = new Writable({ write(chunk, _enc, cb) { received = Buffer.concat([received, chunk]); cb(); } });
  const reports = [];
  await pumpStreams(rs, ws, { size: 11, progress: { report: (r) => reports.push(r) } });
  assert.equal(received.toString(), 'hello world');
  const total = reports.reduce((a, r) => a + (r.increment || 0), 0);
  assert.ok(total > 99 && total <= 100.0001, `progress sums to ~100 (got ${total})`);
});

test('pumpStreams: source error rejects', async () => {
  const { Readable, Writable } = require('node:stream');
  const { pumpStreams } = require('../../out/tree/moveOps');
  const rs = new Readable({ read() { this.destroy(new Error('boom')); } });
  const ws = new Writable({ write(_c, _e, cb) { cb(); } });
  await assert.rejects(() => pumpStreams(rs, ws), /boom/);
});

test('pumpStreams: cancellation rejects and runs cleanup', async () => {
  const { Readable, Writable } = require('node:stream');
  const { pumpStreams } = require('../../out/tree/moveOps');
  let cancelCb;
  const token = { onCancellationRequested: (cb) => { cancelCb = cb; } };
  let cleaned = false;
  // 永不产出数据的源：只有取消能结束这次传输
  const rs = new Readable({ read() {} });
  const ws = new Writable({ write(_c, _e, cb) { cb(); } });
  const p = pumpStreams(rs, ws, { token, cleanup: () => { cleaned = true; } });
  cancelCb();
  await assert.rejects(p);
  assert.ok(cleaned, 'cleanup ran on cancel');
});
