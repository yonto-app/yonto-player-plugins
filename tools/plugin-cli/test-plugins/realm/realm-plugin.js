/* yonto-plugin
{
  "kind": "content-source",
  "id": "realm",
  "name": "Realm probe",
  "version": "1.0.0",
  "contractVersion": 21,
  "provides": "source",
  "allowedHosts": [
    "h.tv"
  ]
}
*/
import { GREETING } from './src/greeting.js';

export default {
  async getMediaList() { return [{ id: 'm', title: 'M' }]; },
  async getMediaDetail() { return { id: 'm', title: 'M', playbackOptions: [] }; },
  // A plugin may be more than one file; the engine bundles before it evaluates.
  async getCategories() {
    return [{ id: 'bundled', name: GREETING }];
  },
  // Node has URL and a television does not, so this has to fail in both places or the
  // CLI is lying to whoever is writing the plugin.
  async search() {
    return new URL('https://h.tv/x').host;
  },
  // What a plugin sees of the host has to be built in here, or these three answer
  // differently under `doctor` than they do on a television.
  async realmChecks() {
    const res = await yonto.fetch('https://h.tv/x');
    return {
      error: yonto.error.notFound('x') instanceof Error,
      array: res.setCookie instanceof Array,
      object: res.headers.constructor === Object,
    };
  },
  // The surface a plugin actually sees, walked the way JsHostApiConformanceTest walks the
  // device's. Leaves only, because a namespace is not something a plugin can call.
  async yontoSurface() {
    const walk = (value, prefix) => Object.entries(value).flatMap(([key, member]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof member === 'function') return [path];
      if (member && typeof member === 'object' && path !== 'config') return walk(member, path);
      return [];
    });
    return walk(yonto, '').sort();
  },
  async blocked() {
    return (await yonto.fetch('https://elsewhere.test/x')).status;
  },
  // A synchronous host member fails too, and its Error has to be built in here just as
  // an asynchronous one's is.
  async syncError() {
    try {
      yonto.crypto.aesCbcDecrypt('AAAA', 'AAAA', 'AAAA');
      return 'did not throw';
    } catch (error) {
      return { isError: error instanceof Error, code: error.code ?? null };
    }
  },
  async storeFails() {
    try {
      await yonto.store.set('k', 1);
      return 'did not throw';
    } catch (error) {
      return { isError: error instanceof Error, code: error.code ?? null, message: error.message };
    }
  },
  async storeBoom() {
    await yonto.store.set('k', 1);
  },
  async globals() {
    return Object.getOwnPropertyNames(globalThis).sort();
  },
  async config() {
    return yonto.config;
  },
  // Nothing yields here, so no deadline expressed as a Promise can win the race — only
  // an interrupt inside the engine can end it.
  async spins() {
    while (true) { /* until the interrupt handler says otherwise */ }
  },
  async spinsFor(ms) {
    const until = yonto.now() + ms;
    while (yonto.now() < until) { /* JS time */ }
    return 'spun';
  },
  // Still in flight after its spin, so a call started then runs beside it.
  async spinsThenSleeps(ms, sleepMs) {
    const until = yonto.now() + ms;
    while (yonto.now() < until) { /* JS time */ }
    await yonto.sleep(sleepMs);
    return 'spun';
  },
  async fetchesThenSpins() {
    yonto.fetch('https://h.tv/x').catch(() => {});
    await yonto.sleep(0); // so the fetch starts before the spin uses up the deadline
    while (true) { /* until the interrupt handler says otherwise */ }
  },
  // Plain functions, not async: an async one's own promise would be awaited inside the call's
  // first run, which is timed anyway. These leave their trap for the host's reading of the
  // answer, which is where nothing timed them (found in review of kangzj/yonto#630).
  thenLoops() {
    Promise.prototype.then = function () { for (;;) { /* the host's own resolvePromise calls this */ } };
    return 'unreachable';
  },
  constructorLoops() {
    Object.defineProperty(Promise.prototype, 'constructor', { get() { for (;;) { /* read by Promise.resolve */ } } });
    return 'unreachable';
  },
  throwsLoopingToJson() {
    throw { toJSON() { for (;;) { /* run by the host dumping what was thrown */ } } };
  },
  // A chain nothing awaits spends the budget in the job queue, while the call waits on a promise
  // that never settles. Its handler returns nothing: one that returns the next link's promise
  // piles them up and races the memory limit (kangzj/yonto#1411).
  async detachedChain() {
    const loop = () => { Promise.resolve().then(loop); };
    loop();
    await new Promise(() => {});
  },
  // Parks on a request only its call's end cancels, then keeps asking for [forMs] after the
  // call is over, every ask refused. Stops by itself, so a process it froze still ends.
  async outlivesItsCall(forMs) {
    try { await yonto.fetch('https://h.tv/never'); } catch { /* cancelled with the call */ }
    const until = yonto.now() + forMs;
    while (yonto.now() < until) {
      try { await yonto.sleep(0); } catch { /* refused: there is no call to sleep in */ }
    }
    return 'unreachable';
  },
  async sleepsThenAnswers() {
    await yonto.sleep(50);
    return 'woke';
  },
  // Touches nothing, so it can only fail if something else left the engine broken.
  async fine() {
    return 'fine';
  },
  async slowSleep() {
    await yonto.sleep(600);
    return 'slept';
  },
  async readsStore() {
    return await yonto.store.get('k');
  },
  // Its ceiling ends the call while the sleep is still out; the answer lands later and
  // pumps the queue, which resumes this — with nothing above it unless the pump carries
  // a ceiling of its own.
  async sleepThenSpin(ms) {
    await yonto.sleep(ms);
    while (true) { /* until the interrupt handler says otherwise */ }
  },
  // The same shape, parked in a fetch rather than a sleep. Since kangzj/lantern-tv#169 a
  // sleep is bounded by the call's own budget, so a sleep long enough to outlive the
  // ceiling is refused before it ever parks — which makes `sleepThenSpin` the wrong probe
  // for what happens to an answer that lands after its call was abandoned. A slow site is
  // the park that still does that: the transport's timeout bounds it, not the call's.
  async fetchThenSpin() {
    await yonto.fetch('https://h.tv/x');
    while (true) { /* until the interrupt handler says otherwise */ }
  },
  async slowFetch() {
    await yonto.fetch('https://h.tv/x');
    return 'fetched';
  },
  // Never asks for more than the call's budget, so a ceiling on one sleep would not touch
  // it — what has to stop it is the budget running out across the call.
  async sleepLoop(ms) {
    while (true) { await yonto.sleep(ms); }
  },
  async sleepsFor(ms) {
    await yonto.sleep(ms);
    return 'slept';
  },
  // Nothing to say for itself, three ways. `(error.message || error)` turned the first
  // into the word `Error` and the other two into `[object Object]` — see
  // kangzj/lantern-tv#193.
  async throwsEmptyError() {
    throw Object.assign(new Error(''), { code: 'UNAVAILABLE' });
  },
  async throwsBareObject() {
    throw { code: 'UNAVAILABLE' };
  },
  async throwsObjectWithEmptyMessage() {
    throw { code: 'UNAVAILABLE', message: '' };
  },
  async throwsString() {
    throw 'plain string failure';
  },
  async throwsNull() {
    throw null;
  },
};
