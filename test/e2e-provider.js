/* Integration: the real RemoteFsProvider (watch → poll → diff → onDidChangeFile)
 * against a local/container SSH server. The ssh PATH wrapper injects -F /dev/null
 * + optional key because this sandbox's /etc/ssh/ssh_config.d may have broken
 * ownership, and the vscode API is stubbed because plain node has no vscode module.
 * Run: node test/e2e-provider.js
 *
 * Target server comes from the environment — NEVER hardcode a personal server here.
 *   AGENTDOCK_E2E_HOST  (default 127.0.0.1)
 *   AGENTDOCK_E2E_PORT  (default 2222)
 *   AGENTDOCK_E2E_USER  (default e2e)
 *   AGENTDOCK_E2E_KEY   private key path (optional; default ssh-agent / default keys)
 *
 * Container example (any sshd image works):
 *   docker run -d --rm --name agentdock-e2e-sshd -p 2222:22 \
 *     -e PASSWORD_ACCESS=false \
 *     -e USER_NAME=e2e \
 *     -v "$HOME/.ssh/id_ed25519.pub:/config/.ssh/e2e.pub:ro" \
 *     lscr.io/linuxserver/openssh-server
 *   AGENTDOCK_E2E_HOST=127.0.0.1 AGENTDOCK_E2E_PORT=2222 \
 *   AGENTDOCK_E2E_USER=e2e AGENTDOCK_E2E_KEY="$HOME/.ssh/id_ed25519" \
 *   node test/e2e-provider.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// --- e2e target (env-driven, local/container sandbox only) ---
const E2E_HOST = process.env.AGENTDOCK_E2E_HOST || '127.0.0.1';
const E2E_PORT = Number(process.env.AGENTDOCK_E2E_PORT || 2222);
const E2E_USER = process.env.AGENTDOCK_E2E_USER || 'e2e';
const E2E_KEY = process.env.AGENTDOCK_E2E_KEY || '';

// --- vscode stub (module resolver rewrites 'vscode' to this) ---
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-stub-'));
const stubFile = path.join(stubDir, 'vscode.js');
fs.writeFileSync(
  stubFile,
  `const noop = () => ({ dispose() {} });
const SERVERS = [{ name: 'e2e-sshd', host: ${JSON.stringify(E2E_HOST)}, user: ${JSON.stringify(E2E_USER)}, port: ${E2E_PORT}, folders: [] }];
class EventEmitter {
  constructor() { this.fns = new Set(); this.event = (fn) => { this.fns.add(fn); return { dispose: () => this.fns.delete(fn) }; }; }
  fire(evts) { for (const fn of [...this.fns]) fn(evts); }
}
module.exports = {
  workspace: {
    getConfiguration: () => ({ get: (key, dflt) => (key === 'servers' ? SERVERS : key === 'remoteWatchIntervalSeconds' ? 1 : key === 'sshConnectionPersist' ? '0' : dflt), update: async () => {} }),
    onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop,
    createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose() {} }),
    fs: {}, textDocuments: [],
  },
  env: { language: 'en', remoteName: undefined, machineId: 'e2e' },
  window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }), showErrorMessage() {}, showWarningMessage() {}, showInformationMessage() {}, setStatusBarMessage: () => ({ dispose() {} }) },
  Uri: { from: (o) => ({ scheme: o.scheme, authority: o.authority, path: o.path, fsPath: o.path, toString: () => o.scheme + '://' + o.authority + o.path }) },
  EventEmitter,
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  ThemeIcon: { Folder: 'folder', File: 'file' },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Created: 1, Changed: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  FileSystemError: class extends Error { static FileNotFound = (u) => new Error('nf ' + u); static Unavailable = (m) => new Error(m); static NoPermissions = () => new Error('noperm'); },
  commands: { executeCommand: async () => {} },
  l10n: { t: (s) => s },
  ConfigurationTarget: { Global: 1 },
};
`,
);

// --- resolve bare 'vscode' to the stub (must be installed before requiring out/) ---
const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return stubFile;
  return origResolve.call(this, request, ...args);
};

// --- ssh wrapper: bypass broken system ssh config in this sandbox ---
const fakebin = '/tmp/fakebin';
fs.mkdirSync(fakebin, { recursive: true });
const keyArg = E2E_KEY ? ` -i ${JSON.stringify(E2E_KEY)}` : '';
fs.writeFileSync(
  path.join(fakebin, 'ssh'),
  `#!/bin/sh\nexec /usr/bin/ssh -F /dev/null${keyArg} "$@"\n`,
  { mode: 0o755 },
);
process.env.PATH = `${fakebin}:${process.env.PATH}`;

const { RemoteFsProvider, remoteUri } = require('../out/ssh/remoteFsProvider');
const { execRemote } = require('../out/ssh/remoteExec');

const server = { name: 'e2e-sshd', host: E2E_HOST, user: E2E_USER, port: E2E_PORT, folders: [] };
const F = '/tmp/agentdock-provider/f.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // preflight: the test needs a reachable local/container sshd
  const probe = await execRemote(server, 'true', 8_000, { quiet: true });
  if (probe.code !== 0) {
    console.error(
      `Cannot reach e2e sshd at ${E2E_USER}@${E2E_HOST}:${E2E_PORT} — start a local/container sshd and set ` +
        'AGENTDOCK_E2E_HOST/PORT/USER/KEY (see header comment for a docker example).',
    );
    process.exit(2);
  }

  const provider = new RemoteFsProvider();
  const events = [];
  const sub = provider.onDidChangeFile((evts) => events.push(...evts));
  const uri = remoteUri(server.name, F);

  await execRemote(server, `rm -rf /tmp/agentdock-provider && mkdir -p /tmp/agentdock-provider && printf 'v1' > ${F}`);
  const watch = provider.watch(uri, { recursive: false });

  // baseline: wait 2.5 intervals, expect no events
  await sleep(2600);
  console.log('baseline events (expect 0):', events.length);
  if (events.length !== 0) throw new Error('baseline fired events');

  // append → expect Changed within ~3s
  await execRemote(server, `printf 'v2' >> ${F}`);
  await sleep(3000);
  console.log('events after append:', events.map((e) => `${e.type}:${e.uri.path}`));
  if (!events.some((e) => e.type === 2 && e.uri.path === F)) {
    // vscode.FileChangeType.Changed === 2
    throw new Error('append change event NOT fired');
  }

  // delete → expect Changed again
  events.length = 0;
  await execRemote(server, `rm ${F}`);
  await sleep(3000);
  console.log('events after delete:', events.map((e) => `${e.type}:${e.uri.path}`));
  if (!events.some((e) => e.type === 2 && e.uri.path === F)) {
    throw new Error('delete change event NOT fired');
  }

  // two watchers (batched into one poll) both fire on their own changes
  const F2 = '/tmp/agentdock-provider/g.txt';
  await execRemote(server, `printf 'g1' > ${F2}`);
  const uri2 = remoteUri(server.name, F2);
  const watch2 = provider.watch(uri2, { recursive: false });
  await sleep(2600); // baseline for both
  events.length = 0;
  await execRemote(server, `printf 'g2' >> ${F2} && printf 'x' >> ${F}`);
  await sleep(3000);
  console.log('two-watcher events:', events.map((e) => `${e.type}:${e.uri.path}`));
  if (!events.some((e) => e.type === 2 && e.uri.path === F2)) {
    throw new Error('second watcher change event NOT fired');
  }
  if (!events.some((e) => e.type === 2 && e.uri.path === F)) {
    throw new Error('first watcher change event NOT fired (batched poll)');
  }

  // readFile: small file reads; oversized file rejected with Unavailable (TOOBIG path)
  await execRemote(server, `printf 'hello remote' > ${F}`);
  const content = await provider.readFile(remoteUri(server.name, F));
  console.log('readFile small:', Buffer.from(content).toString('utf8'));
  if (Buffer.from(content).toString('utf8') !== 'hello remote') throw new Error('readFile content mismatch');
  await execRemote(server, `head -c 9437184 /dev/zero | tr '\\0' x > ${F2}`); // 9 MiB > 8 MiB cap
  let rejected = false;
  try {
    await provider.readFile(remoteUri(server.name, F2));
  } catch (err) {
    rejected = String(err).includes('preview cap');
    console.log('readFile oversized rejected:', String(err));
  }
  if (!rejected) throw new Error('oversized readFile must be rejected via TOOBIG marker');

  watch.dispose();
  watch2.dispose();
  provider.disposeAll();
  sub.dispose();
  await execRemote(server, 'rm -rf /tmp/agentdock-provider');
  console.log('PROVIDER INTEGRATION OK');
  process.exit(0);
})().catch((e) => {
  console.error('PROVIDER INTEGRATION FAILED:', e.message);
  process.exit(1);
});
