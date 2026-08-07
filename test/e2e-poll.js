/* End-to-end: poll script + parsing + diff against a local/container SSH server.
 * Mirrors execRemote's argv (ssh <base> dest bash -s) with -F /dev/null + optional
 * key, because this sandbox's /etc/ssh/ssh_config.d may have broken ownership.
 * Everything under test — buildPollScript / parsePollOutput / buildLimitedReadScript —
 * is the real production code.
 * Run: node test/e2e-poll.js
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
 *   node test/e2e-poll.js
 */
const { spawn } = require('node:child_process');
const {
  buildPollScript,
  parsePollOutput,
  diffFileSnapshot,
  diffDirSnapshot,
  buildLimitedReadScript,
  isTooBigResult,
} = require('../out/ssh/remoteFsPoll');

// --- e2e target (env-driven, local/container sandbox only) ---
const E2E_HOST = process.env.AGENTDOCK_E2E_HOST || '127.0.0.1';
const E2E_PORT = Number(process.env.AGENTDOCK_E2E_PORT || 2222);
const E2E_USER = process.env.AGENTDOCK_E2E_USER || 'e2e';
const E2E_KEY = process.env.AGENTDOCK_E2E_KEY || '';

const D = '/tmp/agentdock-e2e';
const F = `${D}/f.txt`;
const PIPE_FILE = `${D}/a|b.txt`; // 路径含 '|' 的合法文件名
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exec(script, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const keyArgs = E2E_KEY ? ['-i', E2E_KEY] : [];
    const args = [
      '-F', '/dev/null',
      ...keyArgs,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-T',
      '-p', String(E2E_PORT),
      `${E2E_USER}@${E2E_HOST}`, 'bash', '-s',
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.end(script);
  });
}

async function poll(paths) {
  const isDirPath = new Set([`${D}/dir`, `${D}/gone`, `${D}/tricky`]);
  const script = buildPollScript(paths.map((p) => ({ path: p, isDir: isDirPath.has(p) })));
  const res = await exec(script);
  if (res.code !== 0) throw new Error(`poll failed (${res.code}): ${res.stderr}`);
  return parsePollOutput(res.stdout);
}

(async () => {
  // preflight: the test needs a reachable local/container sshd
  const probe = await exec('true', 8_000);
  if (probe.code !== 0) {
    console.error(
      `Cannot reach e2e sshd at ${E2E_USER}@${E2E_HOST}:${E2E_PORT} — start a local/container sshd and set ` +
        'AGENTDOCK_E2E_HOST/PORT/USER/KEY (see header comment for a docker example).',
    );
    process.exit(2);
  }

  await exec(`rm -rf ${D} && mkdir -p ${D}/dir && printf 'v1' > ${F} && printf 'p1' > '${PIPE_FILE}'`);

  // 1. baseline: no events; '|' path parses to its full key
  let snap = await poll([F, `${D}/dir`, PIPE_FILE]);
  const f0 = snap.get(F);
  const p0 = snap.get(PIPE_FILE);
  const d0 = snap.get(`${D}/dir`);
  console.log('baseline file:', JSON.stringify(f0), 'pipe-file:', JSON.stringify(p0), 'dir:', JSON.stringify(d0));
  console.log('baseline diff (expect false):', diffFileSnapshot(undefined, f0));
  if (!f0 || f0.size !== 2 || !p0 || p0.size !== 2 || !Array.isArray(d0)) throw new Error('bad baseline');
  if (!snap.has(PIPE_FILE) || snap.has(`${D}/a`)) throw new Error("'|' path key pollution");

  // 2. append → size+mtime change → Changed
  await exec(`printf 'v2' >> ${F}`);
  await sleep(1100);
  snap = await poll([F]);
  const afterAppend = snap.get(F);
  console.log('after append:', JSON.stringify(afterAppend), 'diff (expect true):', diffFileSnapshot(f0, afterAppend));
  if (diffFileSnapshot(f0, afterAppend) !== true) throw new Error('append not detected');

  // 3. same-size rewrite, new mtime → Changed
  await exec(`printf 'v1v' > ${F}`);
  await sleep(1100);
  snap = await poll([F]);
  const afterRewrite = snap.get(F);
  console.log('same-size rewrite:', JSON.stringify(afterRewrite), 'diff (expect true):', diffFileSnapshot(f0, afterRewrite));
  if (diffFileSnapshot(f0, afterRewrite) !== true) throw new Error('same-size rewrite not detected');

  // 4. delete → null → Changed once, then silent
  await exec(`rm ${F}`);
  snap = await poll([F]);
  const afterDelete = snap.get(F) ?? null;
  console.log('after delete (expect null):', afterDelete, 'diff (expect true):', diffFileSnapshot(f0, afterDelete));
  if (afterDelete !== null || diffFileSnapshot(f0, afterDelete) !== true) throw new Error('delete not detected');
  snap = await poll([F]);
  console.log('still missing (expect false):', diffFileSnapshot(null, snap.get(F) ?? null));
  if (diffFileSnapshot(null, snap.get(F) ?? null) !== false) throw new Error('repeat delete event');

  // 5. dir: create entry → created list
  await exec(`touch ${D}/dir/new.txt`);
  snap = await poll([`${D}/dir`]);
  const d1 = snap.get(`${D}/dir`);
  console.log('dir after create:', JSON.stringify(d1));
  const diff = diffDirSnapshot(d0, d1);
  console.log('dir diff (expect created new.txt):', JSON.stringify(diff));
  if (!diff.changed || diff.created.indexOf('new.txt') < 0) throw new Error('dir create not detected');

  // 6. dir deleted → snapshot must be null (M| marker), not []
  await exec(`rm -rf ${D}/dir`);
  snap = await poll([`${D}/dir`]);
  const dGone = snap.get(`${D}/dir`) ?? null;
  console.log('dir after delete (expect null):', dGone);
  if (dGone !== null) throw new Error('deleted dir must parse to null, not []');
  const dirDiff = diffDirSnapshot(d1, dGone);
  console.log('dir delete diff (expect changed):', JSON.stringify(dirDiff));
  if (!dirDiff.changed) throw new Error('dir delete not detected');

  // 7. dir entries starting with S|/D|/E|/M| do not break blocks
  await exec(`mkdir -p ${D}/tricky && touch '${D}/tricky/S|x' '${D}/tricky/D|y' '${D}/tricky/E|z' '${D}/tricky/M|w'`);
  snap = await poll([`${D}/tricky`]);
  const tricky = snap.get(`${D}/tricky`);
  console.log('tricky dir:', JSON.stringify(tricky));
  const names = (tricky || []).map((e) => e.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['D|y', 'E|z', 'M|w', 'S|x'])) {
    throw new Error(`tricky entries broken: ${JSON.stringify(names)}`);
  }

  // 8. bounded read: small file reads fine; oversized file rejected via TOOBIG marker
  const small = await exec(buildLimitedReadScript(PIPE_FILE, 1024)); // still exists, content 'p1'
  console.log('limited read small:', small.code, JSON.stringify(small.stdout), 'tooBig:', isTooBigResult(small, 1024));
  if (small.code !== 0 || small.stdout !== 'p1' || isTooBigResult(small, 1024)) throw new Error('small read failed');
  await exec(`head -c 4096 /dev/zero | tr '\\0' x > ${D}/big.txt`);
  const big = await exec(buildLimitedReadScript(`${D}/big.txt`, 1024));
  console.log('limited read big: code', big.code, 'stdoutLen', big.stdout.length, 'tooBig:', isTooBigResult(big, 1024));
  if (!isTooBigResult(big, 1024) || big.stdout.length !== 0) throw new Error('oversized file must be rejected');

  await exec(`rm -rf ${D}`);
  console.log('E2E OK');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
