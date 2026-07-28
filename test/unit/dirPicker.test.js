const test = require('node:test');
const assert = require('node:assert/strict');
const { expandTilde, splitPathInput, parentDir, buildBrowseItems } = require('../../out/views/pathInput');

test('expandTilde', () => {
  assert.equal(expandTilde('~', '/home/u'), '/home/u');
  assert.equal(expandTilde('~/proj', '/home/u'), '/home/u/proj');
  assert.equal(expandTilde('/abs/path', '/home/u'), '/abs/path');
  assert.equal(expandTilde('relative', '/home/u'), 'relative');
  assert.equal(expandTilde('~/proj', '/home/u/'), '/home/u/proj');
});

test('splitPathInput: trailing slash vs partial segment', () => {
  assert.deepEqual(splitPathInput('/a/b/'), { base: '/a/b/', segment: '' });
  assert.deepEqual(splitPathInput('/a/b/c'), { base: '/a/b/', segment: 'c' });
  assert.deepEqual(splitPathInput('/a'), { base: '/', segment: 'a' });
  assert.deepEqual(splitPathInput('/'), { base: '/', segment: '' });
});

test('parentDir', () => {
  assert.equal(parentDir('/a/b/'), '/a/');
  assert.equal(parentDir('/a/'), '/');
  assert.equal(parentDir('/'), '/');
});

const STRINGS = { open: (p) => `open ${p}`, notExist: (p) => `missing ${p}` };

test('buildBrowseItems: subdirs listed with alwaysShow, prefix-filtered', () => {
  const items = buildBrowseItems({
    input: '/a/b/',
    homeDir: '/h',
    subs: ['src', 'docs', 'test'],
    strings: STRINGS,
  });
  assert.ok(items.every((i) => i.alwaysShow === true), 'every browse item must bypass quickpick filtering');
  assert.equal(items[0].accept, '/a/b/');
  assert.deepEqual(items.filter((i) => i.nav && i.nav !== '/a/').map((i) => i.label), [
    '$(folder) docs',
    '$(folder) src',
    '$(folder) test',
  ]);
  assert.ok(items.some((i) => i.nav === '/a/'), 'parent navigation present');
});

test('buildBrowseItems: partial segment filters subs; accept offered after navigating', () => {
  const items = buildBrowseItems({
    input: '/a/b/sr',
    homeDir: '/h',
    subs: ['src', 'docs'],
    strings: STRINGS,
  });
  assert.ok(!items.some((i) => i.accept), 'partial segment must not offer accept');
  assert.deepEqual(items.filter((i) => i.nav && i.label !== '$(folder) ..').map((i) => i.label), ['$(folder) src']);
  const navigated = buildBrowseItems({
    input: '/a/b/src/',
    homeDir: '/h',
    subs: ['src', 'docs'],
    strings: STRINGS,
  });
  assert.equal(navigated[0].accept, '/a/b/src/');
});

test('buildBrowseItems: missing directory yields noOp error item', () => {
  const items = buildBrowseItems({ input: '/nope/', homeDir: '/h', subs: undefined, strings: STRINGS });
  assert.equal(items.length, 1);
  assert.ok(items[0].noOp);
  assert.ok(items[0].alwaysShow);
});

test('buildBrowseItems: tilde expansion applied before browsing', () => {
  const items = buildBrowseItems({ input: '~/x/', homeDir: '/home/u', subs: ['y'], strings: STRINGS });
  assert.equal(items[0].accept, '/home/u/x/');
  assert.deepEqual(items[1].nav, '/home/u/');
  assert.deepEqual(items[2].nav, '/home/u/x/y/');
});

test('buildBrowseItems: connection error yields single noOp error item', () => {
  const items = buildBrowseItems({
    input: '/a/',
    homeDir: '/h',
    subs: ['src'],
    connError: 'getsockname failed: Not a socket',
    strings: { ...STRINGS, connFailed: (d) => `unreachable: ${d}` },
  });
  assert.equal(items.length, 1);
  assert.ok(items[0].noOp && items[0].alwaysShow);
  assert.ok(items[0].label.includes('unreachable: getsockname failed'));
});
