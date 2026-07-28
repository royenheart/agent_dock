const test = require('node:test');
const assert = require('node:assert/strict');
const { parseListeners } = require('../../out/ssh/listeners');

test('parseListeners: ss -tlnpH with process info', () => {
  const out = [
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1234,fd=3))',
    'LISTEN 0 511 127.0.0.1:3306 0.0.0.0:* users:(("mysqld",pid=2345,fd=21))',
    'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=345,fd=13))',
  ].join('\n');
  const map = parseListeners(out);
  assert.deepEqual(map.get(22), { name: 'sshd', pid: 1234 });
  assert.deepEqual(map.get(3306), { name: 'mysqld', pid: 2345 });
  assert.deepEqual(map.get(53), { name: 'systemd-resolve', pid: 345 });
});

test('parseListeners: ss without permission shows port but no process name', () => {
  const out = 'LISTEN 0 128 0.0.0.0:6379 0.0.0.0:*\nLISTEN 0 511 [::]:8080 [::]:*';
  const map = parseListeners(out);
  assert.deepEqual(map.get(6379), { name: '', pid: undefined });
  assert.deepEqual(map.get(8080), { name: '', pid: undefined });
});

test('parseListeners: netstat -tlnp format', () => {
  const out = [
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1234/sshd',
    'tcp        0      0 127.0.0.1:5432          0.0.0.0:*               LISTEN      999/postgres',
  ].join('\n');
  const map = parseListeners(out);
  assert.deepEqual(map.get(22), { name: 'sshd', pid: 1234 });
  assert.deepEqual(map.get(5432), { name: 'postgres', pid: 999 });
});

test('parseListeners: ignores non-listen lines and dupes keep first', () => {
  const out = [
    'tcp 0 0 10.0.0.1:22 10.0.0.2:5555 ESTABLISHED',
    'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))',
    'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("other",pid=2,fd=6))',
    '',
  ].join('\n');
  const map = parseListeners(out);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(80), { name: 'nginx', pid: 1 });
});
