const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSshBaseArgs, buildRealpathScript, buildListDirsScript, buildInteractiveSshArgs, buildPtySshArgs, buildClientShellSpawn, shq } = require('../../out/ssh/sshArgs');

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

test('buildInteractiveSshArgs: -tt forces remote pty, stty injects size, default login shell', () => {
  const args = buildInteractiveSshArgs({ host: 'a', user: 'u', port: 2222 }, { rows: 40, cols: 120 });
  assert.deepEqual(args, ['-tt', '-p', '2222', 'u@a', 'stty rows 40 cols 120; exec "$SHELL" -l']);
});

test('buildInteractiveSshArgs: custom remote command follows stty, no port flag without port', () => {
  const args = buildInteractiveSshArgs({ host: 'a' }, { rows: 24, cols: 80 }, `cd '/x' && opencode --session 1`);
  assert.deepEqual(args, ['-tt', 'a', `stty rows 24 cols 80; cd '/x' && opencode --session 1`]);
});

test('buildClientShellSpawn: linux wraps shell in util-linux script with stty', () => {
  const spec = buildClientShellSpawn('linux', { rows: 30, cols: 100 });
  assert.equal(spec.file, 'script');
  assert.deepEqual(spec.args, ['-qec', 'stty rows 30 cols 100; exec "$SHELL" -l', '/dev/null']);
});

test('buildClientShellSpawn: darwin uses BSD script argv form', () => {
  const spec = buildClientShellSpawn('darwin', { rows: 30, cols: 100 });
  assert.equal(spec.file, 'script');
  assert.deepEqual(spec.args, ['-q', '/dev/null', 'sh', '-c', 'stty rows 30 cols 100; exec "$SHELL" -l']);
});

test('buildClientShellSpawn: win32 spawns PowerShell with dumb mode (no pty, CRLF lines)', () => {
  const spec = buildClientShellSpawn('win32', { rows: 30, cols: 100 });
  assert.equal(spec.file, 'powershell.exe');
  assert.deepEqual(spec.args, ['-NoLogo']);
  assert.deepEqual(spec.dumb, { enter: '\r\n' });
});

test('buildClientShellSpawn: posix pty specs carry no dumb mode', () => {
  assert.equal(buildClientShellSpawn('linux', { rows: 30, cols: 100 }).dumb, undefined);
  assert.equal(buildClientShellSpawn('darwin', { rows: 30, cols: 100 }).dumb, undefined);
});

test('buildPtySshArgs: plain login shell without remote command, -t only with command', () => {
  assert.deepEqual(buildPtySshArgs({ host: 'a', user: 'u', port: 2222 }), ['-p', '2222', 'u@a']);
  assert.deepEqual(buildPtySshArgs({ host: 'a' }, 'cd /x && opencode --session 1'), ['-t', 'a', 'cd /x && opencode --session 1']);
});
