const test = require('node:test');
const assert = require('node:assert/strict');
// out/ssh/portForward → out/config → require('vscode')：解析到最小 stub
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { forwardRetryDelayMs, forwardSpec } = require('../../out/ssh/portForward');

test('forwardSpec: local → remoteHost:remotePort', () => {
  assert.equal(forwardSpec({ localPort: 8080, remotePort: 80 }), '8080:localhost:80');
  assert.equal(forwardSpec({ localPort: 8080, remoteHost: 'db', remotePort: 5432 }), '8080:db:5432');
});

test('forwardRetryDelayMs: exponential backoff capped at 30s', () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 100].map(forwardRetryDelayMs);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
