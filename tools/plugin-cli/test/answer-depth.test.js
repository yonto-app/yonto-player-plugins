import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engines/quickjs.js';
import { createHost } from '../src/host/index.js';
import { loadManifest } from '../src/manifest.js';
import { scratchDir } from '../src/scratch-dir.js';

const dir = fileURLToPath(new URL('../conformance/answer-depth/', import.meta.url));
const record = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));
const limits = JSON.parse(readFileSync(fileURLToPath(new URL('../conformance/limits.json', import.meta.url)), 'utf8'));

const nested = (depth) => {
  let value = [];
  for (let i = 1; i < depth; i++) value = [value];
  return value;
};

// `PluginAnswerDepthRecordTest` walks the same record through the device.
test('an answer nests as deep as conformance/answer-depth/calls.json says, and no deeper', async () => {
  const depthOf = (depth) => ({ limit: limits.answerDepth, 'limit+1': limits.answerDepth + 1 }[depth] ?? depth);
  const host = createHost({
    manifest: loadManifest(dir),
    config: {},
    transport: { async request() { throw new Error('no requests in this record'); } },
    storeDir: scratchDir('lp-answer-depth-'),
    pluginDir: dir,
  });
  const engine = createEngine({ dir, host });

  for (const { why, method, depth, answer, code, message } of record.calls) {
    const args = depth === undefined ? [] : [depthOf(depth)];
    if (code === undefined) {
      assert.deepEqual(await engine.call(method, args), answer === 'nested' ? nested(depthOf(depth)) : answer, why);
      continue;
    }
    const thrown = await engine.call(method, args).then(
      () => assert.fail(`${why}: the call answered`),
      (error) => error,
    );
    assert.equal(thrown.code, code, why);
    assert.equal(thrown.message, message.replaceAll('{limit}', limits.answerDepth), why);
  }
});
