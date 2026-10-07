import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engines/quickjs.js';
import { createHost } from '../src/host/index.js';
import { loadManifest } from '../src/manifest.js';
import { scratchDir } from '../src/scratch-dir.js';

const dir = fileURLToPath(new URL('../conformance/fetch-body/', import.meta.url));
const record = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));
const limits = JSON.parse(readFileSync(fileURLToPath(new URL('../conformance/limits.json', import.meta.url)), 'utf8'));

// kangzj/lantern-tv#333. `PluginFetchBodyRecordTest` walks the same record through the device.
test('a plugin reads what conformance/fetch-body/calls.json says of a response body', async () => {
  const bytesOf = (bytes) => ({ limit: limits.responseBodyBytes, 'limit+1': limits.responseBodyBytes + 1 }[bytes] ?? bytes);
  const sized = Object.fromEntries(Object.entries(record.sized)
    .map(([url, { bytes, fill }]) => [url, Buffer.alloc(bytesOf(bytes), fill).toString('base64')]));
  const host = createHost({
    manifest: loadManifest(dir),
    config: {},
    transport: {
      async request({ url }) {
        if (url in sized) {
          return { status: 200, headers: {}, bodyBase64: sized[url] };
        }
        const { contentType, bodyBase64 } = record.bodies[url];
        return { status: 200, headers: { 'content-type': contentType }, bodyBase64 };
      },
    },
    storeDir: scratchDir('lp-fetch-body-'),
    pluginDir: dir,
  });
  const engine = createEngine({ dir, host });

  for (const { why, method, args = [], answer } of record.calls) {
    assert.deepEqual(await engine.call(method, args), answer, why);
  }
});

// The CLI's own commands make one call at a time, as the device does, but a test may run two side
// by side on one realm (the plugins' login coalescing is tested that way). Which of them a body
// belongs to cannot be told then, so one call ending must not drop another's.
test('a call that starts and ends while another waits leaves that one its bodies', async () => {
  const pluginDir = join(scratchDir('lp-overlap-'), 'overlap');
  mkdirSync(pluginDir);
  writeFileSync(join(pluginDir, 'overlap-plugin.js'), `/* yonto-plugin
{"kind":"content-source","id":"overlap","name":"Overlap","version":"1.0.0","contractVersion":21,"provides":"source-type","allowedHosts":["body.test"]}
*/
export default {
  async getCategories() { return []; },
  async a() {
    const response = await yonto.fetch('https://body.test/a');
    await yonto.fetch('https://body.test/gate');
    return response.bodyBase64;
  },
  async b() { await yonto.fetch('https://body.test/b'); return 'b'; },
};
`);
  let reachedGate;
  const atGate = new Promise((resolve) => { reachedGate = resolve; });
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const host = createHost({
    manifest: loadManifest(pluginDir),
    config: {},
    transport: {
      async request({ url }) {
        if (url.endsWith('/gate')) {
          reachedGate();
          await gate;
        }
        return { status: 200, headers: {}, bodyBase64: Buffer.from(url).toString('base64') };
      },
    },
    storeDir: pluginDir,
    pluginDir,
  });
  const engine = createEngine({ dir: pluginDir, host });

  const a = engine.call('a', []);
  await atGate;
  assert.equal(await engine.call('b', []), 'b');
  openGate();

  assert.equal(await a, Buffer.from('https://body.test/a').toString('base64'));
});
