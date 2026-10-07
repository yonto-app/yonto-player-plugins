import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/host/index.js';
import { createEngine, fetchRequest } from '../src/engines/quickjs.js';
import { loadManifest } from '../src/manifest.js';
import { Code, HostRefusal } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * What this host decides about a call outside the plugin's realm, where conformance/host-verdicts
 * cannot reach because both hosts have to agree on it without the same insides: a verdict that
 * lands after its call ended, the Node-side checks behind the bootstrap's, and Node's own words
 * about a value, none of which a plugin reads (kangzj/lantern-tv#342).
 */

const realmDir = fileURLToPath(new URL('../test-plugins/realm/', import.meta.url));

function pluginOf(body) {
  const pluginDir = join(scratchDir('lp-'), 'verdicts');
  mkdirSync(pluginDir);
  const manifest = {
    kind: 'content-source', id: 'verdicts', name: 'Verdicts', version: '1.0.0', contractVersion: 21,
    provides: 'source-type', allowedHosts: ['site.test'],
  };
  writeFileSync(join(pluginDir, 'verdicts-plugin.js'), `/* yonto-plugin\n${JSON.stringify(manifest)}\n*/\n${body}\n`);
  return pluginDir;
}

/** A host whose one site answers only after [delayMs], and then as a transport failure. */
function engineOverFailingSite(pluginDir, delayMs) {
  const host = createHost({
    pluginDir,
    manifest: loadManifest(pluginDir),
    transport: {
      request: () => new Promise((_, reject) => setTimeout(() => reject(new Error('connection reset')), delayMs)),
    },
    storeDir: scratchDir('lp-'),
  });
  return createEngine({ dir: pluginDir, host, timeoutMs: 2000 });
}

const codeOf = (promise) => promise.then(() => 'answered', (error) => error.code);

test('a verdict that lands after its call ended speaks for no later call', async () => {
  const e = engineOverFailingSite(pluginOf(`
    export default {
      async start() { yonto.fetch('https://site.test/slow').catch(() => {}); return []; },
      async later() { await yonto.sleep(400); throw { code: 'REQUEST_FAILED', message: 'borrowed' }; },
    };
  `), 100);

  assert.equal(await codeOf(e.call('start', [])), 'answered');
  assert.equal(await codeOf(e.call('later', [])), Code.METHOD_THREW);
});

test('a plugin repeating the host verdict its own call was given is reporting it, which is allowed', async () => {
  const e = engineOverFailingSite(pluginOf(`
    export default {
      async getCategories() {
        try { await yonto.fetch('https://site.test/slow'); } catch {}
        throw { code: 'REQUEST_FAILED', message: 'the host said so' };
      },
    };
  `), 10);

  assert.equal(await codeOf(e.call('getCategories', [])), Code.REQUEST_FAILED);
});

test("Node's own error about a value is the device's sentence, not Node's words", async () => {
  const host = createHost({
    pluginDir: realmDir,
    manifest: loadManifest(realmDir),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    storeDir: scratchDir('lp-'),
  });
  host.yonto.store.set = () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); };
  const e = createEngine({ dir: realmDir, host, timeoutMs: 2000 });

  assert.deepEqual(await e.call('storeFails', []),
    { isError: true, code: null, message: 'the host could not do that with what it was given' });
});

/** The bootstrap's checks run in a realm the plugin can rewrite, so the host checks again. */
test('the host refuses a malformed fetch request in its own words', () => {
  const refused = (request) => {
    try {
      fetchRequest(JSON.stringify(request));
      return 'accepted';
    } catch (error) {
      assert.ok(error instanceof HostRefusal, String(error));
      return error.message;
    }
  };

  assert.equal(refused([]), 'yonto.fetch: the request must be an object');
  assert.equal(refused('x'), 'yonto.fetch: the request must be an object');
  assert.equal(refused({ url: {} }), 'yonto.fetch: url must be a string');
  assert.equal(refused({ url: 'https://site.test/', headers: [] }), 'yonto.fetch: headers must be an object');
  assert.equal(refused({ url: 'https://site.test/', headers: { a: {} } }), 'yonto.fetch: headers.a must be a string');
  assert.equal(refused({ url: 'https://site.test/', headers: { a: 1 } }), 'yonto.fetch: headers.a must be a string');
  assert.equal(refused({ url: 'https://site.test/', body: {} }), 'yonto.fetch: body must be a string');
  assert.equal(refused({ url: 'https://site.test/', method: 5 }), 'yonto.fetch: method must be a string');
  assert.deepEqual(fetchRequest(JSON.stringify({ url: 123, body: null })), { url: '123', headers: {} });
});

/**
 * Reading a thrown value runs its getters, which are plugin code, after the call's own
 * ceiling is disarmed. One that never answers must not hang `run` or `doctor`: without its
 * own ceiling the read never returns, and these tests never end.
 */
function engineOf(pluginDir) {
  const host = createHost({
    pluginDir,
    manifest: loadManifest(pluginDir),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    storeDir: scratchDir('lp-'),
  });
  return createEngine({ dir: pluginDir, host, timeoutMs: 10_000 });
}

for (const [shape, thrown] of [
  ['a plain object whose code never answers', '{ get code() { for (;;) {} } }'],
  ['a plain object whose message never answers', '{ get message() { for (;;) {} } }'],
  ['a Proxy whose every property never answers', 'new Proxy({}, { get() { for (;;) {} } })'],
]) {
  test(`${shape}, thrown by a call, is METHOD_THREW in moments`, async () => {
    const e = engineOf(pluginOf(`export default { async ready() { return []; }, async getCategories() { throw ${thrown}; } };`));
    // Loaded first, so what is timed is the read and not the build.
    await e.call('ready', []);
    const started = Date.now();

    assert.equal(await codeOf(e.call('getCategories', [])), Code.METHOD_THREW);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  });
}

test('a module body throwing a value whose getters never answer fails to load rather than hanging', async () => {
  const e = engineOf(pluginOf('throw { get message() { for (;;) {} } };\nexport default {};'));

  assert.equal(await codeOf(e.call('getCategories', [])), Code.METHOD_THREW);
});
