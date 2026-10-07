import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { MANIFEST_FACTS, METHODS, RESULT_FIELDS } from './contract.js';
import { cookieLoginOf } from './host/credential.js';
import { HOST_FUNCTIONS } from './host/surface.js';

const recordPath = new URL('../../../contracts/contract-versions.json', import.meta.url);
export const RECORD = JSON.parse(readFileSync(recordPath, 'utf8'));

/**
 * The newest contract version this host speaks.
 *
 * Derived rather than declared: the record knows the newest version by knowing what
 * arrived in it, and a field saying so would be the same number written twice — which is
 * the drift this file exists to prevent, happening inside it.
 */
export const LATEST = Math.max(RECORD.oldest, ...Object.values(RECORD.since));

/** The oldest contract version a host still runs; a plugin declaring less is refused everywhere. */
export const OLDEST = RECORD.oldest;

/** What arrived after version 1; everything else has been there from the start. Host
 *  functions are keyed by the dotted path a plugin calls, `yonto.` and all, so a key
 *  that forgot the prefix is a dead entry rather than a silent one — the record test
 *  refuses it. */
const since = (name) => RECORD.since[name] ?? 1;

/** The record's name for a `cookieLogin` whose session the host holds — see
 *  [MANIFEST_FACTS], which is where that is spelled out. */
const { HOST_HELD_LOGIN, CATALOGS_ARE_REMOTE, RUNS_FETCHED_CODE, PLAYBACK_TOKENS, BROWSER_CHECK, LINK_LOGIN } =
  MANIFEST_FACTS;

// A `yonto` that is not read through: `const { now } = yonto`, a spread of it, a
// computed key the minifier could not fold to a name. `HOST_CALL` sees none of them, and
// what it could not see it used to ignore — which counted as version 1 and said nothing,
// the one direction this file is not allowed to be wrong in. An alias is not in here:
// `const now = yonto.now` keeps the dotted text, so it places like any other call.
//
// It over-reports on `typeof yonto` and anything else that names the namespace without
// reaching into it. That is the trade taken deliberately: an author reading a warning about
// a line they can rewrite, rather than a plugin declaring 1 and dying at the first call on
// somebody's television.
const HOST_TAKEN_APART = /\byonto\b(?!\s*\.)/;

// The host global under its name before contract 21, which no host defines: a member read off it, or it read
// off globalThis. A plugin's own value named `lantern`, used as a value, is left alone.
const OLD_HOST_NAME = /(?<![\w$.])lantern\s*\.|\bglobalThis\s*\.\s*lantern\b/;

// `yonto.now`, `yonto.store.get` — one or two segments, which is as deep as the host
// API goes. Checked against the surface both hosts are held to rather than assumed, so a
// name nobody added is reported instead of quietly counting as version 1.
const HOST_CALL = /\byonto\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;

// The namespaces those leaves hang off. `HOST_FUNCTIONS` lists leaves only, so a plugin
// holding `yonto.store` as a value matches no entry — and it is not a name nobody added
// either. It is the host, on its way to a leaf this cannot see.
const HOST_NAMESPACES = new Set(
  HOST_FUNCTIONS.filter((name) => name.includes('.')).map((name) => name.slice(0, name.indexOf('.'))));

// The code each `yonto.error` constructor puts on what it returns — `misconfigured` is
// `MISCONFIGURED`, `unreachable` is `UNREACHABLE` — because a host honours a hand-built
// `{ code: 'UNREACHABLE' }` exactly as it honours the constructor's, and an older host turns
// either into METHOD_THREW. So the code written out places a plugin where its constructor
// arrived, though no call to it appears anywhere.
const ERROR_CODES = new Map(
  HOST_FUNCTIONS.filter((name) => name.startsWith('error.'))
    .map((name) => [name.slice('error.'.length).replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(), `yonto.${name}`]));
const QUOTED_WORD = /(["'`])([A-Z_]+)\1/g;
// Counted unless it is only read. A code reaches a thrown value through too many shapes to
// recognise the raise — a helper's parameter, a class field, a ternary, a constant — and
// missing one lets a plugin install on an app that turns its code into an ordinary outage,
// so every quoted code counts except an operand of an equality test or a `case` label. Only
// the text before it is read: minifying moves a constant to the right of a comparison, so
// `'UNREACHABLE' === e.code` arrives here as `e.code==="UNREACHABLE"`.
const ONLY_READ = /(?:[=!]==?|\bcase)\s*$/;
const isOnlyRead = (code, start) => ONLY_READ.test(code.slice(Math.max(0, start - 8), start));

// A key of the exported object, as either `name() {` or `name: fn`. Applied to that object
// alone — see `exportedKeys` — because the same shape is how any object literal is written.
const keyedAs = (name) => new RegExp(`(^|[\\s,{])${name}\\s*(\\(|:)`, 'm');

/**
 * The source with comments and string contents gone, or the source itself when that could
 * not be done safely.
 *
 * Minified first, because a comment naming a function is not a call to it: `plugins/jellyfin`
 * explains `getImageHeaders()` in prose three lines above exporting it, and a scan of the raw
 * file cannot tell those apart. Minifying also folds `yonto['now']` to `yonto.now` and
 * `{ getImageHeaders }` to `getImageHeaders:`, which is how those two reach the scan at all.
 *
 * And it mangles local names, which is the only thing that tells a plugin's own
 * `function getImageHeaders()` apart from the export of that name. Worth saying out loud
 * because nothing about "minify" advertises it: swapping this for a comment stripper would
 * leave every scan here reading local helpers as contract surface.
 */
async function scannable(source) {
  // No legal comments either: a `/*! … */` survives minifying otherwise, and a name in a
  // comment is prose wherever it is written.
  const { code } = await esbuild.transform(source, { loader: 'js', minify: true, legalComments: 'none' });
  const blanked = blankStrings(code);
  return { code: blanked ?? code, blanked: blanked !== null, raw: code };
}

/**
 * Blanks what is inside quotes, leaving the quotes and everything else where they were.
 *
 * A `${…}` inside a backtick is code, not a string body, and is left alone: a cache-busting
 * `` `?_=${yonto.now()}` `` is an ordinary shape and blanking it hid the call completely.
 *
 * Regex literals are skipped rather than scanned, because `replace(/'/g, '')` carries a lone
 * quote that would otherwise open a string running to the end of the file — a silent false
 * *negative*, the worst direction here: everything after it stops being read at all. If a
 * quote is still open when the source runs out, the source is handed back untouched and a
 * caller is told, so the failure is the noisy one rather than the blind one.
 */
export function blankStrings(code) {
  // What can precede a `/` that starts a regex rather than divides. Minified code has no
  // comments and little whitespace, so the previous significant character is enough — plus
  // the keywords a regex can follow directly, which `return/\{/` reaches verbatim.
  const BEFORE_REGEX = '(,=:[!&|?{};+-*%~^<>';
  const KEYWORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'do', 'else', 'yield', 'await'];
  let out = '';
  let quote = null;
  // Depth of `${…}` inside the current template, so its code is scanned and its text is not.
  const templates = [];
  let previous = '';
  let word = '';
  let afterDot = false;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (quote) {
      if (char === '\\') { out += '  '; i += 1; continue; }
      if (char === quote) { quote = null; out += char; continue; }
      if (quote === '`' && char === '$' && code[i + 1] === '{') {
        templates.push(0);
        quote = null;
        out += '${';
        i += 1;
        continue;
      }
      out += ' ';
      continue;
    }
    if (templates.length > 0) {
      if (char === '{') templates[templates.length - 1] += 1;
      else if (char === '}') {
        if (templates[templates.length - 1] === 0) { templates.pop(); quote = '`'; out += char; continue; }
        templates[templates.length - 1] -= 1;
      }
    }
    // A keyword only starts a regex when it is a keyword: `o.in / 2` is a property divided,
    // and reading it as a regex swallowed everything to the next slash — silently.
    if (char === '/' && (BEFORE_REGEX.includes(previous) || (KEYWORDS.includes(word) && !afterDot))) {
      const end = endOfRegex(code, i);
      if (end !== -1) {
        out += code.slice(i, end + 1).replace(/[^/]/g, ' ');
        i = end;
        previous = '/';
        word = '';
        continue;
      }
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    out += char;
    if (/[\w$]/.test(char)) {
      if (word === '') afterDot = previous === '.';
      word += char;
    } else {
      word = '';
    }
    if (char.trim()) previous = char;
  }
  return quote === null && templates.length === 0 ? out : null;
}

/** Where the regex starting at [from] ends, or -1 if it does not close on this line —
 *  which means it was a division after all. */
function endOfRegex(code, from) {
  for (let i = from + 1; i < code.length; i += 1) {
    const char = code[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '\n') return -1;
    if (char === '[') {
      while (i < code.length && code[i] !== ']') {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (char === '/') return i;
  }
  return -1;
}

/**
 * The keys of the object a plugin exports, and nothing else's.
 *
 * A method name used as any key anywhere would otherwise raise the version a plugin has to
 * declare: an internal `{ getImageHeaders: … }` lookup table, or a helper in a file nothing
 * imports, would both read as an export. What the app calls is the entry file's default
 * export, so that is what is read.
 *
 * Written as a literal (`export default {`) or named (`export default api`, which minifies
 * to a renamed local) — both are resolved. An object spreading another, and an export this
 * cannot follow at all, return null and the caller reads the whole file instead: over-reporting a version is a plugin that refuses apps it could
 * have run, which is bad, and missing an export is artwork that silently never
 * authenticates, which is worse.
 */
/** [exportedKeys]'s answer when the entry default-exports nothing at all — as opposed to
 *  `null`, which is "there is an export and this could not read it". */
export const NOTHING_EXPORTED = Symbol('nothing exported');

function exportedKeys(code) {
  const literal = code.search(/export\s+default\s*\{/);
  if (literal !== -1) {
    const object = objectAt(code, code.indexOf('{', literal));
    if (object === null) return null;
    // `{ ...base, … }` borrows keys from somewhere this cannot enumerate, so the object is
    // not the whole export and reading only it would miss what `base` brought.
    //
    // `{ [NAMES[0]]() {} }` is the same blindness by a different route, and used not to be
    // treated as one: the key is an expression this cannot fold, so the method is a real
    // export on both hosts — `Object.keys` sees it — and read as absent here. That was
    // harmless while this only lowered a version floor and stopped being harmless when
    // `lint` began refusing a plugin for what it could not find (kangzj/lantern-tv#326,
    // found in review). A *literal* computed key, `['getCategories']: …`, is folded by the
    // minifier before this sees it and is not affected.
    // A computed key's `[` opens where a key does — right after the brace or a comma —
    // where a value's (`getCategories: []`) opens after a colon.
    const top = topLevelOf(object);
    return top.includes('...') || /[{,]\s*\[/.test(top) ? null : object;
  }

  // Nothing default-exported at all, which is not blindness — it is the scan seeing
  // clearly that there is nothing there, and the engine agrees ("must default-export an
  // object of methods"). Told apart from the two above so a caller can refuse this and
  // only warn about those (kangzj/lantern-tv#326, found in review).
  const named = code.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
  if (!named) return NOTHING_EXPORTED;
  const declared = code.match(new RegExp(`(?:const|let|var)\\s+${named[1]}\\s*=\\s*\\{`));
  if (!declared) return null;
  return objectAt(code, code.indexOf('{', declared.index));
}

/** The braced span starting at [open], or null if it never closes. */
function objectAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const char = code[i];
    if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

/** Top level of the exported object only: a key nested inside one of its methods is that
 *  method's business, not the contract's. */
function topLevelOf(objectSource) {
  let out = '';
  let depth = 0;
  for (const char of objectSource) {
    if (depth <= 1) out += char;
    if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') depth -= 1;
  }
  return out;
}

/**
 * The lowest `contractVersion` a plugin can honestly declare, and what forced it there.
 *
 * Two kinds of surface, for the two ways a plugin can outrun the app it lands on: a host
 * function it *calls* that an older app does not provide, which fails loudly as
 * `yonto.now is not a function` and reads as a broken plugin; and a method it *exports*
 * that an older app does not know to call, which fails silently — the artwork that never
 * authenticates, and nobody told.
 */
export async function contractVersionOf(sources, manifest = null, entry = null) {
  const used = [];
  // Which key is the plugin's own file, said by the caller because only the caller knows.
  // This used to be inferred — "the key with no `/` in it" — on the premise that every
  // helper lives under `src/`. That was true of the walk that produced these keys and
  // stopped being true when the bundler did: a helper sitting next to the entry has a
  // relative path that is a bare basename too, so punctuation cannot tell the two apart,
  // and the helper's internal `{ getSubSources() {} }` read as the plugin exporting one
  // (kangzj/lantern-tv#327, found in review).
  //
  // Null is how the unit tests spell a one-file plugin, and there the single key is it.
  const entryKey = entry ?? Object.keys(sources).find((key) => !key.includes('/')) ?? null;
  // What a manifest asks the host for, which no scan of the source could see: the session
  // a host-held `cookieLogin` is attached with never appears in the plugin's own code —
  // that is the point of it — so the declaration is the only evidence there is.
  const login = cookieLoginOf(manifest);
  if (login !== null && login.writesTo === undefined) {
    used.push({ path: 'the manifest', name: 'a host-held cookieLogin', version: since(HOST_HELD_LOGIN) });
  }
  // Same shape, same reason: a declaration is all the evidence there is. `catalogsAreRemote`
  // buys a fetch inside `getSubSources` and a wait the picker can show for it, and an older
  // app drops the key — so it asks on the dialog's opening frame and shows nothing while the
  // plugin goes to the network, which is the freeze the declaration exists to avoid.
  if (manifest?.catalogsAreRemote === true) {
    used.push({ path: 'the manifest', name: CATALOGS_ARE_REMOTE, version: since(CATALOGS_ARE_REMOTE) });
  }
  // And the one there is provably nothing in the source to find: the code this declares is
  // downloaded while the plugin runs, so it is not in what was scanned and never will be.
  // The floor it raises is what puts the sentence on the install dialog.
  if (manifest?.runsFetchedCode === true) {
    used.push({ path: 'the manifest', name: RUNS_FETCHED_CODE, version: since(RUNS_FETCHED_CODE) });
  }
  // And the one whose absence costs a title rather than a line. A `pan` option is neither a
  // call nor an export, so nothing in the source announces it; an app too old to know what
  // it is decodes the option with `stream` required and fails the whole detail, taking the
  // thirty-nine ordinary episodes beside the one share with it.
  if (manifest?.playbackTokens === true) {
    used.push({ path: 'the manifest', name: PLAYBACK_TOKENS, version: since(PLAYBACK_TOKENS) });
  }
  // A declaration again: what a check wins is attached by the host and never appears in the
  // plugin's code, and an app too old for it would read the plugin's challenge as a method
  // that threw.
  if ((manifest?.capabilities ?? []).some((capability) => capability?.type === BROWSER_CHECK)) {
    used.push({ path: 'the manifest', name: BROWSER_CHECK, version: since(BROWSER_CHECK) });
  }
  // And a sign-in the host runs, whose credential is never in the plugin's code either.
  if ((manifest?.capabilities ?? []).some((capability) => capability?.type === LINK_LOGIN)) {
    used.push({ path: 'the manifest', name: LINK_LOGIN, version: since(LINK_LOGIN) });
  }
  const unscannable = [];
  const nothingExported = [];
  const unclassified = [];
  const oldName = [];
  const exports = [];
  for (const [path, source] of Object.entries(sources)) {
    // Named here rather than by the caller, which only knows it was scanning "this plugin":
    // a file that does not parse is one the author has to open, and esbuild reports it as
    // `<stdin>` because it is handed the text rather than the path.
    let code;
    let blanked;
    let raw;
    try {
      ({ code, blanked, raw } = await scannable(source));
    } catch (cause) {
      cause.message = `${path} could not be read: ${cause.message}`;
      throw cause;
    }
    if (!blanked) unscannable.push({ path, why: 'a quote this could not close' });
    if (HOST_TAKEN_APART.test(code)) unclassified.push({ path });
    if (OLD_HOST_NAME.test(code)) oldName.push({ path });

    for (const match of code.matchAll(HOST_CALL)) {
      const [, first, second] = match;
      const pair = second ? `${first}.${second}` : null;
      // `yonto.config` is a value rather than a function and is on no host's list for
      // that reason: reading it says nothing about which contract a plugin needs.
      if (first === 'config') continue;
      if (pair && HOST_FUNCTIONS.includes(pair)) used.push({ path, name: `yonto.${pair}`, version: since(`yonto.${pair}`) });
      else if (!pair && HOST_FUNCTIONS.includes(first)) used.push({ path, name: `yonto.${first}`, version: since(`yonto.${first}`) });
      // A namespace with an unknown leaf is reported as the leaf, not as the namespace:
      // `yonto.store.getAll` is the name an author has to look at.
      //
      // The namespace on its own is neither. `const store = yonto.store` is correct code
      // reaching a leaf through a local name, so calling it a function nobody added is a
      // warning its author cannot act on — and those are how warnings stop being read. It
      // places nothing, so it says the same thing a destructured `yonto` says: this is a
      // floor, not an answer.
      else if (!pair && HOST_NAMESPACES.has(first)) unclassified.push({ path });
      else used.push({ path, name: `yonto.${pair ?? first}`, version: null });
    }

    for (const match of raw.matchAll(QUOTED_WORD)) {
      const [, , word] = match;
      const constructor = ERROR_CODES.get(word);
      if (constructor && !isOnlyRead(raw, match.index)) used.push({ path, name: `'${word}' (${constructor}'s code)`, version: since(constructor) });
    }

    // Exports only from the entry: a helper's own default export is not what the app calls.
    if (path !== entryKey) continue;
    const exported = exportedKeys(code);
    const searched = exported === null || exported === NOTHING_EXPORTED ? code : topLevelOf(exported);
    if (exported === NOTHING_EXPORTED) nothingExported.push({ path });
    else if (exported === null) unscannable.push({ path, why: 'an export this could not follow' });
    for (const name of METHODS) {
      if (keyedAs(name).test(searched)) {
        used.push({ path, name, version: since(name) });
        exports.push(name);
      }
    }
  }

  const placed = used.filter((u) => u.version !== null);
  return {
    // Which contract methods the entry exports. `reasons` happens to name `getImageHeaders`
    // today because its version is 2, but that is an accident of the record rather than a
    // statement about the surface — a caller asking "does this plugin export X" has to be
    // able to ask it without knowing which version X arrived in.
    exports,
    // The host functions it calls, for the same reason and with the same caveat: a name
    // this could not place reads as a call to nothing rather than as a call missing, so a
    // caller asking "does this plugin read X" has to weigh `unclassified` beside it.
    calls: [...new Set(used.filter((u) => u.name.startsWith('yonto.')).map((u) => u.name))],
    required: placed.reduce((highest, u) => Math.max(highest, u.version), 1),
    // Result fields a method it exports may answer with (`getFilters.init`). Nothing in the
    // source says whether it does, so a declaration of exactly one of these versions is
    // justified without being required: an older app still runs the plugin.
    mayAnswerWith: Object.values(RESULT_FIELDS)
      .filter((field) => exports.includes(field.split('.')[0]))
      .map((field) => ({ name: field, version: since(field) })),
    // What forced the answer, so a report can name the thing to change rather than only
    // the number to write.
    reasons: placed.filter((u) => u.version > 1),
    unknown: [...new Map(used.filter((u) => u.version === null).map((u) => [u.name, u])).values()],
    // Files read whole, strings and all, because they could not be read any other way
    // safely. A refusal traceable to one of these is one to look at twice.
    unscannable: [...new Map(unscannable.map((u) => [`${u.path}|${u.why}`, u])).values()],
    // Files that reach the host in a shape no name can be read out of. Nothing is placed
    // from them, so the number below is a floor rather than an answer, and whoever reads
    // the report is the only one who can say what it should be.
    unclassified,
    // Files that name `lantern`, which no host has defined since contract 21.
    oldName,
    // Files that default-export nothing at all. Not the same as `unscannable`: this scan
    // saw clearly, and what it saw was nothing — so a caller may refuse on it where it
    // would only warn about a file it could not read (see [NOTHING_EXPORTED]).
    nothingExported,
  };
}
