const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSshAuthority,
  parseServerList,
  mergeServersByName,
  planRegistration,
  hostMatches,
  findCurrentServer,
} = require('../../out/serverRegistration');

test('parseSshAuthority: user@host:port / host / alias', () => {
  assert.deepEqual(parseSshAuthority('alice@10.0.0.1:2222'), { user: 'alice', host: '10.0.0.1', port: 2222 });
  assert.deepEqual(parseSshAuthority('10.0.0.1'), { user: undefined, host: '10.0.0.1', port: undefined });
  assert.deepEqual(parseSshAuthority('my-alias'), { user: undefined, host: 'my-alias', port: undefined });
  assert.deepEqual(parseSshAuthority('bob@my-alias'), { user: 'bob', host: 'my-alias', port: undefined });
});

test('parseServerList: keeps valid entries, parses folders/forwards, drops junk', () => {
  const servers = parseServerList([
    { name: 'a', host: '1.1.1.1', folders: ['/x'], forwards: [{ localPort: 8080, remotePort: 80 }, { bad: true }] },
    { name: 'b' },
    'junk',
    { name: 1, host: 'x' },
  ]);
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0].folders, ['/x']);
  assert.deepEqual(servers[0].forwards, [{ localPort: 8080, remotePort: 80, remoteHost: undefined }]);
  assert.deepEqual(parseServerList('nope'), []);
});

test('mergeServersByName: union, local wins on name clash', () => {
  const local = [{ name: 'a', host: 'local-a' }];
  const remote = [
    { name: 'a', host: 'remote-a' },
    { name: 'b', host: 'remote-b' },
  ];
  const merged = mergeServersByName(local, remote);
  assert.deepEqual(
    merged.map((s) => [s.name, s.host]),
    [
      ['a', 'local-a'],
      ['b', 'remote-b'],
    ],
  );
});

test('hostMatches / findCurrentServer: alias and decorations', () => {
  const servers = [
    { name: 'A', host: '10.0.0.1', user: 'alice' },
    { name: 'my-alias', host: '10.0.0.2' },
  ];
  assert.ok(hostMatches('alice@10.0.0.1:22', servers[0]));
  assert.equal(findCurrentServer(servers, 'alice@10.0.0.1')?.name, 'A');
  // authority 是 ssh 别名、配置 host 是 IP：按 name 兜底匹配
  assert.equal(findCurrentServer(servers, 'my-alias')?.name, 'my-alias');
  assert.equal(findCurrentServer(servers, 'unknown'), undefined);
});

test('planRegistration: skips local window and empty authority', () => {
  assert.deepEqual(planRegistration({ isLocal: true, wsPaths: [], servers: [] }), { action: 'skip', reason: 'local window' });
  const plan = planRegistration({ isLocal: false, sshHost: undefined, wsPaths: [], servers: [] });
  assert.equal(plan.action, 'skip');
});

test('planRegistration: registers new server parsed from authority', () => {
  const plan = planRegistration({ isLocal: false, sshHost: 'alice@10.0.0.9:2222', wsPaths: ['/proj'], servers: [] });
  assert.equal(plan.action, 'register');
  assert.deepEqual(plan.server, { name: '10.0.0.9', host: '10.0.0.9', user: 'alice', port: 2222, folders: ['/proj'] });
});

test('planRegistration: same-named entry counts as current (alias case), not re-registered', () => {
  const servers = [{ name: '10.0.0.9', host: 'other-host', folders: ['/x'] }];
  const plan = planRegistration({ isLocal: false, sshHost: '10.0.0.9', wsPaths: ['/x'], servers });
  assert.equal(plan.action, 'none');
});

test('planRegistration: syncs folders only when changed; empty workspace never wipes', () => {
  const servers = [{ name: 'A', host: '10.0.0.1', folders: ['/a', '/b'] }];
  const same = planRegistration({ isLocal: false, sshHost: '10.0.0.1', wsPaths: ['/b', '/a'], servers });
  assert.equal(same.action, 'none');
  const diff = planRegistration({ isLocal: false, sshHost: '10.0.0.1', wsPaths: ['/a', '/c'], servers });
  assert.equal(diff.action, 'sync-folders');
  assert.deepEqual(diff.folders, ['/a', '/c']);
  const empty = planRegistration({ isLocal: false, sshHost: '10.0.0.1', wsPaths: [], servers });
  assert.equal(empty.action, 'none');
});
