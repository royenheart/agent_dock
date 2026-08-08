/* Standalone: persistent SSH session + SFTP against a LOCAL sshd sandbox.
 * Requires a running local sshd (test/e2e/sshd-local.sh start) and env:
 *   AGENTDOCK_E2E_HOST / AGENTDOCK_E2E_PORT / AGENTDOCK_E2E_USER
 *   AGENTDOCK_E2E_KEY / AGENTDOCK_E2E_HOME (with .ssh/known_hosts)
 * Validates: ONE persistent connection for exec + SFTP, binary roundtrip,
 * timeout, concurrency, dispose.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
// out/ssh/sshSession -> out/log -> require('vscode'): resolve to the minimal stub (same as unit tests)
const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(__dirname, 'unit', 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};
const { SshSession } = require('../out/ssh/sshSession');

const HOST = process.env.AGENTDOCK_E2E_HOST || '127.0.0.1';
const PORT = Number(process.env.AGENTDOCK_E2E_PORT || 2222);
const USER = process.env.AGENTDOCK_E2E_USER || 'e2e';
const KEY = process.env.AGENTDOCK_E2E_KEY || '';
const HOME = process.env.AGENTDOCK_E2E_HOME || '';

if (!KEY || !HOME) {
  console.error('AGENTDOCK_E2E_KEY and AGENTDOCK_E2E_HOME required (see test/e2e/sshd-local.sh)');
  process.exit(2);
}

const server = { name: 'e2e-sshd', host: HOST, user: USER, port: PORT, folders: [] };
const opts = {
  // 'yes' 严格校验：known_hosts 里是 [127.0.0.1]:2222 形式（sshd-local.sh 保留真实格式），
  // 回归「非默认端口主机密钥校验 Host denied」缺陷
  hostKeyMode: 'yes',
  knownHostsFiles: [path.join(HOME, '.ssh', 'known_hosts')],
  identityFiles: [KEY],
};

/** 到本地沙箱 sshd（:PORT）的已建立 TCP 连接数。
 * 一条持久连接 = 一个 TCP 连接；exec 通道/SFTP 子系统都复用它，不新增连接。 */
function sshdConnections() {
  try {
    const out = execFileSync('ss', ['-tnH', 'state', 'established', `( sport = :${PORT} )`], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim()).length;
  } catch {
    return -1; // ss 不可用时跳过计数断言
  }
}

const sftpCall = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));

(async () => {
  const D = '/tmp/agentdock-sftp-e2e';
  const sess = new SshSession(server, opts);

  // 1. exec over the persistent connection
  const r1 = await sess.exec('echo persistent-ok; printf "err-line" >&2; exit 0', 15_000);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.stdout.trim(), 'persistent-ok');
  assert.ok(r1.stderr.includes('err-line'));
  const connCount = sshdConnections();
  if (connCount >= 0) assert.equal(connCount, 1, 'exactly one persistent connection after exec');

  // 2. SFTP: mkdir / write / stat / read / readdir (same connection)
  const sftp = await sess.sftp();
  await sftpCall((cb) => sftp.mkdir(D, cb));
  await sftpCall((cb) => sftp.writeFile(`${D}/f.txt`, Buffer.from('hello sftp'), cb));
  const st = await sftpCall((cb) => sftp.stat(`${D}/f.txt`, cb));
  assert.equal(st.size, 10, 'size matches');
  const buf = await sftpCall((cb) => sftp.readFile(`${D}/f.txt`, cb));
  assert.equal(buf.toString('utf8'), 'hello sftp');
  const entries = await new Promise((resolve, reject) => {
    sftp.opendir(D, (e, h) => {
      if (e) {
        return reject(e);
      }
      sftp.readdir(h, (e2, list) => {
        sftp.close(h, () => {});
        e2 ? reject(e2) : resolve(list);
      });
    });
  });
  assert.ok(entries.some((x) => x.filename === 'f.txt'));
  const connCount2 = sshdConnections();
  if (connCount2 >= 0) assert.equal(connCount2, 1, 'still one connection after SFTP ops');

  // 3. binary roundtrip (NUL bytes must survive SFTP)
  const blob = Buffer.from([0, 1, 2, 255, 254, 0, 65, 66, 67]);
  await sftpCall((cb) => sftp.writeFile(`${D}/bin.dat`, blob, cb));
  const back = await sftpCall((cb) => sftp.readFile(`${D}/bin.dat`, cb));
  assert.ok(back.equals(blob), 'binary roundtrip');

  // 4. rename
  await sftpCall((cb) => sftp.rename(`${D}/f.txt`, `${D}/g.txt`, cb));
  const gone = await new Promise((resolve) => sftp.stat(`${D}/f.txt`, (e) => resolve(e ? true : false)));
  assert.ok(gone, 'old name gone after rename');
  const moved = await sftpCall((cb) => sftp.stat(`${D}/g.txt`, cb));
  assert.equal(moved.size, 10);

  // 5. timeout: 30s command killed by 2s channel timeout
  const t0 = Date.now();
  const rt = await sess.exec('sleep 30', 2_000);
  assert.equal(rt.timedOut, true);
  assert.ok(Date.now() - t0 < 15_000, `timeout cut the command (${Date.now() - t0}ms)`);

  // 6. concurrency: 6 parallel exec channels on the SAME connection
  const results = await Promise.all([...Array(6)].map((_, i) => sess.exec(`echo run-${i}`, 10_000)));
  results.forEach((r, i) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), `run-${i}`);
  });
  const connCount3 = sshdConnections();
  if (connCount3 >= 0) assert.equal(connCount3, 1, 'one connection under concurrency');

  // 7. cleanup
  await sftpCall((cb) => sftp.unlink(`${D}/g.txt`, cb));
  await sftpCall((cb) => sftp.unlink(`${D}/bin.dat`, cb));
  await sftpCall((cb) => sftp.rmdir(D, cb));

  sess.dispose();
  console.log('SSH SESSION E2E OK: one persistent connection carries exec + SFTP');
  process.exit(0);
})().catch((e) => {
  console.error('SSH SESSION E2E FAILED:', e.message);
  process.exit(1);
});
