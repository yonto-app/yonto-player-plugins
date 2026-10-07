import { clearsAt, siteOf } from '../browser-check.js';
import { hostOf } from '../hostname.js';
import { isPrivate } from './redirect.js';
import { isHeaderValue, isToken } from './request-shape.js';

/**
 * What `yonto.fetch` does with a clearance the host holds: sent to the one site it was won
 * at, per redirect hop, and never handed to the plugin — the design's *Where it is sent*
 * (docs/design/2026-09-23-a-challenge-the-viewer-clears.md).
 *
 * `core/src/androidMain/.../PluginClearances.kt` is the same rule on a television, and
 * `conformance/clearances.json` holds the two to one answer. A clearance is
 * `{ site, cookies: [{ name, value }], userAgent }`.
 */

/**
 * The clearance a hop to [url] carries, or null: only on the site it was won at, scheme and
 * host exact, and only while the manifest's check still clears there.
 */
export function clearanceForHop(manifest, url, held) {
  const site = siteOf(url);
  if (site === null || !clearsAt(manifest, site)) return null;
  return held.find((clearance) => clearance.site === site) ?? null;
}

/**
 * [headers] as the plugin set them for this hop, with the clearance on: its cookies in one
 * `Cookie` header, over any of the same name and beside the plugin's others whatever spelling
 * it used, and its agent over the plugin's.
 */
export function headersWith(clearance, headers) {
  const held = new Set(clearance.cookies.map((cookie) => cookie.name));
  const plugins = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'cookie')
    .flatMap(([, value]) => String(value).split(';'))
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !held.has(nameOf(pair)));
  const cookie = [...plugins, ...clearance.cookies.map(({ name, value }) => `${name}=${value}`)].join('; ');
  return {
    ...Object.fromEntries(Object.entries(headers)
      .filter(([name]) => !['cookie', 'user-agent'].includes(name.toLowerCase()))),
    Cookie: cookie,
    'User-Agent': clearance.userAgent,
  };
}

/**
 * The `Set-Cookie`s the plugin is handed from a site whose clearance the host holds: all but
 * the ones named as the clearance's, so a re-issued clearance never reaches it and a cookie of
 * the plugin's own on that site still does.
 */
export function setCookieWithout(clearance, setCookie) {
  const held = new Set(clearance.cookies.map((cookie) => cookie.name));
  return setCookie.filter((line) => !held.has(nameOf(String(line).split(';')[0])));
}

/**
 * The clearance an author copied from their own browser, from `YONTO_PLUGIN_CLEARANCE`,
 * `YONTO_PLUGIN_CLEARANCE_UA` and `YONTO_PLUGIN_CLEARANCE_SITE`: all three or none, and
 * the site as a hop's site prints on a public `https` host, as a television keeps one.
 * Returns null for none, and throws an `Error` naming what is wrong for anything else.
 */
export function clearanceFromEnv(env) {
  const cookies = env.YONTO_PLUGIN_CLEARANCE;
  const userAgent = env.YONTO_PLUGIN_CLEARANCE_UA;
  const site = env.YONTO_PLUGIN_CLEARANCE_SITE;
  const given = [cookies, userAgent, site].filter((value) => value !== undefined && value !== '');
  if (given.length === 0) return null;
  if (given.length !== 3) {
    throw new Error('YONTO_PLUGIN_CLEARANCE, YONTO_PLUGIN_CLEARANCE_UA and YONTO_PLUGIN_CLEARANCE_SITE ' +
      'go together: a clearance is its cookies, the agent it was won under and the site it was won at');
  }
  if (siteOf(site) !== site || !site.startsWith('https://') || isPrivate(hostOf(site))) {
    throw new Error(`YONTO_PLUGIN_CLEARANCE_SITE is ${site}, and a clearance is kept only for a public https ` +
      "site written as https://host, lowercase, with no path — the form a request's site is compared in");
  }
  const pairs = cookies.split(';').map((pair) => pair.trim()).filter((pair) => pair !== '');
  const parsed = pairs.map((pair) => ({ name: nameOf(pair), value: pair.slice(pair.indexOf('=') + 1), pair }));
  // What a television's store refuses too: nothing to send, or what a header cannot carry.
  if (parsed.length === 0 || parsed.some(({ name, value, pair }) =>
    !pair.includes('=') || !isToken(name) || !isHeaderValue(value) || value.trim() !== value)) {
    throw new Error('YONTO_PLUGIN_CLEARANCE is name=value pairs separated by ;, as a Cookie header is');
  }
  if (new Set(parsed.map(({ name }) => name)).size !== parsed.length) {
    throw new Error('YONTO_PLUGIN_CLEARANCE names one cookie twice');
  }
  if (!isHeaderValue(userAgent)) {
    throw new Error('YONTO_PLUGIN_CLEARANCE_UA has a character a User-Agent header cannot carry');
  }
  return { site, cookies: parsed.map(({ name, value }) => ({ name, value })), userAgent };
}

function nameOf(pair) {
  return pair.split('=')[0].trim();
}
