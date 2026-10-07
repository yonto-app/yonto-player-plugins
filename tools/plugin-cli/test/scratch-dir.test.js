import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { scratchDir } from '../src/scratch-dir.js';

const scratchDirModule = new URL('../src/scratch-dir.js', import.meta.url).href;

/**
 * Runs a script that makes a scratchDir, writes into it, runs [body] and then never ends, sends
 * it [signal], and says how it ended and what it left in its TMPDIR. In its own process group,
 * killed whole at the end, so a script the signal did not stop cannot outlive the test.
 * [body] is handed a file it may write to, outside that TMPDIR.
 */
async function signalled(signal, body = () => '') {
  const dir = scratchDir('lp-scratch-signal-');
  const tmp = join(dir, 'tmp');
  const started = join(dir, 'started');
  const note = join(dir, 'note');
  const script = join(dir, 'hangs.mjs');
  mkdirSync(tmp);
  writeFileSync(script, `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '${scratchDirModule}';
const made = scratchDir('lp-made-');
writeFileSync(join(made, 'store.json'), '{}');
${body(JSON.stringify(note))}
writeFileSync(${JSON.stringify(started)}, '');
setInterval(() => {}, 1000);`);
  const run = spawn(process.execPath, [script], { env: { ...process.env, TMPDIR: tmp }, detached: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => run.on('exit', (code, endedBy) => resolve({ code, endedBy })));
  try {
    for (let waited = 0; !existsSync(started); waited += 50) {
      assert.ok(waited < 30_000, 'the script never started');
      await sleep(50);
    }
    process.kill(run.pid, signal);
    const { code, endedBy } = await Promise.race([exited, sleep(30_000, { code: 'still running', endedBy: null }, { ref: false })]);
    return { code, endedBy, left: readdirSync(tmp), note: existsSync(note) ? readFileSync(note, 'utf8') : null };
  } finally {
    try {
      process.kill(-run.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`a process stopped by ${signal} removes its scratchDirs and still ends by that signal`, async () => {
    const { code, endedBy, left } = await signalled(signal);

    assert.deepEqual(left, []);
    assert.equal(endedBy, signal);
    assert.equal(code, null);
  });
}

test('a process with its own SIGINT listener keeps its scratchDirs until it exits', async () => {
  const { code, left, note } = await signalled('SIGINT', (notePath) => `
process.on('SIGINT', () => {
  writeFileSync(${notePath}, String(existsSync(made)));
  process.exit(0);
});`);

  assert.equal(note, 'true');
  assert.equal(code, 0);
  assert.deepEqual(left, []);
});
