const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { startForward, stopForward, isForwardActive, markForwardsShuttingDown } = require('../../out/ssh/portForward');

function makeFakeSsh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentws-fakessh-'));
  const log = path.join(dir, 'calls.log');
  const script = path.join(dir, 'ssh');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `echo "$$:$*" >> ${JSON.stringify(log)}`,
      'if [[ "$*" == *" bash -s"* ]]; then cat >/dev/null; exit 0; fi',
      'if [[ "$*" == *" -N "* ]]; then',
      '  trap "exit 0" TERM INT',
      '  while true; do sleep 1; done',
      'fi',
      'exit 0',
    ].join('\n'),
  );
  fs.chmodSync(script, 0o755);
  return { dir, log, script };
}

test('port forward process auto-restarts after unexpected exit and stops on demand', async () => {
  const fake = makeFakeSsh();
  const prevPath = process.env.PATH;
  process.env.PATH = `${fake.dir}:${prevPath}`;
  const server = { name: 'fake-server', host: '127.0.0.1', port: 1, folders: [], forwards: [{ localPort: 18080, remotePort: 80 }] };
  const forward = server.forwards[0];
  try {
    await startForward(server, forward);
    assert.equal(isForwardActive(server.name, forward), true, 'forward becomes active');
    let pids = fs.readFileSync(fake.log, 'utf8').trim().split('\n').map((l) => l.split(':')[0]);
    assert.ok(pids.some((pid) => !isNaN(Number(pid))), `fake ssh -N spawned: ${pids}`);

    // 杀掉正在运行的转发进程：应保持 active 状态并自动拉起新进程
    process.kill(Number(pids.at(-1)), 'SIGTERM');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(isForwardActive(server.name, forward), true, 'active state survives process exit');
    await new Promise((r) => setTimeout(r, 2000));
    pids = fs.readFileSync(fake.log, 'utf8').trim().split('\n').map((l) => l.split(':')[0]);
    assert.ok(pids.length >= 2, `restarted ssh -N process: ${pids}`);

    await stopForward(server, forward);
    assert.equal(isForwardActive(server.name, forward), false, 'stop removes active state');
  } finally {
    markForwardsShuttingDown();
    process.env.PATH = prevPath;
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});
