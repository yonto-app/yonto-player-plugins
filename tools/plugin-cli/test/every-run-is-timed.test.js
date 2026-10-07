import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../src/scratch-dir.js';
import { callsInChild } from '../test-support/calls-in-child.js';

// In a child, because what these guard against freezes the process it happens in
// (found in review of kangzj/yonto#630).
const realmDir = fileURLToPath(new URL('../test-plugins/realm/', import.meta.url));
const inChild = ({ pluginDir = realmDir, timeoutMs = 300, ...rest }) => callsInChild({ pluginDir, timeoutMs, ...rest });

/**
 * [method]'s outcome on a realm engine already loaded by a first call, so its time is the
 * call's alone and not the bundle's and QuickJS's start, which a busy machine can take
 * seconds over (found in review of kangzj/yonto#630).
 */
async function afterWarmUp(method) {
  const [, outcome] = await inChild({ calls: [{ method: 'fine', args: [] }, { method, args: [] }] });
  return outcome;
}

/** Cut at about one budget of 300 ms: well under the default 85 s ceiling it would otherwise wait for. */
function assertCutAtTheBudget(outcome) {
  assert.equal(outcome.code, 'TIMEOUT');
  assert.ok(outcome.tookMs >= 250 && outcome.tookMs < 3000, `took ${outcome.tookMs} ms, not about the 300 ms budget`);
}

test('a Promise.prototype.then that loops is cut when the host reads the answer', async () => {
  const outcome = await afterWarmUp('thenLoops');

  assertCutAtTheBudget(outcome);
});

test('a Promise constructor getter that loops is cut when the host reads the answer', async () => {
  const outcome = await afterWarmUp('constructorLoops');

  assertCutAtTheBudget(outcome);
});

test('a thrown object whose toJSON loops is METHOD_THREW in moments, not a hang', async () => {
  const outcome = await afterWarmUp('throwsLoopingToJson');

  // Read under a ceiling of its own (`DUMP_MS`), which stopped a getter and not the call.
  assert.equal(outcome.code, 'METHOD_THREW');
  assert.ok(outcome.tookMs < 3000, `took ${outcome.tookMs} ms`);
});

/** A copy of the `ok` plugin named [id], whose module is [body]. */
function pluginOf(id, body) {
  const pluginDir = join(scratchDir('lp-'), id);
  cpSync(fileURLToPath(new URL('../test-plugins/ok/', import.meta.url)), pluginDir, { recursive: true });
  renameSync(join(pluginDir, 'ok-plugin.js'), join(pluginDir, `${id}-plugin.js`));
  const source = readFileSync(join(pluginDir, `${id}-plugin.js`), 'utf8').replace('"id": "ok"', `"id": "${id}"`);
  writeFileSync(join(pluginDir, `${id}-plugin.js`), `${source.slice(0, source.indexOf('*/') + 2)}\n${body}\n`);
  return pluginDir;
}

test('a module body that leaves a looping then is cut when the host waits on its evaluation', async () => {
  const pluginDir = pluginOf('loops-in-then', `
Promise.prototype.then = function () { for (;;) { /* the host's own resolvePromise calls this */ } };
export default {};`);

  const [outcome] = await inChild({ pluginDir, calls: [{ method: 'getCategories', args: [] }] });

  // Nothing to warm up with, since the load is what is cut, so the bound is wide: the first
  // call bundles the plugin and starts QuickJS too. Anything well under the 85 s ceiling
  // tells a cut load from one that waited for the ceiling.
  assert.equal(outcome.code, 'TIMEOUT');
  assert.ok(outcome.tookMs >= 250 && outcome.tookMs < 20000, `took ${outcome.tookMs} ms, not a cut load`);
});

test('a module body that puts a looping accessor where the host used to hand over its exports still loads', async () => {
  // The device keeps the namespace inside a module; the CLI wrote and read it through this
  // global, running whatever setter or getter the body left there with nothing timing it.
  const pluginDir = pluginOf('accessor', `
Object.defineProperty(globalThis, '__yontoPlugin', { set() { for (;;) {} }, get() { for (;;) {} } });
export default { async getCategories() { return [{ id: 'a', name: 'answered' }]; } };`);

  const [outcome] = await inChild({ pluginDir, calls: [{ method: 'getCategories', args: [] }] });

  assert.deepEqual(outcome.answer, [{ id: 'a', name: 'answered' }]);
});

test('a microtask chain the call never awaits is cut at the budget, not the ceiling', async () => {
  const outcome = await afterWarmUp('detachedChain');

  assertCutAtTheBudget(outcome);
});

test('a call left asking after its ceiling does not freeze the next call', async () => {
  // The first call parks until its ceiling, at its budget of 300 ms, then goes on asking for
  // 3 s with every ask refused. The second starts from a timer once that loop is under way,
  // with no call in flight to lift the refusals.
  const [abandoned, next] = await inChild({
    ceilingMs: 300,
    pauseMs: 100,
    calls: [{ method: 'outlivesItsCall', args: [3000] }, { method: 'sleepsThenAnswers', args: [] }],
  });

  assert.equal(abandoned.code, 'TIMEOUT');
  // What the second call answers is not the point: the loop's asks land in it, and it waits
  // for them as quickjs-kt's `evaluate` waits for every async host call, so its own ceiling
  // ends it. What matters is that the ceiling, a timer, still fires: a process whose timers
  // the loop starved ends the next call only once the loop gives up.
  assert.ok(next.endedAtMs < 2000, `the next call ended ${next.endedAtMs} ms after the first began, behind the 3 s loop`);
});
