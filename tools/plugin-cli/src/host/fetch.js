import { readFileSync } from 'node:fs';
import { Code, PluginError } from '../errors.js';
import { hostAllowed, hostOf } from '../hostname.js';
import { headersWith, setCookieWithout } from './clearance.js';
import { cookieFor, withholdsCookies } from './credential.js';
import { credentialHeader } from './link-sign-in.js';
import { maskedBytes } from './mask.js';
import { carriesCredentials, normalisedMethod, requestShapeProblem, withBodyType } from './request-shape.js';
import {
  MAX_CHAIN_MILLIS, MAX_HOPS, carriesBody, floorRefuses, headersFor, isRedirect, methodFor, resolve,
} from './redirect.js';

/** The device's bounds on a call, its requests and its answers, which the CLI takes rather than chooses. */
export const LIMITS = JSON.parse(readFileSync(new URL('../../conformance/limits.json', import.meta.url), 'utf8'));

/** The most of a response body `yonto.fetch` hands a plugin. A transport need read no more than one byte past it. */
export const RESPONSE_BODY_BYTES = LIMITS.responseBodyBytes;

/** The most of its bodies one call keeps for `bodyBase64`; past it the oldest is dropped. */
export const UNREAD_BODY_BYTES_PER_CALL = LIMITS.unreadBodyBytesPerCall;

/** The deepest a call's answer may nest; the engine refuses a deeper one unread. Read here with the other limits. */
export const ANSWER_DEPTH = LIMITS.answerDepth;

function locationOf(headers) {
  const found = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'location');
  return found && String(found[1]).trim() !== '' ? String(found[1]) : null;
}

function decodes(encoding) {
  try {
    new TextDecoder(encoding);
    return true;
  } catch {
    return false;
  }
}

/** Whether a `url` value named `host`, which is what widens a manifest's allowlist. */
function namedByConfig(hosts, host) {
  return hosts.fromViewer.includes(host) || hosts.fromRepo.includes(host);
}

/**
 * `yonto.fetch`, including what it does with a 3xx.
 *
 * A redirect is followed here rather than by the transport, so both gates are checked at
 * every hop: it is otherwise the one way a request can leave the hosts a plugin was allowed
 * to reach. `redirect: 'manual'` hands the 3xx back instead, and the answer's `url` is the
 * URL the body actually came from. `YontoHostApi.fetch` does the same, in the same order.
 *
 * `hosts` carries provenance rather than a union because the floor turns on it — see
 * `hostsWith` and contracts/content-source-http.md's "The private-address floor".
 * `clearanceFor(url)` is the clearance a hop to that URL carries, or null — see
 * `clearanceForHop`. [linkSession] is `createSession`'s, for a plugin with a linkLogin: it binds
 * a server's credential to a hop, and everything handed back is masked with what it holds.
 */
export function createFetch({
  hosts, transport, requests, hostsEnforced = true, login = null, credential = () => null, clearanceFor = () => null,
  linkSession = null, callSignal = () => undefined,
}) {
  const fetchOnce = createFetchOnce({
    hosts, transport, requests, hostsEnforced, login, credential, clearanceFor, linkSession, callSignal,
  });
  if (linkSession === null) return fetchOnce;
  return async function yontoFetch(rawUrl, init) {
    try {
      return await fetchOnce(rawUrl, init);
    } catch (error) {
      // Host-built words can quote a server's Location or a transport's failure (the design's 2c).
      if (error instanceof PluginError) error.message = linkSession.mask(error.message);
      throw error;
    }
  };
}

/** Headers never sent beside a credential the host attached: a range could split one across two answers, past the mask. */
const NOT_BESIDE_A_CREDENTIAL = new Set(['range', 'if-range']);

function createFetchOnce({ hosts, transport, requests, hostsEnforced, login, credential, clearanceFor, linkSession, callSignal }) {
  return async function yontoFetch(rawUrl, init = {}) {
    // The call this request belongs to, read once so every hop is cancelled with it.
    const signal = callSignal();
    // What a refusal prints: everything this plugin was permitted, whoever permitted it,
    // so an author reading the message sees the list they can act on.
    const allowedHosts = hosts.all;
    const { encoding = 'utf-8', redirect = 'follow' } = init;
    const follow = redirect !== 'manual';
    // Before anything is sent: a mistyped charset is not worth a request to the site, and it
    // was found only after one, as a RangeError no plugin can branch on (kangzj/lantern-tv#502).
    if (!decodes(encoding)) {
      throw new PluginError(Code.REQUEST_INVALID, `${encoding} is not a charset this host can decode`, { encoding });
    }

    let url = rawUrl;
    let method = normalisedMethod(String(init.method ?? 'GET'));
    let body = init.body;
    const misshapen = requestShapeProblem({ url, method, headers: init.headers ?? {}, body });
    if (misshapen !== null) throw new PluginError(Code.REQUEST_INVALID, misshapen, { url });
    if (linkSession?.carries(String(url ?? ''))) {
      throw new PluginError(Code.REQUEST_INVALID, 'the URL carries a credential the host holds, and one never goes in a URL');
    }
    let headers = withBodyType(init.headers ?? {}, body);
    // One budget for the chain, not one per hop: every hop is its own request with its own
    // timeout now, and twenty of those is not a length of time to hold a plugin open.
    const deadline = Date.now() + MAX_CHAIN_MILLIS;

    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const started = Date.now();

      // The same extraction that decides what a `url` field widens the allowlist to, and
      // the same verdict the device reaches on a string that names no host.
      const host = hostOf(url);
      if (host === null) {
        // An empty one is its own sentence: it is what a plugin builds from a config field
        // nobody filled in, and `not a URL: ` with nothing after the colon names neither
        // the field nor the fact that there was nothing there.
        // The same coercion `hostOf` performs one line above, and for the same reason: a
        // config field a viewer left blank is *absent*, so what a plugin interpolates is
        // `undefined` rather than the empty string this branch is named for.
        throw new PluginError(Code.REQUEST_INVALID,
          String(url ?? '').trim() === '' ? 'the URL was empty' : `not a URL: ${url}`, { url });
      }

      const blocked = (message, detail = {}) => {
        requests.push({
          method, url, requestHeaders: headers,
          status: null, bytes: 0, ms: 0, blocked: true, failed: false, error: null, clearanceSent: false,
        });
        throw new PluginError(Code.HOST_NOT_ALLOWED, message, { host, url, ...detail });
      };

      // Two questions, in this order. The first is what a plugin's allowlist means, and a
      // `hostsFromConfig` plugin skips it — that is what the flag is. The second is the
      // floor under every plugin, which nothing in a manifest switches off.
      if (hostsEnforced && !hostAllowed(host, hosts.fromManifest) && !namedByConfig(hosts, host)) {
        blocked(`${host} is not in this plugin's allowedHosts [${allowedHosts.join(', ')}]`,
          { allowedHosts });
      }

      // A plugin may not reach the television's own network because its manifest asked to —
      // that is the viewer's decision, and a viewer makes it by typing an address into a
      // `url` field, or a repo's address on that host. The exemption is a host and not a
      // chain, which is why this sits inside the hop loop: a redirect off the typed host is
      // refused.
      if (floorRefuses(host, hosts.floorExempt)) {
        blocked(`${host} is a private address, and nothing the viewer typed names it`);
      }
      // The host's own `Cookie`, over whatever the plugin put there — a plugin cannot
      // hand itself a session, and cannot suppress the real one either. Whatever spelling
      // it reached for is removed first: a header name is case-insensitive on the wire, so
      // `cookie` left beside `Cookie` is two of them and the site picks.
      const session = cookieFor(login, url, credential());
      // Asked of this hop's own site, from the plugin's headers for it, so a clearance never
      // rides a redirect off the site it was won at. The session wins on its site.
      const clearance = session === null ? clearanceFor(url) : null;
      let sent = headers;
      if (session !== null) {
        sent = {
          ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'cookie')),
          Cookie: session,
        };
      } else if (clearance !== null) {
        sent = headersWith(clearance, headers);
      }
      const clearanceSent = clearance !== null;
      // A server's own credential, on the hop to a host it is bound to, over any spelling of
      // its header the plugin set: it can neither supply one nor keep the real one off.
      const bound = linkSession === null ? null : await linkSession.bindingFor(url);
      if (bound !== null) {
        const header = credentialHeader(linkSession.credentialHeader, bound.credential);
        sent = {
          ...Object.fromEntries(Object.entries(sent).filter(([name]) =>
            name.toLowerCase() !== header.name.toLowerCase() && !NOT_BESIDE_A_CREDENTIAL.has(name.toLowerCase()))),
          [header.name]: header.value,
        };
      }

      let response;
      try {
        response = await transport.request({ method, url, headers: sent, body, signal });
      } catch (error) {
        requests.push({
          method, url, requestHeaders: sent,
          status: null, bytes: 0, ms: Date.now() - started, blocked: false, failed: true, error: error.message,
          clearanceSent,
          // What the host itself decided, kept because a plugin may catch the throw and raise
          // its own: doctor still needs to know a request found no fixture.
          code: error instanceof PluginError ? error.code : null,
        });
        // The Kotlin host wraps anything its transport throws as REQUEST_FAILED
        // (runCatching { ... }.getOrElse { failure(REQUEST_FAILED, ...) }), so this does
        // too. The test is `instanceof PluginError`, never `.code` — a Node error carries
        // an errno for the filesystem's reasons, and EACCES from a read-only fixtures
        // directory is not a verdict this host reached.
        throw error instanceof PluginError
          ? error
          : new PluginError(Code.REQUEST_FAILED, `${method} ${url} — ${error?.message ?? error}`,
            { url, cause: error });
      }

      const received = Buffer.from(response.bodyBase64, 'base64');
      const bytes = linkSession === null ? received : maskedBytes(received, linkSession.held());
      const mask = linkSession === null ? (text) => text : linkSession.mask;
      // What went out, session included — `format.js` hides a Cookie's value and prints
      // its name, because "was it sent at all" is the question a 401 report has to answer.
      requests.push({
        method, url, requestHeaders: sent,
        status: response.status, bytes: received.length, ms: Date.now() - started,
        blocked: false, failed: false, error: null, clearanceSent,
      });

      const location = locationOf(response.headers);
      const next = location === null ? null : resolve(url, location);
      if (!follow || location === null || !isRedirect(response.status)) {
        if (received.length > RESPONSE_BODY_BYTES) {
          throw new PluginError(Code.RESPONSE_TOO_LARGE,
            `the response from ${url} was larger than the ${RESPONSE_BODY_BYTES / (1024 * 1024)} MB a plugin may read`,
            { url });
        }
        // Two cookies folded into one comma-joined header cannot be split again — an
        // Expires date contains a comma — so the folded value is dropped rather than
        // offered alongside the array that is correct.
        // Every name lowercased here rather than trusted to the transport, because the
        // contract promises it and a fixture or a test double spells headers however it
        // likes: a plugin reads `headers['content-type']`, and on a page served as GBK that
        // one key is the difference between text and mojibake (kangzj/lantern-tv#431).
        const responseHeaders = Object.fromEntries(Object.entries(response.headers ?? {})
          .map(([name, value]) => [name.toLowerCase(), mask(value)])
          .filter(([name]) => name !== 'set-cookie'));

        return {
          status: response.status,
          url: mask(url),
          // `location` resolved, because a plugin handed a 3xx of its own has no URL parser
          // to resolve `/elsewhere` with — QuickJS has no `URL`.
          location: next === null ? null : mask(next),
          headers: responseHeaders,
          // Withheld on the site whose session the host holds — see withholdsCookies — and
          // by name where it holds a clearance. Empty rather than absent: the contract
          // promises an array, and a plugin doing .length on it should not meet undefined.
          setCookie: (withholdsCookies(login, url) ? []
            : clearanceSent ? setCookieWithout(clearance, response.setCookie ?? [])
              : (response.setCookie ?? [])).map(mask),
          // Decoded from the masked bytes and masked again, for a charset that spells ASCII in other bytes.
          body: mask(new TextDecoder(encoding).decode(bytes)),
          bodyBase64: linkSession === null ? response.bodyBase64 : bytes.toString('base64'),
        };
      }

      if (next === null) {
        throw new PluginError(
          Code.REDIRECT_REFUSED, `${url} redirected to something that is not a URL: ${location}`, { url, location });
      }
      if (carriesCredentials(next)) {
        throw new PluginError(
          Code.REDIRECT_REFUSED, `${url} redirected to a URL carrying a user name or password`, { url });
      }
      // Asked of every hop: a server can put a credential it was sent into where it sends the plugin next.
      if (linkSession?.carries(next)) {
        throw new PluginError(Code.REDIRECT_REFUSED, `${url} redirected to a URL carrying a credential the host holds`, { url });
      }

      const keepsBody = carriesBody(response.status, method);
      headers = headersFor(headers, url, next, keepsBody, linkSession?.credentialHeaderNames ?? []);
      if (!keepsBody) body = undefined;
      method = methodFor(response.status, method);
      url = next;

      if (Date.now() >= deadline) {
        throw new PluginError(
          Code.REDIRECT_REFUSED, `a redirect chain took longer than ${MAX_CHAIN_MILLIS} ms, ending at ${url}`, { url });
      }
    }

    throw new PluginError(Code.REDIRECT_REFUSED, `more than ${MAX_HOPS} redirects, ending at ${url}`, { url });
  };
}
