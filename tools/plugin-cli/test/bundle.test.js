import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { bundlePlugin } from '../src/bundle.js';
import { headerJson } from '../src/header.js';
import { scratchDir } from '../src/scratch-dir.js';

const dir = fileURLToPath(new URL('../test-plugins/ok/', import.meta.url));

test('produces the file a plugin is, and a zip carrying exactly that one file', async () => {
  const outDir = scratchDir('lp-out-');
  const { jsPath, zipPath, sha256, bytes } = await bundlePlugin({ dir, outDir });

  assert.match(jsPath, /ok-1\.0\.0\.js$/);
  assert.match(zipPath, /ok-1\.0\.0\.zip$/);
  assert.equal(sha256.length, 64);
  assert.ok(bytes > 0);

  // The file is the artifact: its own manifest in its own header, then the code.
  const file = readFileSync(jsPath, 'utf8');
  assert.equal(JSON.parse(headerJson(file)).id, 'ok');
  assert.match(file, /getCategories/);

  // And the zip is that same file, compressed — one entry, because a manifest in two
  // places is two places that can disagree about where a plugin may reach.
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  assert.deepEqual(Object.keys(zip.files), ['source.js']);
  assert.equal(await zip.file('source.js').async('string'), file);
});

test('the sha256 is of the zip bytes, so the app can verify a download', async () => {
  const outDir = scratchDir('lp-out-');
  const { zipPath, sha256 } = await bundlePlugin({ dir, outDir });
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(readFileSync(zipPath)).digest('hex'), sha256);
});

// This is the assertion that actually carries the reproducibility guarantee — it is what
// pinning each zip entry's `date` (src/bundle.js) is for. A twice-and-compare test alone is
// a placebo here: JSZip's DOS timestamp has 2-second granularity, so two `bundlePlugin()`
// calls back to back in one process essentially never straddle a tick and would pass
// identically with the pin removed. Do not "simplify" this into a sleep-and-hash comparison
// instead — that reintroduces the flakiness (and CI-speed cost) this avoids.
//
// The expected value is 1980-01-01T00:00:00Z, not the Unix epoch: the zip format's DOS
// timestamp cannot represent a year before 1980, so `new Date(0)` would silently wrap to a
// bogus date instead of failing — this is the earliest date the format can actually hold.
const DOS_EPOCH_MS = Date.UTC(1980, 0, 1);

test('each zip entry is dated the earliest the zip format can hold, which is what makes the sha256 reproducible', async () => {
  const outDir = scratchDir('lp-out-');
  const { zipPath } = await bundlePlugin({ dir, outDir });

  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  assert.equal(zip.files['source.js'].date.getTime(), DOS_EPOCH_MS);
});

// Harmless as a smoke check once the assertion above exists, but not sufficient on its
// own — see the comment above.
test('bundling the same plugin twice produces the same sha256', async () => {
  const first = await bundlePlugin({ dir, outDir: scratchDir('lp-out-') });
  const second = await bundlePlugin({ dir, outDir: scratchDir('lp-out-') });
  assert.equal(first.sha256, second.sha256, 'the published hash must be reproducible, not record-once');
});

test('a bundle is the same bytes from any working directory and any parent path', () => {
  // esbuild writes each module's path, relative to its working directory, into the bundle as a
  // comment, so the bytes followed wherever the CLI was run from (kangzj/lantern-tv#638). They
  // are named from the plugin's own directory now, so neither where it is run from nor where the
  // plugin sits changes them. Copies, because `bundle` writes into the plugin's own `dist/`.
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const copyUnder = (...parents) => {
    const plugin = join(scratchDir('lp-cwd-'), ...parents, 'ok');
    mkdirSync(plugin, { recursive: true });
    copyFileSync(join(dir, 'ok-plugin.js'), join(plugin, 'ok-plugin.js'));
    return plugin;
  };
  const bundleFrom = (cwd, pluginDir) => {
    const run = spawnSync(process.execPath, [cli, 'bundle', pluginDir], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const [jsPath, , , sha256] = run.stdout.trim().split('\n');
    return { sha256, text: readFileSync(resolve(cwd, jsPath), 'utf8') };
  };

  const alice = copyUnder('alice', 'plugins');
  const bob = copyUnder('bob');
  const fromInside = bundleFrom(alice, '.');

  assert.equal(bundleFrom(join(alice, '..'), 'ok').sha256, fromInside.sha256);
  assert.equal(bundleFrom(join(alice, '..', '..', '..'), relative(join(alice, '..', '..', '..'), alice)).sha256, fromInside.sha256);
  assert.equal(bundleFrom(bob, '.').sha256, fromInside.sha256);
  // Named by its own file name: no directory above the plugin reaches the artifact.
  assert.match(fromInside.text, /\/\/ ok-plugin\.js\n/);
  assert.ok(!fromInside.text.includes('alice') && !fromInside.text.includes('lp-cwd-'), 'a parent path is in the bundle');
});
