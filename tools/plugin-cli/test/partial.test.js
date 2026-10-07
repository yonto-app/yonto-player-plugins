import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engines/quickjs.js';
import { createHost } from '../src/host/index.js';
import { loadManifest } from '../src/manifest.js';
import { partialShown } from '../src/partial.js';
import { scratchDir } from '../src/scratch-dir.js';

const dir = fileURLToPath(new URL('../conformance/partial/', import.meta.url));
const record = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));

// kangzj/lantern-tv#357. `PluginPartialRecordTest` walks the same record through the device.
test('yonto.partial shows what conformance/partial/calls.json says it keeps', async () => {
  for (const { why, calls, keeps } of record.cases) {
    const host = createHost({
      manifest: loadManifest(dir),
      config: {},
      transport: { async request() { throw new Error('no network in this record'); } },
      storeDir: scratchDir('lp-partial-'),
      pluginDir: dir,
    });
    const engine = createEngine({ dir, host });
    for (const call of calls) {
      await engine.call(call.method, [JSON.stringify(call), { page: 1, filters: {} }]).catch(() => {});
    }

    assert.equal(partialShown(calls.at(-1).method, host.takePartial()), keeps, why);
  }
});
