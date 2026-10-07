import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../src/scratch-dir.js';

// The wrapper runs this file too, so a wrapper that swallows exit codes would report these
// failing as a pass: every test asserts on what the run printed as well as how it ended.

const runTests = fileURLToPath(new URL('../scripts/run-tests.js', import.meta.url));
const scratchDirModule = new URL('../src/scratch-dir.js', import.meta.url).href;

const LEAVES_ONE = `
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const leaveOne = () => mkdtempSync(join(tmpdir(), 'lp-left-'));`;

function probe(body) {
  const file = join(scratchDir('lp-run-tests-'), 'probe.test.js');
  writeFileSync(file, `import { test } from 'node:test';\n${body}\n`);
  // Without NODE_TEST_CONTEXT, which would make the inner runner report to this one instead.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  // Node defaults to TAP off a TTY before Node 23, so ask for the reporter the assertions read.
  return { args: [runTests, '--test-reporter=spec', file], env };
}

function runTestsOver(body) {
  const { args, env } = probe(body);
  return spawnSync(process.execPath, args, { encoding: 'utf8', env });
}

/** Whether [pid] is still there a few seconds on, which is time enough for a runner to stop it. */
async function stillRunning(pid) {
  for (let waited = 0; waited < 5_000; waited += 50) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
    await sleep(50);
  }
  return true;
}

/**
 * Runs a probe whose one test writes its pid, `process.ppid` (the node --test runner) and its
 * TMPDIR to a file and then never ends, and hands [act] the runner's pid and the wrapper's once
 * it has started. Says how the wrapper ended, its TMPDIR and, when asked, whether the test file
 * outlived it. The wrapper's group and the runner's are killed whole at the end, so a hanging
 * run cannot outlive a failing test.
 */
async function whileHanging(body, act, { watchTestFile = false } = {}) {
  const started = join(scratchDir('lp-run-tests-'), 'started');
  const { args, env } = probe(`${LEAVES_ONE}
import { mkdirSync, writeFileSync } from 'node:fs';
test('hangs', () => {
  ${body}
  writeFileSync(${JSON.stringify(started)}, JSON.stringify([process.ppid, process.pid, tmpdir()]));
  return new Promise(() => setInterval(() => {}, 1000));
});`);
  const run = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  run.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => run.on('exit', (code, signal) => {
    if (signal !== null) stderr += `\nthe wrapper was ended by ${signal}`;
    resolve(code);
  }));
  let runner;
  try {
    for (let waited = 0; !existsSync(started) || readFileSync(started, 'utf8') === ''; waited += 50) {
      assert.ok(waited < 30_000, 'the probe never started');
      await sleep(50);
    }
    let testFile, testTmpdir;
    [runner, testFile, testTmpdir] = JSON.parse(readFileSync(started, 'utf8'));
    act({ runner, wrapper: run.pid });
    const code = await Promise.race([exited, sleep(30_000, 'still running', { ref: false })]);
    return { code, stderr, testTmpdir, testFileOutlived: watchTestFile && await stillRunning(testFile) };
  } finally {
    for (const group of [run.pid, runner].filter(Boolean)) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

test('npm test fails a run that leaves a temp directory behind, and names it', () => {
  const run = runTestsOver(`${LEAVES_ONE}\ntest('leaves one', leaveOne);`);

  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /left an entry in its TMPDIR: lp-left-\w+\. Make a temp directory with scratchDir/);
});

test('a scratchDir is gone by the end of the run, with what was written into it', () => {
  const run = runTestsOver(`
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '${scratchDirModule}';
test('writes a store', () => { writeFileSync(join(scratchDir('lp-kept-'), 'store.json'), '{}'); });`);

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ℹ pass 1\n/);
  assert.doesNotMatch(run.stderr, /TMPDIR/);
});

test('npm test still fails a run whose tests fail and leave nothing', () => {
  const run = runTestsOver(`test('fails', () => { throw new Error('no'); });`);

  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /ℹ fail 1\n/);
  assert.doesNotMatch(run.stderr, /TMPDIR/);
});

test('a failed run that leaves something points at the failure before scratchDir', () => {
  const run = runTestsOver(`${LEAVES_ONE}\ntest('leaves one and fails', () => { leaveOne(); throw new Error('no'); });`);

  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /left an entry in its TMPDIR: lp-left-\w+\. A test process that was killed or crashed/);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`a run stopped by ${signal} says so, not that a test forgot scratchDir`, async () => {
    const { code, stderr, testFileOutlived } = await whileHanging(
      'leaveOne();', ({ wrapper }) => process.kill(wrapper, signal), { watchTestFile: true });

    assert.equal(code, 128 + constants.signals[signal], stderr);
    assert.equal(testFileOutlived, false);
    assert.match(stderr, new RegExp(`stopped by ${signal} and left an entry in its TMPDIR: lp-left-\\w+, now removed`));
    assert.doesNotMatch(stderr, /scratchDir/);
  });
}

// node --test exits on a stop while its test files may still be writing, so the wrapper waits
// for them before removing the directory they write into.
test('a stopped run waits for a test file still writing into its TMPDIR, then removes it', async () => {
  const { code, stderr, testTmpdir } = await whileHanging(`
    process.on('SIGTERM', () => setTimeout(() => {
      mkdirSync(tmpdir(), { recursive: true });
      writeFileSync(join(tmpdir(), 'written-after-the-stop'), '');
      process.exit(0);
    }, 500));`, ({ wrapper }) => process.kill(wrapper, 'SIGTERM'));

  assert.equal(code, 128 + constants.signals.SIGTERM, stderr);
  assert.match(stderr, /stopped by SIGTERM and left an entry in its TMPDIR: written-after-the-stop, now removed/);
  assert.equal(existsSync(testTmpdir), false);
});

test('a runner killed before it could report is a failed run, and says what ended it', async () => {
  const { code, stderr } = await whileHanging('', ({ runner }) => process.kill(runner, 'SIGKILL'));

  assert.equal(code, 1, stderr);
  assert.match(stderr, /node --test was ended by SIGKILL before it could report/);
  assert.doesNotMatch(stderr, /TMPDIR/);
});
