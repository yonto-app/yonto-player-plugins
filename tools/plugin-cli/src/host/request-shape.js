import { readFileSync } from 'node:fs';

/**
 * What `yonto.fetch` will not send and what it changes before sending, read from
 * `conformance/request-rules.json`: the WHATWG Fetch standard's rules, with the exceptions that
 * file names and the reasons it gives. `PluginRequestShape` is the device's copy, held to the
 * same file by `PluginRequestRulesRecordTest`.
 *
 * Checked by the host before anything is sent, rather than left to undici or OkHttp: each
 * refuses its own set in its own words, and a refusal surfacing from the transport read as
 * `REQUEST_FAILED`, a server that gave no answer, for a request that never left.
 */
export const REQUEST_RULES = Object.freeze(
  JSON.parse(readFileSync(new URL('../../conformance/request-rules.json', import.meta.url), 'utf8')),
);

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Printable ASCII or a tab. Fetch would take any byte but NUL, CR and LF; OkHttp would not.
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const FORBIDDEN_METHODS = new Set(REQUEST_RULES.forbiddenMethods);
const FORBIDDEN_HEADERS = new Set(REQUEST_RULES.forbiddenHeaders);

/** Whether [name] can be a header's or a cookie's name: an RFC 9110 token. */
export function isToken(name) {
  return TOKEN.test(name);
}

/** Whether [value] can go on the wire as a header's value, here and on a television. */
export function isHeaderValue(value) {
  return HEADER_VALUE.test(value);
}

/** Fetch's "normalize a method": the standard ones upper case, any other as it was spelled. */
export function normalisedMethod(method) {
  const upper = method.toUpperCase();
  return REQUEST_RULES.normalisedMethods.includes(upper) ? upper : method;
}

/** Whether [url] names a user or a password, which Fetch will not send. */
export function carriesCredentials(url) {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

function forbiddenHeader(name, value) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower)) return true;
  if (REQUEST_RULES.forbiddenHeaderPrefixes.some((prefix) => lower.startsWith(prefix))) return true;
  return REQUEST_RULES.methodOverrideHeaders.includes(lower) &&
    String(value).split(',').some((method) => FORBIDDEN_METHODS.has(method.trim().toUpperCase()));
}

/** Why the host will not send this request, or null when it will. [method] is normalised. */
export function requestShapeProblem({ url, method, headers, body }) {
  if (!TOKEN.test(method)) return `${method} is not an HTTP method`;
  if (FORBIDDEN_METHODS.has(method.toUpperCase())) return `${method} is a method the host does not send`;
  const upper = method.toUpperCase();
  if ((upper === 'GET' || upper === 'HEAD') && body != null) return `a ${upper} request cannot carry a body`;
  if (carriesCredentials(url)) return 'a URL cannot carry a user name or password';
  for (const [name, value] of Object.entries(headers)) {
    if (!TOKEN.test(name)) return `${name} is not a header name`;
    if (!HEADER_VALUE.test(String(value))) return `the ${name} header has a character a header cannot carry`;
    if (forbiddenHeader(name, value)) return `${name} is a header the host does not let a plugin set`;
  }
  return null;
}

/** Fetch's Content-Type for a string body, when the plugin named none. */
export function withBodyType(headers, body) {
  if (body == null || Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) return headers;
  return { ...headers, 'Content-Type': REQUEST_RULES.stringBodyContentType };
}
