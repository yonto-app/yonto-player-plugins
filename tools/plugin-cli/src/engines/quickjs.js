import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { newQuickJSWASMModule } from 'quickjs-emscripten';
import { Code, HostRefusal, PluginError } from '../errors.js';
import { ANSWER_DEPTH, LIMITS, UNREAD_BODY_BYTES_PER_CALL } from '../host/fetch.js';
import { entryFile } from '../manifest.js';
import { buildPlugin, bundleRoot } from '../build.js';
import { PARSER_FILE, buildParser } from '../../scripts/build-parser.mjs';
import { CRYPTO_FILE, buildCrypto } from '../../scripts/build-crypto.mjs';
import { JSENCRYPT_FILE, buildJsEncrypt } from '../../scripts/build-jsencrypt.mjs';

// The only codes a plugin may raise for itself, via `yonto.error.*` or by hand. Any other
// code a call ends in stands only if one of the host's own functions answered that same call
// with it, which is recorded here in Node, where the plugin cannot reach: nothing in its realm
// can vouch for a host code, since the plugin can rewrite all of it (kangzj/lantern-tv#342).
const HONOURED_CODES = new Set([
  Code.NOT_FOUND, Code.UNAUTHENTICATED, Code.UNAVAILABLE, Code.MISCONFIGURED, Code.UNREACHABLE, Code.CHALLENGED,
]);

/** What the plugin reads when what it handed a host function could not be used. The device's words. */
const GIVEN_UNUSABLE = 'the host could not do that with what it was given';

/** What the plugin reads when a host function failed at its own work. The device's words. */
const HOST_FAULT = 'the app could not do that just now; try again';

/** What a call ends in when the answer is not the envelope the engine's own wrapper makes. */
const NOT_JSON = 'the plugin answered with something that is not JSON';

/**
 * What a call ends in when its answer nests deeper than [ANSWER_DEPTH], which
 * `JsRuntime.MAX_ANSWER_DEPTH` is held to: reading a deeper one killed the app on iOS, so
 * neither host reads one. The device's words.
 */
const TOO_DEEP = `the plugin's answer nests more than ${ANSWER_DEPTH} levels deep`;

/**
 * Whether [json] opens more than [limit] arrays or objects inside one another, read in one pass
 * without parsing it; brackets inside strings are text. `nestsDeeperThan` on the device.
 */
function nestsDeeperThan(json, limit) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (escaped) escaped = false;
    else if (inString && char === '\\') escaped = true;
    else if (char === '"') inString = !inString;
    else if (inString) continue;
    else if (char === '[' || char === '{') {
      if (++depth > limit) return true;
    } else if (char === ']' || char === '}') depth -= 1;
  }
  return false;
}

/** Refuses [envelope] unread when the value it wraps nests deeper than [ANSWER_DEPTH], one level under the envelope's own. */
function refuseTooDeep(envelope, method) {
  if (typeof envelope === 'string' && nestsDeeperThan(envelope, ANSWER_DEPTH + 1)) {
    throw new PluginError(Code.METHOD_THREW, TOO_DEEP, { method });
  }
}

/** Node's own errors about a value it was handed, as opposed to the host failing at its own work. */
const aboutTheInput = (error) =>
  error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError;

const BODY_READ_LATE = 'bodyBase64 can only be read during the call that fetched it';
const BODY_LANDED_LATE = 'this response arrived after the call that fetched it had ended';

/** What a plugin is allowed to spend on one call — `JsLimits`, in JavaScript. */
const MEMORY_BYTES = 64 * 1024 * 1024;

// QuickJS's own stack limit, so plain runaway recursion is its `InternalError: stack
// overflow`, with the plugin's frames, as on a device (kangzj/lantern-tv#541). Not the
// device's 1 MB: from about 300 KB up this WASM build is deeper than Node's own stack, and on
// Node 20 inside a test runner from about 224 KB, so this keeps a margin under both. Not
// enough on its own either — recursion through a getter, an async function or a deep
// JSON.parse spends Node's stack faster than QuickJS counts it — which is what
// `overflowedNode` below is for.
const STACK_BYTES = 192 * 1024;

/** How long reading a thrown value may run the plugin's getters for. Plenty for any getter
 *  that answers; a getter that never does ends there, and the call is METHOD_THREW. */
const DUMP_MS = 200;

/**
 * Whether Node's own stack gave out under the WASM, which QuickJS's limit does not always
 * reach first. The runtime is past trusting then — its own stack accounting is left wrong, so
 * an ordinary call on it reports an overflow too — and freeing it aborts the process, so it
 * is dropped, never freed, for a fresh one; the plugin is told what a device would tell it.
 */
function overflowedNode(error) {
  return error instanceof RangeError && /Maximum call stack size exceeded/.test(error.message);
}

/**
 * Shapes `yonto` out of the flat `__host_*` functions, inside QuickJS.
 *
 * This is `JsHostApi.BOOTSTRAP`, statement for statement, and deliberately so: the two
 * hosts now run the same engine, so the only way left for them to disagree is for one of
 * them to shape its surface differently. Both envelopes carry their value as JSON — the
 * device's used to carry it as a string wearing a marker, which a string could imitate.
 *
 * Every host function answers with an `{ ok, value }` envelope rather than throwing,
 * because that is what lets a failure the host decided on keep its code — and it is why
 * nothing in here has to guess whether a thrown `.code` is a verdict or an errno.
 */
const BOOTSTRAP = `
(() => {
// Taken before the plugin runs, because what they return crosses into Node and a replaced
// one could hand the host a value it would read as something else.
const stringify = JSON.stringify;
const parse = JSON.parse;
const text = String;
const finite = Number.isFinite;

// A failure's code is only what the host said; whether the host said it is decided in
// Node, against what its own functions answered this call, never here, where a plugin can
// rewrite anything (kangzj/lantern-tv#342).
function unwrap(json) {
  const result = parse(json);
  if (result.ok) return result.value;
  const error = new Error(result.message);
  if (result.code) error.code = result.code;
  throw error;
}

// A wrong type is the plugin's own TypeError, named for the function, not Node's words about it.
const need = (value, type, what) => {
  if (typeof value !== type) throw new TypeError(what + ' must be a ' + type);
  return value;
};
const optionalText = (value, what) => (value === undefined || value === null ? value : need(value, 'string', what));

// Off the global before the plugin runs, so the checked surface below is the only way in.
const raw = {};
for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (name.startsWith('__host_')) {
    raw[name] = globalThis[name];
    delete globalThis[name];
  }
}

// Compiled on the first \`yonto.html.load\` or \`yonto.xml.load\` and never again, out
// of source the host does not hand over until it is asked for — 194 KB that costs about
// 19 ms to compile on a television, and most sources never parse markup at all.
// \`new Function\` rather than a module or a global: the bundle's own \`cheerio\` is a local
// of this function, so the realm gains no name a plugin did not declare.
let cheerio = null;
function parser() {
  if (cheerio === null) cheerio = new Function(unwrap(raw.__host_parser()) + ';return cheerio;')();
  return cheerio;
}

// The same shape for CryptoJS, and the same reasons. \`cryptoJs.library\` rather than the
// namespace itself: the bundle re-exports the library under that name precisely so neither
// host has to reach through \`.default\`.
let cryptoJs = null;
function cryptoJsLib() {
  if (cryptoJs === null) cryptoJs = new Function(unwrap(raw.__host_cryptoJs()) + ';return cryptoJs.library;')();
  return cryptoJs;
}

// The same shape for JSEncrypt, which is the RSA class itself.
let jsEncrypt = null;
function jsEncryptLib() {
  if (jsEncrypt === null) jsEncrypt = new Function(unwrap(raw.__host_jsEncrypt()) + ';return jsEncrypt.library;')();
  return jsEncrypt;
}

globalThis.yonto = {
  config: unwrap(raw.__host_config()),
  async fetch(url, init) {
    const options = init || {};
    const headers = options.headers || {};
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      throw new TypeError('yonto.fetch: headers must be an object');
    }
    for (const name of Object.keys(headers)) need(headers[name], 'string', 'yonto.fetch: headers.' + name);
    const response = unwrap(await raw.__host_fetch(stringify({
      method: optionalText(options.method, 'yonto.fetch: method') || 'GET',
      url: typeof url === 'number' ? url : optionalText(url, 'yonto.fetch: url'),
      headers,
      body: options.body === undefined ? null : optionalText(options.body, 'yonto.fetch: body'),
      encoding: optionalText(options.encoding, 'yonto.fetch: encoding') || 'utf-8',
      redirect: optionalText(options.redirect, 'yonto.fetch: redirect') || 'follow',
    })));
    // Asked for on first read, since most plugins read only \`body\`.
    const bodyId = response.bodyId;
    delete response.bodyId;
    const body = raw.__host_fetchBody(bodyId);
    if (body === null) throw new Error('${BODY_LANDED_LATE}');
    response.body = body;
    let bodyBase64;
    Object.defineProperty(response, 'bodyBase64', {
      enumerable: true,
      configurable: true,
      get: () => {
        if (bodyBase64 === undefined) {
          const read = raw.__host_fetchBodyBase64(bodyId);
          if (read === null) throw new Error('${BODY_READ_LATE}');
          bodyBase64 = read;
        }
        return bodyBase64;
      },
      set: (value) => { bodyBase64 = value; },
    });
    return response;
  },
  store: {
    async get(key) {
      need(key, 'string', 'yonto.store.get: key');
      const value = unwrap(await raw.__host_storeGet(key));
      return value === null || value === undefined ? null : value;
    },
    async set(key, value, options) {
      need(key, 'string', 'yonto.store.set: key');
      const ttl = options && options.ttlSeconds !== undefined && options.ttlSeconds !== null
        ? need(options.ttlSeconds, 'number', 'yonto.store.set: ttlSeconds') : null;
      if (ttl !== null && !finite(ttl)) throw new TypeError('yonto.store.set: ttlSeconds must be a finite number');
      const json = stringify(value);
      if (json === undefined) throw new TypeError('yonto.store.set: value must be something JSON can hold');
      unwrap(await raw.__host_storeSet(key, json, ttl));
    },
    async remove(key) { need(key, 'string', 'yonto.store.remove: key'); unwrap(await raw.__host_storeRemove(key)); },
    async clear() { unwrap(await raw.__host_storeClear()); },
  },
  crypto: {
    md5: (input) => unwrap(raw.__host_md5(need(input, 'string', 'yonto.crypto.md5: input'))),
    sha1: (input) => unwrap(raw.__host_sha1(need(input, 'string', 'yonto.crypto.sha1: input'))),
    sha256: (input) => unwrap(raw.__host_sha256(need(input, 'string', 'yonto.crypto.sha256: input'))),
    hmacSha256: (keyBase64, message) => unwrap(raw.__host_hmacSha256(
      need(keyBase64, 'string', 'yonto.crypto.hmacSha256: keyBase64'), need(message, 'string', 'yonto.crypto.hmacSha256: message'))),
    aesCbcDecrypt: (keyBase64, ivBase64, dataBase64, options) =>
      unwrap(raw.__host_aesCbcDecrypt(need(keyBase64, 'string', 'yonto.crypto.aesCbcDecrypt: keyBase64'),
        need(ivBase64, 'string', 'yonto.crypto.aesCbcDecrypt: ivBase64'), need(dataBase64, 'string', 'yonto.crypto.aesCbcDecrypt: dataBase64'),
        !options || options.padding === undefined ? true : !!options.padding)),
  },
  encoding: {
    base64Encode: (text) => unwrap(raw.__host_base64Encode(need(text, 'string', 'yonto.encoding.base64Encode: text'))),
    base64Decode: (base64) => unwrap(raw.__host_base64Decode(need(base64, 'string', 'yonto.encoding.base64Decode: base64'))),
    hexToBase64: (hex) => unwrap(raw.__host_hexToBase64(need(hex, 'string', 'yonto.encoding.hexToBase64: hex'))),
    base64ToHex: (base64) => unwrap(raw.__host_base64ToHex(need(base64, 'string', 'yonto.encoding.base64ToHex: base64'))),
  },
  text: {
    decode: (base64, charset) => unwrap(raw.__host_textDecode(need(base64, 'string', 'yonto.text.decode: base64'),
      charset ? need(charset, 'string', 'yonto.text.decode: charset') : 'utf-8')),
  },
  html: {
    load: (markup) => parser().load(markup),
  },
  xml: {
    load: (markup) => parser().load(markup, { xml: true }),
  },
  cryptoJs: () => cryptoJsLib(),
  jsEncrypt: () => jsEncryptLib(),
  async sleep(ms) { unwrap(await raw.__host_sleep(need(ms, 'number', 'yonto.sleep: ms'))); },
  now: () => Number(unwrap(raw.__host_now())),
  installId: () => unwrap(raw.__host_installId()),
  subSource: () => unwrap(raw.__host_subSource()),
  log(level, message) { raw.__host_log(text(level), text(message)); },
  partial(reason) { raw.__host_partial(typeof reason === 'string' ? reason : ''); },
  error: {
    notFound: (id) => Object.assign(new Error('not found: ' + id), { code: 'NOT_FOUND' }),
    unauthenticated: (message, options) =>
      Object.assign(new Error(message), { code: 'UNAUTHENTICATED' }, options && options.signIn === false ? { signIn: false } : {}),
    unavailable: (reason) => Object.assign(new Error(reason), { code: 'UNAVAILABLE' }),
    misconfigured: (reason) => Object.assign(new Error(reason), { code: 'MISCONFIGURED' }),
    unreachable: (reason) => Object.assign(new Error(reason), { code: 'UNREACHABLE' }),
    challenged: (url) => Object.assign(new Error(String(url ?? '')), { code: 'CHALLENGED' }),
  },
};
// Registered only for a plugin whose linkLogin a host runs.
if (raw.__host_sessionLinked) {
  globalThis.yonto.session = {
    linked: () => unwrap(raw.__host_sessionLinked()),
    async servers() { return unwrap(await raw.__host_sessionServers()); },
    refused() { unwrap(raw.__host_sessionRefused()); },
  };
}

// What the engine calls a method through, answering an envelope as JSON text made with the
// stringify taken before the plugin ran. A thrown value is left to throw: the engine reads
// its code and decides, outside the realm, whether it stands. Read once, as JsRuntime's
// bootstrap reads it: a getter is plugin code, and asking twice would run it twice.
//
// The plugin's namespace is held here, out of the realm's reach, and handed over through the
// function this bootstrap evaluates to: on a global, the engine's own write and read of it ran
// any setter or getter a module body put there, untimed.
//
// A call's thrown value is held here until the engine has read its code, so whether it declines
// the host's sign-in is read in the realm, as the device's failure envelope reads it, and a
// getter or a Proxy answers the same on both hosts.
let plugin;
const thrown = Object.create(null);
globalThis.__yontoInvoke = async (method, argsJson, call) => {
  const impl = plugin.default[method];
  if (typeof impl !== 'function') {
    return stringify({ ok: false, code: 'MISSING_EXPORT', message: 'the plugin does not export ' + method });
  }
  let value;
  try {
    value = await impl(...parse(argsJson));
  } catch (error) {
    thrown[call] = error;
    throw error;
  }
  return stringify({ ok: true, value });
};
globalThis.__yontoDeclined = (call, read) => {
  const error = thrown[call];
  delete thrown[call];
  return read && error !== null && error !== undefined && error.signIn === false;
};
globalThis.__yontoExports = () => stringify(Object.keys(plugin.default));
return (namespace) => { plugin = namespace; };
})();
`;

const ok = (value) => JSON.stringify({ ok: true, value: value === undefined ? null : value });

/**
 * What a thrown value says for itself, or nothing.
 *
 * Not `(error.message || error)`: an empty message is falsy, so that fell through to
 * `String(error)` — the literal word `Error` for an Error, `[object Object]` for a plain
 * object — and both are ordinary non-blank strings that every guard downstream passes to a
 * viewer (kangzj/lantern-tv#193). The contract invites the second: a hand-built
 * `{ code: 'NOT_FOUND' }` is honoured exactly like `yonto.error.notFound()`.
 *
 * A thrown string or number is its own message. Anything `String()` cannot describe says
 * nothing instead. `JsRuntime`'s `messageOf` is the same rule on the device.
 */
const messageOf = (error) => {
  if (error === null || error === undefined) return '';
  if (typeof error === 'object') return typeof error.message === 'string' ? error.message : '';
  return String(error);
};

/**
 * What a host function's failure says to the plugin: a verdict the host reached keeps its code,
 * a refusal the host wrote for a plugin keeps its sentence, and anything else is one of two
 * sentences with no code, so no Node text reaches a plugin. `JsHostApi.answering` on the device.
 * [binding] and the error go to stderr for a fault of the host's own, and nothing the plugin
 * passed in does.
 */
const failed = (binding, error) => {
  if (error instanceof PluginError) return JSON.stringify({ ok: false, code: error.code, message: error.message });
  if (error instanceof HostRefusal) return JSON.stringify({ ok: false, message: error.message });
  if (aboutTheInput(error)) return JSON.stringify({ ok: false, message: GIVEN_UNUSABLE });
  process.stderr.write(`YontoHost: ${binding} failed: ${error?.stack ?? error}\n`);
  return JSON.stringify({ ok: false, message: HOST_FAULT });
};

/**
 * The request `yonto.fetch`'s bootstrap assembled, checked again here, because the checks in
 * the bootstrap run in a realm the plugin can rewrite. The device's `text()` and `headers()`,
 * in the same words: a number or a boolean for the url is read as its text, which the fetch
 * then refuses as not a URL, and anything else not a string is refused by name.
 */
export function fetchRequest(requestJson) {
  const request = JSON.parse(requestJson);
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new HostRefusal('yonto.fetch: the request must be an object');
  }
  const text = (key) => {
    const value = request[key];
    if (value === null || value === undefined || typeof value === 'string') return value ?? undefined;
    throw new HostRefusal(`yonto.fetch: ${key} must be a string`);
  };
  const url = typeof request.url === 'number' || typeof request.url === 'boolean' ? String(request.url) : text('url');
  const headers = request.headers ?? {};
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new HostRefusal('yonto.fetch: headers must be an object');
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw new HostRefusal(`yonto.fetch: headers.${name} must be a string`);
  }
  const init = { headers };
  for (const key of ['method', 'body', 'encoding', 'redirect']) {
    const value = text(key);
    if (value !== undefined) init[key] = value;
  }
  return { url, ...init };
}

/**
 * Whether QuickJS stopped the plugin because its time ran out. The interrupt arrives as an
 * InternalError, but so does running out of memory, which is the plugin's own failure and not
 * a timeout (kangzj/lantern-tv#534).
 */
function interrupted(thrown) {
  return thrown?.name === 'InternalError' && thrown?.message === 'interrupted';
}

/** What a run the interrupt cut says, whatever the plugin's code left half-read. */
const INTERRUPTED = Object.freeze({ name: 'InternalError', message: 'interrupted' });

/** The module that loads [entry], whose namespace holds the plugin's as `plugin`. */
const LOAD = (entry) => `import * as plugin from ${JSON.stringify(entry)};\nexport { plugin };\n`;

/**
 * The async host calls one call has made and not had answered, and a promise that resolves
 * once there are none left.
 */
function openAsks() {
  let open = 0;
  let allAnswered = Promise.resolve();
  let resolve = () => {};
  return {
    opened() {
      if (open === 0) allAnswered = new Promise((done) => { resolve = done; });
      open += 1;
    },
    answered() {
      open -= 1;
      if (open === 0) resolve();
    },
    get all() { return allAnswered; },
  };
}

/** What a call the wall-clock ceiling ended says. */
const CEILING = Object.freeze({ name: 'ceiling' });

/**
 * A stack with its bundle frames renamed to the file and line an author has open.
 *
 * The bundle is evaluated under the entry's name, so every frame in it, a helper's included,
 * carries that name with the bundle's own line numbers: the header comment gone and each
 * helper inlined above, which put a 26-line file's throw at line 43 (kangzj/lantern-tv#455).
 * The source map the build appends is what reads them back; a frame of the host's own code
 * names another file and is left as it is.
 */
function authorsFrames(dir, entry, bundle) {
  const encoded = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\s*$/.exec(bundle)?.[1];
  if (!encoded) return (stack) => stack;
  const map = new SourceMap(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
  // esbuild names each source relative to its working directory, [bundleRoot], by its real
  // path, and as a URL: a map's sources are URLs, so a bracket in a folder name arrives as %28.
  const home = realpathSync(dir);
  // The entry's own name, matched whole rather than as whatever sits inside the brackets:
  // a path can hold brackets of its own, and `Program Files (x86)` does.
  const frameOfEntry = new RegExp(`\\(${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)\\)`, 'g');
  return (stack) => stack.replace(frameOfEntry, (frame, line, column) => {
    const found = map.findEntry(Number(line) - 1, Number(column) - 1);
    if (!found?.originalSource) return frame;
    const source = join(dir, relative(home, resolve(bundleRoot(dir), decodeURIComponent(found.originalSource))));
    return `(${source}:${found.originalLine + 1}:${found.originalColumn + 1})`;
  });
}

/**
 * [host] is a whole `createHost` result rather than its `yonto` alone, because the engine
 * is the only thing that knows where one call ends and the next begins — and `yonto.sleep`
 * needs telling. `JsRuntime` takes a `JsHostApi` for the same reason and calls
 * `callStarted` for the same one. Taking the host makes an engine without that wiring
 * impossible to build, which is the point: an unwired one would sleep unbounded and say
 * nothing about it.
 *
 * [timeoutMs] is the JS a call may run, summed over its runs; [ceilingMs] is the wall clock
 * that ends a call nothing else does, the device's `JsLimits.wallClockCeilingMs`.
 */
export function createEngine({
  dir, host, timeoutMs = LIMITS.callBudgetMs, ceilingMs = timeoutMs + LIMITS.requestTimeoutMs + LIMITS.ceilingMarginMs,
}) {
  const {
    yonto, startCall, endCall, takePartial, redact = (text) => text, maskBodyBase64 = (base64) => base64,
  } = host;
  let prepared = null;
  let authors = (stack) => stack;
  // Response bodies until read as `bodyBase64` or no call is running, as `YontoHostApi` holds
  // them for its one call. Calls here may overlap and share a realm, so which of them a fetch
  // belongs to cannot be known; a body is kept while any runs.
  const unreadBodies = new Map();
  let unreadBytes = 0;
  // Held to the same bytes as `UnreadBodies` on the device, the oldest dropped first.
  const keepUnread = (id, unread) => {
    for (const [oldId, old] of unreadBodies) {
      if (unreadBytes + unread.bytes <= UNREAD_BODY_BYTES_PER_CALL) break;
      unreadBodies.delete(oldId);
      unreadBytes -= old.bytes;
    }
    unreadBodies.set(id, unread);
    unreadBytes += unread.bytes;
  };
  let bodyIds = 0;
  let callsRunning = 0;

  // Which call is running, the codes the host's own
  // functions answered it with, and the last call the interrupt stopped. All three live here
  // in Node, out of the plugin's reach: they are what decides whether a host code or a
  // timeout a call ends in is the host's (`JsHostApi.verdicts` and
  // `TimedRuntimeThread.interruptedThisCall` on the device).
  let call = 0;
  const verdicts = new Set();
  let interruptedCall = 0;

  // How many times QuickJS has polled the interrupt: it polls on calls, loop back-edges and regex
  // backtracking, which a busy machine does not stretch the way it stretches time
  // (kangzj/lantern-tv#746). Work inside a C builtin such as `slice` is not counted.
  let polls = 0;
  let calls = 0;
  const startVerdicts = () => {
    call += 1;
    verdicts.clear();
  };

  /**
   * A runtime with the host installed and nothing of the plugin's evaluated yet: what a device
   * has before any call starts (`JsRuntime.create`). Bundling and starting the WASM are the
   * CLI's own work, not the plugin's, so they happen before the first call's clocks start.
   */
  async function context() {
    if (prepared) return prepared;
    const entry = entryFile(dir);

    // QuickJS has no module resolution, so the bundle is not an optimisation here — it is
    // how a plugin of more than one file runs at all. A module rather than a script, as the
    // device evaluates it: a script cannot await at the top level, and a plugin may.
    const built = await buildPlugin(dir, { format: 'esm', sourcemap: 'inline' });
    authors = authorsFrames(dir, entry, built.outputFiles[0].text);

    // A module per runtime, not the one every engine shares: each overflow of Node's stack
    // leaves a little of the module's memory wrong, and dropping the runtime does not reset
    // it — enough of them in one process and a call answered a wrong number with no error
    // (found in review of kangzj/lantern-tv#544).
    const QuickJS = await newQuickJSWASMModule();
    const runtime = QuickJS.newRuntime();
    // Rejected when Node's stack gives out inside a queued job run from a host answer's
    // callback, which is under no call's `try`: the call waiting on it hears it here rather
    // than as an unhandled rejection and a timeout.
    let ruin;
    const ruined = new Promise((_, reject) => { ruin = reject; });
    ruined.catch(() => {});
    runtime.setMemoryLimit(MEMORY_BYTES);
    runtime.setMaxStackSize(STACK_BYTES);

    // The budget is an interrupt, as it is on the device, because a Promise.race cannot
    // stop a synchronous `while (true)`: nothing yields for it to win. It counts only JS
    // time, as `TimedRuntimeDispatcher` does: each run of JS (an evaluation, `resolvePromise`,
    // or the queue a host answer resumes) is timed, the runs of a call share one budget, and
    // time parked on a host function is between runs. A run outside any call, an abandoned
    // call's continuation, gets the whole budget, so a `while (true)` after its await is still cut.
    let callSpentMs = 0;
    let cutAt = Infinity;
    let runCut = false;

    // The calls in flight. One at a time on the device; here a test may run two side by side on
    // one realm, and then they share the budget and each keeps its own ceiling. Each call's `stopped` rejects when a run is cut mid-call,
    // whatever the run was doing: QuickJS turns an interrupt inside a promise job into a
    // rejection of that job's promise, so a chain the call never awaits would otherwise spend
    // the budget and leave the call to the ceiling.
    const running = new Set();
    const inCall = () => running.size > 0;
    const meter = {
      begin() {
        if (!inCall()) callSpentMs = 0;
        let stop;
        const stopped = new Promise((_, reject) => { stop = reject; });
        stopped.catch(() => {});
        const record = { stopped, stop, asks: openAsks() };
        running.add(record);
        return record;
      },
      stopAll: (reason) => { for (const record of running) record.stop(reason); },
      /** Whether [record] was the last call in flight. */
      end(record) {
        running.delete(record);
        return !inCall();
      },
    };

    runtime.setInterruptHandler(() => {
      polls += 1;
      runCut ||= Date.now() > cutAt;
      return runCut;
    });
    const timed = (run) => {
      const startedAt = Date.now();
      const charged = inCall();
      cutAt = startedAt + timeoutMs - (charged ? callSpentMs : 0);
      runCut = false;
      try {
        return run();
      } finally {
        if (charged) callSpentMs += Date.now() - startedAt;
        cutAt = Infinity;
        if (runCut) {
          interruptedCall = call;
          if (charged) meter.stopAll(INTERRUPTED);
        }
      }
    };
    const vm = runtime.newContext();

    /**
     * A thrown value, read in Node. Reading it runs its getters, or a Proxy's traps, which are
     * plugin code, so it is read under a short ceiling of its own: one that loops forever would
     * otherwise hang the CLI after its call. An interrupt that fires here stopped a getter, not
     * the call, so it is neither charged to the call nor recorded as the call's.
     */
    const dumpThrown = (handle) => {
      cutAt = Date.now() + DUMP_MS;
      try {
        return vm.dump(handle);
      } finally {
        cutAt = Infinity;
        runCut = false;
        handle.dispose();
      }
    };

    const pump = () => {
      let ran;
      try {
        ran = timed(() => runtime.executePendingJobs());
      } catch (error) {
        if (!overflowedNode(error)) throw error;
        ruin(error);
        return;
      }
      // A job does not throw: a plugin's exception rejects the promise it was run for. What
      // comes back is what nothing in the plugin can catch, the memory ceiling or the
      // interrupt, and it ends the call in flight. Outside a call it ends only the run.
      if (!ran.error) return;
      const thrown = dumpThrown(ran.error);
      meter.stopAll(thrown);
    };

    /**
     * What a promise the plugin handed back settles to: `{ value }`, a handle that is the
     * caller's to free, or `{ thrown }`, plain data. `resolvePromise` runs plugin code on the
     * way in, so it is a timed run too.
     */
    const settle = (handle) => {
      const settling = timed(() => vm.resolvePromise(handle));
      const cut = runCut;
      return settling.then(
        (result) => (result.error ? { thrown: dumpThrown(result.error) } : { value: result.value }),
        (error) => {
          if (overflowedNode(error)) throw error;
          return { thrown: cut ? INTERRUPTED : error.cause };
        });
    };

    /** [record]'s call's `settle`, ended early by whatever ends the call before its promise does. */
    const outcome = (handle, record) => Promise.race([
      settle(handle),
      ruined,
      record.stopped.catch((thrown) => ({ thrown })),
    ]);

    // A string read on its own goes through the build's default TextDecoder, which drops a
    // leading U+FEFF the device keeps. Read inside an array, it is JSON that starts with `[`
    // (kangzj/lantern-tv#590).
    const valueOf = (arg) => {
      if (vm.typeof(arg) !== 'string') return vm.dump(arg);
      const boxed = vm.newArray();
      vm.setProp(boxed, 0, arg);
      const [value] = vm.dump(boxed);
      boxed.dispose();
      return value;
    };

    /**
     * One `__host_*` function: JSON-ish arguments in, an envelope string out. A verdict it
     * reaches is written down for the call that asked, and only while that call is still the
     * one running: an answer landing after its call ended speaks for no other.
     */
    const register = (name, fn, isAsync, plain = false) => {
      const handle = vm.newFunction(name, (...args) => {
        // A plain string or null, not an envelope: a body in JSON would be copied once more to
        // be parsed. Only for a function that cannot fail. Made by evaluating a string literal,
        // because `newString` hands QuickJS a C string and a body's first NUL would end it.
        if (plain) {
          const value = fn(...args.map(valueOf));
          return value === null ? vm.null : vm.unwrapResult(vm.evalCode(JSON.stringify(value), 'yonto:host'));
        }
        const asked = call;
        const refuse = (error) => {
          if (error instanceof PluginError && asked === call) verdicts.add(error.code);
          return failed(name, error);
        };
        const values = args.map(valueOf);
        if (!isAsync) {
          try {
            return vm.newString(ok(fn(...values)));
          } catch (error) {
            return vm.newString(refuse(error));
          }
        }
        // The call in flight's, to wait for before that call ends; an ask made between calls
        // (an abandoned call's continuation) belongs to none. With calls side by side, which one
        // asked cannot be told, and it is charged to the latest: charged to every one, two calls
        // each waiting on the other's asks would hold each other open.
        const asks = [...running].at(-1)?.asks;
        asks?.opened();
        const deferred = vm.newPromise();
        // .catch after .then, not a second argument to it: `ok(value)` can throw on its
        // own — a host answer holding a BigInt cannot be JSON — and that is a failure to
        // report, not one to drop.
        Promise.resolve()
          .then(() => fn(...values))
          .then((value) => ok(value))
          .catch((error) => refuse(error))
          .then((envelope) => {
            const answer = vm.newString(envelope);
            deferred.resolve(answer);
            answer.dispose();
          })
          // Handing the answer back can itself fail, under the memory ceiling. Nothing
          // is left holding anything: the promise simply never settles, and the call's
          // own ceiling ends it.
          .catch(() => {});
        // From a macrotask, not the answer's microtask: a call abandoned at its ceiling that
        // keeps asking is refused at once, and refusals chained in one microtask checkpoint
        // never let Node reach a timer, the next call's ceiling included. The ask counts as
        // answered once what its answer resumed has run.
        deferred.settled.then(() => setImmediate(() => {
          pump();
          asks?.answered();
        }));
        return deferred.handle;
      });
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    };

    register('__host_config', () => yonto.config, false);
    register('__host_log', (level, message) => yonto.log(level, message), false);
    register('__host_partial', (reason) => yonto.partial(reason), false);
    register('__host_md5', (input) => yonto.crypto.md5(input), false);
    register('__host_sha1', (input) => yonto.crypto.sha1(input), false);
    register('__host_sha256', (input) => yonto.crypto.sha256(input), false);
    register('__host_hmacSha256', (key, message) => yonto.crypto.hmacSha256(key, message), false);
    register('__host_aesCbcDecrypt',
      (key, iv, data, padding) => yonto.crypto.aesCbcDecrypt(key, iv, data, { padding }), false);
    register('__host_base64Encode', (text) => yonto.encoding.base64Encode(text), false);
    register('__host_base64Decode', (base64) => yonto.encoding.base64Decode(base64), false);
    register('__host_hexToBase64', (hex) => yonto.encoding.hexToBase64(hex), false);
    register('__host_base64ToHex', (base64) => yonto.encoding.base64ToHex(base64), false);
    register('__host_textDecode', (base64, charset) => yonto.text.decode(base64, charset), false);
    // Read off disk on the first `yonto.html.load` or `yonto.xml.load` and not before,
    // which is what makes the laziness the same laziness the device has.
    //
    // A read, not a build: `npm install`'s prepare hook has normally produced this
    // already, and calling `buildParser()` unconditionally put an esbuild subprocess and
    // two file writes inside a plugin's call budget — 33 ms cold, and a build running as
    // a side effect of a plugin parsing markup, which is not a thing a host should do
    // (found in review). Built only when it is genuinely absent, which is a clone that
    // skipped the install.
    register('__host_parser', () => {
      const file = existsSync(PARSER_FILE) ? PARSER_FILE : buildParser();
      return readFileSync(file, 'utf8');
    }, false);
    // Read on the first `yonto.cryptoJs()` and not before, and built only when genuinely
    // absent, for the same two reasons as the parser above it.
    register('__host_cryptoJs', () => {
      const file = existsSync(CRYPTO_FILE) ? CRYPTO_FILE : buildCrypto();
      return readFileSync(file, 'utf8');
    }, false);
    // The same, for `yonto.jsEncrypt()`.
    register('__host_jsEncrypt', () => {
      const file = existsSync(JSENCRYPT_FILE) ? JSENCRYPT_FILE : buildJsEncrypt();
      return readFileSync(file, 'utf8');
    }, false);
    register('__host_fetch', async (requestJson) => {
      const { url, ...init } = fetchRequest(requestJson);
      const { body, bodyBase64, ...response } = await yonto.fetch(url, init);
      bodyIds += 1;
      if (callsRunning > 0) keepUnread(bodyIds, { body, bodyBase64, bytes: Buffer.byteLength(bodyBase64, 'base64') });
      return { ...response, bodyId: bodyIds };
    }, true);
    register('__host_fetchBody', (id) => unreadBodies.get(id)?.body ?? null, false, true);
    register('__host_fetchBodyBase64', (id) => {
      const unread = unreadBodies.get(id);
      if (unread) unreadBytes -= unread.bytes;
      unreadBodies.delete(id);
      return unread ? maskBodyBase64(unread.bodyBase64) : null;
    }, false, true);
    register('__host_sleep', (ms) => yonto.sleep(ms), true);
    // A string, to match what the Android host's envelope carries (`ok(String?)`), so the
    // bootstrap that reads it back is the same line on both sides.
    register('__host_now', () => String(yonto.now()), false);
    register('__host_installId', () => yonto.installId(), false);
    register('__host_subSource', () => yonto.subSource(), false);
    register('__host_storeGet', (key) => yonto.store.get(key), true);
    register('__host_storeSet',
      (key, valueJson, ttlSeconds) => yonto.store.set(key, JSON.parse(valueJson), { ttlSeconds }), true);
    register('__host_storeRemove', (key) => yonto.store.remove(key), true);
    register('__host_storeClear', () => yonto.store.clear(), true);
    if (yonto.session) {
      register('__host_sessionLinked', () => yonto.session.linked(), false);
      register('__host_sessionServers', () => yonto.session.servers(), true);
      register('__host_sessionRefused', () => yonto.session.refused(), false);
    }

    const loadTimedOut = (entryPath, limitMs, what) => new PluginError(Code.TIMEOUT,
      `${entryPath} did not finish loading within ${limitMs} ms${what}`, { entry: entryPath, timeoutMs: limitMs });

    /** A QuickJS failure while loading, reported the way the device reports it. */
    const loadFailure = (thrown, entryPath) => {
      if (thrown === CEILING) return loadTimedOut(entryPath, ceilingMs, '');
      // An interrupted evaluation arrives as an InternalError, exactly as it does
      // through quickjs-kt, where JsRuntime maps it to TIMEOUT. Only when the interrupt really
      // fired: a module body can throw an InternalError of its own that says 'interrupted'.
      if (interrupted(thrown) && interruptedCall === call) return loadTimedOut(entryPath, timeoutMs, ' of JavaScript');
      // The same rule as a call's failure, and the device's: an object's own message, a
      // primitive's text, and nothing at all rather than `null` (kangzj/lantern-tv#458).
      const said = redact(messageOf(thrown));
      return new PluginError(Code.METHOD_THREW,
        `${entryPath} threw while it was being evaluated${said ? `: ${said}` : ''}`,
        { entry: entryPath, stack: redact(authors(thrown?.stack ?? '')) });
    };

    /** Evaluates one script, and hands back what it evaluated to: the caller's to free. */
    const evaluate = (code, filename, entryPath) => {
      const result = timed(() => vm.evalCode(code, filename));
      if (result.error) throw loadFailure(dumpThrown(result.error), entryPath);
      return result.value;
    };

    // The plugin is reached only by the import in LOAD, under its own file's name, so a stack
    // frame points at what the author wrote. The name is taken as written, not resolved
    // against the importer's.
    runtime.setModuleLoader(
      (name) => (name === entry ? built.outputFiles[0].text : { error: new Error(`there is no module ${name}`) }),
      (_importer, requested) => requested);

    /**
     * Evaluates the plugin through a module that imports its namespace statically and hands it
     * back, the caller's to free, as `JsRuntime`'s bootstrap imports it. Not the plugin's own
     * evaluation promise: settling that to its namespace would call a `then` the plugin
     * exports, and read what it resolved to outside every timed run.
     *
     * A top-level await leaves the evaluation pending on the queue, so it is waited for the
     * way a call's answer is, and ended by whatever ends the call it is loaded in.
     */
    const evaluateModule = async (entryPath, record) => {
      const result = timed(() => vm.evalCode(LOAD(entryPath), 'yonto:load', { type: 'module' }));
      if (result.error) throw loadFailure(dumpThrown(result.error), entryPath);
      const settling = outcome(result.value, record);
      result.value.dispose();
      pump();

      const settled = await settling;
      if ('thrown' in settled) throw loadFailure(settled.thrown, entryPath);
      const namespace = vm.getProp(settled.value, 'plugin');
      settled.value.dispose();
      return namespace;
    };

    /**
     * Evaluates the host's bootstrap and then the plugin, once per runtime, inside the call
     * that first asks it for anything, as `JsRuntime` loads the modules after `callStarted`:
     * the module body's JS is spent from that call's budget and its waiting from that call's
     * ceiling.
     *
     * A load that fails takes its runtime with it rather than leaving one behind per attempt,
     * since a runtime is native memory no garbage collector reclaims: `doctor` calls seven
     * methods, and would otherwise build seven.
     */
    let modulesLoaded = false;
    const load = async (record) => {
      if (modulesLoaded) return;
      try {
        const adopt = evaluate(BOOTSTRAP, 'yonto:host', entry);
        let exported;
        try {
          exported = await evaluateModule(entry, record);
        } catch (failure) {
          adopt.dispose();
          throw failure;
        }
        // None of these runs plugin code: `adopt` is the bootstrap's own closure, `exported` is
        // a module namespace, and `default` on it is a binding, not a property with a getter.
        vm.callFunction(adopt, vm.undefined, exported).value.dispose();
        adopt.dispose();

        // `.default`, not just the module object: `export default 42` and a module with no
        // default at all both have to be MISSING_EXPORT, which is what JsRuntime's
        // MISSING_DEFAULT reports for the same plugin.
        const methods = vm.getProp(exported, 'default');
        const usable = vm.typeof(exported) === 'object' && vm.typeof(methods) === 'object';
        methods.dispose();
        exported.dispose();
        if (!usable) {
          throw new PluginError(Code.MISSING_EXPORT, `${entry} must default-export an object of methods`, { entry });
        }
        modulesLoaded = true;
      } catch (failure) {
        prepared = null;
        if (overflowedNode(failure)) {
          // Not disposed: freeing a runtime Node's stack ran out under is what aborts.
          throw new PluginError(Code.METHOD_THREW, `${entry} threw while it was being evaluated: stack overflow`, { entry });
        }
        // A module body that threw may have left an async host call in flight, and QuickJS
        // aborts rather than frees when one is outstanding. What the author needs is the
        // throw that stopped their plugin, not a WASM stack trace about a runtime nobody
        // asked them to think about; the memory outlives the process either way.
        try {
          vm.dispose();
          runtime.dispose();
        } catch { /* reported as `failure` below, which is the one worth reading */ }
        throw failure;
      }
    };

    /**
     * Resolves once every one of [asks] has been answered and what each answer resumed has
     * run, or rejects with what stopped the call first.
     */
    const answered = (record) => Promise.race([record.asks.all, ruined, record.stopped]);

    prepared = { vm, pump, timed, meter, dumpThrown, outcome, load, answered };
    return prepared;
  }

  /**
   * Whether [claimed] may stand as the code a call ends in: one a plugin may raise for itself,
   * or one a host function of this call answered it with. Asked here in Node, never of the
   * realm (`JsRuntime.unwrap` on the device).
   */
  const stands = (claimed) => typeof claimed === 'string' && (HONOURED_CODES.has(claimed) || verdicts.has(claimed));

  /** What a call's thrown value is: its code where [stands] says so, otherwise METHOD_THREW. */
  function asPluginError(cause, method) {
    if (cause instanceof PluginError) return cause;
    if (cause === CEILING) {
      return new PluginError(Code.TIMEOUT,
        `${method} did not finish or fail within ${ceilingMs} ms — it may never have intended to`,
        { method, timeoutMs: ceilingMs });
    }
    // The only thing that interrupts a plugin is the budget on its call, and an interrupt
    // arrives as an InternalError — the same mapping JsRuntime makes from
    // QuickJsInterruptedException. Only when the interrupt fired this call: a plugin can
    // throw an InternalError of its own that says 'interrupted'.
    if (interrupted(cause) && interruptedCall === call) {
      return new PluginError(Code.TIMEOUT,
        `${method} did not finish within ${timeoutMs} ms of JavaScript`, { method, timeoutMs });
    }
    // Plugin text crossing into the host, with every held credential taken out.
    const message = redact(messageOf(cause));
    const stack = redact(authors(cause?.stack ?? ''));
    if (!stands(cause?.code)) return new PluginError(Code.METHOD_THREW, `${method} threw: ${message}`, { method, stack });
    const error = new PluginError(cause.code, message, { method, stack });
    // The one thing a plugin may say beside its code, read in the realm by [withSignIn].
    if (cause.code === Code.UNAUTHENTICATED) error.signIn = true;
    return error;
  }

  /**
   * The answer the engine's own wrapper made, which a plugin can replace: a failure in it is
   * held to [stands] like a thrown one, and anything that is not its envelope is the plugin's.
   */
  function answerOf(envelope, method) {
    refuseTooDeep(envelope, method);
    let answer;
    try {
      answer = typeof envelope === 'string' ? JSON.parse(envelope) : null;
    } catch {
      answer = null;
    }
    if (answer === null || typeof answer !== 'object') throw new PluginError(Code.METHOD_THREW, NOT_JSON, { method });
    if (answer.ok === true) return answer.value;
    // The wrapper's own verdict, as `__yontoCall`'s is on the device.
    if (answer.code === Code.MISSING_EXPORT) throw new PluginError(Code.MISSING_EXPORT, messageOf(answer), { method });
    throw asPluginError(answer, method);
  }

  /** Node's stack gave out under [method]: the runtime is dropped, and the plugin is told
   *  what a device would tell it. */
  function stackOverflow(method) {
    prepared = null;
    return new PluginError(Code.METHOD_THREW, `${method} threw: stack overflow`, { method });
  }

  /**
   * Runs [body] as one call into the plugin, loading the modules first if no call has yet:
   * `JsRuntime.evaluate`. The host's deadline and sleep budget, the JS budget and the
   * wall-clock ceiling all start here, as `callStarted` starts them on the device, and the
   * last call in flight ends, however it ends, by cancelling the requests it left.
   *
   * The interrupt ends a call's JS once it has run the budget, but sees nothing of a call
   * parked on a host function or on a promise nothing settles; the ceiling ends that, at the
   * device's number, by stopping the call the way the interrupt does.
   */
  async function within(name, body) {
    const engine = await context();
    const record = engine.meter.begin();
    startCall(timeoutMs);
    startVerdicts();
    const ceiling = setTimeout(() => record.stop(CEILING), ceilingMs);
    try {
      await engine.load(record);
      const settled = await body(engine, record).then((answer) => ({ answer }), (failure) => ({ failure }));
      // Not over while the async host calls it made are still out, as quickjs-kt's `evaluate`
      // waits for every one: work a call left running is that call's. A failure the call
      // already has stands over what ends the wait.
      try {
        await engine.answered(record);
      } catch (stopped) {
        if ('failure' in settled) throw settled.failure;
        if (overflowedNode(stopped)) throw stopped;
        throw asPluginError(stopped, name);
      }
      if ('failure' in settled) throw settled.failure;
      return settled.answer;
    } finally {
      clearTimeout(ceiling);
      if (engine.meter.end(record)) endCall();
    }
  }

  /**
   * [error] as the realm reads its thrown value's `signIn`, which only an UNAUTHENTICATED is asked
   * for: a getter that throws makes the call the plugin's own failure, as on the device. The
   * value is let go either way.
   */
  function withSignIn({ vm, timed, dumpThrown }, call, error, method) {
    const read = error.code === Code.UNAUTHENTICATED;
    let asked;
    try {
      asked = timed(() => vm.evalCode(`__yontoDeclined(${call}, ${read})`, 'yonto:call'));
    } catch {
      return error;
    }
    if (asked.error) return asPluginError(dumpThrown(asked.error), method);
    if (read && vm.dump(asked.value) === true) error.signIn = false;
    asked.value.dispose();
    return error;
  }

  async function invokeOnce(engine, record, method, args) {
    const { vm, pump, timed, dumpThrown, outcome } = engine;
    // Timed as a run of the call, which is what reads `plugin[method]` — a getter, or a
    // Proxy trap, is plugin code with nothing above it — as well as running the method.
    const call = ++calls;
    const started = timed(() => vm.evalCode(
      `__yontoInvoke(${JSON.stringify(method)}, ${JSON.stringify(JSON.stringify(args))}, ${call})`,
      'yonto:call'));
    if (started.error) throw asPluginError(dumpThrown(started.error), method);

    // resolvePromise reads the handle and disposes only its own intermediates, so the
    // one it is given is still ours to free.
    const settling = outcome(started.value, record);
    started.value.dispose();
    // Pumped here for a method that awaited nothing, and again by each host answer as it
    // settles.
    pump();

    const settled = await settling;
    if ('thrown' in settled) throw withSignIn(engine, call, asPluginError(settled.thrown, method), method);
    const envelope = vm.typeof(settled.value) === 'string' ? vm.getString(settled.value) : undefined;
    settled.value.dispose();
    return answerOf(envelope, method);
  }

  return {
    /** The interrupt polls so far: the calls, loop back-edges and regex backtracking run. */
    polls: () => polls,
    async exports() {
      return within('exports', async ({ vm, timed, dumpThrown }) => {
        let answer;
        try {
          // Object.keys over the plugin, so a Proxy's ownKeys trap runs here too.
          answer = timed(() => vm.evalCode('__yontoExports()', 'yonto:call'));
        } catch (error) {
          if (overflowedNode(error)) throw stackOverflow('exports');
          throw error;
        }
        if (answer.error) throw asPluginError(dumpThrown(answer.error), 'exports');
        const envelope = vm.typeof(answer.value) === 'string' ? vm.getString(answer.value) : undefined;
        answer.value.dispose();
        refuseTooDeep(envelope, 'exports');
        let names;
        try {
          names = typeof envelope === 'string' ? JSON.parse(envelope) : null;
        } catch {
          names = null;
        }
        if (!Array.isArray(names)) throw new PluginError(Code.METHOD_THREW, NOT_JSON, { method: 'exports' });
        return names;
      });
    },
    /** Calls one exported method and returns its answer, or undefined. */
    async call(method, args = []) {
      callsRunning += 1;
      try {
        return await within(method, (engine, record) => invokeOnce(engine, record, method, args));
      } catch (error) {
        // No answer, so nothing for `yonto.partial`'s sentence to be about: the device's
        // `JsRuntime.answer` never reads it for a call that failed either.
        takePartial();
        if (overflowedNode(error)) throw stackOverflow(method);
        throw error;
      } finally {
        callsRunning -= 1;
        if (callsRunning === 0) {
          unreadBodies.clear();
          unreadBytes = 0;
        }
      }
    },
  };
}
