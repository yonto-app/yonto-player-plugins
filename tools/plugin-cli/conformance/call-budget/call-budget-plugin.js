/* yonto-plugin
{
  "kind": "content-source",
  "id": "call-budget",
  "name": "Call budget",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": ["site.test"]
}
*/
// Not a content source: the plugin `calls.json` is walked through. Every request it makes
// answers after the record's `siteAnswersAfterMs`.
// Runs on after the clock says the time is up, because a thread descheduled across that
// moment comes back past it: a loop that stopped there would never reach QuickJS's next
// interrupt check, and a call over its budget answered (found in review of
// kangzj/yonto#630). QuickJS checks every ten thousand or so steps.
const runOn = () => { for (let i = 0; i < 100000; i += 1) { /* a few interrupt checks' worth */ } };
const spinFor = (ms) => {
  const until = yonto.now() + ms;
  while (yonto.now() < until) { /* JS time, which is what the budget counts */ }
  runOn();
};
const status = (path) => yonto.fetch(`https://site.test/${path}`).then((r) => String(r.status));

// The module body's own JS, which the first call pays for. `Date.now()`, because a plugin must
// not read `yonto` while it is being evaluated.
const MODULE_BODY_MS = 500;
for (const until = Date.now() + MODULE_BODY_MS; Date.now() < until;) { /* JS time */ }
runOn();

export default {
  async ready() { return 'ready'; },
  async spins(ms) {
    spinFor(ms);
    return 'spun';
  },
  async yieldThenSpin(burstMs) {
    for (;;) {
      try { await yonto.sleep(0); } catch { /* the deadline's refusal, which this loop ignores */ }
      spinFor(burstMs);
    }
  },
  async waitThenWork(workMs) {
    const answers = await Promise.all([status('a'), status('b')]);
    spinFor(workMs);
    return `${answers.join(',')}:worked`;
  },
  async leaves(workMs) {
    status('a').then(() => spinFor(workMs));
    return 'left';
  },
  async waitThenSpin() {
    await status('a');
    for (;;) { /* never yields */ }
  },
};
