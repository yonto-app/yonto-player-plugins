import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport } from '../src/format.js';
import { METHODS } from '../src/contract.js';
import { NEXT_PAGE_STEP } from '../src/doctor.js';

const manifest = {
  id: 'test-plugin',
  version: '1.0.0',
  contractVersion: 21,
  allowedHosts: ['example.com'],
};

test('formatReport includes manifest information', () => {
  const report = { steps: [], ok: true };
  const output = formatReport(manifest, report, []);
  assert.match(output, /test-plugin/);
  assert.match(output, /1\.0\.0/);
  assert.match(output, /example\.com/);
});

test('formatReport shows a passing step', () => {
  const report = {
    steps: [
      { method: 'getCategories', ok: true, message: '5 items', ms: 123, requests: 1, warnings: [] },
    ],
    ok: true,
  };
  const output = formatReport(manifest, report, []);
  assert.match(output, /✓.*getCategories.*5 items.*123 ms.*1 request/);
});

test('formatReport shows 0 ms for a step that ran, rather than reading as skipped', () => {
  const report = {
    steps: [
      { method: 'getFilters', ok: true, skipped: false, message: '0 items', ms: 0, requests: 1, warnings: [] },
    ],
    ok: true,
  };
  const output = formatReport(manifest, report, []);
  assert.match(output, /getFilters.*0 items.*0 ms.*1 request/);
});

test('formatReport shows a failing step with code and message', () => {
  const report = {
    steps: [
      {
        method: 'getMediaDetail',
        ok: false,
        message: 'title not found',
        code: 'RESULT_INVALID',
        ms: 456,
        requests: 1,
        detail: { stack: 'Error: not found\n    at getMediaDetail (index.js:10:5)' },
      },
    ],
    ok: false,
  };
  const output = formatReport(manifest, report, []);
  assert.match(output, /✗.*getMediaDetail.*RESULT_INVALID.*title not found/);
  assert.match(output, /at getMediaDetail/);
});

test('formatReport leaves a passing step\'s code out of the line', () => {
  const report = {
    steps: [
      { method: 'getRecommendations', ok: true, skipped: true, code: 'MISSING_EXPORT',
        message: 'not exported (optional)', ms: 0, requests: 0 },
    ],
    ok: true,
  };
  assert.doesNotMatch(formatReport(manifest, report, []), /MISSING_EXPORT/);
});

test('formatReport shows a skipped step', () => {
  const report = {
    steps: [
      {
        method: 'getMediaDetail',
        ok: false,
        skipped: true,
        message: 'skipped — no item id came out of the previous step',
        ms: 0,
        requests: 0,
      },
    ],
    ok: false,
  };
  const output = formatReport(manifest, report, []);
  assert.match(output, /✗.*getMediaDetail.*skipped/);
});

test('formatReport shows warnings indented beneath the step', () => {
  const report = {
    steps: [
      {
        method: 'getMediaList',
        ok: true,
        message: '3 items',
        ms: 100,
        requests: 1,
        warnings: ['unrecognized type "SERIE" — the app maps this to MOVIE rather than failing'],
      },
    ],
    ok: true,
  };
  const output = formatReport(manifest, report, []);
  const lines = output.split('\n');
  const mediaListLineIdx = lines.findIndex((line) => line.includes('getMediaList'));
  const warningLineIdx = lines.findIndex((line) => line.includes('unrecognized type'));
  assert.ok(mediaListLineIdx !== -1, 'should have getMediaList line');
  assert.ok(warningLineIdx !== -1, 'should have warning line');
  assert.ok(warningLineIdx > mediaListLineIdx, 'warning should come after step');
  assert.match(lines[warningLineIdx], /^\s{4}⚠/);
});

test('formatReport shows failed request headers', () => {
  const report = { steps: [], ok: true };
  const requests = [
    {
      status: 403,
      method: 'GET',
      url: 'https://example.com/api',
      bytes: 512,
      ms: 50,
      blocked: false,
      requestHeaders: { 'User-Agent': 'Mozilla/5.0', 'Authorization': 'Bearer token' },
    },
  ];
  const output = formatReport(manifest, report, requests);
  assert.match(output, /403 GET https:\/\/example\.com\/api/);
  assert.match(output, /User-Agent: Mozilla\/5\.0/);
  // The name, never the value. A 403 is exactly when this report gets pasted into an issue,
  // and 'was the key sent at all' — which is what a debugger needs — is in the name.
  assert.match(output, /Authorization: <12 characters, hidden>/);
  assert.ok(!output.includes('Bearer token'));
});

test('formatReport shows blocked requests', () => {
  const report = { steps: [], ok: true };
  const requests = [
    {
      blocked: true,
      method: 'POST',
      url: 'https://disallowed.com/api',
      requestHeaders: { 'Content-Type': 'application/json' },
    },
  ];
  const output = formatReport(manifest, report, requests);
  assert.match(output, /BLOCKED POST https:\/\/disallowed\.com\/api/);
  assert.match(output, /Content-Type: application\/json/);
});

test('formatReport prints what the plugin said under its step, at every level', () => {
  const report = {
    steps: [
      { method: 'getCategories', ok: true, message: '12 items', ms: 8, requests: 2,
        said: [{ level: 'info', message: 'index names 81, readable 81' }] },
      { method: 'getMediaList', ok: false, code: 'UNAVAILABLE', message: '片源的程序跑不起来', ms: 14, requests: 1,
        said: [{ level: 'warn', message: 'catalog answered badly: fetch failed' }] },
    ],
    ok: false,
  };

  const lines = formatReport(manifest, report, []).split('\n');

  const categories = lines.findIndex((line) => line.includes('getCategories'));
  const tally = lines.findIndex((line) => line.includes('index names 81'));
  assert.ok(tally > categories, 'the tally belongs under the step that produced it');
  assert.match(lines[tally], /^\s{4}· info /);
  // An `info` prints too. Deciding for an author that a level is not worth their attention
  // is how the one line answering their question gets dropped — here it is the line saying
  // the plugin was fine and the site was not.
  assert.match(lines.find((line) => line.includes('fetch failed')), /^\s{4}· warn /);
});

test('formatReport indents the rest of a multi-line thing the plugin said', () => {
  const report = {
    steps: [{ method: 'search', ok: true, message: '2 items', ms: 4, requests: 1,
      said: [{ level: 'warn', message: 'two tabs share one id\nthe second was dropped' }] }],
    ok: true,
  };

  const lines = formatReport(manifest, report, []).split('\n');

  assert.match(lines.find((line) => line.includes('two tabs')), /^\s{4}· warn /);
  assert.equal(lines.find((line) => line.includes('the second was dropped')), '            the second was dropped');
});

test('a log level that is not a string does not take the whole report down', () => {
  // `yonto.log` stores whatever a plugin passed and the host checks nothing, so a level of
  // `1` or `null` reaches here from somebody else's catalog. Before `String(level)` this
  // threw on `padEnd` and the author lost the entire diagnosis — including the steps that
  // had nothing to do with the plugin that logged it. Found in review.
  const report = {
    steps: [{ method: 'getCategories', ok: true, message: '7 items', ms: 5, requests: 2,
      said: [{ level: 1, message: 'a number' }, { level: null, message: 'nothing at all' }] }],
    ok: true,
  };

  const output = formatReport(manifest, report, []);

  assert.match(output, /· 1 {5}a number/);
  assert.match(output, /· null {2}nothing at all/);
});

test('every line of a report starts its payload in one column, whatever step it is', () => {
  // The manifest line sat a column left of the steps, a failed step's stack a column left of
  // its step, and a label longer than the padding pushed its own line right — which every
  // report has, since an unexported method is still a step (kangzj/lantern-tv#446).
  const steps = [...METHODS, NEXT_PAGE_STEP].map((method) => ({ method, ok: true, message: 'ok', ms: 1, requests: 1 }));
  steps.push({ method: 'load', ok: false, code: 'METHOD_THREW', message: 'boom', ms: 1,
    detail: { stack: 'Error: boom\n    at getCategories (p-plugin.js:3:9)' } });
  const lines = formatReport(manifest, { steps }, []).split('\n');

  const columns = new Map([
    [lines[0], lines[0].indexOf('id=')],
    ...lines.filter((line) => / ok /.test(line)).map((line) => [line, line.indexOf(' ok ') + 1]),
    ...lines.filter((line) => line.includes('METHOD_THREW')).map((line) => [line, line.indexOf('METHOD_THREW')]),
    ...lines.filter((line) => line.includes('p-plugin.js:3:9')).map((line) => [line, line.indexOf('at ')]),
  ]);
  assert.equal(columns.size, METHODS.length + 4, 'a line the test meant to measure is missing');
  assert.equal(new Set(columns.values()).size, 1, [...columns].map(([line, at]) => `${at} ${line}`).join('\n'));
});

test('a failed step shows the first frame of its stack, which is where it threw', () => {
  // QuickJS's stack is frames only, with no message line above them to skip past.
  const steps = [{ method: 'load', ok: false, code: 'METHOD_THREW', message: 'boom', ms: 1,
    detail: { stack: '    at <anonymous> (p-plugin.js:19:7)\n    at <eval> (yonto:call:1:16)\n' } }];

  assert.match(formatReport(manifest, { steps }, []), /\n +at <anonymous> \(p-plugin\.js:19:7\)$/m);
});

test("a failed step shows the plugin's own frame, past the host's", () => {
  // A `throw yonto.error.*` is built inside the host's bootstrap, so the host's frame
  // comes first, and so does the host's unwrap under any refusal it passes back.
  const steps = [{ method: 'getMediaList', ok: false, code: 'UNAVAILABLE', message: 'down', ms: 1,
    detail: { stack: '    at unavailable (yonto:host:99:53)\n    at restingError (p-plugin.js:157:35)\n' } }];

  assert.match(formatReport(manifest, { steps }, []), /\n +at restingError \(p-plugin\.js:157:35\)$/m);
});

test("a stack with no frame of the plugin's own shows none", () => {
  const steps = [{ method: 'search', ok: false, code: 'METHOD_THREW', message: 'bad JSON', ms: 1,
    detail: { stack: '    at <input>:1:1\n    at parse (native)\n    at __yontoUnwrap (yonto:host:34:26)\n' } }];

  assert.doesNotMatch(formatReport(manifest, { steps }, []), /^ +at /m);
});

test("a step's notes sit under it, in its payload column", () => {
  const steps = [{ method: 'getFilters', ok: true, message: '2 items', ms: 1, requests: 1, notes: ['类型 opens on 全部 (all)'] }];
  const [line, note] = formatReport(manifest, { steps }, []).split('\n').slice(1);

  assert.equal(note.trim(), '类型 opens on 全部 (all)');
  assert.equal(note.indexOf('类'), line.indexOf('2 items'));
});
