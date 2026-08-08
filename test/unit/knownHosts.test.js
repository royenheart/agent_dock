const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseKnownHosts,
  checkHostKey,
  buildHostKeyVerifier,
} = require('../../out/ssh/knownHosts');

function fakeKey(tag) {
  return Buffer.from(`fake-key-blob-${tag}`);
}

/** 按 OpenSSH 语义构造哈希条目：HMAC-SHA1(key=salt, msg=hostname)。 */
function hashHost(host, salt) {
  return crypto.createHmac('sha1', salt).update(host, 'utf8').digest();
}

test('parseKnownHosts: plain, hashed, comments, @markers, malformed', () => {
  const key = fakeKey('k1').toString('base64');
  const salt = Buffer.from('salt123');
  const h = hashHost('host-a', salt).toString('base64');
  const content = [
    '# comment line',
    '',
    `host-a ssh-ed25519 ${key}`,
    `|1|${salt.toString('base64')}|${h} ssh-ed25519 ${key}`,
    '@cert-authority example.com ssh-ed25519 AAAA',
    '@revoked oldhost ssh-ed25519 AAAA',
    'short-line',
    '   spaced.example ssh-rsa BBBB   # trailing comment',
  ].join('\n');
  const entries = parseKnownHosts(content);
  assert.equal(entries.length, 3, 'only plain + hashed + spaced parsed');
  assert.equal(entries[0].hosts, 'host-a');
  assert.equal(entries[0].hashed, false);
  assert.equal(entries[1].hashed, true);
  assert.equal(entries[1].salt.toString('utf8'), 'salt123');
  assert.equal(entries[2].hosts, 'spaced.example');
});

test('checkHostKey: plain match and mismatch', () => {
  const key = fakeKey('k1');
  const entries = parseKnownHosts(`host-a ssh-ed25519 ${key.toString('base64')}\n`);
  assert.equal(checkHostKey(entries, ['host-a'], key), true);
  assert.equal(checkHostKey(entries, ['host-b'], key), false);
  assert.equal(checkHostKey(entries, ['host-a'], fakeKey('other')), false);
});

test('checkHostKey: hashed entry matches only with the right host+key', () => {
  const key = fakeKey('k2');
  const salt = Buffer.from('salty');
  const h = hashHost('hash-host', salt);
  const entries = parseKnownHosts(`|1|${salt.toString('base64')}|${h.toString('base64')} ssh-ed25519 ${key.toString('base64')}\n`);
  assert.equal(checkHostKey(entries, ['hash-host'], key), true);
  assert.equal(checkHostKey(entries, ['other-host'], key), false, 'wrong host must not match hash');
  assert.equal(checkHostKey(entries, ['hash-host'], fakeKey('x')), false, 'wrong key must not match');
});

test('checkHostKey: non-default-port hosts match the [host]:port known_hosts form', () => {
  // OpenSSH 对非 22 端口的服务器在 known_hosts 里记录为 [host]:port（CLI 写盘形式），
  // 校验时必须把 `[host]:port` 作为匹配候选，否则持久连接永远 Host denied
  const key = fakeKey('portform');
  const entries = parseKnownHosts(`[my-host]:40608 ssh-ed25519 ${key.toString('base64')}\n`);
  assert.equal(checkHostKey(entries, ['[my-host]:40608'], key), true, 'bracketed candidate must match');
  assert.equal(checkHostKey(entries, ['my-host'], key), false, 'bare hostname must NOT match the bracketed entry');
  // 哈希条目：OpenSSH 以 `[host]:port` 作为 hash 输入
  const salt = Buffer.from('salt2');
  const h = hashHost('[hash-host]:40620', salt);
  const entries2 = parseKnownHosts(`|1|${salt.toString('base64')}|${h.toString('base64')} ssh-ed25519 ${key.toString('base64')}\n`);
  assert.equal(checkHostKey(entries2, ['[hash-host]:40620'], key), true, 'hashed [host]:port candidate must match');
});

test('checkHostKey: wildcard patterns and comma lists', () => {
  const key = fakeKey('k3');
  const entries = parseKnownHosts(`*.example.com,10.0.0.? ssh-rsa ${key.toString('base64')}\n`);
  assert.equal(checkHostKey(entries, ['web.example.com'], key), true);
  assert.equal(checkHostKey(entries, ['10.0.0.5'], key), true);
  assert.equal(checkHostKey(entries, ['evil.com'], key), false);
});

test('checkHostKey: negated pattern rejects even if a positive entry matches', () => {
  const key = fakeKey('k4');
  const entries = parseKnownHosts(
    `*.corp ssh-rsa ${key.toString('base64')}\n!bad.corp ssh-rsa ${key.toString('base64')}\n`,
  );
  assert.equal(checkHostKey(entries, ['good.corp'], key), true);
  assert.equal(checkHostKey(entries, ['bad.corp'], key), false, 'negated match must reject');
});

test('buildHostKeyVerifier: mode=no accepts anything', () => {
  const v = buildHostKeyVerifier([], ['x'], 'no');
  assert.equal(v(fakeKey('anything')), true);
});

test('buildHostKeyVerifier: mode=yes consults known_hosts file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentws-kh-'));
  const kh = path.join(dir, 'known_hosts');
  const key = fakeKey('k5');
  fs.writeFileSync(kh, `my-host ssh-ed25519 ${key.toString('base64')}\n`);
  const v = buildHostKeyVerifier([kh], ['my-host'], 'yes');
  assert.equal(v(key), true);
  assert.equal(v(fakeKey('other')), false, 'unknown key must be rejected in yes mode');
  const v2 = buildHostKeyVerifier([kh], ['ghost'], 'yes');
  assert.equal(v2(key), false, 'unknown host must be rejected in yes mode');
});

test('buildHostKeyVerifier: mode=accept-new appends unknown host then accepts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentws-kh2-'));
  const kh = path.join(dir, 'known_hosts');
  fs.writeFileSync(kh, '');
  const key = fakeKey('new');
  const v = buildHostKeyVerifier([kh], ['fresh-host'], 'accept-new');
  assert.equal(v(key), true, 'accept-new accepts unknown');
  const saved = fs.readFileSync(kh, 'utf8');
  assert.ok(saved.includes('fresh-host'), 'host recorded: ' + saved);
  // 同一 key 再校验应命中已记录条目
  const v2 = buildHostKeyVerifier([kh], ['fresh-host'], 'yes');
  assert.equal(v2(key), true);
});
