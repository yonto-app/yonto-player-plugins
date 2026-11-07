import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCache } from '../src/host/cache.js';
import { scratchDir } from '../src/scratch-dir.js';

/** `yonto.cache` as the CLI keeps it, held to what `PluginCachesTest` holds the device's to. */
const fileOf = (dir, key) => join(dir, createHash('sha256').update(key).digest('hex'));

test('a value survives a new cache over the same folder, and a removed one is gone', async () => {
  const dir = scratchDir('lp-cache-');
  assert.equal(await createCache({ dir }).set('index', 'line one\nline two'), true);

  const again = createCache({ dir });
  assert.equal(await again.get('index'), 'line one\nline two');
  await again.remove('index');
  assert.equal(await again.get('index'), null);
});

test('a value is gone once its ttl has passed', async () => {
  let clock = 1_000_000;
  const cache = createCache({ dir: scratchDir('lp-cache-'), now: () => clock });
  await cache.set('index', 'titles', { ttlSeconds: 60 });

  clock += 59_999;
  assert.equal(await cache.get('index'), 'titles');
  clock += 1;
  assert.equal(await cache.get('index'), null);
});

test('past the entry cap the least recently written other entry goes', async () => {
  let clock = 1;
  const cache = createCache({ dir: scratchDir('lp-cache-'), now: () => clock, maxEntries: 2 });
  await cache.set('a', '1');
  clock += 1;
  await cache.set('b', '2');
  clock += 1;
  await cache.set('a', '1 again');
  clock += 1;
  await cache.set('c', '3');

  assert.deepEqual([await cache.get('a'), await cache.get('b'), await cache.get('c')], ['1 again', null, '3']);
});

test('past the byte cap the least recently written others go, and never the new one', async () => {
  let clock = 1;
  const cache = createCache({ dir: scratchDir('lp-cache-'), now: () => clock, maxBytes: 300 });
  await cache.set('a', 'x'.repeat(100));
  clock += 1;
  await cache.set('b', 'y'.repeat(100));
  clock += 1;
  await cache.set('c', 'z'.repeat(400));

  assert.deepEqual([await cache.get('a'), await cache.get('b'), (await cache.get('c'))?.length], [null, null, 400]);
});

test('an expired entry goes before a live one', async () => {
  let clock = 1_000_000;
  const dir = scratchDir('lp-cache-');
  const cache = createCache({ dir, now: () => clock, maxEntries: 2 });
  await cache.set('old', 'live');
  clock += 1;
  await cache.set('short', 'expires', { ttlSeconds: 1 });
  clock += 2_000;
  await cache.set('new', '3');

  assert.deepEqual([await cache.get('old'), await cache.get('new')], ['live', '3']);
  assert.ok(!existsSync(fileOf(dir, 'short')));
});

test('a file that is not an entry for the key reads as absent', async () => {
  const dir = scratchDir('lp-cache-');
  const cache = createCache({ dir });
  await cache.set('index', 'titles');

  writeFileSync(fileOf(dir, 'index'), 'not an entry');
  assert.equal(await cache.get('index'), null);
  writeFileSync(fileOf(dir, 'index'), '{"key":"other","expiresAt":null,"writtenAt":1}\ntitles');
  assert.equal(await cache.get('index'), null);
});

test('a write the disk refuses is dropped rather than thrown, and says it kept nothing', async () => {
  const dir = join(scratchDir('lp-cache-'), 'cache');
  writeFileSync(dir, 'a file where the folder goes');
  const cache = createCache({ dir });

  assert.equal(await cache.set('index', 'titles'), false);
  assert.equal(await cache.get('index'), null);
});

test('a cache with no folder keeps nothing, says so, and still refuses what no cache keeps', async () => {
  const cache = createCache({ dir: null });

  assert.equal(await cache.set('index', 'titles'), false);
  assert.equal(await cache.get('index'), null);
  await assert.rejects(cache.set('lone\ud800', 'v'), { code: 'STORE_REFUSED' });
});

test('a remove the disk refuses is dropped rather than thrown', async () => {
  const dir = scratchDir('lp-cache-');
  const cache = createCache({ dir });
  await cache.set('index', 'titles');
  chmodSync(dir, 0o500);
  try {
    await cache.remove('index');
  } finally {
    chmodSync(dir, 0o700);
  }
});

