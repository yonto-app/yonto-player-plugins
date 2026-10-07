import { execFile } from 'node:child_process';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * How long a child may run before it is killed. A test runner's own timeout is a timer, and
 * JS nothing interrupts, or a job queue Node never gets out of, freezes every timer in the
 * process it is in; an orphan that loops forever keeps that process from exiting. Either
 * way the process has to be another one for a regression to fail rather than hang the suite.
 */
const HARD_LIMIT_MS = 30_000;

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

const SCRIPT = `
  import { createEngine } from ${JSON.stringify(src('engines/quickjs.js'))};
  import { createHost } from ${JSON.stringify(src('host/index.js'))};
  import { loadManifest } from ${JSON.stringify(src('manifest.js'))};

  const { pluginDir, storeDir, calls, timeoutMs, ceilingMs, pauseMs, siteAnswersAfterMs } = JSON.parse(process.argv[1]);
  const host = createHost({
    pluginDir, manifest: loadManifest(pluginDir), storeDir,
    transport: {
      request: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
        if (siteAnswersAfterMs !== null) {
          setTimeout(() => resolve({ status: 200, headers: {}, bodyBase64: '' }), siteAnswersAfterMs);
        }
      }),
    },
  });
  const engine = createEngine({ dir: pluginDir, host, timeoutMs, ceilingMs });
  const outcomes = [];
  const origin = Date.now();
  for (const [index, { method, args }] of calls.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const started = Date.now();
    const outcome = await engine.call(method, args).then((answer) => ({ answer }), (error) => ({ code: error.code }));
    outcomes.push({ ...outcome, tookMs: Date.now() - started, endedAtMs: Date.now() - origin });
  }
  process.stdout.write(JSON.stringify(outcomes), () => process.exit(0));
`;

/**
 * Runs [calls] one after another on one engine over [pluginDir], in a process of their own,
 * and resolves to each call's `{ answer }` or `{ code }`, with the ms it took and the ms from
 * the first call's start to its end. Each call after the first starts from a timer [pauseMs]
 * later, as the next step of a `doctor` run would. A request answers 200 after
 * [siteAnswersAfterMs], or, left null, waits until its call's end cancels it.
 *
 * The child exits once the last call is over, as the CLI does, so an orphan still running
 * cannot hold it open. Its store is made here, since a child killed for hanging cleans up nothing.
 */
export function callsInChild({ pluginDir, calls, timeoutMs, ceilingMs, pauseMs = 0, siteAnswersAfterMs = null }) {
  const config = JSON.stringify({
    pluginDir, storeDir: scratchDir('lp-child-'), calls, timeoutMs, ceilingMs, pauseMs, siteAnswersAfterMs,
  });
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', SCRIPT, config],
      { timeout: HARD_LIMIT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error?.killed) reject(new Error(`still running after ${HARD_LIMIT_MS} ms, killed`));
        else if (error) reject(new Error(`the child failed: ${stderr}`));
        else resolve(JSON.parse(stdout));
      });
  });
}
