import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { BROWSER_CHECK } from './browser-check.js';
import { COOKIE_LOGIN } from './host/credential.js';
import { isPrivate } from './host/redirect.js';
import { hostOf, hostOfEntry } from './hostname.js';

/**
 * A sign-in the viewer finishes on a phone, which the host runs for a service it knows and
 * whose credential the plugin never holds — docs/design/2026-09-24-a-code-the-viewer-links.md.
 *
 * A manifest names a service and nothing else; `contracts/link-logins.json` says how its
 * sign-in and its server list work. `core/src/androidMain/.../LinkLogins.kt` is the same rule on a
 * television, which runs no `lint` and so asks [linkLoginRefusals] of every manifest it builds;
 * `conformance/link-login/manifests.json` holds the two to one answer.
 */

export const LINK_LOGIN = 'linkLogin';

const contracts = new URL('../../../contracts/', import.meta.url);
const validateRegistry = new Ajv2020({ allErrors: true, strict: false })
  .compile(JSON.parse(readFileSync(new URL('link-login.schema.json', contracts), 'utf8')));

/** Each service's declaration by name, held to `contracts/link-login.schema.json`. */
export function readRegistry(json) {
  const registry = JSON.parse(json);
  if (!validateRegistry(registry)) {
    throw new Error(`contracts/link-logins.json is not a registry of services: ${JSON.stringify(validateRegistry.errors)}`);
  }
  const { $comment, ...services } = registry;
  return Object.freeze(services);
}

export const SERVICES = readRegistry(readFileSync(new URL('link-logins.json', contracts), 'utf8'));

/** Whether [host] is [parent] or a subdomain of it. */
export function isAtOrBelow(host, parent) {
  return host === parent || host.endsWith(`.${parent}`);
}

/** Whether a URL or QR a service shows may be shown: https, on its visit site, under 2,048 characters. */
export function showable(url, visit) {
  const host = hostOf(url);
  const visitHost = hostOf(visit);
  return typeof url === 'string' && url.length < 2048 && url.startsWith('https://') &&
    host !== null && visitHost !== null && isAtOrBelow(host, visitHost);
}

/** Whether an `allowedHosts` entry admits [domain] or any host below it, exactly or through a `*.` entry. */
function reaches(entry, domain) {
  const written = String(entry).trim().toLowerCase();
  if (written.startsWith('*.')) {
    const suffix = written.slice(2).replace(/\.$/, '');
    return isAtOrBelow(suffix, domain) || isAtOrBelow(domain, suffix);
  }
  const host = hostOfEntry(written);
  return host !== null && isAtOrBelow(host, domain);
}

/** A template's host, with whatever it fills in left out: the host is always written out. */
function hostOfTemplate(template) {
  return hostOf(String(template).replace(/\{\w+\}/g, 'x'));
}

/** The hosts the service's account lives on: every host its sign-in and its discovery ask, which the plugin may never reach. */
export function accountHostsOf(service) {
  return [...new Set([service.begin.url, service.poll.url, service.discover.url].map(hostOfTemplate))].sort();
}

/** The manifest's linkLogin, with its service's declaration, when a host would run it; otherwise null. */
export function linkLoginOf(manifest, services = SERVICES) {
  if (linkLoginRefusals(manifest, services).length > 0) return null;
  const login = (manifest?.capabilities ?? []).find((capability) => capability?.type === LINK_LOGIN);
  return login === undefined ? null : { name: login.service, service: services[login.service] };
}

/** Every rule a manifest's linkLogin breaks, worded as `LinkLogins.refusals` words it. Empty for a manifest with none. */
export function linkLoginRefusals(manifest, services = SERVICES) {
  const logins = (manifest?.capabilities ?? []).filter((capability) => capability?.type === LINK_LOGIN);
  if (logins.length === 0) return [];
  if (logins.length > 1) return ['linkLogin is declared more than once'];
  const [{ service: name }] = logins;
  const refusals = [];
  const service = Object.hasOwn(services, String(name)) ? services[name] : null;
  if (service === null) {
    refusals.push(`linkLogin names ${name}, which is not a service a host signs in to: ` +
      `${Object.keys(services).join(', ')} (contracts/link-logins.json)`);
  } else {
    for (const entry of manifest.allowedHosts ?? []) {
      if (reaches(entry, service.accountDomain)) {
        refusals.push(`allowedHosts entry ${entry} reaches ${service.accountDomain}, where ${name}'s account is: only Yonto talks to it`);
      }
    }
  }
  const companions = [
    [manifest.hostsFromConfig === true, 'hostsFromConfig, since nothing bounds where its requests go'],
    [manifest.runsFetchedCode === true, 'runsFetchedCode, since nothing bounds what code runs beside the session'],
    [(manifest.handles ?? []).length > 0, 'handles: a catalog is never offered a sign-in'],
    [manifest.capabilities.some((c) => c?.type === COOKIE_LOGIN), 'a cookieLogin: two host-held credentials on one source need a merge rule'],
    [manifest.capabilities.some((c) => c?.type === BROWSER_CHECK), 'a browserCheck: two host-held credentials on one source need a merge rule'],
  ];
  for (const [present, why] of companions) {
    if (present) refusals.push(`a linkLogin cannot stand beside ${why}`);
  }
  return refusals;
}

/**
 * What is wrong with a registry's services beyond its grammar: an address that is not public
 * https, an account host not at or below the account's domain, a visit site neither above nor
 * below the start's host, a QR template off the visit site, or a body on a GET, which no
 * transport sends. Asked by a test of the registry file on each host rather than by `lint`,
 * since a plugin cannot change it.
 */
export function registryProblems(services) {
  return Object.entries(services).flatMap(([name, service]) => {
    const problems = [];
    const hosts = {};
    for (const [field, url] of [['visit', service.visit], ['begin', service.begin.url], ['poll', service.poll.url], ['discover', service.discover.url]]) {
      const host = hostOfTemplate(url);
      if (host === null || !url.startsWith('https://')) problems.push(`${name}: ${field} is not an https URL`);
      else if (isPrivate(host)) problems.push(`${name}: ${field} is on a private network`);
      else hosts[field] = host;
    }
    const { begin: start, visit } = hosts;
    for (const field of ['begin', 'poll', 'discover']) {
      if (hosts[field] && !isAtOrBelow(hosts[field], service.accountDomain)) {
        problems.push(`${name}: ${field} at ${hosts[field]} is not at or below ${service.accountDomain}, the account's domain`);
      }
    }
    if (start && visit && !isAtOrBelow(visit, start) && !isAtOrBelow(start, visit)) {
      problems.push(`${name}: visit at ${visit} is on neither ${start} nor a host above or below it`);
    }
    const qr = service.begin.qr.template;
    if (visit && qr !== undefined && !showable(qr.replace(/\{\w+\}/g, 'X'), service.visit)) {
      problems.push(`${name}: the QR is not on the visit site`);
    }
    for (const field of ['begin', 'poll']) {
      if (service[field].method === 'GET' && service[field].body !== undefined) problems.push(`${name}: ${field} sends a body on a GET`);
    }
    return problems;
  });
}

/**
 * Whether a session linked under [record] may still be used by [manifest]: the same service,
 * whose account still lives on the same hosts, and a plugin reaching no further than when it
 * was linked. On reach, not on origin (the design's *What happens to it*).
 */
export function recordAdmits(record, manifest, services = SERVICES) {
  const login = linkLoginOf(manifest, services);
  if (login === null || record === null || typeof record !== 'object') return false;
  if (record.service !== login.name) return false;
  if (!sameMembers(record.accountHosts ?? [], accountHostsOf(login.service))) return false;
  const linkedReach = new Set((record.allowedHosts ?? []).map(canonicalEntry));
  return (manifest.allowedHosts ?? []).every((entry) => linkedReach.has(canonicalEntry(entry)));
}

function sameMembers(a, b) {
  return a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);
}

function canonicalEntry(entry) {
  return String(entry).trim().toLowerCase();
}

/** What a host writes down beside the credential when a sign-in succeeds. */
export function linkRecord(manifest, now, services = SERVICES) {
  const login = linkLoginOf(manifest, services);
  return {
    linkedAt: now,
    service: login.name,
    accountHosts: accountHostsOf(login.service),
    allowedHosts: [...manifest.allowedHosts],
  };
}
