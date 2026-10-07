import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Code } from '../src/errors.js';
import { buildPlugin } from '../src/build.js';
import { scratchDir } from '../src/scratch-dir.js';

const unresolvedImportDir = fileURLToPath(new URL('../test-plugins/unresolved-import/', import.meta.url));
const twoUnresolvedDir = fileURLToPath(new URL('../test-plugins/two-unresolved-imports/', import.meta.url));

async function failureOf(dir) {
  try {
    await buildPlugin(dir, { format: 'esm' });
  } catch (error) {
    return error;
  }
  return assert.fail(`${dir} built`);
}

test('a plugin reached through a symlink is still named from its own directory', async () => {
  // esbuild reports the real path and the author typed the link: macOS's /tmp is one, which
  // is where kangzj/lantern-tv#452's own reproduction lived.
  const link = join(scratchDir('lp-'), 'unresolved-import');
  symlinkSync(unresolvedImportDir, link);

  const error = await failureOf(link);

  assert.equal(error.code, Code.BUILD_FAILED);
  assert.match(error.message, /could not be built: unresolved-import-plugin\.js:14:23: /);
});

test('every reason a build failed is on the one line', async () => {
  const error = await failureOf(twoUnresolvedDir);

  assert.equal(error.message.split('\n').length, 1, error.message);
  assert.match(error.message, /nowhere\.js.*elsewhere\.js/);
});

test('a failure esbuild gives no location for is still a sentence', async () => {
  const error = await failureOf(scratchDir('lp-'));

  assert.equal(error.code, Code.BUILD_FAILED);
  assert.match(error.message, /-plugin\.js could not be built: Could not resolve/);
});

test('a failure esbuild has no structured reasons for keeps its own message', async () => {
  let error;
  try {
    await buildPlugin(unresolvedImportDir, { format: 'nope' });
  } catch (thrown) {
    error = thrown;
  }

  assert.equal(error?.code, Code.BUILD_FAILED);
  assert.match(error.message, /could not be built: .*Invalid value "nope"/);
});
