import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformance } from '../src/conformance.js';
import { createEngine } from '../src/engines/quickjs.js';

const dir = fileURLToPath(new URL('../conformance/host-api/', import.meta.url));
const hostsFromConfigDir = fileURLToPath(new URL('../conformance/hosts-from-config/', import.meta.url));
const privateFloorDir = fileURLToPath(new URL('../conformance/private-floor/', import.meta.url));
const hostVerdictsDir = fileURLToPath(new URL('../conformance/host-verdicts/', import.meta.url));
const linkedDir = fileURLToPath(new URL('../conformance/link-login/host-api/', import.meta.url));

test('the CLI host satisfies the conformance suite', async () => {
  const report = await runConformance({
    dir,
    engineFactory: createEngine,
  });
  const failures = report.cases.filter((c) => !c.ok);
  assert.deepEqual(failures, [], `drifted: ${failures.map((c) => c.name).join(', ')}`);
  assert.equal(report.ok, true);
});

test('a host that returns the wrong value is reported by name', async () => {
  const report = await runConformance({
    dir,
    engineFactory: createEngine,
    override: { 'yonto.crypto.md5': () => 'wrong' },
  });
  assert.equal(report.ok, false);
  assert.equal(report.cases.find((c) => !c.ok).name, 'md5');
});

// The second suite: one manifest flag, read by two hosts, asserted by one file.
test('the CLI host reads hostsFromConfig the way the device does', async () => {
  const report = await runConformance({ dir: hostsFromConfigDir, engineFactory: createEngine });

  const failures = report.cases.filter((c) => !c.ok);
  assert.deepEqual(failures, [], `drifted: ${failures.map((c) => c.name).join(', ')}`);
});

// The fourth suite: a host code stands only where a host function gave it that call, and a
// wrong argument is the plugin's own TypeError in the device's words (kangzj/lantern-tv#342).
test('the CLI host reaches the same verdicts as the device', async () => {
  const report = await runConformance({ dir: hostVerdictsDir, engineFactory: createEngine });

  const failures = report.cases.filter((c) => !c.ok);
  assert.deepEqual(failures, [], `drifted: ${failures.map((c) => `${c.name} (${c.actual})`).join(', ')}`);
});

// A linked plugin's yonto.session, and what yonto.fetch hands it back with every held
// credential masked.
test('the CLI host answers a linked plugin the way the device does', async () => {
  const report = await runConformance({ dir: linkedDir, engineFactory: createEngine });

  const failures = report.cases.filter((c) => !c.ok);
  assert.deepEqual(failures, [], `drifted: ${failures.map((c) => `${c.name} (${c.actual})`).join(', ')}`);
});

// The third suite: the floor under every plugin, and the one exception to it.
test('the CLI host puts the same floor under a plugin that the device does', async () => {
  const report = await runConformance({ dir: privateFloorDir, engineFactory: createEngine });

  const failures = report.cases.filter((c) => !c.ok);
  assert.deepEqual(failures, [], `drifted: ${failures.map((c) => c.name).join(', ')}`);
});

// The floor under a catalog made from a repo: its values are the repo's word, and only the
// host the viewer typed as the repo's address, before redirects, lets one past the floor.
for (const suite of ['repo-on-the-lan', 'repo-redirected', 'repo-typed-host-listed', 'resolved-name']) {
  test(`the CLI host puts the same floor under a repo's catalog that the device does: ${suite}`, async () => {
    const report = await runConformance({ dir: join(privateFloorDir, suite), engineFactory: createEngine });

    const failures = report.cases.filter((c) => !c.ok);
    assert.deepEqual(failures, [], `drifted: ${failures.map((c) => c.name).join(', ')}`);
  });
}
