import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { createHost } from '../src/host/index.js';
import { linkRecord } from '../src/link-login.js';
import { loadManifest, validateManifest } from '../src/manifest.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * A linkLogin plugin end to end on this host: what `lint` refuses, and what the plugin sees of
 * `yonto.session` and of its servers through the engine. `JsLinkLoginPluginTest` runs the
 * same plugin on the device's.
 */

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const pluginDir = (name) => fileURLToPath(new URL(`../test-plugins/${name}/`, import.meta.url));
const DIR = pluginDir('link-login');
const ACCOUNT = 'account-token-cccccccc';
const SHARED = 'shared-token-aaaaaaaa';
const BOUND = 'https://203-0-113-7.aaaa.plex.direct:32400';
const DISCOVER = 'https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1';

function lint(dir) {
  return spawnSync('node', [CLI, 'lint', dir], { encoding: 'utf8' });
}

test('lint passes a linkLogin plugin', () => {
  const run = lint(DIR);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /contract {10}21\n/);
});

test('lint refuses yonto.session on a plugin that declares no linkLogin', () => {
  const run = lint(pluginDir('session-without-link-login'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /yonto\.session\.linked is called and no linkLogin is declared/);
});

test('lint refuses a linkLogin whose plugin could reach the account', () => {
  const run = lint(pluginDir('reaches-the-account'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /allowedHosts entry \*\.plex\.tv reaches plex\.tv, where plex\.tv's account is/);
});

/** A transport answering by URL, remembering what each request carried. */
function answering(answers) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const answer = answers[req.url];
      if (answer === undefined) throw new Error(`nothing answers ${req.url}`);
      return { status: answer.status, headers: {}, bodyBase64: Buffer.from(JSON.stringify(answer.body)).toString('base64') };
    },
  };
}

function running({ session = null, answers = {} } = {}) {
  const manifest = loadManifest(DIR);
  const hostTransport = answering({
    [DISCOVER]: {
      status: 200,
      body: [{
        name: 'Friend', clientIdentifier: 'server-friend', provides: 'server', owned: false, accessToken: SHARED,
        connections: [{ uri: BOUND, address: '203.0.113.7', port: 32400, protocol: 'https', local: false, relay: false }],
      }],
    },
  });
  const transport = answering(answers);
  const host = createHost({
    manifest, transport, hostTransport, storeDir: scratchDir('lp-'), pluginDir: DIR,
    session: session && { credential: session, record: linkRecord(manifest, 0) },
  });
  return { host, transport, engine: createEngine({ dir: DIR, host, timeoutMs: 5000 }) };
}

test('a linked plugin reads its servers with no credential in them, and its request to one carries the server\'s', async () => {
  const { engine, transport } = running({
    session: ACCOUNT,
    answers: { [`${BOUND}/library/sections`]: { status: 200, body: { sections: [{ id: '1', name: 'Films' }] } } },
  });

  assert.deepEqual(await engine.call('getCategories', []), [{ id: '1', name: 'Films' }]);
  assert.equal(transport.calls[0].headers['X-Plex-Token'], SHARED);
  const state = await engine.call('sessionState', []);
  assert.equal(state.linked, true);
  assert.equal(JSON.stringify(state).includes(SHARED), false);
  assert.deepEqual(Object.keys(state.servers[0]), ['name', 'id', 'owned', 'connections']);
});

test('a server echoing its credential is masked before the plugin reads it', async () => {
  const { engine } = running({
    session: ACCOUNT,
    answers: { [`${BOUND}/echo`]: { status: 200, body: { token: SHARED, account: ACCOUNT } } },
  });
  await engine.call('sessionState', []);

  const echoed = await engine.call('echo', [`${BOUND}/echo`]);

  assert.equal(echoed.body, '{"token":"yonto-held-credential","account":"yonto-held-credential"}');
});

test('with no session the plugin reads that it is not linked, and no servers', async () => {
  const { engine } = running();

  assert.deepEqual(await engine.call('sessionState', []), { linked: false, servers: [] });
  await assert.rejects(engine.call('getCategories', []), (error) => error.code === Code.UNAUTHENTICATED);
});

test('what the plugin throws, logs or says is partial crosses into the host with every held credential redacted', async () => {
  const { engine, host } = running({ session: ACCOUNT });
  await engine.call('sessionState', []);

  await assert.rejects(engine.call('says', [`got ${SHARED} and ${ACCOUNT}`]), (error) => {
    assert.equal(error.message, 'says threw: got ‹credential› and ‹credential›');
    return true;
  });
  assert.equal(host.logs.at(-1).message, 'got ‹credential› and ‹credential›');
});

test('the schema takes a linkLogin naming a service and nothing else, and no service on any other capability', () => {
  const manifest = (capability) => ({
    kind: 'content-source', id: 'probe', name: 'Probe', version: '1.0.0', contractVersion: 21,
    provides: 'source-type', allowedHosts: [], capabilities: [capability],
  });

  assert.equal(validateManifest(manifest({ type: 'linkLogin', service: 'plex.tv' })).valid, true);
  // The second revision's endpoints and discovery paths, which a manifest no longer chooses.
  assert.equal(validateManifest(manifest({
    type: 'linkLogin', service: 'plex.tv', discover: 'https://clients.plex.tv/api/v2/resources',
  })).valid, false);
  assert.equal(validateManifest(manifest({ type: 'linkLogin', service: 'plex.tv', credentialField: 'clientIdentifier' })).valid, false);
  assert.equal(validateManifest(manifest({ type: 'linkLogin' })).valid, false);
  assert.equal(validateManifest(manifest({ type: 'linkLogin', service: 'plex.tv', url: 'https://plex.tv' })).valid, false);
  assert.equal(validateManifest(manifest({ type: 'cookieLogin', url: 'https://ddys.app', service: 'plex.tv' })).valid, false);
});
