import { METHODS } from './contract.js';
import { NEXT_PAGE_STEP } from './doctor.js';
import { SERVICES } from './link-login.js';

const MANIFEST = 'manifest';

// A 401 is exactly when someone copies this report into an issue, and the header that
// caused it is the one thing they must not paste. The name still shows: "was the key sent
// at all" is a question a report has to answer, and the value never answers it.
// A linkLogin service's credential headers are among them, whether the host or the plugin sent one.
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-emby-token', 'x-api-key',
  ...Object.values(SERVICES).flatMap((service) => [service.accountHeader.name, service.serverHeader.name]).map((name) => name.toLowerCase())]);

function redacted(name, value) {
  if (!SECRET_HEADERS.has(name.toLowerCase())) return value;
  return `<${value.length} characters, hidden>`;
}

// As wide as the longest label a report can carry, so no line pushes past it and the column
// is the same from one run to the next: every method is a step, exported or not.
const LABEL_WIDTH = Math.max(...[MANIFEST, NEXT_PAGE_STEP, ...METHODS].map((label) => label.length));

/** [conceal] takes out of the whole report every credential the host holds, wherever a line quotes one. */
export function formatReport(manifest, report, requests, conceal = (text) => text) {
  const lines = [
    `✓ ${MANIFEST.padEnd(LABEL_WIDTH)} id=${manifest.id} version=${manifest.version} ` +
    `contract=${manifest.contractVersion} hosts=[${manifest.allowedHosts.join(', ')}]`,
  ];
  for (const step of report.steps) {
    const mark = step.ok ? '✓' : '✗';
    // A skipped step never ran, so it has no time to report; a step that ran in under a
    // millisecond genuinely took 0 ms and should say so, not read as skipped too.
    const timing = step.skipped ? '      — ' : `${String(step.ms).padStart(5)} ms`;
    const count = step.requests ? `${step.requests} request${step.requests === 1 ? '' : 's'}` : '';
    // A failure's code is what says whether the site changed under the plugin
    // (EMPTY_RESULT, NO_FIXTURE) or the plugin itself is wrong (METHOD_THREW,
    // RESULT_INVALID), so it leads the line rather than staying in the exit status.
    const outcome = step.ok || !step.code ? step.message : `${step.code}  ${step.message}`;
    lines.push(`${mark} ${step.method.padEnd(LABEL_WIDTH)} ${outcome.padEnd(34)} ${timing}  ${count}`.trimEnd());
    if (!step.ok && step.detail?.stack) {
      // The first frame in one of the plugin's own files, which is the line an author can
      // open. Not simply the first: a `yonto.error.*` is built in the host's bootstrap,
      // whose frame (`yonto:host`) comes before the plugin's, as do `native` and `<input>`.
      const frame = step.detail.stack.split('\n').find((line) => /^\s*at .*\((?!yonto:).+:\d+:\d+\)\s*$/.test(line));
      if (frame) lines.push(`${' '.repeat(LABEL_WIDTH + 3)}${frame.trim()}`);
    }
    // Under the step that provoked them, in the order the plugin wrote them, and at every
    // level: a `doctor` run is an author reading a diagnosis, and deciding for them that an
    // `info` is not worth their attention is how the one line that answers their question
    // gets dropped. `⚠` stays doctor's own voice — these are the plugin's, and the marker
    // says so.
    // `String` on both halves, not only on the message. `yonto.log` stores whatever a
    // plugin passed — the host does not check it — so `yonto.log(1, 'x')` from somebody
    // else's catalog would throw on `padEnd` here and take the whole report down with it. A
    // diagnostic tool losing its diagnosis over the shape of a log level is the wrong trade.
    for (const { level, message } of step.said ?? []) {
      const [first, ...rest] = String(message).split('\n');
      lines.push(`    · ${String(level).padEnd(5)} ${first}`);
      for (const line of rest) lines.push(`            ${line}`);
    }
    // The sentence a television shows under the row, so an author reads it as a viewer will.
    if (step.partial) lines.push(`    ◐ partial ${step.partial}`);
    for (const note of step.notes ?? []) {
      lines.push(`${' '.repeat(LABEL_WIDTH + 3)}${note}`);
    }
    for (const warning of step.warnings ?? []) {
      lines.push(`    ⚠ ${warning}`);
    }
  }
  for (const warning of report.sourceWarnings ?? []) {
    lines.push(`    ⚠ ${warning}`);
  }
  const failed = requests.filter((r) => r.blocked || (r.status && r.status >= 400));
  for (const r of failed) {
    lines.push(`  ${r.blocked ? 'BLOCKED' : r.status} ${r.method} ${r.url}`);
    for (const [k, v] of Object.entries(r.requestHeaders)) lines.push(`      ${k}: ${redacted(k, v)}`);
  }
  return conceal(lines.join('\n'));
}
