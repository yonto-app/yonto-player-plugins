import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFetch } from '../src/host/fetch.js';
import {
  beginRequest, bindingsOf, discoverRequest, identityRequest, pollRequest, readBegin, readDiscovery, readPoll, typedPlacesOf, widened,
} from '../src/host/link-sign-in.js';
import { MASKED, REDACTED, masked } from '../src/host/mask.js';
import { createSession } from '../src/host/session.js';
import {
  SERVICES, accountHostsOf, linkLoginRefusals, linkRecord, readRegistry, recordAdmits, registryProblems,
} from '../src/link-login.js';
import { hostsWith } from '../src/manifest.js';

/**
 * The link sign-in on this host, walked through the records `conformance/link-login/` keeps for
 * both. `LinkSignInRecordTest`, `LinkBindingRecordTest`, `CredentialMaskRecordTest`,
 * `LinkRecordRecordTest`, `LinkLoginsRecordTest` and `PluginSessionAttachRecordTest` walk the
 * same files through the device's.
 */

const record = (name) => JSON.parse(readFileSync(new URL(`../conformance/link-login/${name}`, import.meta.url), 'utf8'));
const SIGN_IN = record('sign-in.json');
const { $comment, ...DECLARED } = readRegistry(readFileSync(new URL('../conformance/link-login/declarations.json', import.meta.url), 'utf8'));
/** The registry's services and the conformance's own, as a case names them. */
const ALL = { ...SERVICES, ...DECLARED };
const serviceOf = (name) => ALL[name];
const bodyOf = (c) => (c.bodyText !== undefined ? c.bodyText : JSON.stringify(c.body));

test('the registry holds only services whose addresses are public https, whose account hosts are at or below its domain, and whose QR is on the visit site', () => {
  assert.deepEqual(registryProblems(SERVICES), []);
  assert.deepEqual(Object.keys(SERVICES), ['plex.tv']);
});

test('the registry check names what is wrong with a service', () => {
  const plex = SERVICES['plex.tv'];
  const broken = {
    ...plex,
    visit: 'https://elsewhere.test/link',
    begin: { ...plex.begin, url: 'http://plex.tv/api/v2/pins', qr: { template: 'https://elsewhere.test/q?{code}' } },
    discover: { ...plex.discover, url: 'https://api.example.test/resources' },
    poll: { ...plex.poll, url: 'https://192.168.1.1/pins/{id}' },
  };
  assert.deepEqual(registryProblems({ broken }), [
    'broken: begin is not an https URL',
    'broken: poll is on a private network',
    "broken: discover at api.example.test is not at or below plex.tv, the account's domain",
  ]);
  const offSite = { ...plex, visit: 'https://elsewhere.test/link', discover: { ...plex.discover, url: 'https://api.example.test/r' } };
  assert.deepEqual(registryProblems({ offSite }), [
    "offSite: discover at api.example.test is not at or below plex.tv, the account's domain",
    'offSite: visit at elsewhere.test is on neither plex.tv nor a host above or below it',
    'offSite: the QR is not on the visit site',
  ]);
});

test('the conformance\'s own services pass the registry\'s check', () => {
  assert.deepEqual(registryProblems(DECLARED), []);
});

test('a body on a GET is a registry problem, on the start or the poll', () => {
  const quick = DECLARED['quick.test'];
  const get = { ...quick, begin: { ...quick.begin, method: 'GET' }, poll: { ...quick.poll, method: 'GET' } };
  assert.deepEqual(registryProblems({ get }), ['get: begin sends a body on a GET', 'get: poll sends a body on a GET']);
});

test('a registry that is not one is refused as it is read', () => {
  assert.throws(() => readRegistry(JSON.stringify({ 'x.test': { visit: 'https://x.test' } })), /not a registry of services/);
});

test('the grammar refuses what the engine could not run as written', () => {
  const device = DECLARED['device.test'];
  const outcomes = device.poll.outcomes;
  const refused = {
    'a credential header with no {credential}': { ...device, accountHeader: { name: 'Authorization', value: 'Bearer' } },
    'a credential header naming it twice': { ...device, serverHeader: { name: 'Authorization', value: '{credential} {credential}' } },
    'a credential header naming anything else': { ...device, serverHeader: { name: 'Authorization', value: '{product} {credential}' } },
    'the bare string a header once was': { ...device, serverHeader: 'X-Key' },
    'a slower outcome with no step': { ...device, poll: { ...device.poll, outcomes: [{ status: [400], field: 'error', equals: 'slow_down', is: 'slower' }] } },
    'a step on an outcome that is not slower': { ...device, poll: { ...device.poll, outcomes: [{ ...outcomes[1], bySeconds: 5 }] } },
    'an equals of null': { ...device, poll: { ...device.poll, outcomes: [{ ...outcomes[1], equals: null }] } },
    'an expiry naming neither a field nor seconds': { ...device, begin: { ...device.begin, expiresIn: {} } },
    'an expiry under ten seconds': { ...device, begin: { ...device.begin, expiresIn: { seconds: 9 } } },
    'a body of both kinds': { ...device, begin: { ...device.begin, body: { form: { a: 'b' }, json: { a: 'b' } } } },
    'an identity header naming a placeholder': { ...device, identity: { ...device.identity, headers: { 'X-Client': '{clientId}' } } },
  };
  for (const [why, service] of Object.entries(refused)) {
    assert.throws(() => readRegistry(JSON.stringify({ 'device.test': service })), /not a registry of services/, why);
  }
});

test('the account\'s hosts are every host its sign-in and discovery ask', () => {
  assert.deepEqual(accountHostsOf(SERVICES['plex.tv']), ['clients.plex.tv', 'plex.tv']);
});

for (const c of SIGN_IN.requests) {
  test(`sign-in.json requests: ${c.why}`, () => {
    const service = serviceOf(c.service);
    const made = {
      begin: () => beginRequest(service, c.clientId),
      poll: () => pollRequest(service, c.clientId, c.code),
      discover: () => discoverRequest(service, c.clientId, c.account),
      identity: () => identityRequest(service, c.place),
    }[c.request]();
    assert.deepEqual({ method: made.method, url: made.url, headers: made.headers, body: made.body }, c.expect);
  });
}

for (const c of SIGN_IN.begin) {
  test(`sign-in.json begin: ${c.why}`, () => {
    assert.deepEqual(readBegin(serviceOf(c.service), c.status, bodyOf(c)), c.expect);
  });
}

for (const c of SIGN_IN.poll) {
  test(`sign-in.json poll: ${c.why}`, () => {
    assert.deepEqual(readPoll(serviceOf(c.service), c.status, bodyOf(c)), c.expect);
  });
}

for (const c of SIGN_IN.widen) {
  test(`sign-in.json widen: ${c.why}`, () => {
    assert.equal(widened(c.intervalMs, c.byMs), c.expect);
  });
}

for (const c of record('discovery.json').cases) {
  test(`discovery.json: ${c.why}`, () => {
    const read = readDiscovery(serviceOf(c.service), bodyOf(c));
    if (c.expect.refused !== undefined) {
      assert.deepEqual(read, { refused: c.expect.refused });
      return;
    }
    assert.deepEqual(read.servers.map((entry) => entry.server), c.expect.servers);
    const bindings = bindingsOf(read.servers, { allowedHosts: c.allowedHosts, typed: typedPlacesOf(c.typed), account: c.account });
    assert.deepEqual(bindings, c.expect.bindings);
  });
}

for (const c of record('masking.json').cases) {
  test(`masking.json: ${c.why}`, () => {
    assert.equal(masked(c.text, c.held, MASKED), c.masked);
    assert.equal(masked(c.text, c.held, REDACTED), c.redacted);
  });
}

for (const c of record('reach.json').cases) {
  test(`reach.json: ${c.why}`, () => {
    assert.equal(recordAdmits(c.record, { id: 'probe', ...c.manifest }), c.kept);
  });
}

for (const c of record('manifests.json').cases) {
  test(`manifests.json: ${c.why}`, () => {
    assert.deepEqual(linkLoginRefusals({ id: 'probe', ...c.manifest }), c.refusals);
  });
}

/** A transport answering by URL, as `attach.json` scripts it. */
function answering(answers) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const answer = answers[req.url];
      if (answer === undefined) throw new Error(`nothing answers ${req.url}`);
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? '');
      return {
        status: answer.status,
        headers: answer.headers ?? {},
        setCookie: answer.setCookie ?? [],
        bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
      };
    },
  };
}

/** The one value of [name] a hop carried, or null; two spellings of it is a failure. */
function headerOf(headers, name) {
  const found = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  assert.ok(found.length <= 1, `two ${name} headers: ${JSON.stringify(headers)}`);
  return found.length === 0 ? null : found[0][1];
}

/** A linked session for [manifest], its host answering [hostAnswers]. */
function sessionFor(manifest, { account, config = {}, hostAnswers, now = () => 1_700_000_000_000 }) {
  return createSession({
    manifest,
    config,
    held: account === null ? null : { credential: account, record: linkRecord(manifest, 0, ALL) },
    transport: answering(hostAnswers),
    clientId: 'host-client-id',
    now,
    services: ALL,
  });
}

for (const c of record('attach.json').cases) {
  test(`attach.json: ${c.why}`, async () => {
    const manifest = { id: 'probe', ...c.manifest };
    const session = sessionFor(manifest, c);
    await session.servers();
    const transport = answering(c.answers);
    const fetch = createFetch({ hosts: hostsWith(manifest, c.config), transport, requests: [], linkSession: session });
    const serverHeader = serviceOf(c.manifest.capabilities[0].service).serverHeader.name;

    const outcome = await fetch(c.url, { headers: c.headers, redirect: c.redirect }).then(
      (answer) => ({ answer }),
      (error) => ({ refused: { code: error.code, message: error.message } }),
    );

    assert.deepEqual(transport.calls.map((call) => ({
      url: call.url,
      credential: headerOf(call.headers, serverHeader),
      range: headerOf(call.headers, 'range'),
      ifRange: headerOf(call.headers, 'if-range'),
    })), c.sent);
    if (c.refused !== undefined) {
      assert.deepEqual(outcome.refused, c.refused);
    } else if (c.answer !== undefined) {
      const { body, bodyBase64, ...rest } = outcome.answer;
      assert.deepEqual({ ...rest, body }, c.answer);
      assert.equal(Buffer.from(bodyBase64, 'base64').toString('utf8'), c.answer.body);
    }
  });
}
