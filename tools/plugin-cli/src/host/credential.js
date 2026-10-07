import { readFileSync } from 'node:fs';
import { hostOf } from '../hostname.js';

/**
 * The login a host drives for a plugin, and where the session it captured may be sent.
 *
 * The credential is the host's: it is kept beside the profile a television saved, never
 * handed to the plugin as config, and attached by `yonto.fetch` itself — see
 * `docs/design/2026-09-20-the-host-holds-the-session.md` and kangzj/lantern-tv#163. A
 * plugin cannot send a credential it is never given, whatever its manifest declares.
 *
 * `core/src/androidMain/.../PluginLogins.kt` is the same rule in the other language. They have to
 * agree: a plugin that passes `doctor` here and is logged out on a television is the
 * failure mode this file is written against.
 */

export const COOKIE_LOGIN = 'cookieLogin';

/** The login this plugin declares, or null. A capability naming no page is no login:
 *  there is nowhere to open, and nowhere for its session to be sent. */
export function cookieLoginOf(manifest) {
  return (manifest?.capabilities ?? []).find((c) => c?.type === COOKIE_LOGIN && String(c.url ?? '').trim() !== '')
    ?? null;
}

const DRIVEN_LOGINS = JSON.parse(
  readFileSync(new URL('../../../../contracts/driven-logins.json', import.meta.url), 'utf8'));

/**
 * What `lint` says about each cookieLogin no host will offer a viewer: a page outside
 * `contracts/driven-logins.json` is accepted by both hosts and then never drawn. A linkLogin
 * is held to `contracts/link-logins.json` by `linkLoginRefusals`, which refuses rather than warns.
 */
export function undrivenLoginWarnings(manifest) {
  return (manifest?.capabilities ?? []).filter((capability) => capability?.type === COOKIE_LOGIN).flatMap((capability) => {
    const driven = DRIVEN_LOGINS[COOKIE_LOGIN];
    if (driven.some((page) => sameSite(page, capability.url))) return [];
    const where = capability.url ? `${COOKIE_LOGIN} at ${capability.url}` : `${COOKIE_LOGIN} with no url`;
    const instead = `a host drives a ${COOKIE_LOGIN} at ${driven.join(', ')} and nowhere else`;
    return [`${where} will never be offered to a viewer: ${instead} (contracts/driven-logins.json)`];
  });
}

/**
 * What `Cookie:` this request carries, or null when the session has no business here.
 *
 * Asked per hop rather than per call, because a redirect is otherwise the one way a
 * credential leaves the site it belongs to — the same reason the allowlist is checked per
 * hop.
 *
 * Scheme as well as host: the television permits cleartext, so a session declared at
 * `https` and a request made over `http` are not the same place.
 *
 * The stored credential is the whole `name=value; ...` string a browser handed back and is
 * sent as it was captured. A value with no `=` in it is one somebody pasted by hand, and
 * `cookieName` is the name it goes under — the one job that field has ever had.
 */
export function cookieFor(login, url, credential) {
  const session = String(credential ?? '').trim();
  if (session === '' || !login) return null;
  if (!sameSite(login.url, url)) return null;
  if (session.includes('=')) return session;
  const name = String(login.cookieName ?? '').trim();
  return name === '' ? null : `${name}=${session}`;
}

/**
 * Whether this request's `Set-Cookie` is the host's business rather than the plugin's.
 *
 * True on the site a `cookieLogin` names, where the session belongs to the host. Attaching
 * the credential on the way out and handing it back on the way in would be the same
 * credential in the plugin's hands one call later: a site that re-issues its session cookie
 * on an authenticated response — ordinary WordPress behaviour on a refresh, and something a
 * plugin can go looking for rather than wait for — would hand over the thing the whole
 * design exists to keep from it (kangzj/lantern-tv#189). `HttpOnly` and `Secure` are no
 * help; those are instructions to a browser, and this is not one.
 *
 * Asked about the **site**, not about whether a credential was attached to this particular
 * request. A logged-out request and a logged-in one to the same host must come back the
 * same shape, or the difference is an oracle telling the plugin whether a session exists.
 */
export function withholdsCookies(login, url) {
  return login !== null && login !== undefined && sameSite(login.url, url);
}

function sameSite(capabilityUrl, requestUrl) {
  const host = hostOf(capabilityUrl);
  const scheme = schemeOf(capabilityUrl);
  if (host === null || scheme === null) return false;
  return host === hostOf(requestUrl) && scheme === schemeOf(requestUrl);
}

function schemeOf(url) {
  try {
    return new URL(String(url).trim()).protocol.replace(/:$/, '');
  } catch {
    return null;
  }
}
