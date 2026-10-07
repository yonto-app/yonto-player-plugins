/**
 * A URL to the one host string every gate asks about.
 *
 * A host has many spellings and one meaning: `http://127.1/`, `http://2130706433/` and
 * `http://0x7f000001/` all reach loopback. Extracting once and asking only about the answer
 * is what stops the allowlist, the private-address floor and the redirect check from reading
 * one string three ways — see contracts/content-source-http.md's "What a host is".
 *
 * `core/src/commonMain/…/content/plugin/PluginHostname.kt` is the same file in the other language, and
 * `conformance/hostnames.json` holds both to it.
 */

import { domainToUnicode } from 'node:url';

const HEX = /^0x[0-9a-f]*$/;
const OCTAL = /^0[0-7]+$/;
const DIGITS = /^[0-9]+$/;

/**
 * The part's value, or null when it is a name rather than a number.
 *
 * A leading zero commits the part to its radix: `08` is a failed octal number and never a
 * decimal eight, which is why the decimal case is only reached when nothing claimed it.
 *
 * Matched against an explicit ASCII pattern rather than handed to a parser: Kotlin's
 * `toLongOrNull` takes a sign and a full-width digit, WHATWG's parser takes neither, and
 * the two hosts have to answer alike — so neither may inherit its language's leniency.
 */
function numberOf(part) {
  if (HEX.test(part)) return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  if (part.length > 1 && part.startsWith('0')) {
    return OCTAL.test(part) ? Number.parseInt(part.slice(1), 8) : null;
  }
  return DIGITS.test(part) ? Number.parseInt(part, 10) : null;
}

/**
 * Whether the host's last part means this host was *meant* to be an address.
 *
 * All ASCII digits counts even when the number itself is invalid, which is the difference
 * between `http://08/` and `http://0xg/`: the first was meant to be an address, fails to be
 * one and is therefore not a host at all, while the second was never a number and is an
 * ordinary domain name.
 */
function endsInNumber(part) {
  return DIGITS.test(part) || numberOf(part) !== null;
}

/**
 * A host that ends in a number, folded to a dotted quad — or null, because a host that was
 * meant to be an address and is not one is not a domain name either.
 *
 * WHATWG's `URL` does this already and OkHttp does not, so the rule is in the contract and
 * both hosts implement it rather than each inheriting its library's answer.
 */
function dottedQuad(host) {
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const numbers = parts.map(numberOf);
  if (numbers.some((n) => n === null || !Number.isSafeInteger(n))) return null;

  const last = numbers[numbers.length - 1];
  const leading = numbers.slice(0, -1);
  // The last part fills whatever room the ones before it left: `192.168.1` puts 1 in the
  // final two octets, and `2130706433` puts the whole address in the only part there is.
  if (leading.some((n) => n > 255) || last >= 2 ** (8 * (5 - numbers.length))) return null;

  const address = leading.reduce((acc, n, i) => acc + n * 2 ** (8 * (3 - i)), last);
  return [address >>> 24, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff].join('.');
}

/**
 * An IPv4-mapped IPv6 address to its dotted quad, so `::ffff:192.168.1.1` is `192.168.1.1`
 * and the dotted-quad classification catches it — rather than a second classifier having to
 * know that `::ffff:c0a8:101` is a LAN address wearing a hat.
 *
 * WHATWG serialises the mapped form in hex groups and compresses the leading run of zeros,
 * so the address half is always one or two groups. OkHttp folds it already, which is why the
 * canonical form follows OkHttp here.
 */
function unbracket(hostname) {
  const inner = hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
  if (mapped === null) return inner;
  const [high, low] = mapped.slice(1).map((group) => Number.parseInt(group, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function hostOf(url) {
  const written = String(url ?? '').trim();
  // WHATWG's parser quietly drops a tab or line break from anywhere in a URL. In the host
  // the device's refuses one — `exa<TAB>mple.com` was example.com here and no host there —
  // while in the path or query it percent-encodes it, so only the host part is looked at
  // (kangzj/lantern-tv#537).
  // Up to where both parsers end the host — a `/`, `\`, `?` or `#` — and not in a username or
  // password, which the device percent-encodes too.
  const [, lead = '', authority = ''] = /^([^/?#\\]*?:[\\/\t\n\r]*)([^/?#\\]*)/.exec(written) ?? [];
  if (/[\t\n\r]/.test(lead + authority.slice(authority.lastIndexOf('@') + 1))) return null;
  let parsed;
  try {
    parsed = new URL(written);
  } catch {
    return null;
  }
  // Port 0 is no port anything is fetched on, and the device's parser refuses it outright.
  if (parsed.port === '0') return null;
  // The device's parser takes http and https and stops there, and a scheme this host will
  // not fetch names no host to allow: an `ftp://` in a `url` field widened the CLI's
  // allowlist and not the television's.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '') return null;
  if (hostname.startsWith('[')) return unbracket(hostname);

  // A root dot names the same host, and `isPrivate` would otherwise read `localhost.` as an
  // ordinary public name — which it did, while `lint` stripped the dot and warned about it.
  const name = hostname.replace(/\.$/, '');
  if (name === '') return null;
  // An empty label, or one longer than DNS allows, is no name DNS can hold, and the device's
  // parser refuses both.
  const labels = name.split('.');
  if (labels.some((label) => label === '' || label.length > 63)) return null;
  // A Punycode label that decodes to nothing but ASCII spells no internationalised name, and
  // the device refuses one. So does Node 24's parser, but Node 20 and 22's read `xn--abc-`
  // as `abc` and hand it back as a host.
  const ascii = (label) => /^[\x00-\x7f]*$/.test(domainToUnicode(label));
  if (labels.some((label) => label.startsWith('xn--') && ascii(label))) return null;
  return endsInNumber(name.slice(name.lastIndexOf('.') + 1)) ? dottedQuad(name) : name;
}

/**
 * The canonical host of something written as a host rather than as a URL — an
 * `allowedHosts` entry, a `url` field's default, anything a person types.
 *
 * A colon is ambiguous in a bare host: `192.168.1.50:8096` is a host and a port, which is
 * what gets typed on a remote and what `SourceUrl.normalize` accepts on the device, while
 * `::1` is an address that needs its brackets back before a parser will take it. So the port
 * reading is tried first and the brackets are the fallback. Reading it the other way round
 * makes a schemeless `host:port` into an IPv6 literal no parser accepts, and the string
 * classifies as naming no host at all.
 *
 * Already a URL — anything carrying `://` — is passed through to `hostOf` untouched.
 */
export function hostOfEntry(written) {
  const entry = String(written ?? '').trim().toLowerCase();
  if (entry === '') return null;
  if (entry.includes('://')) return hostOf(entry);
  const asPort = hostOf(`http://${entry}`);
  if (asPort !== null) return asPort;
  return entry.includes(':') && !entry.startsWith('[') ? hostOf(`http://[${entry}]`) : null;
}

/**
 * Whether an `allowedHosts` entry admits this host, comparing canonical forms.
 *
 * An entry is hand-written JSON and a hostname is case-insensitive, so an entry goes
 * through the same extraction a request does: `allowedHosts: ["2130706433"]` and a fetch of
 * `http://127.1/` are the same permission, and used not to be.
 *
 * A `*.` entry is a name suffix and is never folded as an address — an IP has no
 * subdomains — so `evilaiyingshi.tv` is still not a subdomain of `*.aiyingshi.tv`, and
 * `*.1.1` still matches `192.168.1.1` with the floor left to refuse it.
 */
export function hostAllowed(host, allowedHosts) {
  return allowedHosts.some((entry) => {
    const allowed = String(entry).trim().toLowerCase();
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(2).replace(/\.$/, '');
      return host.endsWith(`.${suffix}`) && host !== suffix;
    }
    // `hostOfEntry` rather than a scheme glued on here: an entry may be a bare
    // `host:port`, and one contributed by a `url` default is already an unbracketed IPv6
    // address, which `http://` + the string does not parse as a host at all.
    return host === hostOfEntry(allowed);
  });
}
