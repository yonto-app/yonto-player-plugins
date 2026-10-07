import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { headerFor, headerJson, headerSafe, MAX_HEADER_CHARS } from '../src/header.js';

const record = JSON.parse(
  readFileSync(fileURLToPath(new URL('../conformance/headers.json', import.meta.url)), 'utf8'));

// The same record PluginHeaderConformanceTest walks, so a rule that moves on one host and
// not the other is a red test rather than a plugin that installs on a laptop and not a
// television.
test('the CLI host reads a header the way the record says', () => {
  for (const { why, source, manifestJson } of record.cases) {
    if (manifestJson === null) {
      assert.throws(() => headerJson(source), why);
    } else {
      assert.equal(headerJson(source), manifestJson, why);
    }
  }
});

test('the terminator is looked for within the cap, not to the end of a hostile file', () => {
  const far = `/* yonto-plugin\n{}${' '.repeat(MAX_HEADER_CHARS)}*${'/'}`;

  assert.throws(() => headerJson(far), /not closed within/);
});

test('a manifest that would close its own header early is refused rather than escaped', () => {
  // An escape a reader cannot see is worse than a refusal: the file would look like a
  // manifest and be read as one ending somewhere else.
  assert.equal(headerSafe(`{"name":"a*${'/'}b"}`), false);
  assert.throws(() => headerFor({ name: `a*${'/'}b` }), /cannot contain/);
});

test('what bundle writes is what the reader reads back', () => {
  const manifest = { kind: 'content-source', id: 'round', name: 'Round', version: '1.0.0' };

  assert.deepEqual(JSON.parse(headerJson(`${headerFor(manifest)}export default {};`)), manifest);
});
