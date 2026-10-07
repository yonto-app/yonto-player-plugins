// `npm test`: `node --test` with a TMPDIR of its own, failing the run if anything is left in it.
//
//   npm test [-- <node --test arguments>]
//
// Not named test.js: node --test's default patterns include **/test.js, and this runs it.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = mkdtempSync(join(tmpdir(), 'yonto-plugin-test-'));
// In a process group of its own, so a stop reaches the test files too: node --test exits on
// one while its test files are still writing into the directory.
const tests = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: dir },
  detached: true,
});

// macOS answers EPERM, not ESRCH, for a group with only zombies left, which are done writing.
const groupIsGone = (error) => error.code === 'ESRCH' || error.code === 'EPERM';

function signalGroup(signal) {
  try {
    process.kill(-tests.pid, signal);
  } catch (error) {
    if (!groupIsGone(error)) throw error;
  }
}

function groupAlive() {
  try {
    process.kill(-tests.pid, 0);
    return true;
  } catch (error) {
    return !groupIsGone(error);
  }
}

async function groupGone(withinMs) {
  for (let waited = 0; groupAlive(); waited += 50) {
    if (waited >= withinMs) return false;
    await sleep(50);
  }
  return true;
}

// Detached, the group outlives a wrapper that dies on its own; this covers the deaths that exit.
process.on('exit', () => signalGroup('SIGTERM'));

// Passed on rather than obeyed, so the directory is still removed when a run is stopped. As
// SIGTERM, because node --test dies outright on a SIGHUP and orphans its test files.
let stoppedBy = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stoppedBy ??= signal;
    signalGroup('SIGTERM');
  });
}
const status = await new Promise((resolve) => tests.on('exit', (code, signal) => {
  if (signal !== null) console.error(`✗ node --test was ended by ${signal} before it could report`);
  resolve(code ?? 1);
}));

if (!await groupGone(0)) {
  signalGroup('SIGTERM');
  if (!await groupGone(10_000)) {
    signalGroup('SIGKILL');
    await groupGone(5_000);
  }
}

const left = readdirSync(dir);
let removed = true;
try {
  rmSync(dir, { recursive: true, force: true });
} catch (error) {
  removed = false;
  console.error(`✗ could not remove ${dir}: ${error.message}`);
}
const named = `${left.length === 1 ? 'an entry' : `${left.length} entries`} in its TMPDIR: ` +
  `${left.slice(0, 10).join(', ')}${left.length > 10 ? ', …' : ''}`;

if (stoppedBy !== null) {
  if (left.length > 0) console.error(`✗ the run was stopped by ${stoppedBy} and left ${named}${removed ? ', now removed' : ''}.`);
  process.exit(128 + constants.signals[stoppedBy]);
}
if (left.length > 0) {
  // A test file killed part-way (a signal sent to the runner alone ends it as a failure) never
  // reaches the exit that removes its scratchDirs, so a failed run's leftovers may not be a leak.
  console.error(`✗ the run left ${named}. ` + (status === 0
    ? 'Make a temp directory with scratchDir (src/scratch-dir.js), which removes it on exit.'
    : 'A test process that was killed or crashed cannot remove what it made, so look at the failure first; ' +
      'if a passing run still leaves them, make each with scratchDir (src/scratch-dir.js).'));
  process.exit(1);
}
process.exit(removed ? status : 1);
