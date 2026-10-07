import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

const schemaPath = new URL('../../../contracts/content-source.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

export const METHODS = [
  'getCategories', 'getFilters', 'getMediaList',
  'getMediaDetail', 'search', 'getRecommendations', 'checkHealth', 'getImageHeaders',
  'onImageHeadersRefused',
  // Its argument comes out of another step's answer — a `track` off a `getMediaDetail` —
  // and `doctor` walks this list in order, so it has to sit after that one.
  'getStream',
  // Last, though it reads like a thing to ask first: `doctor` walks this list in order, and
  // `activeId` is the library a source *is reading* rather than the one it means to try.
  // Asked before anything had been read, it named the site a walk was about to start from —
  // and against the real 仓 that is 👒┃小胡┃资源┃, which does not answer, printed above four
  // steps that all came from 索尼. The app asks in this order for the same reason.
  'getSubSources',
];

/**
 * Which of those a host may find absent and carry on, read from the record rather than
 * written here — `conformance/optional-methods.json`, which `PluginOptionalMethodsTest`
 * holds the device to. Beside [METHODS] because `lint` and `doctor` both need it and a
 * third copy is how the second one drifted (kangzj/lantern-tv#330, #326).
 *
 * Everything not in it is a method the app calls with nothing to fall back on.
 */
export const OPTIONAL_METHODS = new Set(
  JSON.parse(readFileSync(new URL('../conformance/optional-methods.json', import.meta.url), 'utf8')),
);

/**
 * Parts of the contract that are neither a host function a plugin calls nor a method it
 * exports: a manifest declares them, and a host answers them.
 *
 * `cookieLogin.hostHeld` is a `cookieLogin` capability with no `writesTo` — the session
 * belongs to the host, which attaches it to the capability's own site
 * (kangzj/lantern-tv#163). A plugin declaring one on an app from before that arrived runs
 * logged out and says nothing, so it is recorded in `contracts/contract-versions.json`
 * beside the functions and the methods, and a manifest has to declare the version.
 *
 * `catalogsAreRemote` is the same shape: it says `getSubSources` may have
 * to read a document before it can answer, and an app from before it arrived drops the key
 * and asks on the dialog's opening frame with nothing to show for the wait.
 *
 * `runsFetchedCode` is the same shape again and the one this scan can least check: code a
 * plugin downloads at run time is not in the source being read, so there is nothing here to
 * find and the declaration is the whole of the evidence. What the version buys is a line on
 * the install dialog, and an app from before it arrived drops the key and shows a dialog
 * that says less than the truth — which is why it is a version and not a silent field.
 *
 * `playbackTokens` is the last, and the one whose absence is loudest. It says this
 * source may answer an option carrying a `pan` or a `track` instead of a `stream`, and
 * nothing in the source says so — a `pan` is not a call and not an export. An app from
 * before it arrived decodes such an option with `stream` required and fails the whole
 * title rather than one row, which is why it is a floor rather than a key to drop.
 *
 * `browserCheck` is a site where the plugin may send the viewer to pass a browser check. An
 * app from before it arrived drops the capability and reads the plugin's `CHALLENGED` as a
 * method that threw, a generic error where a way back should be — which is why it is a floor.
 *
 * `linkLogin` is a sign-in the host runs and holds, whose credential never appears in the
 * plugin's code; an app from before it arrived drops the capability and runs the source signed
 * out with nothing to press, so it is a floor too.
 *
 * Keyed rather than positional. These are read by name from two files, and the first of
 * them used to be reached by destructuring the array's head — which is a lookup that keeps
 * working, wrongly, the day somebody sorts the list.
 */
export const MANIFEST_FACTS = {
  HOST_HELD_LOGIN: 'cookieLogin.hostHeld',
  CATALOGS_ARE_REMOTE: 'catalogsAreRemote',
  RUNS_FETCHED_CODE: 'runsFetchedCode',
  PLAYBACK_TOKENS: 'playbackTokens',
  BROWSER_CHECK: 'browserCheck',
  LINK_LOGIN: 'linkLogin',
};

/**
 * Parts of the contract that live in a method's answer: nothing in a plugin's source or
 * manifest says it uses one, so `lint` can only say a plugin may, from what it exports.
 *
 * `getFilters.init` is a filter group naming the option it is already on (contract 13). An
 * older app ignores it and shows "All" over a listing that is not, which is today's
 * behaviour rather than a new failure.
 */
export const RESULT_FIELDS = {
  FILTER_INIT: 'getFilters.init',
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = Object.fromEntries(
  METHODS.map((method) => [method, ajv.compile({ $defs: schema.$defs, ...schema.properties[method] })]),
);

export function validateResult(method, value) {
  const validate = validators[method];
  if (!validate(value)) {
    const errors = validate.errors.map((e) => ({
      path: e.instancePath || '/',
      message: `${e.instancePath || '/'} ${e.message}` +
        (e.params?.missingProperty ? `: ${e.params.missingProperty}` : ''),
    }));
    return { valid: false, errors };
  }
  const errors = method === 'getFilters' ? unofferedInits(value) : [];
  return { valid: errors.length === 0, errors };
}

// What the schema cannot say: an `init` names one of its own group's options.
function unofferedInits(groups) {
  return groups.flatMap((group, index) => {
    if (group.init === undefined || group.options.some((option) => option.id === group.init)) return [];
    const path = `/${index}/init`;
    return [{ path, message: `${path} ${JSON.stringify(group.init)} is not one of this group's option ids` }];
  });
}

/**
 * The titles in a listing, whichever shape it came in.
 *
 * `getMediaList` may answer a bare array or `{ items, nextCursor }` — a source whose API
 * hands out an opaque token cannot be paged by number — so everything that reads a
 * listing reads it through here rather than assuming an array.
 */
export function itemsOf(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.items) ? result.items : [];
}

/** What a listing says the next page starts at, or null. */
export function cursorOf(result) {
  const cursor = Array.isArray(result) ? null : result?.nextCursor;
  return typeof cursor === 'string' && cursor.trim() !== '' ? cursor : null;
}

// Which methods are suspicious when they answer with nothing. getFilters and
// getRecommendations are legitimately empty on plenty of sources; the rest are not.
const EMPTY_IS_A_FAILURE = new Set(['getCategories', 'getMediaList', 'search']);

export function isEmptyResult(method, value) {
  if (method === 'getMediaDetail') return (value?.playbackOptions ?? []).length === 0;
  // A source that exports this and offers nothing has handed a television an empty picker,
  // which is a defect rather than a library with no parts — such a source exports nothing.
  if (method === 'getSubSources') return (value?.items ?? []).length === 0;
  if (!EMPTY_IS_A_FAILURE.has(method)) return false;
  if (method === 'getMediaList') return itemsOf(value).length === 0;
  return Array.isArray(value) && value.length === 0;
}
