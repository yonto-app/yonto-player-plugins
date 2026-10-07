import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndex } from '../src/index-reader.js';
import { YONTO_TYPES } from '../src/yonto-types.js';

const casesDir = fileURLToPath(new URL('../conformance/index-reading/', import.meta.url));

const cases = readdirSync(casesDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .flatMap((file) => JSON.parse(readFileSync(join(casesDir, file), 'utf8')).map((c) => ({ file, ...c })));

const bytesOf = (c) => (c.body !== undefined ? Buffer.from(c.body, 'utf8') : Buffer.from(c.bodyBase64, 'base64'));

test('conformance/index-reading is not empty, and every case says where it came from', () => {
  assert.ok(cases.length > 30, `only ${cases.length} cases`);
  for (const c of cases) {
    assert.ok(c.about, `${c.file}: "${c.name}" says nothing about where it came from`);
    assert.equal(c.file.startsWith('synthetic'), c.about.startsWith('Synthetic'), `${c.file}: "${c.name}"`);
  }
});

for (const c of cases) {
  test(`index-reading ${c.file}: ${c.name}`, () => {
    assert.deepEqual(readIndex(bytesOf(c), c.dialect ?? null), c.expected);
  });
}

test('every name in conformance/yonto-type-names.json is known as a type-50 entry exactly when the grammar says', () => {
  const { cases: names } = JSON.parse(readFileSync(new URL('../conformance/yonto-type-names.json', import.meta.url), 'utf8'));
  for (const { name, accepted } of names) {
    const document = { sites: [{ key: 'k', type: 50, api: 'https://t.example.com/', ext: { yontoType: name } }] };
    const read = readIndex(Buffer.from(JSON.stringify(document)));
    const known = YONTO_TYPES.has(name) || (accepted && name.includes('.'));
    assert.equal(read.entries.length, known ? 1 : 0, `${name.length > 40 ? `${name.slice(0, 40)}… (${name.length})` : name}`);
  }
});
