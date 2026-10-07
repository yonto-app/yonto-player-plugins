import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callsInChild } from '../test-support/calls-in-child.js';

const dir = fileURLToPath(new URL('../conformance/exported-then/', import.meta.url));
const record = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));

// `ExportedThenRecordTest` walks the same record through the device. In a child, because the
// engine these guard against hung on two of them for good.
for (const { plugin, method, answers } of record.cases) {
  test(`exported then: ${plugin} loads and answers`, async () => {
    const [outcome] = await callsInChild({
      pluginDir: join(dir, plugin),
      timeoutMs: record.budgetMs,
      calls: [{ method, args: [] }],
    });

    assert.equal(outcome.answer, answers, JSON.stringify(outcome));
  });
}
