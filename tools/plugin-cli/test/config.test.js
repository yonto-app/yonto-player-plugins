import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configOf } from '../src/config.js';
import { Code } from '../src/errors.js';

// The record PluginConfigRecordTest holds the device's form to, so what a plugin reads as
// `yonto.config` cannot differ between the two hosts (kangzj/lantern-tv#414).
const record = JSON.parse(readFileSync(new URL('../conformance/config.json', import.meta.url), 'utf8'));

for (const { why, given, received, refused } of record.cases) {
  test(`config: ${why}`, () => {
    if (refused === undefined) {
      assert.deepEqual(configOf(record.configSchema, given), received);
      return;
    }
    assert.throws(() => configOf(record.configSchema, given), (error) => {
      assert.equal(error.code, Code.CONFIG_INVALID);
      assert.equal(error.detail.id, refused);
      return true;
    });
  });
}

test('a field named like something every object inherits is still only its answer', () => {
  // The schema allows `toString` as an id, and reading an unanswered one off a plain object
  // hands back Object.prototype's function rather than nothing.
  const schema = [{ id: 'toString', type: 'text', label: 'T' }, { id: 'constructor', type: 'bool', label: 'B' }];

  assert.deepEqual(configOf(schema, {}), { constructor: 'false' });
  assert.deepEqual(configOf(schema, { toString: ' x ' }), { toString: 'x', constructor: 'false' });
});

// The record PluginHostConfigRecordTest holds the device's PluginManifest.configFor to: only
// what a field declares reaches a plugin.
const hostRecord = JSON.parse(readFileSync(new URL('../conformance/host-config.json', import.meta.url), 'utf8'));

for (const { why, values, received } of hostRecord.cases) {
  test(`host config: ${why}`, () => {
    assert.deepEqual(configOf(hostRecord.configSchema, values), received);
  });
}
