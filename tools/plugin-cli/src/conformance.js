import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHost } from './host/index.js';
import { createReplayTransport } from './transport/replay.js';
import { linkRecord } from './link-login.js';
import { loadManifest } from './manifest.js';
import { createEngine } from './engines/quickjs.js';
import { scratchDir } from './scratch-dir.js';

// Calls the probe's own `raiseHandBuiltNotFound` and reports what the engine turned it
// into — this is what proves duck-typing on `code` rather than construction site, outside
// `getCategories` because a thrown value there would abort every other case.
async function describeThrown(engine) {
  try {
    await engine.call('raiseHandBuiltNotFound', []);
    return 'did not throw';
  } catch (error) {
    return `${error.code}: ${error.message}`;
  }
}

// `override['yonto.crypto.md5']` reaches `yonto.crypto.md5` — every override used by
// this suite is two segments deep, one host-API namespace and one function on it. Known
// limit, not generalised: a one-segment override such as `'yonto.fetch'` reads as
// namespace `fetch`, key `undefined`, so it clobbers `patched.fetch` with an object keyed
// `"undefined"` instead of replacing the top-level function directly.
function withOverride(yonto, override) {
  const patched = { ...yonto };
  for (const [path, replacement] of Object.entries(override)) {
    const [, namespace, key] = path.split('.');
    patched[namespace] = { ...patched[namespace], [key]: replacement };
  }
  return patched;
}

/**
 * The instant both hosts run this suite at. A clock that is the host's is the point of
 * `yonto.now()`, so the suite states one rather than reading the wall clock — and the
 * Android side states the same number, which is what makes the `now` case comparable.
 */
export const CONFORMANCE_NOW = 1_700_000_000_000;

/**
 * The library both hosts are told the viewer picked. Stated rather than left unset, because
 * an unset one and a dropped one are the same answer — `null` — and telling those apart is
 * the whole of what this case can check.
 */
export const CONFORMANCE_SUB_SOURCE = 'library-b';

/**
 * Runs the conformance plugin's probe over a replayed fixture set and compares every
 * value it returns against `expected.json`. Plan 2's JVM test runs the same plugin
 * through the Android host implementation and asserts the same file, which is what
 * stops the two `yonto.*` implementations drifting apart.
 */
export async function runConformance({ dir, engineFactory, override = {}, write = false }) {
  const manifest = loadManifest(dir);
  const transport = createReplayTransport({ dir: join(dir, 'fixtures') });
  const storeDir = scratchDir(`yonto-${manifest.id}-`);
  // Checked in beside expected.json, because what the host is configured with decides
  // which hosts a plugin may reach — see the `allowlist` case.
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  // Who wrote those values, for a suite that runs as a catalog made from a repo: the keys the
  // viewer typed and the repo's address. Absent, the suite is an ordinary plugin profile.
  const originPath = join(dir, 'origin.json');
  const origin = existsSync(originPath) ? JSON.parse(readFileSync(originPath, 'utf8')) : null;
  // What the host holds for a suite about a linked plugin: the account credential, linked under
  // the suite's own manifest, with the host's own requests answered from `fixtures/host/`.
  const sessionPath = join(dir, 'session.json');
  const session = existsSync(sessionPath)
    ? { credential: JSON.parse(readFileSync(sessionPath, 'utf8')).credential, record: linkRecord(manifest, CONFORMANCE_NOW) }
    : null;
  const host = createHost({
    manifest, config, transport, storeDir, pluginDir: dir, now: () => CONFORMANCE_NOW,
    subSource: CONFORMANCE_SUB_SOURCE, origin, session,
    hostTransport: createReplayTransport({ dir: join(dir, 'fixtures', 'host') }),
  });
  const engine = engineFactory({ dir, host: { ...host, yonto: withOverride(host.yonto, override) } });

  const actual = await engine.call('getCategories', []);
  actual.push({ id: 'errorDuckTyped', name: await describeThrown(engine) });
  // What a call ends in, for a suite about the host's verdicts: each method in calls.json,
  // in order on this one runtime, and the code it ended in, or `answered`. The code only,
  // because each host words its own METHOD_THREW.
  const callsPath = join(dir, 'calls.json');
  for (const method of existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : []) {
    const verdict = await engine.call(method, []).then(() => 'answered', (error) => error.code);
    actual.push({ id: `call:${method}`, name: verdict });
  }

  const expectedPath = join(dir, 'expected.json');
  if (write) {
    const expected = Object.fromEntries(actual.map((c) => [c.id, c.name]));
    writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
    return { cases: actual.map((c) => ({ name: c.id, ok: true, expected: c.name, actual: c.name })), ok: true };
  }

  if (!existsSync(expectedPath)) {
    throw new Error(`${expectedPath} does not exist — run once with { write: true } to record it`);
  }
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  const cases = actual.map((c) => ({ name: c.id, ok: c.name === expected[c.id], expected: expected[c.id], actual: c.name }));
  return { cases, ok: cases.every((c) => c.ok) };
}

// `node src/conformance.js --write-expected` — the one-time authoring step from the
// conformance suite's README: record what the Node host actually returns, then read and
// verify every value by hand before trusting it as `expected.json`.
async function main() {
  if (!process.argv.includes('--write-expected')) {
    console.error('usage: node src/conformance.js --write-expected');
    process.exitCode = 2;
    return;
  }
  const dir = fileURLToPath(new URL('../conformance/host-api/', import.meta.url));
  const report = await runConformance({ dir, engineFactory: createEngine, write: true });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
