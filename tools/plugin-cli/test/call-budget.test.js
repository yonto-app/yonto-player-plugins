import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callsInChild } from '../test-support/calls-in-child.js';

const dir = fileURLToPath(new URL('../conformance/call-budget/', import.meta.url));
const record = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));

// kangzj/yonto#513. `CallBudgetRecordTest` walks the same record through the device.
//
// In a child: a host that stops adding up a call's runs never cuts `yieldThenSpin`, which
// then outlives its call and keeps whatever process it is in from exiting.
for (const { why, warmsUp = true, method, args, answers, fails, endsWithinMs: [earliest, latest] } of record.cases) {
  test(`call budget: ${why}`, async () => {
    const outcomes = await callsInChild({
      pluginDir: dir,
      timeoutMs: record.budgetMs,
      siteAnswersAfterMs: record.siteAnswersAfterMs,
      calls: [...(warmsUp ? [{ method: 'ready', args: [] }] : []), { method, args }],
    });
    const { tookMs, endedAtMs, ...outcome } = outcomes.at(-1);

    assert.deepEqual(outcome, fails === undefined ? { answer: answers } : { code: fails });
    assert.ok(tookMs >= earliest && tookMs <= latest, `took ${tookMs} ms, not ${earliest}-${latest}`);
  });
}
