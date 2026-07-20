const test = require('node:test');
const assert = require('node:assert/strict');
const { expandTilde, splitPathInput, parentDir } = require('../../out/views/pathInput');

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
