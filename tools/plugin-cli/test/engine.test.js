import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { loadManifest } from '../src/manifest.js';
import { Code } from '../src/errors.js';
import { HOST_FUNCTIONS } from '../src/host/surface.js';
import { scratchDir } from '../src/scratch-dir.js';

// fileURLToPath, never url.pathname — the latter is "/C:/…" on Windows.
const dir = fileURLToPath(new URL('../test-plugins/ok/', import.meta.url));
const realmDir = fileURLToPath(new URL('../test-plugins/realm/', import.meta.url));
const oldNameDir = fileURLToPath(new URL('../test-plugins/old-name/', import.meta.url));
const throwsAfterFetchDir = fileURLToPath(new URL('../test-plugins/throws-after-fetch/', import.meta.url));

function engine({ body = '[]', timeoutMs = 2000, ceilingMs, pluginDir = dir } = {}) {
  const transport = {
    async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from(body).toString('base64') }; },
  };
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(pluginDir), transport, storeDir: scratchDir('lp-'),
  });
  return { engine: createEngine({ dir: pluginDir, host, timeoutMs, ceilingMs }), requests: host.requests };
}

/**
 * An engine over `realm` whose site takes [siteDelayMs] to answer — a park the call's own
 * budget does not bound, because what bounds a fetch is the transport.
 *
 * The two tests that use it are about an answer that lands after the ceiling abandoned its
 * call, and a sleep can no longer produce one (kangzj/lantern-tv#169).
 */
function engineOverSlowSite({ timeoutMs, ceilingMs, siteDelayMs }) {
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(realmDir),
    transport: {
      async request() {
        await new Promise((resolve) => setTimeout(resolve, siteDelayMs));
        return { status: 200, headers: {}, bodyBase64: '' };
      },
    },
    storeDir: scratchDir('lp-'),
  });
  return createEngine({ dir: realmDir, host, timeoutMs, ceilingMs });
}

test('a module that awaits at the top level is ready before its first call', async () => {
  const { engine: e } = engine({ pluginDir: fileURLToPath(new URL('../test-plugins/awaits-at-top-level/', import.meta.url)) });

  assert.deepEqual(await e.call('getCategories', []), [{ id: 'ready', name: 'ready' }]);
});

test('a top-level await that rejects is the module body throwing', async () => {
  const { engine: e } = engine({ pluginDir: fileURLToPath(new URL('../test-plugins/rejects-at-top-level/', import.meta.url)) });

  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /rejects-at-top-level-plugin\.js threw while it was being evaluated: the table was not there/);
    return true;
  });
});

test('a top-level await that never settles is a load that timed out', async () => {
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/never-finishes-loading/', import.meta.url)), ceilingMs: 200,
  });

  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    assert.match(error.message, /never-finishes-loading-plugin\.js did not finish loading within 200 ms$/);
    return true;
  });
});

/** What a module body throws, as this host says it back — the device's half is JsRuntimeTest. */
async function loadFailureOf(body, timeoutMs = 2000) {
  const pluginDir = join(scratchDir('lp-'), 'throws-at-load');
  cpSync(fileURLToPath(new URL('../test-plugins/ok/', import.meta.url)), pluginDir, { recursive: true });
  renameSync(join(pluginDir, 'ok-plugin.js'), join(pluginDir, 'throws-at-load-plugin.js'));
  const source = readFileSync(join(pluginDir, 'throws-at-load-plugin.js'), 'utf8').replace('"id": "ok"', '"id": "throws-at-load"');
  const header = source.slice(0, source.indexOf('*/') + 2);
  writeFileSync(join(pluginDir, 'throws-at-load-plugin.js'), `${header}\n${body}\nexport default {};\n`);
  const { engine: e } = engine({ pluginDir, timeoutMs });
  try {
    await e.call('getCategories', []);
  } catch (error) {
    return error;
  }
  return assert.fail('the module body did not throw');
}

/** The interrupt is Node's to vouch for, not the thrown value's: `PluginHostVerdictTest` on the device. */
test('a module body cannot pass its own throw off as the interrupt', async () => {
  const error = await loadFailureOf("throw new InternalError('interrupted');");

  assert.equal(error.code, Code.METHOD_THREW);
});

test('a module body that throws a plain object is reported by its message', async () => {
  const error = await loadFailureOf("throw { code: 'NOT_FOUND', message: 'not a real Error' };");

  assert.equal(error.code, Code.METHOD_THREW);
  assert.match(error.message, /throws-at-load-plugin\.js threw while it was being evaluated: not a real Error$/);
});

test('a module body that throws nothing says it was evaluating and nothing else', async () => {
  for (const body of ['throw null;', 'throw undefined;']) {
    assert.match((await loadFailureOf(body)).message, /throws-at-load-plugin\.js threw while it was being evaluated$/, body);
  }
});

test('a module body that throws a string says it', async () => {
  assert.match((await loadFailureOf("throw 'a bare string';")).message, /being evaluated: a bare string$/);
});

test('a module body the interrupt stops is a load that timed out', async () => {
  // The interrupt, not the load's own timer: nothing in `while (true)` yields for a timer.
  const error = await loadFailureOf('while (true) {}', 200);

  assert.equal(error.code, Code.TIMEOUT);
  assert.match(error.message, /did not finish loading within 200 ms of JavaScript$/);
});

test('a module body that recurses without end is a stack overflow, as on a device', async () => {
  // Without QuickJS's own limit the recursion ran until Node's stack gave out, and the WASM
  // module was left broken for the next call (kangzj/lantern-tv#541).
  const error = await loadFailureOf('function f(n) { return f(n + 1) + 1; }\nf(0);');

  assert.equal(error.code, Code.METHOD_THREW);
  assert.match(error.message, /being evaluated: stack overflow$/);
  // QuickJS's own limit, reached first here, is what leaves the author a frame to open.
  assert.match(error.detail.stack, /throws-at-load-plugin\.js:\d+:\d+/);
});

test('a module body that runs Node out of stack is a stack overflow, not an abort', async () => {
  // Freeing a runtime Node's stack ran out under aborts the process, so a load that failed
  // that way must not be freed like any other.
  const error = await loadFailureOf("JSON.parse('['.repeat(20000) + ']'.repeat(20000));");

  assert.equal(error.code, Code.METHOD_THREW);
  assert.match(error.message, /being evaluated: stack overflow$/);
});

test('a method that recurses without end is a stack overflow, and the next call still runs', async () => {
  const pluginDir = join(scratchDir('lp-'), 'recurses');
  cpSync(fileURLToPath(new URL('../test-plugins/ok/', import.meta.url)), pluginDir, { recursive: true });
  renameSync(join(pluginDir, 'ok-plugin.js'), join(pluginDir, 'recurses-plugin.js'));
  const source = readFileSync(join(pluginDir, 'recurses-plugin.js'), 'utf8').replace('"id": "ok"', '"id": "recurses"');
  writeFileSync(join(pluginDir, 'recurses-plugin.js'), `${source.slice(0, source.indexOf('*/') + 2)}
function f(n) { return f(n + 1) + 1; }
function depth(n) { return n === 0 ? 0 : depth(n - 1) + 1; }
export default {
  async getCategories() { return f(0); },
  async search() { return [{ id: String(depth(500)), title: 'deep but finite' }]; },
};
`);
  const { engine: e } = engine({ pluginDir });

  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /stack overflow/);
    return true;
  });
  assert.deepEqual(await e.call('search', ['x']), [{ id: '500', title: 'deep but finite' }]);
});

test('recursion QuickJS does not count first is still a stack overflow, and the engine goes on', async () => {
  // Through a getter, an async function or a deep JSON.parse, Node's stack gives out before
  // QuickJS's limit is reached, and the module under it is broken for the next evaluate
  // (found in review of kangzj/lantern-tv#544).
  const pluginDir = join(scratchDir('lp-'), 'deep');
  cpSync(fileURLToPath(new URL('../test-plugins/ok/', import.meta.url)), pluginDir, { recursive: true });
  renameSync(join(pluginDir, 'ok-plugin.js'), join(pluginDir, 'deep-plugin.js'));
  const source = readFileSync(join(pluginDir, 'deep-plugin.js'), 'utf8').replace('"id": "ok"', '"id": "deep"');
  writeFileSync(join(pluginDir, 'deep-plugin.js'), `${source.slice(0, source.indexOf('*/') + 2)}
async function down(n) { return await down(n + 1); }
const loop = { get self() { return this.self; } };
function depth(n) { return n === 0 ? 0 : depth(n - 1) + 1; }
export default {
  async getCategories() { return down(0); },
  async getFilters() { return loop.self; },
  async getMediaList() { return JSON.parse('['.repeat(20000) + ']'.repeat(20000)); },
  // After a host call, so the parse runs in a queued job resumed by the host's answer.
  async getRecommendations() { await yonto.sleep(1); return JSON.parse('['.repeat(20000) + ']'.repeat(20000)); },
  // Deep enough that a runtime whose stack accounting the overflow left wrong refuses it.
  async search() { depth(500); return [{ id: 'fine', title: 'still here' }]; },
};
`);
  const { engine: e } = engine({ pluginDir });

  for (const method of ['getCategories', 'getFilters', 'getMediaList', 'getRecommendations']) {
    await assert.rejects(() => e.call(method, ['x']), (error) => {
      assert.equal(error.code, Code.METHOD_THREW, method);
      assert.match(error.message, /stack overflow/, method);
      return true;
    });
    assert.deepEqual(await e.call('search', ['x']), [{ id: 'fine', title: 'still here' }], `after ${method}`);
  }

  // And after enough of them in one process, an answer is still the right answer: a module
  // shared across overflows corrupted, and once returned a wrong number without an error.
  for (let overflow = 0; overflow < 50; overflow += 1) {
    await assert.rejects(() => e.call('getMediaList', ['x']), /getMediaList threw: stack overflow$/);
  }
  assert.deepEqual(await e.call('search', ['x']), [{ id: 'fine', title: 'still here' }]);
});

test('a module body that runs out of memory is its own failure, not a timeout', async () => {
  // QuickJS raises running out of memory as an InternalError, the class the interrupt uses too
  // (kangzj/lantern-tv#534).
  const error = await loadFailureOf("const hoard = [];\nwhile (true) hoard.push('x'.repeat(1 << 24));");

  assert.equal(error.code, Code.METHOD_THREW);
  assert.match(error.message, /out of memory/);
});

test('a method that runs out of memory is its own failure, not a timeout', async () => {
  const pluginDir = join(scratchDir('lp-'), 'hoards');
  cpSync(fileURLToPath(new URL('../test-plugins/ok/', import.meta.url)), pluginDir, { recursive: true });
  renameSync(join(pluginDir, 'ok-plugin.js'), join(pluginDir, 'hoards-plugin.js'));
  const source = readFileSync(join(pluginDir, 'hoards-plugin.js'), 'utf8').replace('"id": "ok"', '"id": "hoards"');
  writeFileSync(join(pluginDir, 'hoards-plugin.js'), `${source.slice(0, source.indexOf('*/') + 2)}
export default {
  async getCategories() { const hoard = []; while (true) hoard.push('x'.repeat(1 << 24)); },
};
`);
  const { engine: e } = engine({ pluginDir });

  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /out of memory/);
    return true;
  });
});

test('calls a method and returns what it resolved', async () => {
  const { engine: e } = engine({ body: '[{"id":"dianying","name":"电影"}]' });
  assert.deepEqual(await e.call('getCategories', []), [{ id: 'dianying', name: '电影' }]);
});

test('passes arguments through', async () => {
  const { engine: e } = engine();
  const list = await e.call('getMediaList', ['dianying', { page: 2, filters: {} }]);
  assert.equal(list[0].id, 'dianying-2');
});

test('the plugin reaches the host api through the yonto global', async () => {
  const { engine: e, requests } = engine();
  await e.call('getCategories', []);
  assert.equal(requests[0].url, 'https://h.tv/categories');
});

// A plugin whose file exists and parses and exports nothing. It used to be a plugin whose
// source file was missing entirely — which since #100 cannot happen, because that file is
// where the manifest is and nothing gets this far without one.
/**
 * The realm's own surface, held to the record — the missing half of the pair.
 *
 * `host.test.js` walks this host's `yonto` **object**, which is the Node implementation,
 * and `JsHostApiConformanceTest` walks the device realm's `yonto`. Nothing walked *this*
 * realm's, so the CLI could lose a member of the surface a plugin sees and stay green:
 * deleting `html.load` from the bootstrap left the whole CLI suite passing, and only the
 * Android side noticed. That asymmetry gets worse with every `REALM_FUNCTIONS` entry,
 * because those are exactly the members the host object does not have (found in review).
 */
const LINK_LOGIN = { type: 'linkLogin', service: 'plex.tv' };

test('the realm offers the surface the record names', async () => {
  // `yonto.session` is a linkLogin plugin's alone, so the realm is read on one.
  const e = createEngine({
    dir: realmDir,
    host: createHost({
      pluginDir: '/probe/engine',
      manifest: { ...loadManifest(realmDir), capabilities: [LINK_LOGIN] },
      transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
      storeDir: scratchDir('lp-'),
    }),
    timeoutMs: 2000,
  });

  assert.deepEqual(await e.call('yontoSurface', []), [...HOST_FUNCTIONS].sort());
});

test('the realm has yonto alone, with nothing under its old name', async () => {
  const { engine: e } = engine({ pluginDir: oldNameDir });

  assert.deepEqual(await e.call('names', []), { yonto: 'object', lantern: 'undefined' });
});

test('the realm of a plugin with no linkLogin has no yonto.session', async () => {
  const e = createEngine({
    dir: realmDir,
    host: createHost({
      pluginDir: '/probe/engine',
      manifest: loadManifest(realmDir),
      transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
      storeDir: scratchDir('lp-'),
    }),
    timeoutMs: 2000,
  });

  assert.deepEqual(await e.call('yontoSurface', []), HOST_FUNCTIONS.filter((name) => !name.startsWith('session.')).sort());
});

test('a plugin that exports nothing names the file it looked in', async () => {
  const { engine: e } = engine({ pluginDir: fileURLToPath(new URL('../test-plugins/no-export/', import.meta.url)) });
  await assert.rejects(() => e.exports(), (error) => {
    assert.equal(error.code, Code.MISSING_EXPORT);
    assert.match(error.message, /no-export\/no-export-plugin\.js/);
    assert.match(error.message, /default-export an object of methods/);
    return true;
  });
});

test('reports a missing export rather than crashing', async () => {
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getRecommendations', []), (error) => {
    assert.equal(error.code, Code.MISSING_EXPORT);
    assert.match(error.message, /getRecommendations/);
    return true;
  });
});

test('reports a throw with the plugin source line', async () => {
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getMediaDetail', ['1']), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /no such title/);
    assert.match(error.detail.stack, /ok-plugin\.js/);
    return true;
  });
});

test('a throw in a method names the line of the plugin it is on, not of the bundle', async () => {
  // The bundle is the plugin with its header comment gone and any helper inlined, so its
  // line numbers are not the file's (kangzj/lantern-tv#455).
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getMediaDetail', ['1']), (error) => {
    assert.match(error.detail.stack, /at getMediaDetail \(\S*ok-plugin\.js:26:\d+\)/);
    return true;
  });
});

test('a module body that throws names its own line', async () => {
  const { engine: e } = engine({ pluginDir: fileURLToPath(new URL('../test-plugins/says-then-throws/', import.meta.url)) });
  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.match(error.detail.stack, /says-then-throws-plugin\.js:19:11\)/);
    return true;
  });
});

test('a throw in a helper names the helper and its line', async () => {
  const pluginDir = fileURLToPath(new URL('../test-plugins/throws-in-helper/', import.meta.url));
  const { engine: e } = engine({ pluginDir });
  await assert.rejects(() => e.call('getCategories', []), (error) => {
    // Under the plugin's directory as it was given, not the working directory esbuild
    // names its sources from.
    assert.ok(error.detail.stack.includes(`at explode (${join(pluginDir, 'lib', 'fail.js')}:4:13)`), error.detail.stack);
    assert.match(error.detail.stack, /at getCategories \(\S*throws-in-helper-plugin\.js:17:\d+\)/);
    return true;
  });
});

test('a plugin under a path with parentheses in it is still mapped', async () => {
  // `Program Files (x86)` is the ordinary case on Windows.
  const pluginDir = join(scratchDir('lp-'), 'par(en)', 'throws-in-helper');
  cpSync(fileURLToPath(new URL('../test-plugins/throws-in-helper/', import.meta.url)), pluginDir, { recursive: true });
  const { engine: e } = engine({ pluginDir });
  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.ok(error.detail.stack.includes(`at explode (${join(pluginDir, 'lib', 'fail.js')}:4:13)`), error.detail.stack);
    return true;
  });
});

test('a frame in the host\'s own code is left as it is', async () => {
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getMediaDetail', ['1']), (error) => {
    // The host's frame that called the method, which a bundle-wide lookup would find a
    // plugin line for as readily as any other.
    assert.match(error.detail.stack, /at getMediaDetail \([^)]*\)\n\s+at <anonymous> \(yonto:host:\d+:\d+\)/);
    return true;
  });
});

test('a plugin can raise a typed not-found that survives the engine', async () => {
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getMediaDetail', ['404']), (error) => {
    assert.equal(error.code, Code.NOT_FOUND);
    assert.match(error.message, /404/);
    return true;
  });
});

test('an untyped throw is still METHOD_THREW, so a plugin cannot invent codes', async () => {
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getMediaDetail', ['boom']), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    return true;
  });
});

test('a code the host does not know is not honoured', async () => {
  const { engine: e } = engine();
  await assert.rejects(() => e.call('getMediaDetail', ['weird']), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    return true;
  });
});

test('gives up on a method that never returns', async () => {
  const { engine: e } = engine({ timeoutMs: 50 });
  await assert.rejects(() => e.call('search', ['x']), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});

test('lists what the plugin exports', async () => {
  const { engine: e } = engine();
  assert.deepEqual((await e.exports()).sort(),
    ['getCategories', 'getMediaDetail', 'getMediaList', 'search']);
});

test('two engines over one plugin directory never share a host', async () => {
  // Each engine gets a QuickJS context of its own, so `yonto` is that context's global
  // rather than the process's. This is what a shared module cache, or any other
  // process-wide binding, would quietly break — engine A's requests would start landing
  // in engine B's log the moment B loaded the same file.
  const transportA = {
    async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from('[]').toString('base64') }; },
  };
  const transportB = {
    async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from('[]').toString('base64') }; },
  };
  const hostA = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(dir), transport: transportA, storeDir: scratchDir('lp-'),
  });
  const hostB = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(dir), transport: transportB, storeDir: scratchDir('lp-'),
  });
  const engineA = createEngine({ dir, host: hostA, timeoutMs: 2000 });
  const engineB = createEngine({ dir, host: hostB, timeoutMs: 2000 });

  await engineA.call('getCategories', []);
  await engineB.exports(); // loads the same plugin file again, in engine B's own realm

  await engineA.call('getCategories', []); // engine A again — must still land on engine A's own host

  assert.equal(hostA.requests.length, 2, "engine A's second call should show up in engine A's own request log");
  assert.equal(hostB.requests.length, 0, "engine B never called a method, so its log should stay empty");
});

test('bundles a plugin that imports a sibling module', async () => {
  const { engine: e } = engine({ pluginDir: realmDir });
  assert.deepEqual(await e.call('getCategories', []), [{ id: 'bundled', name: '电影' }]);
});

test('a global the device does not have is not reachable here either', async () => {
  const { engine: e } = engine({ pluginDir: realmDir });
  await assert.rejects(() => e.call('search', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    // QuickJS's own wording, quotes and all — which is the point: this is now the
    // message a television would give, not V8's paraphrase of it.
    assert.match(error.message, /'URL' is not defined/);
    return true;
  });
});

// quickjs-kt's build enables Atomics and the published WASM does not. Named here, and
// asserted, so that a second difference cannot appear without failing this test.
const KNOWN_DIFFERENCES = ['Atomics'];

test('the CLI runs the globals the device runs', async () => {
  const recorded = JSON.parse(readFileSync(new URL('../conformance/globals.json', import.meta.url), 'utf8'));
  const { engine: e } = engine({ pluginDir: realmDir });
  // The host's own plumbing is filtered out exactly as QuickJsGlobalSurfaceTest filters
  // it, so the two lists are comparable.
  const actual = (await e.call('globals', []))
    .filter((name) => !name.startsWith('__') && name !== 'yonto');

  assert.deepEqual(actual.filter((n) => !recorded.includes(n)), [],
    'the CLI offers a global the device does not have');
  assert.deepEqual(recorded.filter((n) => !actual.includes(n)), KNOWN_DIFFERENCES,
    'the device has a global the CLI cannot give a plugin');
});

test('what the host hands back is built inside the engine', async () => {
  const { engine: e } = engine({ pluginDir: realmDir });
  // All three are true on the device, where the bootstrap rebuilds every host answer
  // inside QuickJS. A plugin's `catch (e) { if (e instanceof Error) }` depends on it.
  assert.deepEqual(await e.call('realmChecks', []), { error: true, array: true, object: true });
});

test("a host's own verdict keeps its code on the way to the plugin", async () => {
  const { engine: e } = engine({ pluginDir: realmDir });
  await assert.rejects(() => e.call('blocked', []), (error) => {
    assert.equal(error.code, Code.HOST_NOT_ALLOWED, 'a plugin may not claim this code, but the host may');
    assert.match(error.message, /elsewhere\.test/);
    return true;
  });
});

test('a plugin that throws while it is being evaluated is the plugin failing, not the CLI', async () => {
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/module-throws/', import.meta.url)),
  });
  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /module-throws\/module-throws-plugin\.js/);
    assert.match(error.message, /'URL' is not defined/);
    return true;
  });
});

// The device half of kangzj/lantern-tv#395: there, a module body that threw was reported as
// a missing `__yontoCall` on every path and on every attempt. This engine never had that
// bug, and these two cases are what say so rather than leaving it to inspection — `exports`
// is the path the installer takes before any method is called, and a second attempt is what
// a viewer produces by retrying.
test('a module body that threw names itself when the exports are read', async () => {
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/module-throws/', import.meta.url)),
  });
  await assert.rejects(() => e.exports(), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /module-throws\/module-throws-plugin\.js/);
    assert.match(error.message, /'URL' is not defined/);
    return true;
  });
});

test('a module body that threw says so on every call, not just the first', async () => {
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/module-throws/', import.meta.url)),
  });
  await assert.rejects(() => e.call('search', ['anything']), () => true);
  await assert.rejects(() => e.call('getMediaDetail', ['m']), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /'URL' is not defined/);
    return true;
  });
});

test('a synchronous host member fails with an Error the plugin can recognise', async () => {
  const { engine: e } = engine({ pluginDir: realmDir });
  // aesCbcDecrypt rejects a 3-byte key by design. crypto, encoding, text and log do not
  // go through a promise, so a version of this that only wrapped the async members would
  // hand the plugin an outer-realm Error here and nothing would say so.
  assert.deepEqual(await e.call('syncError', []), { isError: true, code: null });
});

test("a host's errno is not mistaken for one of the contract's codes", async () => {
  // createStore writes to $TMPDIR, so ENOSPC and EACCES are live routes to an error that
  // carries `.code` for reasons that have nothing to do with a host verdict. Duck-typing
  // on `.code` inside the realm would report `✗ ENOSPC` as though the contract knew it.
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(realmDir),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    storeDir: scratchDir('lp-'),
  });
  const requests = host.requests;
  host.yonto.store.set = () => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  const e = createEngine({ dir: realmDir, host, timeoutMs: 2000 });

  // Nor is its text handed over: it is the host's fault, in the device's sentence, and the
  // plugin reads no Node words about it (kangzj/lantern-tv#342).
  assert.deepEqual(await e.call('storeFails', []),
    { isError: true, code: null, message: 'the app could not do that just now; try again' });
  await assert.rejects(() => e.call('storeBoom', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW, 'an errno is a plain failure, not a host verdict');
    return true;
  });
  assert.equal(requests.length, 0);
});

/**
 * A plugin that says nothing is reported as saying nothing.
 *
 * `(error.message || error)` fell through to `String(error)` on an empty message — the
 * literal word `Error` for an Error, `[object Object]` for a plain object — and both are
 * ordinary non-blank strings that every guard downstream passes to a viewer
 * (kangzj/lantern-tv#193). The plain-object rows are not a corner: the contract invites
 * that shape, since a hand-built `{ code: 'NOT_FOUND' }` is honoured exactly like
 * `yonto.error.notFound()`.
 *
 * `JsRuntimeTest.a thrown value with nothing to say reports nothing` is the same claim on
 * the device. Both hosts or neither: `doctor` and a television disagreeing about what a
 * viewer reads is what conformance exists to stop.
 */
test('a thrown value with nothing to say reports nothing, not what String made of it', async () => {
  for (const method of ['throwsEmptyError', 'throwsBareObject', 'throwsObjectWithEmptyMessage']) {
    const { engine: e } = engine({ pluginDir: realmDir });
    await assert.rejects(() => e.call(method, []), (error) => {
      assert.equal(error.message, '', method);
      // And the code still crosses, so this is a message emptied rather than a failure
      // that stopped being honoured.
      assert.equal(error.code, Code.UNAVAILABLE, method);
      return true;
    });
  }
});

/**
 * Where a *host function* is what said nothing.
 *
 * `failed()` is the other side of the realm from `asPluginError`: this is a host binding
 * throwing, and what it says reaches the plugin's own `catch` rather than the CLI's. An empty
 * one used to arrive there as the word `Error` (kangzj/lantern-tv#193); a fault of the host's
 * own is now the device's sentence, whatever Node said (kangzj/lantern-tv#342).
 */
test('a host function that says nothing hands the plugin the host-fault sentence, not the word Error', async () => {
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(realmDir),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    storeDir: scratchDir('lp-'),
  });
  host.yonto.store.set = () => { throw new Error(''); };
  const e = createEngine({ dir: realmDir, host, timeoutMs: 2000 });

  assert.deepEqual(await e.call('storeFails', []),
    { isError: true, code: null, message: 'the app could not do that just now; try again' });
});

test('a plugin that throws a string or a null still reports METHOD_THREW', async () => {
  const { engine: e } = engine({ pluginDir: realmDir });

  await assert.rejects(() => e.call('throwsString', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW);
    assert.match(error.message, /plain string failure/, 'the thrown value is the message the device reports');
    return true;
  });
  await assert.rejects(() => e.call('throwsNull', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW, 'not a TypeError escaping to the CLI');
    return true;
  });
});

test('a config value that is an array arrives as one', async () => {
  // markingVerdicts walks the host object looking for functions; Object.entries would
  // turn ['a.tv', 'b.tv'] into { 0: 'a.tv', 1: 'b.tv' } and hand the realm a shape nobody
  // wrote. config is JSON.parse(YONTO_PLUGIN_CONFIG), so an array is easy to write.
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(realmDir),
    config: { hosts: ['a.tv', 'b.tv'] },
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    storeDir: scratchDir('lp-'),
  });
  const e = createEngine({ dir: realmDir, host, timeoutMs: 2000 });

  assert.deepEqual(await e.call('config', []), { hosts: ['a.tv', 'b.tv'] });
});

test('a synchronous loop that never ends is interrupted, not waited on', async () => {
  // The one thing a Promise.race ceiling cannot do: nothing in a `while (true)` yields,
  // so no timer fires and no other job runs. The device has always interrupted this;
  // until the CLI ran the same engine it could only hang.
  const { engine: e } = engine({ pluginDir: realmDir, timeoutMs: 200 });
  await assert.rejects(() => e.call('spins', []), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});

test('each call has its own budget of JavaScript', async () => {
  // Together these two run more JS than the budget; each alone runs less.
  const { engine: e } = engine({ pluginDir: realmDir, timeoutMs: 300 });

  assert.equal(await e.call('spinsFor', [200]), 'spun');
  assert.equal(await e.call('spinsFor', [200]), 'spun');
});

// Found in review of kangzj/yonto#630: the budget is shared while calls run side by side, so
// a call starting beside another does not wipe out the JS that one has spent.
test('calls side by side share one budget of JavaScript', async () => {
  const { engine: e } = engine({ pluginDir: realmDir, timeoutMs: 1000 });
  await e.call('fine', []);

  const outcome = (call) => call.then((answer) => answer, (error) => error.code);
  const first = outcome(e.call('spinsThenSleeps', [600, 200]));
  // From a timer, so the first call has spent its 600 ms before the second starts.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const second = outcome(e.call('spinsFor', [600]));

  assert.equal(await second, Code.TIMEOUT);
  assert.equal(await first, Code.TIMEOUT);
});

/**
 * An engine over a plugin whose requests to `/never` never answer and the rest answer at once,
 * with a 1 s budget and a 2 s ceiling, and the signal each request was sent with.
 */
function sideBySide() {
  const signals = [];
  const pluginDir = join(scratchDir('lp-'), 'side-by-side');
  mkdirSync(pluginDir);
  writeFileSync(join(pluginDir, 'side-by-side-plugin.js'), `/* yonto-plugin
{"kind":"content-source","id":"side-by-side","name":"Side by side","version":"1.0.0","contractVersion":21,"provides":"source-type","allowedHosts":["site.test"]}
*/
export default {
  async getCategories() { return []; },
  async hangs() { await yonto.fetch('https://site.test/never'); return 'answered'; },
  async twice() {
    await yonto.fetch('https://site.test/x');
    await yonto.sleep(200);
    await yonto.fetch('https://site.test/y');
    return 'twice';
  },
  async quick() { return 'quick'; },
};
`);
  const host = createHost({
    pluginDir,
    manifest: loadManifest(pluginDir),
    transport: {
      request: ({ url, signal }) => new Promise((resolve, reject) => {
        signals.push(signal);
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason));
        if (!url.endsWith('/never')) resolve({ status: 200, headers: {}, bodyBase64: '' });
      }),
    },
    storeDir: scratchDir('lp-'),
  });
  return { e: createEngine({ dir: pluginDir, host, timeoutMs: 1000, ceilingMs: 2000 }), signals };
}

// Found in review of kangzj/yonto#630: the second call's start took the first one's ceiling,
// and the first never ended.
test('a call started beside another does not take that one\'s ceiling', async () => {
  const { e, signals } = sideBySide();
  await e.call('quick', []);

  const started = Date.now();
  const hangs = e.call('hangs', []).then(() => 'answered', (error) => error.code);
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  const quick = await e.call('quick', []);
  const outcome = await Promise.race([hangs, new Promise((resolve) => { setTimeout(() => resolve('still pending'), 6000); })]);

  assert.equal(quick, 'quick');
  assert.equal(outcome, 'TIMEOUT');
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  // The request it left is cancelled once no call is left running.
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
});

// Found in review of kangzj/yonto#630: a call that started and ended beside another cancelled
// the requests that other made after it.
test('a call that ends beside another does not cancel that one\'s later requests', async () => {
  const { e } = sideBySide();
  await e.call('quick', []);

  const twice = e.call('twice', []);
  await new Promise((resolve) => { setTimeout(resolve, 100); });

  assert.equal(await e.call('quick', []), 'quick');
  assert.equal(await twice, 'twice');
});

test('a call that ends cancels the requests it left, as on the device', async () => {
  const signals = [];
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(realmDir),
    transport: { request: ({ signal }) => { signals.push(signal); return new Promise(() => {}); } },
    storeDir: scratchDir('lp-'),
  });
  const e = createEngine({ dir: realmDir, host, timeoutMs: 200 });

  await assert.rejects(() => e.call('fetchesThenSpins', []), (error) => error.code === Code.TIMEOUT);

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
});

test('a call that timed out does not take the next one with it', async () => {
  // `pumping` used to be one set for the whole engine, and a call the ceiling gave up on
  // left its host promise in it — so the next call waited on the abandoned one. doctor
  // runs seven methods on one engine and reports each, so a single slow getMediaList
  // turned the other six into timeouts and told the author everything was broken.
  //
  // Parked in a fetch, not a sleep: since #169 a sleep past the call's budget is refused
  // before it parks, so `slowSleep` leaves no outstanding host promise to strand the next
  // call on — it would pass here having exercised none of the above.
  const e = engineOverSlowSite({ timeoutMs: 250, ceilingMs: 250, siteDelayMs: 600 });

  await assert.rejects(() => e.call('slowFetch', []), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
  assert.equal(await e.call('fine', []), 'fine', 'the engine is still usable');
});

test('a host answer that cannot be encoded fails that call and no other', async () => {
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(realmDir),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    storeDir: scratchDir('lp-'),
  });
  host.yonto.store.get = async () => 1n; // JSON cannot carry a BigInt
  const e = createEngine({ dir: realmDir, host, timeoutMs: 2000 });

  await assert.rejects(() => e.call('readsStore', []), (error) => {
    assert.equal(error.code, Code.METHOD_THREW, 'a failure to encode is still a failure, not an escape');
    return true;
  });
  assert.equal(await e.call('fine', []), 'fine', "and it stays that call's problem");
});

test('a plugin whose default export is not an object is MISSING_EXPORT', async () => {
  // `export default 42` made Object.keys return [] and doctor report all seven methods as
  // simply absent; the device answers MISSING_DEFAULT for the same plugin.
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/bad-default/', import.meta.url)),
  });
  await assert.rejects(() => e.exports(), (error) => {
    assert.equal(error.code, Code.MISSING_EXPORT);
    assert.match(error.message, /default-export an object of methods/);
    return true;
  });
});

test('plugin code that runs while a method is being looked up is interrupted too', async () => {
  // A getter is plugin code with nothing above it, and it runs before the call starts —
  // so a ceiling armed after the lookup is a ceiling that never fires. The race cannot
  // help either: the loop owns the event loop.
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/spinning-lookup/', import.meta.url)),
    timeoutMs: 200,
  });
  await assert.rejects(() => e.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});

test('a plugin that spins while its exports are read is interrupted', async () => {
  // Object.keys does not call a getter, so this one is a Proxy: listing what a plugin
  // exports is plugin code too when the plugin says so.
  const { engine: e } = engine({
    pluginDir: fileURLToPath(new URL('../test-plugins/spinning-keys/', import.meta.url)),
    timeoutMs: 200,
  });
  await assert.rejects(() => e.exports(), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});

test('a call the ceiling gave up on cannot resume unbounded later', async () => {
  // The pump is what runs a plugin's continuation, and an answer belonging to an
  // abandoned call lands there too — after that call returned, with the interrupt
  // disarmed unless the pump arms one. A `while (true)` after an `await` then hangs the
  // CLI for good: no race can win against a loop that owns the event loop. If this
  // regresses the test does not fail, it hangs, which is the same thing to CI.
  //
  // The park is a fetch for the same reason as the test above: a sleep that outlives the
  // ceiling no longer parks at all, so `sleepThenSpin` can no longer reach its own spin.
  const e = engineOverSlowSite({ timeoutMs: 300, ceilingMs: 300, siteDelayMs: 500 });

  await assert.rejects(() => e.call('fetchThenSpin', []), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });

  // Long enough for the abandoned fetch to land and pump the queue.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await e.call('fine', []), 'fine', 'the engine survived the orphan resuming');
});

/**
 * What a plugin may spend in `yonto.sleep`: its call's own budget, and no more.
 *
 * The interrupt is only checked while JS is running and the wall-clock ceiling is far above
 * the budget, so neither reaches a sleeping plugin in time; the budget is where the bound
 * lives, and both hosts carry it. `PluginSleepBudgetTest` holds
 * the Kotlin half to these same numbers. kangzj/lantern-tv#169.
 */
test('a sleep longer than the call\'s whole budget fails it rather than parking', async () => {
  const { engine: e } = engine({ pluginDir: realmDir, timeoutMs: 200 });
  // Loaded first, so what is timed is the sleep and not bundling the plugin and starting
  // QuickJS, which a busy machine can take longer than the bound over (found in review of
  // kangzj/yonto#630).
  await e.call('fine', []);

  const started = Date.now();
  await assert.rejects(() => e.call('sleepsFor', [9000]), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
  // The elapsed time is the assertion and the code alone would not be: before the budget
  // the device's same call came back after 9043 ms having succeeded.
  assert.ok(Date.now() - started < 150, `took ${Date.now() - started} ms; the sleep was supposed never to park`);
});

test('a loop of short sleeps is stopped', async () => {
  // The row a ceiling on one sleep does not reach: 20 is well inside the budget, so a
  // clamp never fires. Measured on the device before the budget existed, this shape ran
  // 1105 times whatever the plugin passed, whatever the budget said.
  //
  // The sleep budget and the call's deadline stop it here as on the device, since the race
  // is now the device's ceiling (kangzj/yonto#513).
  const { engine: e } = engine({ pluginDir: realmDir, timeoutMs: 200 });

  await assert.rejects(() => e.call('sleepLoop', [20]), (error) => {
    assert.equal(error.code, Code.TIMEOUT);
    return true;
  });
});

test('each call is given the budget again', async () => {
  // doctor runs seven methods over one host, so a budget that were per host rather than
  // per call would fail a later method for what an earlier one spent — a plugin resting
  // politely between pages would be the one it happened to.
  const { engine: e } = engine({ pluginDir: realmDir, timeoutMs: 200 });

  assert.equal(await e.call('sleepsFor', [120]), 'slept');
  assert.equal(await e.call('sleepsFor', [120]), 'slept');
  assert.equal(await e.call('sleepsFor', [120]), 'slept');
});

test('a module body that throws with a host call in flight still reports its own throw', async () => {
  // Disposing a runtime with an outstanding async host call makes QuickJS abort rather
  // than free, and the RuntimeError that produces is not what stopped the plugin.
  const host = createHost({
    pluginDir: '/probe/engine',
    manifest: loadManifest(throwsAfterFetchDir),
    transport: {
      async request() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { status: 200, headers: {}, bodyBase64: '' };
      },
    },
    storeDir: scratchDir('lp-'),
  });
  const e = createEngine({ dir: throwsAfterFetchDir, host, timeoutMs: 2000 });

  await assert.rejects(() => e.exports(), (error) => {
    assert.equal(error.code, Code.METHOD_THREW, 'not a WASM abort surfacing as a RuntimeError');
    assert.match(error.message, /module body gave up/);
    return true;
  });
});
