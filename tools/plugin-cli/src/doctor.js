import { DISPLAY_TEXT, removes, spaces } from './display-text.js';
import { Code, PluginError } from './errors.js';
import { METHODS, OPTIONAL_METHODS as OPTIONAL, validateResult, isEmptyResult, itemsOf, cursorOf } from './contract.js';
import { partialShown } from './partial.js';

/** The label of the step that asks for a list's second page. */
export const NEXT_PAGE_STEP = 'getMediaList (next page)';

// Methods the app calls but a plugin may legitimately omit. Read from `contract.js`, which
// reads the record — a list kept twice drifts and this one had: `getFilters` was missing
// from it, so `doctor` refused a plugin the device runs, and 爱影视 carried a dead
// `getFilters` that existed only to get past this check (kangzj/lantern-tv#330).
//
// The record is what may be *absent*. What the device does about an absence comes in two
// shapes — a `whenAbsent` argument for the three it fills in (`getFilters`,
// `getRecommendations`, `getSubSources`) and an `!in ready.exports` guard for the three it
// skips (`checkHealth`, `getImageHeaders`, `onImageHeadersRefused`) — and
// `PluginOptionalMethodsTest` holds the record to both by omitting each in turn and calling
// the one that went.

// `type` is a plain string in the contract, not a closed enum — an unrecognized value
// is mapped to a safe default rather than failing validation (see
// contracts/content-source-http.md). It is still very likely a typo in the plugin,
// so doctor flags it as a warning instead of silently letting it through.
//
// Compared the way the device compares it: `ContractDtos.kt`'s `toMediaType` is
// `MediaType.entries.find { it.name.equals(this, ignoreCase = true) }`, so `series` is a
// SERIES on a television. Matching these by exact case said otherwise, in a sentence that
// named the app — every plugin in this repo happens to write them in caps, so only a
// plugin written somewhere else ever read it (kangzj/lantern-tv#306).
const KNOWN_TYPES = new Set(['MOVIE', 'SERIES']);

// QuickJS has a `Date` and nothing takes it away, so a plugin can still time itself
// against `Date.now()` — and then no host can wind its clock, which means no test can
// reach whatever it timed. That is how a TVBox site's 30-minute cooldown came to be
// proven to start and never proven to end. `yonto.now()` is the same number from the
// host, so doctor names the global rather than leaving the next author to find out.
// `new Date` with no arguments reads the clock; `new Date(pubdate)` parses one a site sent
// and has no rewrite, so it must not match — an author handed a warning they cannot act on
// learns to skip warnings.
const HOST_CLOCK_INSTEAD = /\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|\bnew\s+Date\b(?!\s*\()/g;

/**
 * A rejection as a step reports it. A host's own verdict keeps its code — `HOST_NOT_ALLOWED`,
 * `TIMEOUT`, a `MISSING_EXPORT` from a plugin with no default export — and anything else is
 * the plugin's own throw, which is `METHOD_THREW` whatever it was made of.
 */
function asFailure(error) {
  return error instanceof PluginError ? error : new PluginError(Code.METHOD_THREW, error.message);
}

/** What a step that needs a login says when `doctor` runs a linkLogin plugin with no session. */
export const NOT_LOGGED_IN = 'not logged in: run `yonto-plugin link`';

/**
 * [loggedOut] is a linkLogin plugin run with no session: a step raising `unauthenticated` is
 * named as needing the login rather than failed, and so is each step it left with no input.
 */
export async function runDoctor({
  engine, requests, logs = [], takePartial = () => null, query = 'a', category = null, sources = {},
  pagination = 'page', loggedOut = false,
}) {
  // Before the battery, and outside it: reading the clock is a static fact about the source
  // that needs no engine, and a plugin whose module will not even evaluate is exactly the
  // one whose warnings should still reach its author rather than be lost to the failure.
  const sourceWarnings = clockWarnings(sources);
  const said = saying(logs);
  const steps = [];
  // Every step goes through here, so the one that gets added next cannot forget to carry
  // what the plugin said while it ran — and `said()` is read exactly once per step, which
  // is what keeps one line from being reported under two of them. `yonto.partial` the same,
  // taken from every step and shown only where a television would show it: under an answer,
  // which a call that threw or answered something undecodable never gave.
  let needsLogin = false;
  const record = ({ answered = false, ...found }) => {
    const partial = takePartial();
    const notLoggedIn = loggedOut && !found.ok && found.code === Code.UNAUTHENTICATED;
    needsLogin ||= notLoggedIn;
    const step = notLoggedIn ? { ...found, ok: true, code: null, message: NOT_LOGGED_IN } : found;
    steps.push({
      ...step,
      said: said(),
      partial: answered ? partialShown(step.method === NEXT_PAGE_STEP ? 'getMediaList' : step.method, partial) : null,
    });
  };

  // Loading is a step of the battery, because a module body that fails is the one whose
  // own words are worth the most: the lines it wrote on the way down are usually the only
  // description of the cause, and an XPTV catalog's program is a module body evaluating
  // third-party source. Letting `exports()` reject out of here instead reached
  // `main().catch()` with one sentence and threw away both the log and the clock warnings
  // the two lines above exist to save (kangzj/lantern-tv#439).
  const loading = Date.now();
  let exported;
  try {
    exported = new Set(await engine.exports());
  } catch (error) {
    const failure = asFailure(error);
    record({ method: 'load', ok: false, skipped: false, code: failure.code, message: failure.message,
      detail: failure.detail, ms: Date.now() - loading, requests: requests.length });
    return { steps, sourceWarnings, ok: false };
  }

  let categoryId = null;
  let itemId = null;
  // A `track` off the detail, which is the only thing `getStream` may be handed — see the
  // contract's argument table. Null when the detail carried none, and the step is then
  // skipped rather than called with `undefined`.
  let trackToken = null;
  // What `getImageHeaders` answered, so the refusal step can be handed the same map the
  // device hands it — see contracts/content-source-http.md's argument table.
  let signedWith = {};

  const argsFor = {
    // Which library is active is the host's answer, not an argument — `YONTO_PLUGIN_SUBSOURCE`
    // is where it comes from here. See the contract's "A source that is several".
    getSubSources: () => [],
    getCategories: () => [],
    getFilters: () => [categoryId],
    getMediaList: () => [categoryId, { page: 1, filters: {} }],
    getMediaDetail: () => [itemId],
    search: () => [query],
    getRecommendations: () => [],
    checkHealth: () => [],
    getImageHeaders: () => [],
    // The headers that were refused, which is what the device passes. Handing `undefined`
    // instead would certify the one implementation the argument exists to make
    // unnecessary: a source that cannot see what was refused can only forget everything.
    onImageHeadersRefused: () => [signedWith],
    // The token this source itself issued, never one composed here: it is opaque, and a
    // host that made one up would be asking a question no source can answer.
    getStream: () => [trackToken],
  };
  const needs = {
    getFilters: () => categoryId,
    getMediaList: () => categoryId,
    getMediaDetail: () => itemId,
    getStream: () => trackToken,
  };
  // What a step that was skipped for want of an input is missing. Read from here rather
  // than composed at the skip, which used to word every case but `getMediaDetail` as a
  // category id — so a `getStream` with no token would have reported the wrong thing
  // entirely.
  const wanted = {
    getFilters: 'category id',
    getMediaList: 'category id',
    getMediaDetail: 'item id',
    getStream: 'track token',
  };
  // Whose missing input is *not applicable* rather than a failure.
  //
  // For the other three it is a failure of the step before: no category id means
  // `getCategories` answered nothing, and that step is already red — the skip says why this
  // one could not run. `getStream` is different in kind. Its input is a `track`, and a source
  // is under no obligation to issue one: a source reading several kinds of library may answer
  // `track` options for an XPTV catalog and concrete `stream` URLs for a MacCMS one, off the
  // same plugin, so whether a token appears is a fact about the library the battery walks.
  //
  // The contract says as much of the declaration this export sits behind: *"a plugin
  // declaring the fact and never emitting a token has a floor it does not need, which costs
  // nothing."* Marking that red made `doctor` unpassable for a source the contract permits,
  // which is what kangzj/lantern-tv#463 is.
  //
  // This is the same answer the branch above already gives an unexported optional method,
  // which prints `not exported (optional)` and passes. A step with nothing to do has not
  // failed.
  const notApplicableWithout = new Set(['getStream']);

  for (const method of METHODS) {
    const before = requests.length;
    const started = Date.now();

    if (!exported.has(method)) {
      // Optional everywhere except where a previous step proved it is needed: a detail that
      // answered a `track` has handed out a token nothing can redeem, which is a title that
      // cannot play and says nothing about why. `lint` checks the other direction — exporting
      // this without declaring `playbackTokens` — and cannot check this one, because whether
      // a detail really answers a track is something only a run knows.
      const needed = method === 'getStream' && trackToken !== null;
      record({ method, ok: OPTIONAL.has(method) && !needed, skipped: true, code: Code.MISSING_EXPORT,
        message: needed
          ? 'not exported, but getMediaDetail answered a track — nothing can redeem it'
          : `not exported${OPTIONAL.has(method) ? ' (optional)' : ''}`,
        ms: 0, requests: 0 });
      continue;
    }
    if (needs[method] && !needs[method]()) {
      record({ method, ok: notApplicableWithout.has(method) || needsLogin, skipped: true, code: null,
        message: needsLogin ? `skipped — ${NOT_LOGGED_IN}` : `skipped — no ${wanted[method]} came out of the previous step`,
        ms: 0, requests: 0 });
      continue;
    }

    let result;
    try {
      result = await engine.call(method, argsFor[method]());
    } catch (error) {
      const failure = asFailure(error);
      record({ method, ok: false, skipped: false, code: failure.code, message: failure.message,
        detail: failure.detail, ms: Date.now() - started, requests: requests.length - before });
      continue;
    }

    const { valid, errors } = validateResult(method, result);
    if (!valid) {
      record({ method, ok: false, skipped: false, code: Code.RESULT_INVALID,
        message: errors.map((e) => e.message).join('; '), ms: Date.now() - started,
        requests: requests.length - before });
      continue;
    }
    if (isEmptyResult(method, result)) {
      const asked = requests.slice(before);
      record({ method, ok: false, skipped: false, answered: true, code: Code.EMPTY_RESULT,
        message: emptyBecause(asked), ms: Date.now() - started, requests: asked.length });
      continue;
    }

    if (method === 'getCategories') {
      // The first category is what a television opens on, but not always one that pages:
      // 爱影视's is its 推荐 shelf, which has no page 2 for the next-page step to ask for.
      if (category !== null && !result.some((c) => c.id === category)) {
        record({ method, ok: false, skipped: false, answered: true, code: Code.MANIFEST_INVALID,
          message: `probeCategory "${category}" is not one of the ${result.length} categories it answered`,
          ms: Date.now() - started, requests: requests.length - before });
        continue;
      }
      categoryId = category ?? result[0].id;
    }
    if (method === 'getMediaList') itemId = itemsOf(result)[0].id;
    if (method === 'getMediaDetail') trackToken = trackOf(result);
    if (method === 'getImageHeaders') signedWith = result;
    // A health check that answered is not a source that is healthy: `usable: false` is the
    // plugin saying it cannot be used, and the step fails on its word.
    const ok = !(method === 'checkHealth' && result.usable === false);
    record({ method, ok, skipped: false, answered: true, code: null, message: describe(method, result),
      ms: Date.now() - started, requests: requests.length - before, warnings: warningsFor(method, result),
      notes: notesFor(method, result) });

    if (method === 'getMediaList') {
      const next = await nextPage(engine, categoryId, result, pagination, requests);
      if (next) record(next);
    }
  }

  return { steps, sourceWarnings, ok: steps.every((s) => s.ok) };
}

/**
 * What an empty answer says about the site, which depends on what this step asked it.
 *
 * Blaming the site's markup is a guess that needs a page behind it: a plugin's first `doctor`
 * run is usually a stub answering [], and a plugin that catches a failure and answers [] has
 * read no markup at all. One page is enough — a 仓 tries its sites in turn, and a dead first
 * one is the ordinary case — and a redirect is no page, so a 302 whose next hop was refused
 * read nothing either.
 */
function emptyBecause(asked) {
  if (asked.length === 0) return 'the result was empty, and this step made no request — the plugin answered without asking a site';
  if (asked.some((request) => request.status >= 200 && request.status < 300)) {
    return 'the request succeeded and the result was empty — the site\'s markup has most likely changed';
  }
  return 'the result was empty, and every request this step made failed or was refused — the plugin answered [] without a page to read';
}

/**
 * Page 2 of the listing page 1 came from, asked the way a television would ask for it.
 *
 * Paging is the thing a scraper most often gets wrong, and a page 2 that answers page 1
 * again is a category a television silently cuts to its first page — Browse drops the titles
 * it has already shown and stops when nothing new arrives — so it is always asked for, by
 * number unless the manifest declares cursors (kangzj/lantern-tv#331). An empty page 2 is a
 * category that fits on one page and passes; an identical one, or a cursor handed straight
 * back, does not. Null when there is nothing to ask: a cursor listing that gave no cursor.
 */
async function nextPage(engine, categoryId, first, pagination, requests) {
  const method = 'getMediaList';
  const started = Date.now();
  const before = requests.length;
  const step = { method: NEXT_PAGE_STEP, skipped: false, requests: 0 };
  const done = (fields) => ({ ...step, ms: Date.now() - started, requests: requests.length - before, ...fields });
  const cursor = cursorOf(first);

  // A television reads the manifest, not the answer, to decide how to page.
  if (cursor !== null && pagination !== 'cursor') {
    return done({ ok: false, code: Code.RESULT_INVALID, message: 'page 1 answered a nextCursor, but the manifest ' +
      'does not declare "pagination": "cursor", so a television pages this listing by number and never hands it back' });
  }
  if (pagination === 'cursor' && cursor === null) return null;

  let result;
  try {
    result = await engine.call(method, [categoryId, pagination === 'cursor'
      ? { page: 2, filters: {}, cursor }
      : { page: 2, filters: {} }]);
  } catch (error) {
    const failure = asFailure(error);
    // What --replay has no recording of is an input that never arrived, as a skipped step
    // elsewhere is: not the plugin's failure, and nothing to say about its paging either way.
    // Read off the step's own requests as well as the throw, because a plugin may catch the
    // host's NO_FIXTURE and raise its own.
    const unrecorded = requests.slice(before).some((request) => request.code === Code.NO_FIXTURE);
    if (failure.code === Code.NO_FIXTURE || unrecorded) {
      return done({ ok: true, skipped: true, code: null,
        message: 'skipped — no fixture recorded for page 2; run with --record to check paging' });
    }
    return done({ ok: false, code: failure.code, message: failure.message, detail: failure.detail });
  }

  const { valid, errors } = validateResult(method, result);
  if (!valid) return done({ ok: false, code: Code.RESULT_INVALID, message: errors.map((e) => e.message).join('; ') });
  // From here on a television has an answer to show, whatever this step makes of it.
  step.answered = true;
  if (isEmptyResult(method, result)) {
    return pagination === 'cursor'
      ? done({ ok: false, code: Code.EMPTY_RESULT,
        message: 'the cursor from page 1 came back with nothing — a listing that pages by cursor cannot be paged' })
      : done({ ok: true, code: null, message: 'no page 2 — one page in all' });
  }
  const ids = (answer) => itemsOf(answer).map((item) => item.id).join('\n');
  if (ids(result) === ids(first)) {
    return done({ ok: false, code: Code.RESULT_INVALID, message: pagination === 'cursor'
      ? 'the cursor from page 1 answered page 1 again'
      : 'page 2 answered the same items as page 1 — options.page is not being read, so a television shows this category cut to its first page' });
  }
  if (cursor !== null && cursorOf(result) === cursor) {
    return done({ ok: false, code: Code.RESULT_INVALID,
      message: 'page 2 handed back the same cursor it was given — a television stops paging there, two pages in' });
  }
  return done({ ok: true, code: null, message: describe(method, result), warnings: warningsFor(method, result) });
}

/**
 * What the plugin itself said while a step ran, taken once per step so nothing is read twice
 * and nothing is dropped.
 *
 * `doctor` reported what a call *returned* and threw away everything the plugin *said* about
 * getting there, which is the half that answers "why". The XPTV loader is where that bites:
 * its refusals name a part rather than a cause — "This source's program won't run" is every
 * broken catalog's sentence — and the line naming the cause went to `yonto.log` and nowhere
 * else. So did the one saying how much of the index it could read at all
 * (kangzj/lantern-tv#374, and kangzj/lantern-tv#360 for the general complaint).
 *
 * Read from the host's own log rather than from a second list this could build for itself,
 * which is #360's rule: what `doctor` says about a discard has to be what the code did, not a
 * hand-written guess that drifts from it.
 *
 * Whatever a plugin wrote before the first step lands on the first step rather than being
 * dropped, and that holds however the host loads it: the cursor starts at zero and
 * `runDoctor` awaits `engine.exports()` before the loop, so anything already in the log when
 * the first step is recorded goes to that step whenever it was written. Worth saying because
 * the two hosts differ on *when* a module body runs and it would be easy to write something
 * here that is only true of one — `engines/quickjs.js` compiles on the first `exports()` or
 * `call()`, because `context()` is lazy and memoised, and the device defers the body to the
 * first call too (`JsRuntime.kt`). A skipped step asks for its share and gets nothing,
 * because nothing ran.
 *
 * And when that body throws, the first step is the `load` step `runDoctor` records in place
 * of the battery, so the lines are carried the same way rather than leaving with the
 * rejection — which is what used to happen, and the body that fails is the one whose lines
 * are worth the most (kangzj/lantern-tv#439).
 */
function saying(logs) {
  let taken = 0;
  return () => {
    const said = logs.slice(taken);
    taken = logs.length;
    return said;
  };
}

/**
 * Every file under `src/`, with line numbers, because the entry point is not the only file
 * esbuild bundles — a staleness check tucked into `src/util.js` reaches a television just
 * the same, and a warning is worth nothing if it only reads the file people remember.
 *
 * A plain search over the raw text, so it also warns about a `Date.now()` written inside a
 * comment or a string. That is deliberate. Telling those apart needs a lexer, and the one
 * that lived here was silently blind in three separate ways — a quote inside a regex
 * literal, a regex after `return`, a keyword split by whitespace — each found only because
 * someone went looking, and each reporting a clean plugin while missing a real clock read.
 * Every way this can be wrong now is an author reading a warning about prose and rewording
 * it. Every way that one was wrong was a clock reaching a television unnoticed. A guard
 * that cries wolf is fixable by whoever sees it; one that stays quiet is not.
 *
 * `new Date(pubdate)` stays excluded, because that is not prose — it is correct code with
 * no rewrite, and a warning an author cannot act on is how warnings stop working.
 */
/** The call as it would be written, so a wrapped one reads as `Date.now` and not `Date .now`. */
function readAs(match) {
  return match.replace(/\s*\.\s*/g, '.').replace(/\s+/g, ' ');
}

function clockWarnings(sources) {
  const found = [];
  for (const [path, text] of Object.entries(sources)) {
    // Over the whole file rather than line by line, so a call broken across lines —
    // `Date\n  .now()` — is found too; the line is counted back from the match offset.
    for (const match of text.matchAll(HOST_CLOCK_INSTEAD)) {
      const line = text.slice(0, match.index).split('\n').length;
      found.push(`${path}:${line} reads ${readAs(match[0])} — ` +
        'a host cannot wind QuickJS\'s clock, so anything timed against it has no test. ' +
        'Use yonto.now()');
    }
  }
  return found;
}


/** Each object in an answer, with the name of its shape in the record. */
function shapesOf(method, result) {
  switch (method) {
    case 'getCategories':
      return result.map((category) => ['category', category]);
    case 'getFilters':
      return result.flatMap((filter) => [['filter', filter],
        ...(filter.options ?? []).map((option) => ['filterOption', option])]);
    case 'getMediaList':
    case 'search':
    case 'getRecommendations':
      return itemsOf(result).map((summary) => ['summary', summary]);
    case 'getMediaDetail':
      return [['detail', result], ...(result.playbackOptions ?? []).map((option) => ['playbackOption', option])];
    case 'getSubSources':
      return (result.items ?? []).map((subSource) => ['subSource', subSource]);
    case 'checkHealth':
      return [['health', result]];
    default:
      return [];
  }
}

/**
 * What a television will change about this answer's display text, per field. Silent on text
 * that is clean, which is nearly all of it: a warning on the ordinary case is one an author
 * learns to skip.
 */
function cleaningWarningsFor(method, result) {
  const fields = new Map();
  for (const [shape, object] of shapesOf(method, result)) {
    for (const kind of ['line', 'prose']) {
      for (const field of DISPLAY_TEXT[kind][shape] ?? []) {
        const seen = fields.get(`${shape}.${field}`) ?? { values: 0, removed: [], removing: 0, spacing: 0 };
        for (const value of [object?.[field]].flat().filter((each) => typeof each === 'string')) {
          seen.values += 1;
          const removed = [...value].filter(removes);
          if (removed.length > 0) seen.removing += 1;
          seen.removed.push(...removed);
          if (kind === 'line' && [...value].some(spaces)) seen.spacing += 1;
        }
        fields.set(`${shape}.${field}`, seen);
      }
    }
  }
  return [...fields].flatMap(([name, { values, removed, removing, spacing }]) => [
    ...(removing > 0
      ? [`${name} carries ${[...new Set(removed)].map(codePoint).join(', ')} in ${removing} of ${values}, which a television removes`]
      : []),
    ...(spacing > 0
      ? [`${name} carries a line break or tab in ${spacing} of ${values}, which a television shows as a space`]
      : []),
  ]);
}

function codePoint(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * What a television will make of an answer that is not a fault — said under the step so an
 * author sees it without a device. A filter group with an `init` is opened on that option,
 * with no "All" for it (kangzj/lantern-tv#526).
 */
function notesFor(method, result) {
  if (method !== 'getFilters') return [];
  return result.filter((group) => group.init != null).map((group) => {
    const option = group.options.find((each) => each.id === group.init);
    return `${group.name} opens on ${option.name} (${option.id})`;
  });
}

function warningsFor(method, result) {
  const items = method === 'getMediaDetail' ? [result] : itemsOf(result);
  const unknownTypes = new Set(
    items.map((item) => item.type)
      // `String` and the null check are both defensive rather than load-bearing:
      // `validateResult` has already run by the time this is reached (see the `continue` in
      // `step`), and the schema pins `type` to a string — so a number fails the step outright
      // and never arrives here, on a device too (`PluginCodec`'s `Json` sets no
      // `coerceInputValues` and the DTO's `type` is non-null). Kept so this does not silently
      // depend on the order of two things in another function.
      .filter((type) => type != null && !KNOWN_TYPES.has(String(type).toUpperCase())));
  return [
    ...[...unknownTypes].map((type) =>
      `unrecognized type "${type}" — the app maps this to MOVIE rather than failing, but it is likely a typo`),
    ...cleaningWarningsFor(method, result),
  ];
}

/** The first `track` a detail offered, which is what `getStream` is asked about. */
function trackOf(detail) {
  const option = (detail?.playbackOptions ?? []).find((each) => typeof each?.track === 'string' && each.track !== '');
  return option ? option.track : null;
}

function describe(method, result) {
  if (method === 'getSubSources') {
    const items = result?.items ?? [];
    const active = items.find((item) => item.id === result?.activeId);
    const down = items.filter((item) => item.available === false).length;
    return `${items.length} ${items.length === 1 ? 'library' : 'libraries'}` +
      `${down === 0 ? '' : ` (${down} unavailable)`}, reading ${active ? active.name : 'none'}`;
  }
  if (method === 'getMediaList') {
    const items = itemsOf(result);
    const cursor = cursorOf(result);
    return `${items.length} item${items.length === 1 ? '' : 's'}${cursor === null ? '' : ', one more page'}`;
  }
  // The names, never the values: these are credentials, and the runbook tells people to
  // run `doctor --record` against their own server and paste what it printed. The failed
  // requests printed below the steps are redacted for the same reason (`format.js`). The failed
  // requests below the steps are redacted for the same reason (`format.js`).
  if (method === 'getImageHeaders') {
    const names = Object.keys(result || {});
    return names.length === 0 ? 'no headers' : names.join(', ');
  }
  // A sentence rather than the JSON this used to fall through to. `summary` is a source's own
  // line on how much of itself it can offer — `可以读取的片库 12/14` for an index, `<up>/<total>`
  // for a 仓 — and it reached an author as `{"usable":true,"summary":"81/81"}`, which is a
  // report printing its own data structure at the person it is for.
  if (method === 'checkHealth') {
    const usable = result?.usable === false ? 'not usable' : 'usable';
    return result?.summary ? `${usable}, ${result.summary}` : usable;
  }
  // The other object that fell through to its own JSON, fixed in the same pass because
  // leaving `{"renewable":false}` beside a sentence would read as a decision. What the
  // field means is whether asking again could win a different credential, so a host that
  // reads `false` stops asking — see contracts/content-source-http.md.
  if (method === 'onImageHeadersRefused') {
    return result?.renewable === true
      ? 'renewable — a host may ask this source for artwork headers again'
      : 'not renewable — a host will stop asking until the viewer replaces the credential';
  }
  // Neither the URL nor the header values: a redeemed address is signed and short-lived,
  // and the headers beside it carry whatever the catalog needed to sign it. Same rule as
  // `getImageHeaders` above, and the same reason — this report gets pasted into issues.
  if (method === 'getStream') {
    const names = Object.keys(result?.headers || {});
    let host;
    try {
      host = new URL(result.url).host;
    } catch {
      host = 'an address this could not parse';
    }
    return `${host}, ${result?.mimeType ?? 'no mimeType'}${names.length === 0 ? ', no headers' : `, headers: ${names.join(', ')}`}`;
  }
  if (Array.isArray(result)) return `${result.length} item${result.length === 1 ? '' : 's'}`;
  if (method === 'getMediaDetail') return `${result.playbackOptions.length} playback option${result.playbackOptions.length === 1 ? '' : 's'}`;
  return JSON.stringify(result);
}
