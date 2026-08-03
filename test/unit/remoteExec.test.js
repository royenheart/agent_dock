const test = require('node:test');
const assert = require('node:assert/strict');
// out/ssh/remoteExec → out/config → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { Semaphore, execLocal } = require('../../out/ssh/remoteExec');

test('Semaphore: respects max concurrency', async () => {
  const sem = new Semaphore(2);
  const a1 = await sem.acquire();
  const a2 = await sem.acquire();
  assert.equal(a1, true);
  assert.equal(a2, true);
  sem.release();
  sem.release();
  const a3 = await sem.acquire();
  assert.equal(a3, true);
  sem.release();
});

test('Semaphore: queued acquire waits for release', async () => {
  const sem = new Semaphore(1);
  await sem.acquire();
  let granted = false;
  const pending = sem.acquire().then((v) => {
    granted = true;
    return v;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(granted, false, 'queued acquire must not grant before release');
  sem.release();
  assert.equal(await pending, true);
});

test('Semaphore: abort during queue removes the entry and returns false', async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // occupy the only slot
  const controller = new AbortController();
  const pending = sem.acquire(controller.signal);
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  assert.equal(await pending, false, 'aborted queued acquire resolves false');
  // the aborted entry must not block later acquisitions
  sem.release();
  const next = await sem.acquire();
  assert.equal(next, true, 'slot must be usable after the aborted entry was removed');
  sem.release();
});

test('Semaphore: already-aborted signal is rejected immediately without queuing', async () => {
  const sem = new Semaphore(1);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await sem.acquire(controller.signal), false);
  // and no slot was consumed
  const next = await sem.acquire();
  assert.equal(next, true);
  sem.release();
});

test('execLocal: enforces output byte cap by killing the child (truncated)', async () => {
  // bash can generate output much faster than the cap, exercising the kill path
  const res = await execLocal('head -c 1048576 /dev/zero | tr "\\0" x', 15_000, { maxOutputBytes: 4096 });
  assert.equal(res.truncated, true, 'output must be marked truncated');
  assert.notEqual(res.code, 0, 'killed child should not exit 0');
  assert.ok(res.stdout.length <= 4096 + 65536, 'buffered output stays bounded');
});

test('execLocal: normal small output is unaffected by the cap', async () => {
  const res = await execLocal('printf hello', 15_000, { maxOutputBytes: 4096 });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'hello');
  assert.equal(res.truncated, false);
});

test('execLocal: cancelled-before-spawn returns cancelled without spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  const res = await execLocal('echo never', 15_000, { signal: controller.signal });
  assert.equal(res.cancelled, true);
  assert.equal(res.stdout, '');
});
