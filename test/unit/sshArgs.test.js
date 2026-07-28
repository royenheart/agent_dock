const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSshBaseArgs, buildRealpathScript, buildListDirsScript, shq } = require('../../out/ssh/sshArgs');

test('buildSshBaseArgs: win32 omits ControlMaster (getsockname regression guard)', () => {
  const args = buildSshBaseArgs('8h', 'win32');
  assert.ok(!args.some((a) => a.startsWith('ControlMaster') || a.startsWith('ControlPath') || a.startsWith('ControlPersist')));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('-T'));
});

test('buildSshBaseArgs: linux enables ControlMaster unless persist=0', () => {
  const args = buildSshBaseArgs('8h', 'linux');
  const joined = args.join(' ');
  assert.ok(joined.includes('ControlMaster=auto'));
  assert.ok(joined.includes('ControlPersist=8h'));
  const off = buildSshBaseArgs('0', 'linux');
  assert.ok(!off.join(' ').includes('ControlMaster'));
});

test('buildRealpathScript: one line per path, failure echoes original', () => {
  const script = buildRealpathScript(['/a b', "/q'x"]);
  const lines = script.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("realpath '/a b'"));
  assert.ok(lines[0].includes("|| printf '%s\\n' '/a b'"));
  assert.ok(lines[1].includes(`realpath '/q'\\''x'`));
});

test('buildListDirsScript: -d guard and noent marker present', () => {
  const script = buildListDirsScript('/data/x', '__M__');
  assert.ok(script.startsWith("if [ -d '/data/x' ];"));
  assert.ok(script.includes('else echo __M__'));
  assert.ok(script.includes("ls -1Ap '/data/x'"));
});

test('shq: single quotes escaped', () => {
  assert.equal(shq(`a'b`), `'a'\\''b'`);
  assert.equal(shq('plain'), `'plain'`);
});
