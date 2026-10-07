/* yonto-plugin
{
  "kind": "content-source",
  "id": "xptv-js",
  "name": "XPTV format",
  "version": "0.3.3",
  "contractVersion": 21,
  "description": "Reads catalogs written for the XPTV format. Each is a small program, which Yonto fetches from the address you supply and runs in its sandbox; Yonto includes no catalog.",
  "probeQuery": "画皮",
  "provides": "source-type",
  "handles": ["xptv-js"],
  "allowedHosts": [],
  "hostsFromConfig": true,
  "runsFetchedCode": true,
  "playbackTokens": true,
  "configSchema": [
    {
      "id": "ext",
      "label": "Program address",
      "type": "url",
      "required": true
    },
    {
      "id": "className",
      "label": "Class name (optional)",
      "type": "text"
    }
  ],
  "capabilities": [
    { "type": "browserCheck", "fromConfig": true }
  ]
}
*/
// The loader for one `xptv-js` catalog: a stranger's program at `ext`, compiled with `new
// Function` and handed XPTV's twelve names over `yonto.*`. `plugins/xptv-js/AGENTS.md` has the
// realm, what a hostile catalog reaches, the ids and the store keys, and why each is pinned.

const EXT_NOT_A_URL_MESSAGE = "The program address isn't a full http(s) address. Check it.";

const HTTP_URL = /^https?:\/\/\S+$/;

// Anything URL-shaped, with or without a scheme and with its slashes escaped or not. It runs on
// through Chinese and stops at a space, a quote, or CJK and fullwidth punctuation. The
// lookbehind keeps a long hex blob from being tried at every character, which is quadratic.
const ANY_URL = /(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:)?(?:\\?\/){2}[^\s"'<>\u3000-\u303f\uff00-\uffef]+/gi;

// What a name has to hold for its value to be hidden. `sig` covers `sign` and `signature`, `pu+s`
// Baidu's `__pus` and `__puus`, and `ck` counts only standing apart from letters.
const SECRET_STEMS = ['token', 'key', 'sig', 'auth', 'sid', 'sess', 'secret', 'pass', 'pwd', 'cookie', 'ticket', 'bduss', 'pu+s', 'jwt', 'csrf', '(?<![a-z])ck(?![a-z])'];
const SECRET = new RegExp(SECRET_STEMS.join('|'), 'i');

// A name, maybe a `]` and a JSON key's closing quote, then a separator, with the value on that
// line or the next; or a bare `Bearer`. The stems are tested on the name afterwards, because
// inside the pattern they make it backtrack across a long run once per stem.
const NAMED = /(?<![\w.-])(?:([\w.-]+)\]?(?:\\?["'])?[ \t]*(?:[=:：＝]|%3D)[ \t]*(?:\r?\n[ \t]*)?|bearer[ \t]+)/gi;

// Names whose value is a credential whole, spaces and all: `Bearer …`, `a=1; b=2`.
const WHOLE_CREDENTIAL = /cookie|(?:authorization|auth-token)$/i;

const BRACKETS = { '{': 1, '[': 1, '}': -1, ']': -1 };

function quotedEnd(text, start) {
  for (let at = start + 1; at < text.length; at += 1) {
    if (text[at] === '\\') at += 1;
    else if (text[at] === text[start]) return at + 1;
  }
  return text.length;
}

/** Where `\"…\"` (JSON printed as a JSON string) that opens at [start] ends. */
function escapedQuotedEnd(text, start) {
  const quote = text[start + 1];
  let escaped = false;
  for (let at = start + 2; at < text.length; at += 1) {
    const outer = text[at] === '\\';
    if (outer) at += 1;
    if (!outer && text[at] === quote) return at;
    if (escaped) escaped = false;
    else if (outer && text[at] === '\\') escaped = true;
    else if (outer && text[at] === quote) return at + 1;
  }
  return text.length;
}

function bracketedEnd(text, start) {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    if (text[at] === '"' || text[at] === '\'') at = quotedEnd(text, at) - 1;
    else if (BRACKETS[text[at]]) {
      depth += BRACKETS[text[at]];
      if (depth === 0) return at + 1;
    }
  }
  return text.length;
}

function secretEnd(text, start, name) {
  const first = text[start];
  if (first === '"' || first === '\'') return quotedEnd(text, start);
  if (first === '\\' && (text[start + 1] === '"' || text[start + 1] === '\'')) return escapedQuotedEnd(text, start);
  if (first === '{' || first === '[') return bracketedEnd(text, start);
  const rest = text.slice(start);
  const length = WHOLE_CREDENTIAL.test(name) ? rest.search(/\\?"|[\r\n]|$/) : rest.search(/\\?["']|[ \r\n&;<>(){}[\]]|%26|$/i);
  return start + length;
}

function hideSecrets(text) {
  let hidden = '';
  let from = 0;
  NAMED.lastIndex = 0;
  for (let match = NAMED.exec(text); match; match = NAMED.exec(text)) {
    const [named, name = ''] = match;
    if (match[1] !== undefined && !SECRET.test(name)) continue;
    const start = match.index + named.length;
    const end = secretEnd(text, start, name);
    if (end === start) continue;
    hidden += `${text.slice(from, start)}<hidden>`;
    from = end;
    NAMED.lastIndex = end;
  }
  return hidden + text.slice(from);
}

function blank(text) {
  return hideSecrets(text.replace(ANY_URL, '<a URL>'));
}

/**
 * `yonto.log`, with everything URL-shaped blanked and every secret-named value hidden, because
 * a catalog's `$print`, its toasts and what it throws are a stranger's text on its way to logcat.
 * A line that opens with `catalog <logName>` or `[<logName>]` keeps that opening out of the
 * secret pass, so a class name like `csp_apikey` doesn't take the words after it.
 */
function log(level, message, entry) {
  const text = String(message);
  const label = entry && [`catalog ${entry.logName}`, `[${entry.logName}]`].find((it) => text.startsWith(it));
  const kept = label ? label.replace(ANY_URL, '<a URL>') : '';
  yonto.log(level, kept + blank(text.slice(label?.length ?? 0)));
}

// The headers `yonto.fetch` refuses by name, which a native XPTV sends or ignores: one of them
// would cost the whole request. `request-rules.json` is the list, and a test holds this copy to it.
const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'access-control-request-private-network', 'connection', 'content-length', 'cookie2', 'date', 'dnt',
  'expect', 'host', 'keep-alive', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-'];
// Refused by value: these name a method to tunnel, and only a forbidden one is refused.
const METHOD_OVERRIDE_HEADERS = ['x-http-method', 'x-http-method-override', 'x-method-override'];
const FORBIDDEN_METHODS = ['CONNECT', 'TRACE', 'TRACK'];

// The host's `HeaderRule`, character for character.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** Every scalar in a stranger's file may be a number, a null or an object. */
function str(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/** The first of everything that answers to one id: Compose throws on a repeated list key. */
function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
}

/**
 * The catalog this source is, read on each use because a module may not read `yonto` while it
 * is being evaluated.
 *
 * `address` is `ext` exactly as it arrives, trimmed, and it names both store keys. `logName` is
 * the class name, never the address, since an address can carry a token.
 */
function theCatalog() {
  const address = str(yonto.config.ext);
  if (!HTTP_URL.test(address)) throw yonto.error.misconfigured(EXT_NOT_A_URL_MESSAGE);
  return { address, logName: str(yonto.config.className) || 'xptv-js' };
}

// ------------------------------------------------------- a catalog's own code, and its names

const CATALOG_SOURCE_KEEP_SECONDS = 7 * 24 * 60 * 60;

/** XPTV's own entry points. `compileCatalog` guards each, since a catalog need not declare all. */
const ENTRY_POINTS = ['getConfig', 'getTabs', 'getCards', 'getTracks', 'getPlayinfo', 'search'];

// The sentences name the part that failed and not the catalog: the app's headline already names
// the source, and a source here is one catalog.
const CATALOG_UNREACHABLE_MESSAGE = "Can't download this source's program right now. Try again later.";
// Not "try again later": a program over the host's cap will be just as large next time.
const CATALOG_TOO_LARGE_MESSAGE = "This source's program is too large to load.";
const CATALOG_BROKEN_MESSAGE = "This source's program won't run. It may be out of date.";
const SITE_DOWN_MESSAGE = "This source's website isn't available right now. Try again later.";
const NO_CATEGORIES_MESSAGE = 'This source has no categories to browse. Use search instead.';
const NO_SEARCH_MESSAGE = "This source doesn't have search. Try another source.";
const NO_STREAM_MESSAGE = 'This source gave no address to play.';
// A title for an id whose name is missing, which only an id this plugin did not write can be.
const UNTITLED = '未命名';

function noTracksMessage(title) {
  return `"${title}" has nothing to play.`;
}

function notPlayableMessage(title) {
  return `"${title}" can't be played in this version yet, only browsed.`;
}

/**
 * The browser checks this plugin's own shims raise, so the catches below let them past with their
 * sentence. A `WeakSet` rather than a `code` test, which would pass a stranger's hand-built
 * `{ code: 'NOT_FOUND' }` too.
 */
const refusals = new WeakSet();

/**
 * XPTV's `openSafari`, as a request for the browser check the host offers at the page the
 * catalog was on. Their agent is not taken: the host has the one the check runs under.
 */
function askForCheck(url) {
  const error = yonto.error.challenged(String(url));
  refusals.add(error);
  return error;
}

/** A catalog's JavaScript, from the store when it is there and the network otherwise. */
async function catalogSource(entry) {
  const key = `catalog:${entry.address}`;
  const stored = await yonto.store.get(key);
  if (typeof stored === 'string' && stored !== '') return { key, source: stored, kept: true };
  let response;
  try {
    response = await yonto.fetch(entry.address);
  } catch (error) {
    // The host's message names `ext`, which can carry a token, so only its code goes on.
    if (!HOST_FAILURE_CODES.has(error?.code)) throw error;
    log('warn', `catalog ${entry.logName}: its program could not be fetched (${error.code})`, entry);
    throw yonto.error.unavailable(error.code === 'RESPONSE_TOO_LARGE' ? CATALOG_TOO_LARGE_MESSAGE : CATALOG_UNREACHABLE_MESSAGE);
  }
  if (response.status < 200 || response.status >= 300) {
    log('warn', `catalog ${entry.logName} answered HTTP ${response.status}`, entry);
    throw yonto.error.unavailable(CATALOG_UNREACHABLE_MESSAGE);
  }
  const source = response.body;
  if (typeof source !== 'string' || source.trim() === '') {
    throw yonto.error.unavailable(CATALOG_UNREACHABLE_MESSAGE);
  }
  // Kept only once it has compiled and loaded (`compileCatalog`).
  return { key, source, kept: false };
}

/** A cache write that fails loses nothing. The log names [what], never the key. */
async function keepQuietly(key, value, ttlSeconds, what) {
  try {
    await yonto.store.set(key, value, { ttlSeconds });
  } catch (error) {
    log('warn', `could not keep ${what}: ${error?.message ?? error}`);
  }
}

/**
 * A catalog's `$cache`, held whole in memory for the length of a call, because theirs is
 * synchronous (`leijing.js` reads its token with no `await`). One store key for the map, since
 * the store cannot list keys.
 */
let cacheState = null;

async function loadCache(entry) {
  const key = `cache:${entry.address}`;
  const stored = await yonto.store.get(key);
  const map = stored !== null && typeof stored === 'object' ? { ...stored } : {};
  cacheState = { key, logName: entry.logName, map, dirty: false };
}

/** Written back once, at the end of the call that dirtied it, and awaited. */
async function flushCache() {
  if (cacheState === null || !cacheState.dirty) return;
  cacheState.dirty = false;
  await keepQuietly(cacheState.key, cacheState.map, CATALOG_SOURCE_KEEP_SECONDS, `catalog ${cacheState.logName}'s cache`);
}

/**
 * What their `$fetch` answers with: `data`, `status` and `respHeaders`, the only names their
 * plugins read. Header names are case-insensitive, so `respHeaders` answers to any spelling.
 * `set-cookie` is the array `yonto.fetch` answers, which `split` also folds on a comma, because
 * some plugins index it and `anime1.js` splits it as XPTV's string.
 */
function fetchAnswer(response) {
  const cookies = response.setCookie ?? [];
  const headers = {};
  for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
  headers['set-cookie'] = Object.defineProperty([...cookies], 'split', {
    value: (separator) => cookies.join(',').split(separator),
  });
  const lowered = (name) => (typeof name === 'string' ? name.toLowerCase() : name);
  return {
    data: response.body,
    status: response.status,
    respHeaders: new Proxy(headers, {
      // A header by any casing, and everything else (`toString`, `hasOwnProperty`) as an object has it.
      get: (target, name) => Reflect.get(target, Object.prototype.hasOwnProperty.call(target, lowered(name)) ? lowered(name) : name),
      has: (target, name) => lowered(name) in target,
    }),
  };
}

/** An object body is JSON, unless the catalog says the request is a form. */
function requestBody(body, headers) {
  if (typeof body === 'string') return body;
  const type = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (!/^application\/x-www-form-urlencoded/i.test(String(type ?? '')) || body === null || typeof body !== 'object') {
    return JSON.stringify(body);
  }
  return Object.entries(body)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** XPTV's `$html`, where an element is its markup, so the next call can parse it again. */
function htmlShim() {
  const first = (source, selector) => yonto.html.load(source)(selector).first();
  return {
    elements: (source, selector) => {
      const $ = yonto.html.load(source);
      return $(selector).toArray().map((element) => $.html(element));
    },
    text: (source, selector) => first(source, selector).text().trim(),
    attr: (source, selector, name) => first(source, selector).attr(name) ?? '',
  };
}

/**
 * The twelve names XPTV injects, built from explicit `yonto.x.y` references: handing
 * `yonto` over as a value would reduce `lint`'s contract-version answer to a floor.
 */
function shimsFor(entry) {
  const say = (level) => (...parts) => log(level, `[${entry.logName}] ${parts.map(String).join(' ')}`, entry);
  return {
    $fetch: {
      get: (url, options) => catalogFetch(entry, url, { headers: options?.headers }),
      post: (url, body, options) => catalogFetch(entry, url, {
        method: 'POST',
        headers: options?.headers,
        body: requestBody(body, options?.headers),
      }),
    },
    createCheerio: () => ({ load: (markup) => yonto.html.load(markup) }),
    // The real library: their plugins use `AES.encrypt`, `mode.ECB` and `WordArray` objects.
    createCryptoJS: () => yonto.cryptoJs(),
    $print: (message) => log('info', `[${entry.logName}] ${String(message)}`, entry),
    // XPTV's runtime has one, and their plugins log their own errors through it.
    console: {
      log: say('info'), info: say('info'), debug: say('info'), warn: say('warn'), error: say('warn'),
    },
    $cache: {
      get: (key) => cacheState.map[String(key)],
      set: (key, value) => {
        cacheState.map[String(key)] = value;
        cacheState.dirty = true;
      },
      del: (key) => {
        delete cacheState.map[String(key)];
        cacheState.dirty = true;
      },
    },
    $utils: {
      // Logged, and the catalog carries on: the call already worked (kangzj/lantern-tv#357).
      toastInfo: (message) => log('info', `[${entry.logName}] toast: ${String(message)}`, entry),
      toastError: (message) => log('warn', `[${entry.logName}] toast: ${String(message)}`, entry),
      // A catalog calling it waits for the viewer, so carrying on would answer as if they had.
      openSafari: (url) => {
        throw askForCheck(url);
      },
      os: () => 'Yonto',
      app: () => '1.0',
    },
    loadJSEncrypt: () => yonto.jsEncrypt(),
    $html: htmlShim(),
    argsify: (text) => JSON.parse(text),
    jsonify: (value) => JSON.stringify(value),
  };
}

/**
 * The names a compiled catalog must not find, passed as `undefined` parameters. Hygiene, not
 * containment: `new Function('return this')()` and its relatives still reach the real global.
 */
function shadowedNames() {
  const host = Object.getOwnPropertyNames(globalThis)
    .filter((name) => name.startsWith('__host_') || name.startsWith('__yonto'));
  return ['yonto', 'globalThis', ...host];
}

/**
 * Compile a catalog's source and hand back its entry points. Called with a fresh `this`, since a
 * sloppy-mode body's `undefined` `this` would otherwise be the global object.
 */
async function compileCatalog(entry) {
  const { key, source, kept } = await catalogSource(entry);
  // Before the body runs, since a catalog may read its cache at module scope.
  await loadCache(entry);
  const shims = shimsFor(entry);
  const shimNames = Object.keys(shims);
  // Their plugin's own settings, and not this source's: `yonto.config` would hand a
  // stranger's code the viewer's config and still be the wrong shape.
  const configNames = ['$config', '$config_str'];
  const blocked = shadowedNames();
  const returns = ENTRY_POINTS
    .map((name) => `${name}: typeof ${name} === 'function' ? ${name} : undefined`)
    .join(', ');

  let compiled;
  try {
    compiled = new Function(
      ...shimNames, ...configNames, ...blocked,
      // An inner function, so the catalog's own `let $config` shadows the parameter instead of
      // redeclaring it, which is what a script at XPTV's global scope may do.
      `return (function () {\n${source}\n;return { ${returns} };\n}).call(this);`,
    );
  } catch (error) {
    log('warn', `catalog ${entry.logName} did not compile: ${error?.message ?? error}`, entry);
    throw yonto.error.unavailable(CATALOG_BROKEN_MESSAGE);
  }

  const args = [...shimNames.map((name) => shims[name]), {}, '{}', ...blocked.map(() => undefined)];
  let exports;
  try {
    exports = compiled.call({}, ...args);
  } catch (error) {
    // A shim refused at module scope, which is where their plugins call `createCryptoJS()`.
    if (refusals.has(error)) throw error;
    log('warn', `catalog ${entry.logName} threw while loading: ${error?.message ?? error}`, entry);
    throw yonto.error.unavailable(CATALOG_BROKEN_MESSAGE);
  }
  // Not kept until it has compiled and loaded: a CDN's error page served with a 200 would
  // otherwise refuse this catalog for a week.
  if (!kept) await keepQuietly(key, source, CATALOG_SOURCE_KEEP_SECONDS, `catalog ${entry.logName}'s source`);
  return exports;
}

/** The compiled catalog and the answer its `getConfig` gave. */
let compiledCatalog = null;

/**
 * Their runtime calls `getConfig()` on load and some catalogs do setup in there, so it runs
 * before every path, once per compiled catalog. A failure is kept rather than raised, since only
 * [pluginCategories] needs the answer, and it is asked again on the next call. So is one that ran
 * while the site was down: tabs scraped off a 5xx page are empty, and kept they would say
 * search-only after the site came back.
 */
async function configOf(entry, catalog) {
  if (typeof catalog.getConfig !== 'function') return { config: null, failed: null };
  try {
    const config = await answering(entry, async () => JSON.parse(await catalog.getConfig()));
    return { config, failed: null };
  } catch (error) {
    // Kept, it would read as search-only until the viewer went to find a check nobody offered.
    if (error?.code === 'CHALLENGED' && refusals.has(error)) throw error;
    log('warn', `catalog ${entry.logName}: getConfig failed, carrying on without its setup`, entry);
    return { config: null, failed: error };
  }
}

async function catalogFor(entry) {
  siteFailedThisCall = false;
  if (compiledCatalog === null) {
    const catalog = await compileCatalog(entry);
    compiledCatalog = { catalog, config: null, failed: null, configured: false };
  }
  if (!compiledCatalog.configured) {
    const { config, failed } = await configOf(entry, compiledCatalog.catalog);
    Object.assign(compiledCatalog, { config, failed, configured: failed === null && !siteFailedThisCall });
  }
  return compiledCatalog;
}

/**
 * Everything a stranger's code returns is read inside this, so the engine's own words about
 * somebody else's program never reach a screen. A shim's own refusal keeps its sentence.
 */
async function answering(entry, read) {
  try {
    return await read();
  } catch (error) {
    if (refusals.has(error)) throw error;
    log('warn', `catalog ${entry.logName} answered badly: ${failureText(error)}`, entry);
    throw orSiteDown(yonto.error.unavailable(CATALOG_BROKEN_MESSAGE));
  }
}

// The host's own codes, logged by the code alone since each message can name the URL.
// `RESPONSE_TOO_LARGE` arrives with kangzj/lantern-tv#716 and is listed ahead of it, since its
// message names the URL too.
const HOST_FAILURE_CODES = new Set([
  'REQUEST_FAILED', 'REQUEST_INVALID', 'REDIRECT_REFUSED', 'TIMEOUT', 'HOST_NOT_ALLOWED', 'RESPONSE_TOO_LARGE',
]);

/** Their request's headers less the ones the host refuses by name. */
function withoutForbiddenHeaders(entry, headers) {
  if (headers === null || typeof headers !== 'object') return headers;
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const overridesMethod = METHOD_OVERRIDE_HEADERS.includes(lower)
      && String(value).split(',').some((method) => FORBIDDEN_METHODS.includes(method.trim().toUpperCase()));
    if (overridesMethod || FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      log('info', `catalog ${entry.logName}: not sending ${name}, which the host owns`, entry);
    } else {
      kept[name] = value;
    }
  }
  return kept;
}

/**
 * A catalog's `$fetch`, whose failure carries the host's code and not its message: the message
 * names the URL, search text and all, and catalogs rethrow it as their own words.
 */
async function catalogFetch(entry, url, init) {
  let response;
  try {
    response = await yonto.fetch(url, { ...init, headers: withoutForbiddenHeaders(entry, init.headers) });
  } catch (error) {
    if (!HOST_FAILURE_CODES.has(error?.code)) throw error;
    siteFailedThisCall = SITE_FAILURES.has(error.code);
    if (siteFailedThisCall) log('warn', `catalog ${entry.logName}: ${SITE_FAILURES.get(error.code)} (${error.code})`, entry);
    throw Object.assign(new Error(error.code), { code: error.code });
  }
  siteFailedThisCall = response.status >= 500;
  if (siteFailedThisCall) log('warn', `catalog ${entry.logName}: a request answered HTTP ${response.status}`, entry);
  return fetchAnswer(response);
}

/**
 * Whether the latest `$fetch` of the call now running got no answer, a redirect chain the host
 * refused, or a 5xx (kangzj/lantern-tv#579). Their code never reads `status`, so this is how an
 * empty answer or a throw is told apart from the site being down. `TIMEOUT` is the call running out
 * of time, `REQUEST_INVALID` a request their code built wrong and a 4xx the site answering, so
 * none of those counts. Cleared by [catalogFor] and again by [ask], so setup fetches count only for
 * `getCategories`. A runtime runs one call at a time.
 */
let siteFailedThisCall = false;

/** The host's codes that mean the site failed, and what the log says of each. */
const SITE_FAILURES = new Map([
  ['REQUEST_FAILED', 'a request got no answer'],
  ['REDIRECT_REFUSED', 'a request was redirected in a way the host refused'],
]);

function siteDown() {
  return yonto.error.unavailable(SITE_DOWN_MESSAGE);
}

function orSiteDown(otherwise) {
  return siteFailedThisCall ? siteDown() : otherwise;
}

/** A host's own failure is logged by its code, because its message can name the URL asked. */
function failureText(error) {
  return HOST_FAILURE_CODES.has(error?.code) ? error.code : (error?.message ?? String(error));
}

/** A catalog's tabs, from its config and then from `getTabs()` if that offered none. */
async function tabsOf(entry, catalog, config) {
  if (Array.isArray(config?.tabs) && config.tabs.length > 0) return config.tabs;
  if (typeof catalog.getTabs !== 'function') return [];
  return answering(entry, async () => {
    const tabs = JSON.parse(await catalog.getTabs());
    return Array.isArray(tabs) ? tabs : [];
  });
}

/** One of their entry points: a JSON string in, a JSON string out, and the ceremony stops here. */
async function ask(entry, catalog, name, ext) {
  siteFailedThisCall = false;
  return answering(entry, async () => JSON.parse(await catalog[name](JSON.stringify(ext))));
}

// --------------------------------------------------- a catalog's contents, in our shapes

// What a media id spends before it drops the artwork. A budget, not a cap: the `ext` is what `getTracks` is asked with, so one over budget on its own
// goes out with a `warn`.
const MEDIA_ID_BUDGET = 1024;

// A media id is this envelope and a category id is a tab's `ext` bare; each reader refuses the
// other's.
const MEDIA_ENVELOPE = 'e';

/**
 * `{"e":<the card's ext>,"n":<name>,"p":<artwork>}`: their `getTracks` answers no metadata, so the
 * detail screen draws from this.
 */
function mediaId(entry, { ext, title, poster }) {
  const inner = { [MEDIA_ENVELOPE]: ext, n: title, p: poster };
  const encode = () => JSON.stringify(inner);
  const spent = () => encode().length;
  if (spent() <= MEDIA_ID_BUDGET) return encode();
  if (inner.p !== '') {
    log('info', `catalog ${entry.logName}: media id over ${MEDIA_ID_BUDGET}, dropped the artwork`, entry);
    inner.p = '';
  }
  if (spent() > MEDIA_ID_BUDGET) {
    log('warn', `catalog ${entry.logName}: media id is ${spent()} characters, its ext alone is over budget`, entry);
  }
  return encode();
}

/** A category id: the tab's whole `ext` as JSON, which is what their `getCards` is asked with. */
function categoryIdOf(tab) {
  return JSON.stringify(tab?.ext ?? {});
}

// The contract's bound on a `track`.
const TRACK_BUDGET = 2048;

// A token's envelope, so a stale token is never asked about as though it were a tab.
const TRACK_ENVELOPE = 't';

/**
 * `{"t":<the track's ext>}`, or null when it will not fit. Never pruned or truncated: the
 * loader cannot know which fields their `getPlayinfo` reads.
 */
function trackToken(entry, ext) {
  const token = JSON.stringify({ [TRACK_ENVELOPE]: ext ?? {} });
  if (token.length <= TRACK_BUDGET) return token;
  log('warn', `catalog ${entry.logName}: a track's ext is ${token.length} characters, over the ${TRACK_BUDGET} a token may be`, entry);
  return null;
}

/** What this plugin wrote into one of its ids, and `notFound` for anything else. */
function innerOf(id) {
  try {
    return JSON.parse(id);
  } catch (error) {
    log('warn', `not an id this plugin wrote: ${error?.message ?? error}`);
    throw yonto.error.notFound(id);
  }
}

function trackExt(token) {
  let parsed;
  try {
    parsed = JSON.parse(token);
  } catch (error) {
    log('warn', `not a token this plugin wrote: ${error?.message ?? error}`);
    throw yonto.error.notFound(token);
  }
  if (parsed === null || typeof parsed !== 'object' || !(TRACK_ENVELOPE in parsed)) {
    log('warn', 'not a token this plugin wrote: no track envelope');
    throw yonto.error.notFound(token);
  }
  return parsed[TRACK_ENVELOPE];
}

function mediaParts(entry, id) {
  const parsed = innerOf(id);
  if (parsed === null || typeof parsed !== 'object' || !(MEDIA_ENVELOPE in parsed)) {
    log('warn', `catalog ${entry.logName}: not a media id`, entry);
    throw yonto.error.notFound(id);
  }
  return { ext: parsed[MEDIA_ENVELOPE], title: str(parsed?.n) || UNTITLED, poster: str(parsed?.p) };
}

/**
 * Their card as a `MediaSummary`. `vod_id` is not read, since their host opens a title by its
 * `ext`, and `vod_remarks` is free text nothing should guess a type from.
 */
function summaryOf(entry, card) {
  const title = str(card?.vod_name);
  if (title === '') return null;
  const poster = str(card?.vod_pic);
  const summary = { id: mediaId(entry, { ext: card?.ext ?? {}, title, poster }), title };
  if (poster !== '') summary.posterUrl = poster;
  return summary;
}

function summaries(entry, list) {
  const cards = Array.isArray(list) ? list : [];
  return uniqueById(cards.map((card) => summaryOf(entry, card)).filter((summary) => summary !== null));
}

// Their name for the unrestricted option, in every plugin of theirs that has one (48 checked, 2026-09-24).
const ALL = '全部';

/**
 * Their filter groups as ours. `init` only when it names one of the group's own options
 * (kangzj/lantern-tv#550); their 全部 dropped from a group without one whatever its id (ole's is
 * '0'), since the app draws its own All (kangzj/lantern-tv#589, #621); a group keyed `page`
 * dropped, since the contract reserves it.
 */
function filterGroups(filter) {
  const seen = new Set();
  const groups = [];
  for (const group of Array.isArray(filter) ? filter : []) {
    const id = str(group?.key);
    if (id === '' || id === 'page' || seen.has(id)) continue;
    const offered = [];
    const chosen = new Set();
    for (const option of Array.isArray(group?.value) ? group.value : []) {
      const name = str(option?.n);
      const value = str(option?.v);
      if (name === '' || chosen.has(value)) continue;
      chosen.add(value);
      offered.push({ id: value, name });
    }
    const written = group?.init;
    const named = typeof written === 'string' || typeof written === 'number' ? str(written) : null;
    const init = named && chosen.has(named) ? { init: named } : {};
    const options = 'init' in init ? offered : offered.filter((option) => option.id !== '' && option.name !== ALL);
    if (options.length === 0) continue;
    seen.add(id);
    groups.push({ id, name: str(group?.name) || id, ...init, options });
  }
  return groups;
}

/** One page of a category: their `getCards`, asked with the tab's `ext` plus `page` and `filters`. */
async function cardsPage(entry, catalog, categoryId, options) {
  if (typeof catalog.getCards !== 'function') {
    log('warn', `catalog ${entry.logName} declares tabs and no getCards`, entry);
    throw yonto.error.unavailable(CATALOG_BROKEN_MESSAGE);
  }
  const ext = innerOf(categoryId);
  if (ext !== null && typeof ext === 'object' && MEDIA_ENVELOPE in ext) {
    log('warn', `catalog ${entry.logName}: not a category id`, entry);
    throw yonto.error.notFound(categoryId);
  }
  // Spreading a string or a list would hand `getCards` an object of numbered characters.
  const usable = ext !== null && typeof ext === 'object' && !Array.isArray(ext);
  if (!usable) log('warn', `catalog ${entry.logName}: a tab ext that is not an object, asking with none`, entry);
  const base = usable ? ext : {};
  const page = Math.trunc(options?.page ?? 1);
  const asked = { ...base, page: page >= 1 ? page : 1 };
  const filters = options?.filters ?? {};
  if (Object.keys(filters).length > 0) asked.filters = filters;
  const answer = await ask(entry, catalog, 'getCards', asked);
  return { cards: summaries(entry, answer?.list), filter: answer?.filter };
}

async function pluginCategories(entry) {
  const { catalog, config, failed } = await catalogFor(entry);
  if (failed !== null) throw failed;
  if (typeof catalog.getConfig !== 'function') {
    throw yonto.error.unavailable(CATALOG_BROKEN_MESSAGE);
  }
  const tabs = await tabsOf(entry, catalog, config);
  await flushCache();
  const categories = tabs
    .map((tab) => ({ id: categoryIdOf(tab), name: str(tab?.name) }))
    .filter((category) => category.name !== '');
  const unique = uniqueById(categories);
  if (unique.length < categories.length) {
    log('info', `catalog ${entry.logName}: ${categories.length - unique.length} tabs share an ext`, entry);
  }
  // Search-only is a working catalog (`tianyiso.js`), not a broken one.
  if (unique.length === 0) throw orSiteDown(yonto.error.unavailable(NO_CATEGORIES_MESSAGE));
  return unique;
}

/**
 * Theirs come back inline with a listing, so a page is asked for and thrown away. Handing that
 * page to the next `getMediaList` was tried and taken out: it outlived the app's cache and
 * stopped `doctor`'s listing step checking anything of its own.
 */
async function pluginFilters(entry, categoryId) {
  const { catalog } = await catalogFor(entry);
  const { filter } = await cardsPage(entry, catalog, categoryId, { page: 1 });
  await flushCache();
  return filterGroups(filter);
}

async function pluginList(entry, categoryId, options) {
  const { catalog } = await catalogFor(entry);
  const { cards } = await cardsPage(entry, catalog, categoryId, options);
  await flushCache();
  if (cards.length === 0) {
    // An empty page is an answer (page two of a one-page category), unless the site failed.
    if (siteFailedThisCall) throw siteDown();
    log('info', `catalog ${entry.logName}: an empty page`, entry);
  }
  return cards;
}

/** Their groups as 线路, empty ones dropped, so Up Next stays inside one. */
function trackLines(answer) {
  return (Array.isArray(answer?.list) ? answer.list : [])
    .map((group) => ({ line: str(group?.title), tracks: Array.isArray(group?.tracks) ? group.tracks : [] }))
    .filter((group) => group.tracks.length > 0);
}

// Shares go on a line of their own: the app reads the episode count off the largest line.
const SHARE_LINE = '网盘';

// A word rather than `''`, which the app draws as a chip with nothing on it.
const UNNAMED_LINE = '线路';

const URL_HOST = /^https?:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i;

function hostOf(url) {
  return url.match(URL_HOST)?.[1] ?? url;
}

function shareLineBeside(episodeLines) {
  let line = SHARE_LINE;
  for (let n = 2; episodeLines.has(line); n += 1) line = `${SHARE_LINE}${n}`;
  return line;
}

/** The catalog's name for a share, with the host added where it gave several shares one name. */
function shareOptions(shares, line) {
  const named = new Map();
  for (const { name } of shares) named.set(name, (named.get(name) ?? 0) + 1);
  return shares.map(({ name, share }) => {
    const host = hostOf(share);
    const label = name === '' ? host : named.get(name) > 1 ? `${name} · ${host}` : name;
    return { label, pan: { share }, line };
  });
}

/**
 * A title: every episode as a `track` option `getStream` redeems when pressed, and every share
 * as a `pan` option the app opens, whatever drive it is on (kangzj/lantern-tv#392, #386).
 */
async function pluginDetail(entry, id) {
  const { catalog } = await catalogFor(entry);
  const { ext, title, poster } = mediaParts(entry, id);
  if (typeof catalog.getTracks !== 'function') {
    log('warn', `catalog ${entry.logName} has no getTracks`, entry);
    throw yonto.error.unavailable(CATALOG_BROKEN_MESSAGE);
  }
  const answer = await ask(entry, catalog, 'getTracks', ext);
  await flushCache();
  const lines = trackLines(answer);
  const tracks = lines.flatMap((group) => group.tracks);
  if (tracks.length === 0) throw orSiteDown(yonto.error.unavailable(noTracksMessage(title)));
  const shareCount = tracks.filter((track) => str(track?.pan) !== '').length;
  log('info', `catalog ${entry.logName}: ${tracks.length} tracks, ${shareCount} of them a share`, entry);

  const episodes = [];
  const shares = [];
  for (const { line, tracks: own } of lines) {
    for (const track of own) {
      const label = str(track?.name);
      const share = str(track?.pan);
      if (share !== '') {
        if (HTTP_URL.test(share)) shares.push({ name: label, share });
        else log('warn', `catalog ${entry.logName}: a share that is not a URL was left out`, entry);
        continue;
      }
      const token = trackToken(entry, track?.ext);
      if (token === null) continue;
      episodes.push({ label: label || `${episodes.length + 1}`, track: token, line: line || UNNAMED_LINE });
    }
  }
  const shareLine = shareLineBeside(new Set(episodes.map((episode) => episode.line)));
  const options = [...episodes, ...shareOptions(shares, shareLine)];
  if (options.length === 0) throw yonto.error.unavailable(notPlayableMessage(title));

  const detail = { id, title, playbackOptions: options };
  if (poster !== '') detail.posterUrl = poster;
  // A 线路 with more than one episode is a series, and rolling on is series-only.
  const perLine = new Map();
  for (const episode of episodes) perLine.set(episode.line, (perLine.get(episode.line) ?? 0) + 1);
  if ([...perLine.values()].some((count) => count > 1)) detail.type = 'SERIES';
  return detail;
}

const HLS_EXTENSION = 'm3u8';

function extensionOf(url) {
  const path = url.split('?')[0].split('#')[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase();
}

function streamOf(url) {
  return { url, mimeType: extensionOf(url) === HLS_EXTENSION ? 'application/x-mpegURL' : 'video/mp4' };
}

/**
 * Their `getPlayinfo` answer as our `stream`: `urls[0]` and `headers[0]`, or null. A header the
 * host would refuse costs that header rather than the episode; an empty value is kept.
 */
function streamFrom(answer) {
  const urls = Array.isArray(answer?.urls) ? answer.urls : [];
  const url = str(urls[0]);
  if (!HTTP_URL.test(url)) return null;
  if (urls.length > 1) log('info', `a track answered ${urls.length} urls; the first is the one played`);
  const stream = streamOf(url);
  // A map or nothing: `Object.entries` of a string would be one header per character.
  const first = Array.isArray(answer?.headers) ? answer.headers[0] : undefined;
  const written = first !== null && typeof first === 'object' && !Array.isArray(first) ? first : {};
  const headers = {};
  for (const [name, value] of Object.entries(written)) {
    if (typeof value !== 'string') continue;
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) {
      log('warn', `dropping a header a player must not be handed: ${JSON.stringify(name)}`);
      continue;
    }
    headers[name] = value;
  }
  if (Object.keys(headers).length > 0) stream.headers = headers;
  return stream;
}

/**
 * A token redeemed through their `getPlayinfo`. The token is read before the catalog is
 * compiled, so a string that is not one never runs a stranger's program. The flush is in a
 * `finally` because this is the one place their code runs inside a `try`.
 */
async function pluginStream(entry, token) {
  const ext = trackExt(token);
  const { catalog } = await catalogFor(entry);
  if (typeof catalog.getPlayinfo !== 'function') {
    log('warn', `catalog ${entry.logName} has no getPlayinfo`, entry);
    throw yonto.error.unavailable(CATALOG_BROKEN_MESSAGE);
  }
  let answer;
  try {
    answer = await ask(entry, catalog, 'getPlayinfo', ext);
  } finally {
    await flushCache();
  }
  const stream = streamFrom(answer);
  if (stream === null) throw orSiteDown(yonto.error.unavailable(NO_STREAM_MESSAGE));
  return stream;
}

async function pluginSearch(entry, query) {
  const { catalog } = await catalogFor(entry);
  if (typeof catalog.search !== 'function') {
    throw yonto.error.unavailable(NO_SEARCH_MESSAGE);
  }
  const answer = await ask(entry, catalog, 'search', { text: query, page: 1 });
  await flushCache();
  const found = summaries(entry, answer?.list);
  // No results is an answer, unless the site failed while giving it.
  if (found.length === 0 && siteFailedThisCall) throw siteDown();
  return found;
}

export default {
  async getCategories() {
    return pluginCategories(theCatalog());
  },

  // Loads the program as every other path does, so a dead address, a broken program or a site
  // its `getConfig` could not reach reads as that and not as healthy. It asks for no tabs: a
  // search-only catalog works.
  async checkHealth() {
    const entry = theCatalog();
    const { failed } = await catalogFor(entry);
    await flushCache();
    if (failed !== null) throw failed;
    if (siteFailedThisCall) throw siteDown();
    return { usable: true };
  },

  async getFilters(categoryId) {
    return pluginFilters(theCatalog(), categoryId);
  },

  async getMediaList(categoryId, options) {
    return pluginList(theCatalog(), categoryId, options);
  },

  async getMediaDetail(id) {
    return pluginDetail(theCatalog(), id);
  },

  async search(query) {
    return pluginSearch(theCatalog(), query);
  },

  async getStream(token) {
    return pluginStream(theCatalog(), token);
  },
};
