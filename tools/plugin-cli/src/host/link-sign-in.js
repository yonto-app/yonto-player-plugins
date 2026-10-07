import { hostAllowed, hostOf } from '../hostname.js';
import { showable } from '../link-login.js';

/**
 * The one link sign-in engine, and what every service's answers are held to — the design's
 * *The dialects*. A service is data (`contracts/link-logins.json`): the requests to make, where
 * each answer keeps a code, a token or the account's servers, and which header a credential
 * goes in. Nothing here knows a service. `LinkSignIn.kt` is the same engine on a television,
 * and `conformance/link-login/` holds the two to one reading of every answer.
 */

const CODE = /^[A-Za-z0-9-]+( [A-Za-z0-9-]+)*$/;
const CREDENTIAL = /^[\x21-\x7e]{8,4096}$/;
const SECOND_MS = 1000;

/** What the host calls itself to a service, in `{product}`. */
export const PRODUCT = 'Yonto';

export const LINK_RULES = Object.freeze({
  minExpiresInMs: 10 * SECOND_MS,
  maxExpiresInMs: 60 * 60 * SECOND_MS,
  minIntervalMs: 2 * SECOND_MS,
  maxIntervalMs: 60 * SECOND_MS,
  maxBoundHosts: 32,
});

/** A code the viewer types: 1 to 16 ASCII letters, digits, `-` and single spaces. */
export function isCode(value) {
  return typeof value === 'string' && value.length <= 16 && CODE.test(value);
}

/** A credential a host may keep: 8 to 4,096 printable ASCII characters. */
export function isCredential(value) {
  return typeof value === 'string' && CREDENTIAL.test(value);
}

export function clampInterval(ms) {
  return Math.min(LINK_RULES.maxIntervalMs, Math.max(LINK_RULES.minIntervalMs, ms));
}

/** The value at a dot [path] in [value], the empty path being [value] itself; undefined where there is none. */
export function valueAt(value, path) {
  if (path === '') return value;
  return path.split('.').reduce((at, key) => (at !== null && typeof at === 'object' && Object.hasOwn(at, key) ? at[key] : undefined), value);
}

/** [template] with each `{name}` in [values] filled in, percent-encoded where [encode] says. */
function filled(template, values, encode) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    if (!Object.hasOwn(values, name)) return whole;
    return encode ? encodeURIComponent(String(values[name])) : String(values[name]);
  });
}

const CONTENT_TYPES = { form: 'application/x-www-form-urlencoded', json: 'application/json' };

/** A declared body, filled in and written as its kind is: `{ contentType, text }`, or null for none. */
function bodyOf(declared, values) {
  if (declared === undefined) return null;
  const [kind, fields] = Object.entries(declared)[0];
  const pairs = Object.entries(fields).map(([name, value]) => [name, filled(value, values, false)]);
  const text = kind === 'form' ? new URLSearchParams(pairs).toString() : JSON.stringify(Object.fromEntries(pairs));
  return { contentType: CONTENT_TYPES[kind], text };
}

function request(service, part, values) {
  const all = { product: PRODUCT, ...values };
  let headers = Object.fromEntries(Object.entries(service.headers).map(([name, value]) => [name, filled(value, all, false)]));
  const body = bodyOf(part.body, all);
  if (body !== null) {
    headers = {
      ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')),
      'Content-Type': body.contentType,
    };
  }
  return { method: part.method, url: filled(part.url, all, true), headers, body: body?.text ?? null };
}

/** A credential header as it is sent: its name, and its value with [credential] where it says `{credential}`. */
export function credentialHeader(header, credential) {
  return { name: header.name, value: header.value.split('{credential}').join(credential) };
}

function jsonOf(body) {
  try {
    return JSON.parse(String(body ?? ''));
  } catch {
    return undefined;
  }
}

/** The request that asks for a code. */
export function beginRequest(service, clientId) {
  return request(service, service.begin, { clientId });
}

/** A code to show, or `{ refused }`: anything the rules refuse is a failed start, not a sign-in. */
export function readBegin(service, status, body) {
  if (status < 200 || status > 299) return { refused: `the start answered ${status}` };
  const answer = jsonOf(body);
  const { begin } = service;
  const id = valueAt(answer, begin.id);
  const code = valueAt(answer, begin.code);
  const answered = begin.expiresIn.field === undefined ? undefined : valueAt(answer, begin.expiresIn.field);
  const expiresIn = typeof answered === 'number' ? answered : begin.expiresIn.seconds;
  if (!((typeof id === 'string' && id !== '') || (Number.isSafeInteger(id) && id > 0))) {
    return { refused: 'the start answered no id' };
  }
  if (!isCode(code)) return { refused: 'the start answered no code a viewer can type' };
  const expiresInMs = typeof expiresIn === 'number' ? expiresIn * SECOND_MS : NaN;
  if (!(expiresInMs >= LINK_RULES.minExpiresInMs && expiresInMs <= LINK_RULES.maxExpiresInMs)) {
    return { refused: 'the start answered an expiry outside 10 seconds to an hour' };
  }
  const asked = begin.interval.field === undefined ? undefined : valueAt(answer, begin.interval.field);
  const intervalSeconds = typeof asked === 'number' && Number.isFinite(asked) ? asked : begin.interval.seconds;
  const qr = begin.qr.template !== undefined
    ? filled(begin.qr.template, { id, code }, true)
    : valueAt(answer, begin.qr.field);
  return {
    code: {
      id,
      userCode: code,
      visit: service.visit,
      qr: showable(qr, service.visit) ? qr : service.visit,
      expiresInMs,
      intervalMs: clampInterval(intervalSeconds * SECOND_MS),
    },
  };
}

/** The request that asks whether the viewer has finished yet. */
export function pollRequest(service, clientId, code) {
  return request(service, service.poll, { clientId, id: code.id, code: code.userCode });
}

/**
 * `pending`; `slower`, which is pending and widens every later wait by `byMs` ([widened]);
 * `linked` with the account credential; `expired`, `denied` or `failed`.
 */
export function readPoll(service, status, body) {
  const answer = jsonOf(body);
  const outcome = service.poll.outcomes.find((rule) => rule.status.includes(status) &&
    (rule.present === undefined || (valueAt(answer, rule.present) ?? null) !== null) &&
    (rule.field === undefined || valueAt(answer, rule.field) === rule.equals));
  if (outcome === undefined) return { outcome: 'failed', reason: `the poll answered ${status}` };
  if (outcome.is === 'slower') return { outcome: 'slower', byMs: outcome.bySeconds * SECOND_MS };
  if (outcome.is !== 'linked') return { outcome: outcome.is };
  const credential = valueAt(answer, service.poll.credential);
  if (!isCredential(credential)) return { outcome: 'failed', reason: 'the poll answered a credential no host keeps' };
  return { outcome: 'linked', credential };
}

/** The wait between polls once a `slower` answer asked for [byMs] more, clamped as every interval is. */
export function widened(intervalMs, byMs) {
  return clampInterval(intervalMs + byMs);
}

/** The request that lists the account's servers: the one request that carries the account credential. */
export function discoverRequest(service, clientId, credential) {
  const sent = request(service, service.discover, { clientId });
  const { name, value } = credentialHeader(service.accountHeader, credential);
  return { ...sent, headers: { ...sent.headers, [name]: value } };
}

/**
 * The servers a discovery answer lists, each as the host projects it and with its credential
 * apart, or `{ refused }` for an answer with no list where the service says one is. A resource
 * that is not a server is not one; a server that cannot be read is left out, never handed over.
 */
export function readDiscovery(service, body) {
  const list = valueAt(jsonOf(body), service.discover.servers);
  if (!Array.isArray(list)) return { refused: 'the account answered no list of servers' };
  return { servers: list.filter((entry) => isServer(service, entry)).flatMap((entry) => serverOf(service, entry)) };
}

/**
 * Every credential a discovery answer lists, from every entry whether or not it reads as a server,
 * so a recording can hide what [readDiscovery] would leave out rather than hand over.
 */
export function credentialsListed(service, body) {
  const list = valueAt(jsonOf(body), service.discover.servers);
  if (!Array.isArray(list)) return [];
  return list.map((entry) => valueAt(entry, service.discover.server.credential)).filter(isCredential);
}

function isServer(service, entry) {
  const where = service.discover.where;
  if (where === undefined) return true;
  const kinds = valueAt(entry, where.field);
  const list = typeof kinds === 'string' ? kinds.split(',').map((kind) => kind.trim()) : kinds;
  return Array.isArray(list) && list.includes(where.includes);
}

function serverOf(service, entry) {
  const fields = service.discover.server;
  const name = valueAt(entry, fields.name);
  const id = valueAt(entry, fields.id);
  const owned = fields.owned === undefined ? false : valueAt(entry, fields.owned);
  const credential = valueAt(entry, fields.credential) ?? null;
  const connections = valueAt(entry, fields.connections);
  const readable = typeof name === 'string' && typeof id === 'string' && id !== '' && typeof owned === 'boolean' &&
    (credential === null || isCredential(credential)) && Array.isArray(connections);
  if (!readable) return [];
  const read = connections.map((connection) => connectionOf(service, connection));
  if (read.includes(null)) return [];
  return [{ server: { name, id, owned, connections: read }, credential }];
}

function connectionOf(service, connection) {
  const fields = service.discover.connection;
  const read = Object.fromEntries(Object.entries(fields).map(([key, path]) => [key, valueAt(connection, path)]));
  const ok = typeof read.uri === 'string' && typeof read.address === 'string' &&
    Number.isSafeInteger(read.port) && read.port > 0 && read.port < 65536 &&
    typeof read.protocol === 'string' && typeof read.local === 'boolean' && typeof read.relay === 'boolean';
  return ok ? { uri: read.uri, address: read.address, port: read.port, protocol: read.protocol, local: read.local, relay: read.relay } : null;
}

/** What a server at a typed address is asked about itself: the service's declared request, and none of its headers or credentials. */
export function identityRequest(service, binding) {
  const host = binding.host.includes(':') ? `[${binding.host}]` : binding.host;
  return {
    method: service.identity.method,
    url: `${binding.scheme}://${host}:${binding.port}${service.identity.path}`,
    headers: { ...service.identity.headers },
    body: null,
  };
}

export function readIdentity(service, body) {
  const id = valueAt(jsonOf(body), service.identity.id);
  return typeof id === 'string' ? id : null;
}

/**
 * The hosts each server's credential is bound to — the design's *Binding a server*.
 *
 * A connection's `uri` host when it is https and [allowedHosts] admit it; a host the viewer
 * typed as an IP literal when a connection's address and port are that address and port,
 * over the scheme typed, to be confirmed by `/identity` before first use. Never an owned
 * server (none is, where the service declares no owner), never a credential equal to
 * [account], at most 32 hosts.
 */
export function bindingsOf(servers, { allowedHosts, typed, account }) {
  const bindings = [];
  const seen = new Set();
  const bind = (binding) => {
    const key = placeOf(binding);
    if (seen.has(key) || bindings.length >= LINK_RULES.maxBoundHosts) return;
    seen.add(key);
    bindings.push(binding);
  };
  for (const { server, credential } of servers) {
    if (server.owned || credential === null || credential === account) continue;
    for (const connection of server.connections) {
      const at = hopOf(connection.uri);
      if (at !== null && at.scheme === 'https' && hostAllowed(at.host, allowedHosts)) {
        bind({ ...at, credential, server: server.id, typed: false });
      }
      const address = addressOf(connection.address);
      for (const place of typed) {
        if (address !== null && place.host === address && place.port === connection.port) {
          bind({ ...place, credential, server: server.id, typed: true });
        }
      }
    }
  }
  return bindings;
}

/** What the viewer typed, as scheme, host and port; only an IP literal can match a connection's address. */
export function typedPlacesOf(urls) {
  return urls.map(hopOf).filter((hop) => hop !== null);
}

/** `scheme://host:port`, which a binding and a hop are matched by. */
export function placeOf({ scheme, host, port }) {
  return `${scheme}://${host}:${port}`;
}

/** A URL's scheme, canonical host and port (the scheme's own when none is written), or null. */
export function hopOf(url) {
  const host = hostOf(url);
  if (host === null) return null;
  const parsed = new URL(String(url).trim());
  const scheme = parsed.protocol.replace(/:$/, '');
  return { scheme, host, port: parsed.port === '' ? (scheme === 'https' ? 443 : 80) : Number(parsed.port) };
}

function addressOf(address) {
  const host = hostOf(`http://${address.includes(':') ? `[${address}]` : address}`);
  return host !== null && isAddressLiteral(host) ? host : null;
}

/** Whether [host] is an IP address as written, the only typed host a server may be bound on. */
function isAddressLiteral(host) {
  return host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
