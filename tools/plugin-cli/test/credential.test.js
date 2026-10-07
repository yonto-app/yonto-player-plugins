import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host/index.js';
import { createFetch } from '../src/host/fetch.js';
import { cookieFor, undrivenLoginWarnings } from '../src/host/credential.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * The session the host holds, and where it is allowed to go — kangzj/lantern-tv#163.
 *
 * `core/src/androidHostTest/.../JsHostCredentialTest.kt` asserts the same rules through the other
 * host. Both hosts attach it the same way or a plugin that passes `doctor` is logged out
 * on a television, which is the one failure this file exists to make impossible.
 */

function fakeTransport(body = 'hello') {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      return { status: 200, headers: {}, bodyBase64: Buffer.from(body, 'utf8').toString('base64') };
    },
  };
}

/** A response that re-issues the session, which is what an auth refresh looks like. */
function reissuingTransport() {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      return {
        status: 200,
        headers: {},
        bodyBase64: Buffer.from('ok', 'utf8').toString('base64'),
        setCookie: ['gate=THE-REAL-SESSION; Path=/; HttpOnly', 'other=1'],
      };
    },
  };
}

function hostsOf(fromManifest, fromViewer = []) {
  return { fromManifest, fromViewer, fromRepo: [], floorExempt: fromViewer, all: [...fromManifest, ...fromViewer] };
}

const LOGIN = { type: 'cookieLogin', url: 'https://site.test/login', cookieName: 'gate' };

function fetchWith(transport, { credential, hosts = hostsOf(['site.test']), login = LOGIN } = {}) {
  return createFetch({ hosts, transport, requests: [], login, credential: () => credential });
}

test('the session is attached to the site the capability names', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, { credential: 'sid=abc; extra=1' })('https://site.test/page');

  assert.equal(transport.calls[0].headers.Cookie, 'sid=abc; extra=1');
});

test('a bare value is sent under the name the capability declared', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, { credential: 'abc' })('https://site.test/page');

  assert.equal(transport.calls[0].headers.Cookie, 'gate=abc');
});

test('no session, no header', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, { credential: null })('https://site.test/page');

  assert.equal(transport.calls[0].headers.Cookie, undefined);
});

test('another host this plugin may reach is not the capability\'s, and gets nothing', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, {
    credential: 'sid=abc',
    hosts: hostsOf(['site.test', 'other.test']),
  })('https://other.test/collect');

  assert.equal(transport.calls[0].headers.Cookie, undefined);
});

test('a redirect off the capability\'s site does not carry the session with it', async () => {
  const transport = {
    calls: [],
    async request(req) {
      this.calls.push(req);
      return this.calls.length === 1
        ? { status: 302, headers: { location: 'https://other.test/collect' }, bodyBase64: '' }
        : { status: 200, headers: {}, bodyBase64: '' };
    },
  };

  await fetchWith(transport, {
    credential: 'sid=abc',
    hosts: hostsOf(['site.test', 'other.test']),
  })('https://site.test/page');

  assert.deepEqual(transport.calls.map((c) => c.headers.Cookie), ['sid=abc', undefined]);
});

test('the capability\'s scheme is part of where the session may go', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, { credential: 'sid=abc' })('http://site.test/page');

  assert.equal(transport.calls[0].headers.Cookie, undefined);
});

test('a plugin cannot overwrite the session with a Cookie of its own', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, { credential: 'sid=abc' })('https://site.test/page', {
    headers: { cookie: 'sid=mine' },
  });

  const sent = Object.entries(transport.calls[0].headers)
    .filter(([name]) => name.toLowerCase() === 'cookie');
  assert.deepEqual(sent, [['Cookie', 'sid=abc']]);
});

test('a plugin declaring no login is never handed one', async () => {
  const transport = fakeTransport();

  await fetchWith(transport, { credential: 'sid=abc', login: null })('https://site.test/page');

  assert.equal(transport.calls[0].headers.Cookie, undefined);
});

test('a bare value with no cookieName to put it under is not guessed at', async () => {
  assert.equal(cookieFor({ type: 'cookieLogin', url: 'https://site.test/' }, 'https://site.test/p', 'abc'), null);
});

test('the host reads the login out of the manifest and attaches what it was given', async () => {
  // The wiring, not the rule: a `createHost` that took a credential and never passed it to
  // `yonto.fetch` would leave every test above green and every plugin logged out.
  const transport = fakeTransport();
  const { yonto, startCall } = createHost({
    manifest: { id: 'demo', allowedHosts: ['site.test'], capabilities: [LOGIN] },
    transport,
    storeDir: scratchDir('lp-cred-'),
    pluginDir: '/probe/plugin',
    credential: 'sid=abc',
  });
  // A call has to be announced before a host starts anything: that is what gives it a
  // deadline as well as a sleep budget (kangzj/lantern-tv#178).
  startCall(60_000);

  await yonto.fetch('https://site.test/page');

  assert.equal(transport.calls[0].headers.Cookie, 'sid=abc');
});

test('a host given no credential attaches nothing, however the plugin asks', async () => {
  const transport = fakeTransport();
  const { yonto, startCall } = createHost({
    manifest: { id: 'demo', allowedHosts: ['site.test'], capabilities: [LOGIN] },
    transport,
    storeDir: scratchDir('lp-cred-'),
    pluginDir: '/probe/plugin',
  });
  startCall(60_000);

  await yonto.fetch('https://site.test/page', { headers: { Cookie: 'sid=mine' } });

  assert.equal(transport.calls[0].headers.Cookie, 'sid=mine');
});

/**
 * The session goes out and does not come back.
 *
 * Attaching the credential on the way out while handing `Set-Cookie` back on the way in is
 * the same credential in the plugin's hands one call later: a site that re-issues its
 * session on an authenticated response would give the plugin the thing this design exists
 * to keep from it (kangzj/lantern-tv#189).
 */
test('the session is not handed back in Set-Cookie on the site it belongs to', async () => {
  const transport = reissuingTransport();

  const res = await fetchWith(transport, { credential: 'gate=THE-REAL-SESSION' })('https://site.test/page');

  // Empty rather than absent: the contract promises an array.
  assert.deepEqual(res.setCookie, []);
  // And it really was sent, so this is a withheld answer rather than a request that never
  // carried one.
  assert.equal(transport.calls[0].headers.Cookie, 'gate=THE-REAL-SESSION');
});

test('another site\'s Set-Cookie still reaches the plugin', async () => {
  const transport = reissuingTransport();

  const res = await fetchWith(transport, {
    credential: 'gate=THE-REAL-SESSION',
    hosts: hostsOf(['other.test']),
  })('https://other.test/page');

  assert.deepEqual(res.setCookie, ['gate=THE-REAL-SESSION; Path=/; HttpOnly', 'other=1']);
});

/**
 * Withheld by site, not by whether a session happened to be attached: a logged-out request
 * and a logged-in one to the same host have to come back the same shape, or the difference
 * tells the plugin whether a session exists.
 */
test('the site\'s Set-Cookie is withheld even when there is no session to protect', async () => {
  const transport = reissuingTransport();

  const res = await fetchWith(transport, { credential: null })('https://site.test/page');

  assert.deepEqual(res.setCookie, []);
  assert.equal(transport.calls[0].headers.Cookie, undefined);
});

// kangzj/lantern-tv#340: a login no host drives lints green and is never offered on a television.
test('a cookieLogin on a page a host drives draws no warning', () => {
  const manifest = { capabilities: [{ type: 'cookieLogin', url: 'https://ddys.app/', cookieName: 's' }] };

  assert.deepEqual(undrivenLoginWarnings(manifest), []);
});

test('a cookieLogin anywhere else is warned about, naming the pages a host does drive', () => {
  const manifest = { capabilities: [
    { type: 'cookieLogin', url: 'https://other.example/login' },
    { type: 'cookieLogin', url: 'http://ddys.app/' },
  ] };

  assert.deepEqual(undrivenLoginWarnings(manifest), [
    'cookieLogin at https://other.example/login will never be offered to a viewer: a host drives a ' +
      'cookieLogin at https://ddys.app and nowhere else (contracts/driven-logins.json)',
    'cookieLogin at http://ddys.app/ will never be offered to a viewer: a host drives a ' +
      'cookieLogin at https://ddys.app and nowhere else (contracts/driven-logins.json)',
  ]);
});

test('a cookieLogin naming no page is warned about, since no page means no login to offer', () => {
  assert.deepEqual(undrivenLoginWarnings({ capabilities: [{ type: 'cookieLogin', cookieName: 's' }] }), [
    'cookieLogin with no url will never be offered to a viewer: a host drives a cookieLogin at ' +
      'https://ddys.app and nowhere else (contracts/driven-logins.json)',
  ]);
});

test('a manifest with no capabilities draws no warning', () => {
  assert.deepEqual(undrivenLoginWarnings({}), []);
});

test('a linkLogin draws no page warning: its service is held to the registry, and refused rather than warned about', () => {
  assert.deepEqual(undrivenLoginWarnings({ capabilities: [{ type: 'linkLogin', service: 'plex.tv' }] }), []);
});
