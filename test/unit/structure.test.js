const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnder, normPath, pathBasename, uriFsPath } = require('../../out/paths');
const { partitionSessions, groupByCwd } = require('../../out/tree/structure');

function sess(id, cwd, updated = 1000) {
  return { agent: 'opencode', id, title: id, cwd, timeCreated: 0, timeUpdated: updated };
}

test('isUnder: exact / child / non-child', () => {
  assert.ok(isUnder('/a/b', '/a/b'));
  assert.ok(isUnder('/a/b/c', '/a/b'));
  assert.ok(!isUnder('/a/bc', '/a/b'));
  assert.ok(!isUnder('/a', '/a/b'));
});

test('isUnder: trailing slash and root', () => {
  assert.ok(isUnder('/a/b', '/a/'));
  assert.ok(isUnder('/x', '/'));
  assert.ok(!isUnder('relative', '/'));
});

test('normPath / pathBasename', () => {
  assert.equal(normPath('/a/'), '/a');
  assert.equal(normPath('/'), '/');
  assert.equal(pathBasename('/a/b/'), 'b');
  assert.equal(pathBasename('/'), '/');
});

test('partitionSessions: deepest workspace folder wins', () => {
  const sessions = [sess('s1', '/ws/app/src'), sess('s2', '/ws'), sess('s3', '/elsewhere')];
  const { byFolder, others } = partitionSessions(sessions, ['/ws', '/ws/app']);
  assert.deepEqual(byFolder.get('/ws/app').map((s) => s.id), ['s1']);
  assert.deepEqual(byFolder.get('/ws').map((s) => s.id), ['s2']);
  assert.deepEqual(others.map((s) => s.id), ['s3']);
});

test('partitionSessions: trailing slash / empty workspace', () => {
  const sessions = [sess('s1', '/ws/a')];
  const { byFolder, others } = partitionSessions(sessions, ['/ws/']);
  assert.equal(byFolder.get('/ws/').length, 1);
  assert.equal(others.length, 0);
  const empty = partitionSessions(sessions, []);
  assert.equal(empty.others.length, 1);
});

test('groupByCwd: groups and sorts by latest update', () => {
  const groups = groupByCwd([sess('a', '/x', 10), sess('b', '/y', 99), sess('c', '/x', 50)]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].folderPath, '/y');
  assert.equal(groups[1].folderPath, '/x');
  assert.equal(groups[1].sessions.length, 2);
});

test('uriFsPath: vscode-remote uses posix path (Windows backslash regression guard)', () => {
  // Windows 客户端上 vscode-remote URI 的 fsPath 是 \home\x 反斜杠形式
  assert.equal(uriFsPath({ scheme: 'vscode-remote', path: '/home/u/proj', fsPath: '\\home\\u\\proj' }), '/home/u/proj');
  assert.equal(uriFsPath({ scheme: 'file', path: '/c/Users/u', fsPath: 'c:\\Users\\u' }), 'c:\\Users\\u');
  assert.equal(uriFsPath({ scheme: 'file', path: '/home/u', fsPath: '/home/u' }), '/home/u');
});
