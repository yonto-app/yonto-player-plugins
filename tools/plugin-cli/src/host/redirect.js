/**
 * What a host does with a 3xx.
 *
 * The transports never follow one — undici is asked not to, and so is OkHttp — because a
 * redirect is the one way a request can leave the host it was allowed to reach. Following
 * it here means the allowlist is checked again at every hop, and it means the two hosts
 * follow by the same rules rather than by whichever library each one happens to use.
 *
 * `core/…/content/plugin/PluginRedirect.kt` is the same file in the other language, but for
 * `isPrivate`, which is `isPrivateHost` in `core/…/commonMain/…/PrivateHost.kt`, and
 * `conformance/host-api` holds both to it.
 */

/**
 * Hosts a plugin may not reach because they are the viewer's own network — mirrors
 * `isPrivateHost` in `PrivateHost.kt`.
 *
 * Only ever called on a canonical host (see `../hostname.js`), which is what lets this
 * classify rather than pattern-match: no brackets, no leading zeros, no root dot, and an
 * address written as an integer or in hex already folded to a dotted quad.
 *
 * A plugin may not reach the television's own network because its manifest asked to — see
 * contracts/content-source-http.md's "The private-address floor". A viewer pointing a
 * source at their own box does it through a `url` field, which is a person naming a host,
 * and that is the one thing this does not stop.
 */
export function isPrivate(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  // A colon cannot appear in a domain name, so it is the one safe test for "this is an IPv6
  // address" — a prefix test on `f[cd]` would call `fcbarcelona.com` private now that
  // brackets no longer arrive to gate it.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    // An IPv4-compatible address is that IPv4 address in v6 clothing, the same as the
    // `::ffff:` form — which never reaches here, because extraction folded it to a dotted
    // quad. This one is not folded there, because OkHttp does not fold it and the canonical
    // form follows OkHttp, so `::127.0.0.1` arrives as `::7f00:1` and is classified here.
    const compatible = /^::([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/.exec(host);
    if (compatible !== null) {
      const [, first, second] = compatible;
      const high = second === undefined ? 0 : Number.parseInt(first, 16);
      const low = Number.parseInt(second ?? first, 16);
      return isPrivate([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
    }
    // An address that carries an IPv4 one for a translator or a tunnel to deliver to is
    // whatever that IPv4 address is (kangzj/lantern-tv#334, #675's review).
    const embedded = embeddedIpv4(host);
    if (embedded !== null) return isPrivate(embedded);
    // The first group, not the first characters: a canonical group is not zero-padded, so
    // `fc::1` is 00fc:… and genuinely outside fc00::/7.
    const group = Number.parseInt(host.split(':')[0], 16);
    return (group >= 0xfc00 && group <= 0xfdff) || (group >= 0xfe80 && group <= 0xfebf)
      // NAT64's local-use prefix (RFC 8215) reaches a translator on the operator's own
      // network, and where the IPv4 sits in it depends on a prefix length nothing here
      // knows, so the whole /48 is private.
      || host.startsWith('64:ff9b:1:');
  }

  const octets = host.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [a, b] = octets.map(Number);
  return a === 127 || a === 0 || a === 10
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    // Carrier-grade NAT, and the space Tailscale hands its devices (kangzj/lantern-tv#334).
    || (a === 100 && b >= 64 && b <= 127)
    // Benchmarking space, which some home networks hand out (kangzj/lantern-tv#334).
    || (a === 198 && (b === 18 || b === 19));
}

/**
 * The IPv4 address a canonical IPv6 `host` carries for something to deliver to, or null —
 * `embeddedIpv4` in `PrivateHost.kt` on the device, which says why each of these.
 */
function embeddedIpv4(host) {
  const groups = groupsOf(host);
  if (groups === null) return null;
  const dotted = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return dotted(groups[6], groups[7]);
  }
  if (groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0) {
    return dotted(groups[6], groups[7]);
  }
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2]);
  if (groups[0] === 0x2001 && groups[1] === 0) return dotted(groups[6] ^ 0xffff, groups[7] ^ 0xffff);
  return null;
}

/** The eight groups of a canonical IPv6 address, `::` expanded, or null when it is not one. */
function groupsOf(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/**
 * The private-address floor: a private host is refused unless it is one of `exempt`, the
 * hosts a person named. One rule for a plugin's `yonto.fetch` and a repo's own fetch, as
 * `PrivateFloor` is on the device.
 */
export function floorRefuses(host, exempt) {
  return isPrivate(host) && !exempt.includes(host);
}

/** OkHttp's own ceiling, and undici's. A chain this long is a loop. */
export const MAX_HOPS = 20;

/**
 * How long a whole chain may take, across every hop.
 *
 * Each hop is its own request with its own timeout now that the host follows rather than
 * the client, so without this a chain of twenty slow-but-alive hops holds a plugin call
 * open for twenty times as long as one request may take.
 */
export const MAX_CHAIN_MILLIS = 60_000;

const STRIPPED = /[\t\n\r]/g;
const SENSITIVE = ['authorization', 'cookie'];
const BODY_DESCRIBING = ['content-type', 'content-length', 'content-encoding'];

/** 304 and 305 carry a `Location` in neither sense: one is a cache answer, the other a proxy. */
export function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * `location` against the URL it arrived from, or null when it resolves to nothing this
 * host will fetch — a scheme that is not http or https included, which is where the
 * device's parser stops and this one would otherwise carry on.
 *
 * Tabs and line breaks are removed first, wherever they sit: a URL parser on the web
 * removes them and OkHttp's does not.
 */
export function resolve(from, location) {
  try {
    const url = new URL(String(location).replace(STRIPPED, '').trim(), from);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The method the next hop uses, by the rule browsers settled on: a POST that is redirected
 * 301 or 302 becomes a GET, and 303 turns anything but a HEAD into one. 307 and 308 exist
 * precisely so a method survives, and are left alone.
 *
 * A method that changes takes the body with it — see `carriesBody`.
 */
export function methodFor(status, method) {
  const upper = String(method).toUpperCase();
  if ((status === 301 || status === 302) && upper === 'POST') return 'GET';
  if (status === 303 && upper !== 'GET' && upper !== 'HEAD') return 'GET';
  return method;
}

export function carriesBody(status, method) {
  return methodFor(status, method) === method;
}

/**
 * The headers the next hop carries.
 *
 * Leaving the origin — the scheme, the host or the port — drops what was meant for the one
 * being left: a plugin that sends a token to its own server must not hand it to whatever
 * that server points at, and a hop from `https` to `http` on the same host would otherwise
 * put a bearer token on the wire in clear. The same rule the web has.
 *
 * A method that lost its body loses what described it too, or a GET goes out claiming a
 * content type and a length it no longer has. [credentials] are lowercase header names
 * dropped with them: a linkLogin service's own.
 */
export function headersFor(headers, from, to, keepsBody, credentials = []) {
  const dropped = [
    ...(originOf(from) === originOf(to) ? [] : [...SENSITIVE, ...credentials]),
    ...(keepsBody ? [] : BODY_DESCRIBING),
  ];
  if (dropped.length === 0) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !dropped.includes(name.trim().toLowerCase())));
}

/** Scheme, host and port — null when the string names no origin, which equals no origin. */
function originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
