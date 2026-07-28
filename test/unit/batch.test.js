const test = require('node:test');
const assert = require('node:assert/strict');
const { createBatcher } = require('../../out/batch');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('createBatcher: calls within the window merge into one run with aligned results', async () => {
  const runs = [];
  const batched = createBatcher(async (items) => {
    runs.push(items);
    return items.map((i) => i * 2);
  }, 30);
  const [a, b] = await Promise.all([batched([1, 2]), batched([3])]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [1, 2, 3]);
  assert.deepEqual(a, [2, 4]);
  assert.deepEqual(b, [6]);
});

test('createBatcher: calls after the window start a new run', async () => {
  const runs = [];
  const batched = createBatcher(async (items) => {
    runs.push(items);
    return items;
  }, 20);
  await batched([1]);
  await delay(40);
  await batched([2]);
  assert.equal(runs.length, 2);
});

test('createBatcher: maxItems flushes immediately without waiting for the window', async () => {
  const runs = [];
  const batched = createBatcher(
    async (items) => {
      runs.push(items);
      return items;
    },
    10_000,
    3,
  );
  const results = await Promise.all([batched([1, 2]), batched([3])]);
  assert.equal(runs.length, 1, 'flush must not wait for the window once maxItems is reached');
  assert.deepEqual(results, [[1, 2], [3]]);
});

test('createBatcher: run rejection rejects every pending caller', async () => {
  const batched = createBatcher(async () => {
    throw new Error('ssh down');
  }, 10);
  await assert.rejects(batched([1]), /ssh down/);
  await assert.rejects(batched([2]), /ssh down/);
});

test('createBatcher: empty input resolves immediately without a run', async () => {
  let ran = 0;
  const batched = createBatcher(async (items) => {
    ran += 1;
    return items;
  }, 10);
  assert.deepEqual(await batched([]), []);
  assert.equal(ran, 0);
});
