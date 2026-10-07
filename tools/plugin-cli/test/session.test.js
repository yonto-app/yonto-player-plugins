import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Code } from '../src/errors.js';
import { createHost } from '../src/host/index.js';
import { createSecrets } from '../src/host/mask.js';
import { ASK_AT_MOST_EVERY_MS, SERVERS_FRESH_MS, createSession, hostClientIdOf } from '../src/host/session.js';
import { linkRecord } from '../src/link-login.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * `yonto.session` on this host: when it asks the account for its servers, what `refused()`
 * does, and when the host drops the session. `DiscoveryRefusalTest` holds the device's to the
 * same rules.
 */

const DISCOVER = 'https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1';
const ACCOUNT = 'account-token-cccccccc';
const SHARED = 'shared-token-aaaaaaaa';
const BOUND = 'https://203-0-113-7.aaaa.plex.direct:32400';
const manifest = {
  id: 'probe',
  allowedHosts: ['*.plex.direct'],
  capabilities: [{ type: 'linkLogin', service: 'plex.tv' }],
  configSchema: [{ id: 'serverUrl', label: 'Server', type: 'url' }],
};

function server({ name = 'Friend', token = SHARED, uri = BOUND, address = '203.0.113.7' } = {}) {
  return {
    name, clientIdentifier: 'server-friend', provides: 'server', owned: false, accessToken: token,
    connections: [{ uri, address, port: 32400, protocol: 'https', local: false, relay: false }],
  };
}

/** A host transport whose answers a test changes as it goes, counting what it was asked. */
function account(answer = { status: 200, body: [server()] }) {
  const transport = {
    answer,
    identity: null,
    asked: [],
    async request(req) {
      this.asked.push(req);
      const { status, body } = req.url.endsWith('/identity') ? this.identity : this.answer;
      return { status, headers: {}, bodyBase64: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') };
    },
  };
  return transport;
}

function linked(transport, { at = { now: 1_700_000_000_000 }, config = {}, credential = ACCOUNT, warn = () => {}, secrets = null } = {}) {
  return createSession({
    manifest, config, held: { credential, record: linkRecord(manifest, 0) }, transport, clientId: 'host-client-id',
    now: () => at.now, warn, secrets,
  });
}

test('servers() asks the account once and answers from that for ten minutes', async () => {
  const transport = account();
  const at = { now: 1_700_000_000_000 };
  const session = linked(transport, { at });

  const first = await session.servers();
  at.now += SERVERS_FRESH_MS - 1;
  const again = await session.servers();

  assert.equal(transport.asked.length, 1);
  assert.deepEqual(again, first);
  assert.deepEqual(first.map((s) => s.name), ['Friend']);
  at.now += 1;
  await session.servers();
  assert.equal(transport.asked.length, 2);
});

test('the discovery carries the account credential and the host\'s own identifier, never the plugin\'s', async () => {
  const transport = account();
  await linked(transport).servers();

  assert.equal(transport.asked[0].url, DISCOVER);
  assert.equal(transport.asked[0].headers['X-Plex-Token'], ACCOUNT);
  assert.equal(transport.asked[0].headers['X-Plex-Client-Identifier'], 'host-client-id');
});

test('what servers() hands over is masked by value, in case a service puts a token into a name', async () => {
  const session = linked(account({ status: 200, body: [server({ name: `Friend ${SHARED}` }), server({ name: `Mine ${ACCOUNT}`, token: 'owned-token-bbbbbbbb' })] }));

  const names = (await session.servers()).map((s) => s.name);

  assert.deepEqual(names, ['Friend yonto-held-credential', 'Mine yonto-held-credential']);
});

test('refused() after a request that carried a bound credential marks the list stale, drops nothing, and the next servers() asks again once a minute has passed', async () => {
  const transport = account();
  const at = { now: 1_700_000_000_000 };
  const session = linked(transport, { at });
  await session.servers();
  session.startCall();
  assert.notEqual(await session.bindingFor(`${BOUND}/library`), null);

  session.refused();
  await session.servers();
  assert.equal(transport.asked.length, 1, 'never more than once a minute');
  assert.equal(session.linked(), true);

  at.now += ASK_AT_MOST_EVERY_MS;
  await session.servers();
  assert.equal(transport.asked.length, 2);
});

test('refused() in a call that attached nothing marks nothing', async () => {
  const transport = account();
  const at = { now: 1_700_000_000_000 };
  const session = linked(transport, { at });
  await session.servers();
  session.startCall();

  session.refused();
  at.now += ASK_AT_MOST_EVERY_MS;
  await session.servers();

  assert.equal(transport.asked.length, 1);
});

test('a 401 to the host\'s own discovery with the credential it holds drops the session', async () => {
  const warned = [];
  const session = linked(account({ status: 401, body: '' }), { warn: (line) => warned.push(line) });

  assert.deepEqual(await session.servers(), []);
  assert.equal(session.linked(), false);
  assert.equal(await session.bindingFor(`${BOUND}/library`), null);
  assert.match(warned[0], /plex\.tv refused the session/);
});

test('a discovery that fails otherwise is REQUEST_FAILED in words with no credential in them, and drops nothing', async () => {
  const transport = account({ status: 500, body: '' });
  const session = linked(transport);

  await assert.rejects(session.servers(), (error) => error.code === Code.REQUEST_FAILED &&
    error.message === "the account's server list answered 500");
  assert.equal(session.linked(), true);
});

test('with nothing listed yet and the account asked under a minute ago, servers() says so rather than asking again', async () => {
  const transport = account({ status: 500, body: '' });
  const session = linked(transport);
  await session.servers().catch(() => null);

  await assert.rejects(session.servers(), (error) => error.code === Code.REQUEST_FAILED &&
    /asked for the account's servers less than a minute ago/.test(error.message));
  assert.equal(transport.asked.length, 1);
});

test('a session linked for a wider reach than the plugin now has is not used', async () => {
  const warned = [];
  const session = createSession({
    manifest: { ...manifest, allowedHosts: ['*.plex.direct', 'collector.example'] },
    held: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
    transport: account(),
    clientId: 'c',
    now: () => 0,
    warn: (line) => warned.push(line),
  });

  assert.equal(session.linked(), false);
  assert.deepEqual(await session.servers(), []);
  assert.match(warned[0], /narrower reach/);
});

test('a typed address asks the server who it is once, and asks again after refused()', async () => {
  const transport = account({ status: 200, body: [server({ address: '192.168.1.5' })] });
  transport.identity = { status: 200, body: { MediaContainer: { machineIdentifier: 'server-friend' } } };
  const session = linked(transport, { config: { serverUrl: 'http://192.168.1.5:32400' } });
  await session.servers();
  session.startCall();

  await session.bindingFor('http://192.168.1.5:32400/a');
  await session.bindingFor('http://192.168.1.5:32400/b');
  assert.equal(transport.asked.filter((r) => r.url.endsWith('/identity')).length, 1);
  assert.equal(transport.asked.at(-1).headers['X-Plex-Token'], undefined, 'the identity is asked without a credential');

  session.refused();
  await session.bindingFor('http://192.168.1.5:32400/c');
  assert.equal(transport.asked.filter((r) => r.url.endsWith('/identity')).length, 2);
});

test('a url field\'s default the viewer never changed binds nothing', async () => {
  const transport = account({ status: 200, body: [server({ address: '192.168.1.5' })] });
  transport.identity = { status: 200, body: { MediaContainer: { machineIdentifier: 'server-friend' } } };
  const session = createSession({
    manifest: { ...manifest, configSchema: [{ id: 'serverUrl', label: 'Server', type: 'url', default: 'http://192.168.1.5:32400' }] },
    config: { serverUrl: 'http://192.168.1.5:32400' },
    held: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
    transport,
    clientId: 'c',
    now: () => 0,
  });
  await session.servers();

  assert.equal(await session.bindingFor('http://192.168.1.5:32400/a'), null);
});

test('what --record must not write is collected as the host learns it', async () => {
  const secrets = createSecrets();
  await linked(account(), { secrets }).servers();

  assert.deepEqual(secrets.list(), [
    { value: 'host-client-id', placeholder: '<host-client-id>' },
    { value: ACCOUNT, placeholder: '<credential>' },
    { value: SHARED, placeholder: '<server-credential>' },
  ]);
});

test('the host\'s identifier is its own: stable for a plugin, apart from installId', () => {
  const pluginDir = scratchDir('lp-');
  const host = createHost({ manifest, transport: account(), storeDir: pluginDir, pluginDir });

  assert.equal(hostClientIdOf(pluginDir, manifest), hostClientIdOf(pluginDir, manifest));
  assert.notEqual(hostClientIdOf(pluginDir, manifest), host.yonto.installId());
  assert.notEqual(hostClientIdOf(pluginDir, manifest), hostClientIdOf(pluginDir, { ...manifest, id: 'other' }));
});

test('what a plugin logs or says is partial crosses into the host with every held credential redacted', async () => {
  const pluginDir = scratchDir('lp-');
  const host = createHost({
    manifest, transport: account(), hostTransport: account(), storeDir: pluginDir, pluginDir,
    session: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
  });
  host.startCall(10_000);
  await host.yonto.session.servers();

  host.yonto.log('info', `token ${ACCOUNT} and ${SHARED}`);
  host.yonto.partial(`missing ${SHARED}`);

  assert.equal(host.logs[0].message, 'token ‹credential› and ‹credential›');
  assert.equal(host.takePartial(), 'missing ‹credential›');
});

test('a refusal in a call that sent no credential marks nothing, whatever an earlier call sent', async () => {
  const pluginDir = scratchDir('lp-');
  const hostTransport = account();
  const at = { now: 1_700_000_000_000 };
  const host = createHost({
    manifest, pluginDir, storeDir: pluginDir, now: () => at.now, hostTransport,
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } },
    session: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
  });
  host.startCall(10_000);
  await host.yonto.session.servers();
  await host.yonto.fetch(`${BOUND}/library`);

  host.startCall(10_000);
  host.yonto.session.refused();
  at.now += ASK_AT_MOST_EVERY_MS;
  host.startCall(10_000);
  await host.yonto.session.servers();

  assert.equal(hostTransport.asked.length, 1);
});

test('a body in a charset that is not ASCII-compatible is masked once decoded, since its bytes spell a credential no ASCII match finds', async () => {
  const pluginDir = scratchDir('lp-');
  const host = createHost({
    manifest, pluginDir, storeDir: pluginDir, hostTransport: account(),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from(`t=${SHARED}`, 'utf16le').toString('base64') }; } },
    session: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
  });
  host.startCall(10_000);
  await host.yonto.session.servers();

  const answer = await host.yonto.fetch(`${BOUND}/utf16`, { encoding: 'utf-16le' });

  assert.equal(answer.body, 't=yonto-held-credential');
});

test('an ASCII credential read in a charset that pairs its bytes is masked as bytes first, so re-encoding the text cannot recover it', async () => {
  const pluginDir = scratchDir('lp-');
  const host = createHost({
    manifest, pluginDir, storeDir: pluginDir, hostTransport: account(),
    transport: { async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from(`tk=${SHARED}`).toString('base64') }; } },
    session: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
  });
  host.startCall(10_000);
  await host.yonto.session.servers();

  const answer = await host.yonto.fetch(`${BOUND}/ascii`, { encoding: 'utf-16le' });

  assert.equal(Buffer.from(answer.body, 'utf16le').toString('latin1'), 'tk=yonto-held-credential');
});
