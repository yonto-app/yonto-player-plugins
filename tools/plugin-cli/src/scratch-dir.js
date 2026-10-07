import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set();

function removeAll() {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.clear();
}

process.on('exit', removeAll);

// A signal ends the process without an `exit` event. Only when nothing else listens, since
// another listener decides whether the process ends, and its `exit` still cleans up.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, function onSignal() {
    if (process.listenerCount(signal) > 1) return;
    removeAll();
    process.off(signal, onSignal);
    process.kill(process.pid, signal);
  });
}

/**
 * A new directory under the OS temp directory, removed when this process exits or is stopped.
 *
 * On exit rather than when its user is done, because a store is written until the last call
 * returns and the CLI and each test file are one process each.
 */
export function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}
