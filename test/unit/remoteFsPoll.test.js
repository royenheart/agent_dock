const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPollScript,
  parsePollOutput,
  parseDirMtimeLine,
  buildLimitedReadScript,
  isTooBigResult,
  diffFileSnapshot,
  diffDirSnapshot,
} = require('../../out/ssh/remoteFsPoll');

test('buildPollScript: batches files into one stat loop, dirs into D| blocks with E|/M| markers', () => {
  const script = buildPollScript([
    { path: '/srv/a.log', isDir: false },
    { path: '/srv/a.log', isDir: false }, // dedupe
    { path: '/srv/src', isDir: true },
    { path: '/srv/b.log', isDir: false },
  ]);
  assert.match(script, /for p in '\/srv\/a\.log' '\/srv\/b\.log'; do s=\$\(stat -c '%s\|%Y'/);
  assert.match(script, /printf 'D\|%s\\n' '\/srv\/src'/);
  assert.match(script, /ls -1Ap --color=never -- '\/srv\/src' 2>\/dev\/null \|\| printf 'M\|%s\\n' '\/srv\/src'/);
  assert.match(script, /printf 'E\|%s\\n' '\/srv\/src'/);
  assert.equal((script.match(/stat -c/g) || []).length, 1, 'one batched stat loop');
  assert.match(script, /\nexit 0$/, 'script always exits 0 so missing entries are not fatal');
});

test('buildPollScript: quotes paths with single quotes', () => {
  const script = buildPollScript([{ path: "/tmp/it's.txt", isDir: false }]);
  assert.match(script, /'\/tmp\/it'\\''s\.txt'/);
});

test('parsePollOutput: file lines, dir blocks with E| terminator, missing marker', () => {
  const out = parsePollOutput(
    [
      "S|/srv/a.log|123|1753000001",
      "S|/srv/b.log|7|1753000002",
      "D|/srv/src",
      "sub/",
      "file.txt",
      "link@",
      "E|/srv/src",
      "D|/srv/empty",
      "E|/srv/empty",
      "D|/srv/gone",
      "M|/srv/gone",
      "D|/srv/next",
      "x",
      "E|/srv/next",
    ].join('\n'),
  );
  assert.deepEqual(out.get('/srv/a.log'), { size: 123, mtimeSec: 1753000001 });
  assert.deepEqual(out.get('/srv/b.log'), { size: 7, mtimeSec: 1753000002 });
  assert.deepEqual(out.get('/srv/src'), [
    { name: 'sub', isDir: true },
    { name: 'file.txt', isDir: false },
    { name: 'link@', isDir: false }, // -p 语义：标记字符原样保留
  ]);
  assert.deepEqual(out.get('/srv/empty'), []);
  assert.equal(out.get('/srv/gone'), null, 'M| marker maps to null snapshot');
  assert.deepEqual(out.get('/srv/next'), [{ name: 'x', isDir: false }], 'blocks after M| parse normally');
  assert.equal(out.has('/srv/missing'), false);
});

test('parsePollOutput: paths containing "|" parse correctly (right-to-left field split)', () => {
  const out = parsePollOutput("S|/tmp/a|b.txt|4|1753000001\n");
  assert.deepEqual(out.get('/tmp/a|b.txt'), { size: 4, mtimeSec: 1753000001 });
  assert.equal(out.has('/tmp/a'), false, 'no prefix-key pollution');
});

test('parsePollOutput: dir entries starting with S|/D|/E|/M| do not break blocks', () => {
  const out = parsePollOutput(
    ['D|/srv/src', 'S|x', 'D|y', 'E|z', 'M|w', 'real.txt', 'E|/srv/src'].join('\n'),
  );
  assert.deepEqual(out.get('/srv/src'), [
    { name: 'S|x', isDir: false },
    { name: 'D|y', isDir: false },
    { name: 'E|z', isDir: false },
    { name: 'M|w', isDir: false },
    { name: 'real.txt', isDir: false },
  ]);
});

test('parsePollOutput: garbage stat line yields null snapshot', () => {
  const out = parsePollOutput("S|/srv/bad|abc|def\nS|/srv/ok|1|2\n");
  assert.equal(out.get('/srv/bad'), null);
  assert.deepEqual(out.get('/srv/ok'), { size: 1, mtimeSec: 2 });
});

test('parseDirMtimeLine: path may contain "|", mtime is last field; garbage ignored', () => {
  assert.deepEqual(parseDirMtimeLine('/a|b|1753000001'), { path: '/a|b', mtimeSec: 1753000001 });
  assert.deepEqual(parseDirMtimeLine('/plain|1753000001'), { path: '/plain', mtimeSec: 1753000001 });
  assert.equal(parseDirMtimeLine('no-pipe'), undefined);
  assert.equal(parseDirMtimeLine('|'), undefined);
  assert.equal(parseDirMtimeLine('/a|notanumber'), undefined);
});

test('buildLimitedReadScript: stat+cat in one call with TOOBIG marker on stderr', () => {
  const script = buildLimitedReadScript('/srv/big.log', 1024);
  assert.match(script, /stat -c '%s' -- '\/srv\/big\.log'/);
  assert.match(script, /-gt 1024/);
  assert.match(script, /cat '\/srv\/big\.log'/);
  assert.match(script, /__AD_TOOBIG_1024__/);
  assert.equal((script.match(/__AD_TOOBIG_1024__/g) || []).length, 2, 'marker on both failure paths');
});

test('isTooBigResult: marker in stderr with empty stdout rejects; normal output passes', () => {
  assert.equal(isTooBigResult({ stdout: Buffer.alloc(0), stderr: '__AD_TOOBIG_1024__\n', code: 0 }, 1024), true);
  assert.equal(isTooBigResult({ stdout: Buffer.from('data'), stderr: '', code: 0 }, 1024), false);
  assert.equal(isTooBigResult({ stdout: Buffer.alloc(0), stderr: '__AD_TOOBIG_1024__\n', code: 1 }, 1024), false);
  assert.equal(isTooBigResult({ stdout: Buffer.alloc(0), stderr: '__AD_TOOBIG_999__\n', code: 0 }, 1024), false, 'marker must match the cap');
});

test('diffFileSnapshot: baseline records silently, changes fire, delete fires once', () => {
  // baseline
  assert.equal(diffFileSnapshot(undefined, { size: 1, mtimeSec: 10 }), false);
  // unchanged
  assert.equal(diffFileSnapshot({ size: 1, mtimeSec: 10 }, { size: 1, mtimeSec: 10 }), false);
  // size changed
  assert.equal(diffFileSnapshot({ size: 1, mtimeSec: 10 }, { size: 2, mtimeSec: 10 }), true);
  // mtime changed
  assert.equal(diffFileSnapshot({ size: 1, mtimeSec: 10 }, { size: 1, mtimeSec: 11 }), true);
  // deleted
  assert.equal(diffFileSnapshot({ size: 1, mtimeSec: 10 }, null), true);
  // reappeared
  assert.equal(diffFileSnapshot(null, { size: 1, mtimeSec: 10 }), true);
  // still missing: no repeat event
  assert.equal(diffFileSnapshot(null, null), false);
});

test('diffDirSnapshot: baseline, create/delete/toggle detection, dir appear/disappear', () => {
  const base = [
    { name: 'a', isDir: false },
    { name: 'sub', isDir: true },
    { name: 'old', isDir: false },
  ];
  // baseline: record only
  assert.deepEqual(diffDirSnapshot(undefined, base), { changed: false, created: [], deleted: [], toggled: [] });
  // unchanged
  assert.deepEqual(diffDirSnapshot(base, [...base]), { changed: false, created: [], deleted: [], toggled: [] });
  // created + deleted + toggled
  const diff = diffDirSnapshot(base, [
    { name: 'a', isDir: true }, // toggled file -> dir
    { name: 'sub', isDir: true }, // unchanged
    { name: 'new', isDir: false }, // created
  ]);
  assert.deepEqual(diff, { changed: true, created: ['new'], deleted: ['old'], toggled: ['a'] });
  // dir appears/disappears
  assert.equal(diffDirSnapshot(null, base).changed, true);
  assert.equal(diffDirSnapshot(base, null).changed, true);
  assert.equal(diffDirSnapshot(null, null).changed, false);
});
