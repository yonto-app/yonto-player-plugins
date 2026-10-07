import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engines/quickjs.js';
import { RESPONSE_BODY_BYTES } from '../src/host/fetch.js';
import { createHost } from '../src/host/index.js';
import { loadManifest } from '../src/manifest.js';
import { scratchDir } from '../src/scratch-dir.js';

const dir = fileURLToPath(new URL('../conformance/raised/', import.meta.url));
const record = JSON.parse(readFileSync(join(dir, 'raised.json'), 'utf8'));

// kangzj/lantern-tv#615. `PluginRaisedRecordTest` walks the same record through the device.
test('a thrown value ends in what conformance/raised/raised.json says', async () => {
  const host = createHost({
    manifest: loadManifest(dir),
    config: {},
    transport: {
      async request({ url }) {
        if (url === record.answersTooLarge) {
          return { status: 200, headers: {}, bodyBase64: Buffer.alloc(RESPONSE_BODY_BYTES + 1).toString('base64') };
        }
        if (url !== record.redirectsToItself) throw new Error('no answer in this record');
        return { status: 302, headers: { location: url }, bodyBase64: '' };
      },
    },
    storeDir: scratchDir('lp-raised-'),
    pluginDir: dir,
  });
  const engine = createEngine({ dir, host });

  for (const { why, call, code, message } of record.cases) {
    const thrown = await engine.call('raise', [JSON.stringify(call)]).then(
      () => assert.fail(`${why}: the call did not throw`),
      (error) => error,
    );

    assert.equal(thrown.code, code, why);
    if (message !== undefined) assert.equal(thrown.message, message, why);
  }
});
