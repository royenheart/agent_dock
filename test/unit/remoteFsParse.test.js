const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLsAp, parseStatFs, joinRemotePath } = require('../../out/ssh/remoteFsParse');

test('parseLsAp: -p semantics — only "/" stripped, marker chars kept verbatim', () => {
  // ls -1Ap 只给真目录追加 '/'；以 * @ = | % 结尾的文件名必须原样保留
  const out = parseLsAp('src/\nREADME.md\nrun.sh*\nlink@\nsock=\n./\n../\n.fifo|\nfoo%');
  assert.deepEqual(out, [
    { name: 'src', isDir: true },
    { name: 'README.md', isDir: false },
    { name: 'run.sh*', isDir: false },
    { name: 'link@', isDir: false },
    { name: 'sock=', isDir: false },
    { name: '.fifo|', isDir: false },
    { name: 'foo%', isDir: false },
  ]);
});

test('parseLsAp: empty input / empty dir block', () => {
  assert.deepEqual(parseLsAp(''), []);
  assert.deepEqual(parseLsAp('\n'), []);
});

test('parseStatFs: directory / regular / symlink / invalid', () => {
  assert.deepEqual(parseStatFs('directory|4096|1753000000'), { kind: 'directory', size: 4096, mtimeMs: 1753000000000 });
  assert.deepEqual(parseStatFs('regular file|123|1753000001'), { kind: 'file', size: 123, mtimeMs: 1753000001000 });
  assert.deepEqual(parseStatFs('symbolic link|7|1753000002'), { kind: 'link', size: 7, mtimeMs: 1753000002000 });
  assert.equal(parseStatFs('garbage'), undefined);
  assert.equal(parseStatFs('regular file|abc|1'), undefined);
});

test('joinRemotePath', () => {
  assert.equal(joinRemotePath('/a', 'b'), '/a/b');
  assert.equal(joinRemotePath('/a/', 'b'), '/a/b');
  assert.equal(joinRemotePath('/', 'b'), '/b');
});
