import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createFetch } from './fetch.js';
import { maskedBytes } from './mask.js';
import { createSession, hostClientIdOf } from './session.js';
import { clearanceForHop } from './clearance.js';
import { cookieLoginOf } from './credential.js';
import { createStore } from './store.js';
import { crypto, encoding } from './crypto.js';
import { Code, HostRefusal, PluginError } from '../errors.js';
import { hostsWith } from '../manifest.js';

/**
 * [session] is what a television would hold for a linkLogin (`YONTO_PLUGIN_SESSION`): the
 * account credential and its link record. [hostTransport] carries the host's own requests for
 * it, which a recording keeps apart from the plugin's; [secrets] collects what `--record` must
 * not write, and [warn] is told when the host sets a session aside.
 */
export function createHost({
  manifest, config = {}, transport, storeDir, pluginDir, now = Date.now, subSource = null, credential = null, origin = null,
  clearances = [], session: held = null, hostTransport = transport, secrets = null, warn = () => {},
}) {
  // What is left of this call's allowance for `yonto.sleep`, in milliseconds, and the
  // engine's `startCall` is what refills it. Until one does, a host has no call in flight
  // and nothing to spend: a sleep before then is the plugin sleeping outside a call.
  //
  // `JsHostApi.sleepBudgetMs` on the device, for the same reason and with the same rule —
  // cumulative over the call rather than a ceiling on one sleep, because a ceiling on one
  // is not a bound at all. `while (true) { await yonto.sleep(20) }` never asks for more
  // than the budget, so a clamp never fires and the loop runs for as long as it likes.
  let sleepBudgetMs = 0;

  /**
   * When this call runs out of permission to start anything new — its start plus the
   * engine's `timeoutMs`, on the same clock a plugin reads through `yonto.now()`.
   *
   * `JsHostApi.deadlineAt` on the device, where it is the whole fix for
   * kangzj/lantern-tv#178: that host's ceiling is a QuickJS interrupt polled per opcode, so
   * a loop that awaits a host function each turn runs for about a thousand turns whatever
   * the budget says. The engine's interrupt counts only JS time and its race is the device's
   * wall-clock ceiling, so here too this is what ends a call that keeps parking.
   *
   * Zero until a call announces itself, like the sleep budget above: a host reached
   * outside a call is one whose engine is not driving it, and guessing a deadline for it
   * would hide exactly that.
   */
  let deadlineAt = 0;
  let callBudgetMs = 0;

  // Aborted when the call ends, however it ends, so a request it left does not outlive it:
  // `JsHostApi.callEnded` on the device.
  let callRequests = new AbortController();

  // What this call's answer is missing, in the plugin's own words, or null. Per call and raw,
  // as the device keeps it: the last sentence said wins, and `partialShown` decides what shows.
  let partial = null;

  /**
   * Refuses to start anything once this call is out of time.
   *
   * Around every function a call can park in rather than `fetch` alone: what bounds a call
   * is the number of times it resumes, and what it resumed from does not change the
   * answer. A park already begun is never cut here — that is the transport's business, and
   * on a television it is 60 s of OkHttp's own call timeout.
   */
  const bounded = (name, fn) => (...args) => {
    if (now() >= deadlineAt) {
      return Promise.reject(new PluginError(Code.TIMEOUT,
        `this call has been running for more than the ${callBudgetMs} ms it is allowed, ` +
        `so ${name} was refused rather than started`,
        { name, budgetMs: callBudgetMs }));
    }
    return fn(...args);
  };
  // No default. `yonto.installId()` is derived from this, and a host that quietly built
  // one out of `undefined` would hand every plugin on the machine the same answer — which
  // is the failure this whole function exists to prevent, arriving through the host.
  if (!pluginDir) throw new Error('createHost needs pluginDir: yonto.installId() is derived from it');
  // Resolved here rather than trusted as typed, because the three ordinary ways to reach one
  // plugin are three different strings: `doctor plugins/jellyfin` from the root, `doctor .`
  // from inside it, and the absolute path. Hashing them as written gave one plugin three
  // identities, so an author doing the same thing three ways left three rows in a real
  // server's device list — which is what this exists to stop happening to a viewer.
  const home = resolve(pluginDir);
  const requests = [];
  const logs = [];
  const session = createSession({
    manifest, config, origin, held, transport: hostTransport, clientId: hostClientIdOf(home, manifest), now, secrets, warn,
  });
  // Plugin text crossing into the host, with every credential it holds taken out (the design's *Never in a log*).
  const redact = session === null ? (text) => text : session.redact;
  // `bodyBase64` as the plugin reads it, masked with what is held then rather than when it arrived.
  const maskBodyBase64 = session === null ? (base64) => base64
    : (base64) => maskedBytes(Buffer.from(base64, 'base64'), session.held()).toString('base64');

  const yonto = {
    config,
    fetch: bounded('yonto.fetch', createFetch({
      hosts: hostsWith(manifest, config, origin),
      // The login the manifest declares, and the session a viewer's television would be
      // holding for it — `YONTO_PLUGIN_CREDENTIAL` here. The plugin is handed neither:
      // it is attached to the capability's own site by `yonto.fetch`, per redirect hop,
      // which is the whole of kangzj/lantern-tv#163 and the reason it is read here rather
      // than merged into `config`.
      login: cookieLoginOf(manifest),
      credential: () => credential,
      // What passing a browser check won, which a television holds per site —
      // `YONTO_PLUGIN_CLEARANCE` and its two companions here. Attached per hop to the site
      // it was won at while the manifest's check still clears there, and never handed over.
      clearanceFor: (url) => clearanceForHop(manifest, url, clearances),
      // A plugin whose servers are listed inside the config a viewer pointed it at cannot
      // have them in its manifest — see `PluginManifest.hostsAreEnforced` on the device,
      // which is where that boundary is argued. The floor under such a plugin is not
      // switched off along with the allowlist: see `createFetch`.
      hostsEnforced: manifest.hostsFromConfig !== true,
      transport,
      requests,
      linkSession: session,
      callSignal: () => callRequests.signal,
    })),
    store: boundedStore(createStore({ dir: storeDir, now }), bounded),
    crypto,
    encoding,
    text: {
      decode: (base64, charset = 'utf-8') => {
        let decoder;
        try {
          decoder = new TextDecoder(charset);
        } catch {
          // The device's sentence, and fetch's: not Node's RangeError about its own encodings.
          throw new HostRefusal(`${charset} is not a charset this host can decode`);
        }
        return decoder.decode(Buffer.from(base64, 'base64'));
      },
    },
    sleep: bounded('yonto.sleep', (ms) => {
      const asked = Math.max(0, Number(ms) || 0);
      if (asked > sleepBudgetMs) {
        // Refused now rather than after sleeping what is left: the verdict is the same
        // either way, and a call that has asked for more sleep than its budget holds has
        // nothing left to wait for. This is the device's answer, at the device's moment.
        throw new PluginError(Code.TIMEOUT,
          `yonto.sleep(${asked}) wanted more than the ${sleepBudgetMs} ms this call has left`,
          { asked, leftMs: sleepBudgetMs });
      }
      sleepBudgetMs -= asked;
      return new Promise((resolve) => setTimeout(resolve, asked));
    }),
    // The same clock `createStore` ages entries against: a plugin and its store disagreeing
    // about the time is a state no television is ever in, so no test should be able to
    // arrange one. QuickJS's own Date.now() is the thing this replaces — nothing can wind
    // it. See contracts/content-source-http.md's "A plugin's clock".
    now,
    log: (level, message) => { logs.push({ level, pluginId: manifest.id, message: redact(message) }); },
    // Always a string: the engine's bootstrap hands anything else over as ''.
    partial: (reason) => { partial = redact(reason); },
    /**
     * A stable, opaque name for this plugin running for this source — see the contract's
     * "What a source is called on this box".
     *
     * Derived from the plugin's own directory, and emphatically not from [storeDir]: `cli.js`
     * makes that one fresh per invocation, so an id built from it changed on
     * every run. That is not cosmetic here — this is the tool an author points at a real
     * server, and `plugins/jellyfin` spends this as a device id, so ten `doctor` runs left
     * ten orphaned rows in that server's device list. kangzj/lantern-tv#134's own symptom,
     * reproduced by the tool meant to catch it.
     *
     * The directory gives what a television's salt gives: the same answer next run, a
     * different one per plugin, and a different one in somebody else's checkout, so two
     * authors working on the same plugin do not collide on a shared demo server. Nothing is
     * written, so there is no file to go stale or to clear.
     */
    installId: () => createHash('sha256').update(`${home}\u0000${manifest.id}`).digest('hex').slice(0, 32),
    /**
     * Which of this source's libraries the viewer picked, or null — see the contract's "A
     * source that is several".
     *
     * Fixed for the life of a host, because switching is a source built again rather than a
     * source told something: a television writes the id down beside the profile and rebuilds
     * from it, and here it is whatever `YONTO_PLUGIN_SUBSOURCE` said when the command
     * started.
     */
    subSource: () => subSource,
    // The engine (src/engines/quickjs.js) duck-types on a thrown value's `code`: a
    // hand-constructed `{ code: 'NOT_FOUND' }` is honoured exactly like one of these, so
    // this is a convenience, not the only way to raise one. See
    // contracts/content-source-http.md's Yonto plugin errors section.
    error: {
      notFound: (id) => Object.assign(new Error(`not found: ${id}`), { code: Code.NOT_FOUND }),
      unauthenticated: (message) => Object.assign(new Error(message), { code: Code.UNAUTHENTICATED }),
      unavailable: (reason) => Object.assign(new Error(reason), { code: Code.UNAVAILABLE }),
      misconfigured: (reason) => Object.assign(new Error(reason), { code: Code.MISCONFIGURED }),
      unreachable: (reason) => Object.assign(new Error(reason), { code: Code.UNREACHABLE }),
      challenged: (url) => Object.assign(new Error(String(url ?? '')), { code: Code.CHALLENGED }),
    },
  };
  // Only for a plugin whose linkLogin a host runs: `yonto.session` is nobody else's.
  if (session !== null) {
    yonto.session = {
      linked: () => session.linked(),
      servers: bounded('yonto.session.servers', () => session.servers()),
      refused: () => { session.refused(); },
    };
  }

  /**
   * A call into the plugin is starting, and [budgetMs] is what it may spend — the engine's
   * own `timeoutMs`, passed per call so the host cannot hold a number the engine has since
   * been rebuilt with. `JsHostApi.callStarted` on the device.
   *
   * `doctor` runs seven methods on one host, so this has to be per call and not per host:
   * without it the seventh method inherits whatever the first six left, and a plugin that
   * sleeps politely in each of them fails the last one for no reason of its own.
   */
  const startCall = (budgetMs) => {
    sleepBudgetMs = budgetMs;
    callBudgetMs = budgetMs;
    deadlineAt = now() + budgetMs;
    // Kept while a call is still going, as a test may start one beside another.
    if (callRequests.signal.aborted) callRequests = new AbortController();
    partial = null;
    session?.startCall();
  };

  /** No call is left running; the requests they left are cancelled. */
  const endCall = () => callRequests.abort(new Error('the call this request belonged to has ended'));

  /** What the last call said its answer is missing, handed out once so a step that ran
   *  nothing is not given the step before's. */
  const takePartial = () => {
    const said = partial;
    partial = null;
    return said;
  };

  return { yonto, requests, logs, startCall, endCall, takePartial, redact, maskBodyBase64 };
}

/** `yonto.store`, with every one of its functions under the call's deadline. Written
 *  out rather than mapped blindly so a function added to the store has to be added here
 *  too, which is the same rule `surface.js` holds the whole API to. */
function boundedStore(store, bounded) {
  return {
    get: bounded('yonto.store.get', store.get),
    set: bounded('yonto.store.set', store.set),
    remove: bounded('yonto.store.remove', store.remove),
    clear: bounded('yonto.store.clear', store.clear),
  };
}
