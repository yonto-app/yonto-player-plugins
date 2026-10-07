import { createHash } from 'node:crypto';
import { Code, PluginError } from '../errors.js';
import { hostOf } from '../hostname.js';
import { SERVICES, linkLoginOf, recordAdmits } from '../link-login.js';
import { FIELD_TYPE_URL, hostsWith } from '../manifest.js';
import {
  bindingsOf, discoverRequest, hopOf, identityRequest, isCredential, placeOf, readDiscovery, readIdentity, typedPlacesOf,
} from './link-sign-in.js';
import { MASKED, PLACEHOLDERS, REDACTED, masked, maskedLeaves } from './mask.js';

/** How long a server list is used before `servers()` asks the account again. */
export const SERVERS_FRESH_MS = 10 * 60 * 1000;

/** The least time between two asks of the account, whatever the plugin does. */
export const ASK_AT_MOST_EVERY_MS = 60 * 1000;

/**
 * What the host calls itself to a linkLogin's service: never `installId()`, which the plugin
 * knows. Derived from the plugin's directory, as `installId` is here, with a label of its own.
 * `HostClientIdentity.kt` derives the device's from the install's salt and the source's
 * identity id.
 */
export function hostClientIdOf(pluginDir, manifest) {
  return createHash('sha256').update(`lantern-link-client\u0000${pluginDir}\u0000${manifest.id}`).digest('hex').slice(0, 32);
}

/**
 * `yonto.session` and what backs it for one plugin run: the account credential the host
 * holds ([held], `YONTO_PLUGIN_SESSION` here), the servers the account lists, and the
 * credential bound to each server's hosts — the design's *yonto.session* and *Binding a server*.
 *
 * Null for a plugin with no linkLogin a host would run. [transport] is the host's own, which
 * a recording keeps apart from the plugin's. [secrets] is what `--record` must not write.
 * [services] is the registry, which only a test replaces.
 */
export function createSession({
  manifest, config = {}, origin = null, held = null, transport, clientId, now, secrets = null, warn = () => {}, services = SERVICES,
}) {
  const login = linkLoginOf(manifest, services);
  if (login === null) return null;
  const { service } = login;
  const accountHost = hostOf(service.discover.url);
  let account = null;
  if (held !== null) {
    if (isCredential(held.credential) && recordAdmits(held.record, manifest, services)) {
      account = held.credential;
    } else {
      warn('YONTO_PLUGIN_SESSION was linked for another service or a narrower reach, so it is not used: ' +
        'run `yonto-plugin link` again');
    }
  }
  secrets?.add(clientId, PLACEHOLDERS.clientId);
  secrets?.add(account, PLACEHOLDERS.credential);

  const typed = typedPlaces(manifest, config, origin);
  // Every credential this run has held or read, masked for as long as it runs: a server's
  // token read once is not the plugin's after the account stops listing it.
  const ever = new Set(account === null ? [] : [account]);
  let servers = null;
  let bindings = [];
  let fetchedAt = 0;
  let stale = false;
  let askedAt = null;
  const verified = new Map();
  const attached = new Set();

  const failed = (message) => new PluginError(Code.REQUEST_FAILED, masked(message, [...ever]));

  async function ask() {
    askedAt = now();
    const sent = account;
    const request = discoverRequest(service, clientId, sent);
    let response;
    try {
      response = await transport.request(request);
    } catch (error) {
      throw error instanceof PluginError && error.code !== Code.REQUEST_FAILED
        ? error
        : failed(`the account's server list could not be read: ${error?.message ?? error}`);
    }
    if (response.status === 401) {
      if (account === sent) {
        account = null;
        servers = null;
        bindings = [];
        warn(`${accountHost} refused the session, so it is dropped: run \`yonto-plugin link\` again`);
      }
      return [];
    }
    if (response.status !== 200) throw failed(`the account's server list answered ${response.status}`);
    const read = readDiscovery(service, Buffer.from(response.bodyBase64, 'base64').toString('utf8'));
    if (read.refused) throw failed(read.refused);
    for (const { credential } of read.servers) {
      if (credential !== null) {
        ever.add(credential);
        secrets?.add(credential, PLACEHOLDERS.serverCredential);
      }
    }
    bindings = bindingsOf(read.servers, { allowedHosts: manifest.allowedHosts, typed, account });
    for (const key of [...verified.keys()]) if (!bindings.some((b) => placeOf(b) === key)) verified.delete(key);
    servers = maskedLeaves(read.servers.map((entry) => entry.server), [...ever]);
    fetchedAt = now();
    stale = false;
    return servers;
  }

  async function confirmed(binding) {
    const key = placeOf(binding);
    const known = verified.get(key);
    if (known && now() - known.at < SERVERS_FRESH_MS) return known.ok;
    let answer;
    try {
      answer = await transport.request(identityRequest(service, binding));
    } catch {
      return false;
    }
    const ok = answer.status === 200 &&
      readIdentity(service, Buffer.from(answer.bodyBase64, 'base64').toString('utf8')) === binding.server;
    verified.set(key, { ok, at: now() });
    return ok;
  }

  const heldNow = () => [...ever];

  return {
    credentialHeader: service.serverHeader,
    /** Lowercase, for a redirect off an origin to drop as it drops `authorization`. */
    credentialHeaderNames: [service.serverHeader.name, service.accountHeader.name].map((name) => name.toLowerCase()),
    linked: () => account !== null,
    async servers() {
      if (account === null) return [];
      if (servers !== null && !stale && now() - fetchedAt < SERVERS_FRESH_MS) return servers;
      if (askedAt !== null && now() - askedAt < ASK_AT_MOST_EVERY_MS) {
        if (servers !== null) return servers;
        throw failed(`${accountHost} was asked for the account's servers less than a minute ago`);
      }
      return ask();
    },
    refused() {
      if (attached.size === 0) return;
      stale = true;
      for (const key of attached) verified.delete(key);
    },
    /** The binding for this hop, or null: exact scheme, host and port, and a typed address only once `/identity` agrees. */
    async bindingFor(url) {
      if (account === null) return null;
      const hop = hopOf(url);
      const binding = hop && bindings.find((b) => placeOf(b) === placeOf(hop));
      if (!binding) return null;
      if (binding.typed && !await confirmed(binding)) return null;
      attached.add(placeOf(binding));
      return binding;
    },
    /** Whether [text] carries a credential the host holds. */
    carries: (text) => masked(text, heldNow()) !== String(text),
    mask: (text) => masked(text, heldNow(), MASKED),
    maskLeaves: (value) => maskedLeaves(value, heldNow()),
    held: heldNow,
    redact: (text) => masked(text, heldNow(), REDACTED),
    startCall() {
      attached.clear();
    },
  };
}

/** What the viewer typed into a `url` field: a manifest's default or a repo's value binds nothing. */
function typedPlaces(manifest, config, origin) {
  const { fromViewer } = hostsWith(manifest, config, origin);
  return typedPlacesOf((manifest.configSchema ?? [])
    .filter((field) => field.type === FIELD_TYPE_URL && fromViewer.includes(hostOf(config[field.id])))
    .map((field) => config[field.id]));
}
