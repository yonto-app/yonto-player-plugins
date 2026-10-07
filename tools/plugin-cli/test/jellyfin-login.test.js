import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

// kangzj/lantern-tv#88: `Dashboard > API Keys` and `Dashboard > Users` are the server
// administrator's pages, so a viewer given an account on someone else's Jellyfin could not
// obtain either and could not add the source at all. An ordinary login returns the same kind
// of credential, so this covers the path that replaces them.
//
// Scripted rather than replayed, unlike jellyfin.test.js: what matters here is what happens
// on a 401 and how many times a login is attempted, which a fixture set keyed by url+body
// cannot express.
const dir = fileURLToPath(new URL('../../../plugins/jellyfin/', import.meta.url));

const SERVER = 'https://jf.test';
const OTHER_SERVER = 'https://other-jf.test';
const TOKEN = 'token-from-login';
const USER = 'user-id-from-login';

function body(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** Answers by method and path, and records every request so a test can count logins. */
function scripted(answers) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const key = Object.keys(answers).find((k) => {
        const [method, fragment] = k.split(' ');
        return req.method === method && req.url.includes(fragment);
      });
      if (!key) return { status: 404, headers: {}, bodyBase64: body({}) };
      const answer = answers[key];
      return typeof answer === 'function' ? answer(this.calls.length) : answer;
    },
  };
}

const loginOk = { status: 200, headers: {}, bodyBase64: body({ AccessToken: TOKEN, User: { Id: USER } }) };
const viewsOk = {
  status: 200,
  headers: {},
  bodyBase64: body({ Items: [{ Id: 'lib1', Name: 'Films', CollectionType: 'movies' }] }),
};

function hostFor(config, transport) {
  const storeDir = scratchDir('lp-jellyfin-login-');
  // The manifest as it ships: `serverUrl` is a `url` field, so the configured host is what
  // the allowlist rule contributes. A test that arranged the allowlist would arrange the
  // thing it means to prove.
  const host = createHost({ manifest: loadManifest(dir), config, transport, storeDir, pluginDir: dir });
  return createEngine({ dir, host });
}

const withPassword = { serverUrl: SERVER, username: 'demo', password: 'hunter2' };

test('a username and password are exchanged for a token, and the token is what calls carry', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': viewsOk });

  const categories = await hostFor(withPassword, transport).call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id), ['lib1']);
  const [login, views] = transport.calls;
  // The login itself carries no token — there is none yet — and says who is asking, which is
  // what a viewer sees in Dashboard > Devices.
  assert.match(login.headers.Authorization, /^MediaBrowser Client="Yonto", Device=".+", DeviceId=".+", Version=".+"$/);
  assert.equal(JSON.parse(login.body).Username, 'demo');
  assert.equal(JSON.parse(login.body).Pw, 'hunter2');
  // And the call that follows carries the won token, in the one header a 12.x server reads.
  assert.equal(views.headers.Authorization, `MediaBrowser Token="${TOKEN}"`);
  // The user id comes from the server rather than from a viewer typing one.
  assert.ok(views.url.includes(USER), views.url);
});

test('the session is kept, so a second call does not log in again', async () => {
  // A login per call would be one session per call in the server's own device list.
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': viewsOk });
  const engine = hostFor(withPassword, transport);

  await engine.call('getCategories', []);
  await engine.call('getCategories', []);

  assert.equal(transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length, 1);
});

test('a revoked token logs in again and retries the call once', async () => {
  // The difference between a login and a dashboard key: removing the device in
  // Dashboard > Devices revokes the token, and that is recoverable rather than final.
  let refusals = 0;
  const transport = scripted({
    'POST AuthenticateByName': loginOk,
    'GET Views': () => (refusals++ === 0 ? { status: 401, headers: {}, bodyBase64: body({}) } : viewsOk),
  });

  const categories = await hostFor(withPassword, transport).call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id), ['lib1']);
  assert.equal(transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length, 2);
});

test('a second refusal is the account being refused, not an expired session, and stops', async () => {
  // Retrying would log in on every attempt, forever.
  const transport = scripted({
    'POST AuthenticateByName': loginOk,
    'GET Views': { status: 401, headers: {}, bodyBase64: body({}) },
  });

  await assert.rejects(() => hostFor(withPassword, transport).call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    // The server has just accepted the password twice, so checking it is the wrong advice.
    assert.equal(error.message, "Check this account's permissions on the server.");
    return true;
  });
  assert.equal(transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length, 2);
});

test('a refused API key names the key and user id, not a username nobody typed', async () => {
  const transport = scripted({ 'GET Views': { status: 401, headers: {}, bodyBase64: body({}) } });
  const withKey = { serverUrl: SERVER, apiKey: 'dashboard-key', userId: 'dashboard-user' };

  await assert.rejects(() => hostFor(withKey, transport).call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    assertSendsToSettings(error.message, /API key and user ID/);
    return true;
  });
});

test('a refused API key is named even when a username and password are saved too', async () => {
  // The key wins in `session()`, so it is the key that was refused, whatever else is filled in.
  const transport = scripted({
    'POST AuthenticateByName': loginOk,
    'GET Views': { status: 401, headers: {}, bodyBase64: body({}) },
  });
  const withBoth = { ...withPassword, apiKey: 'dashboard-key', userId: 'dashboard-user' };

  await assert.rejects(() => hostFor(withBoth, transport).call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    assertSendsToSettings(error.message, /API key and user ID/);
    return true;
  });
  assert.deepEqual(transport.calls.filter((c) => c.url.includes('AuthenticateByName')), []);
});

/** Read on the error screen and on the source's Settings row, so it says which fields to
 *  check and where they are, in one sentence (contracts/content-source-http.md). */
function assertSendsToSettings(message, fields) {
  assert.match(message, fields);
  assert.match(message, /editing the source in Settings/);
  assert.equal(message.split('. ').length, 1, `one sentence, got: ${message}`);
}

test('a refused username and password says so, rather than reading as a broken server', async () => {
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });

  await assert.rejects(() => hostFor(withPassword, transport).call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    assertSendsToSettings(error.message, /username and password/);
    return true;
  });
});

test('a login that returns no token is refused here rather than as a 401 later', async () => {
  const transport = scripted({
    'POST AuthenticateByName': { status: 200, headers: {}, bodyBase64: body({ User: { Id: USER } }) },
  });

  await assert.rejects(() => hostFor(withPassword, transport).call('getCategories', []));
});

// kangzj/lantern-tv#725: a proxy's sign-in page, a captive portal or a mistyped address
// answers 200 with HTML, and a bare JSON.parse throw reached the app with no sentence.
test('a page that is not JSON, on sign-in or on a call, points at the server URL', async () => {
  const html = { status: 200, headers: {}, bodyBase64: Buffer.from('<html>Sign in</html>').toString('base64') };
  const withKey = { serverUrl: SERVER, apiKey: 'dashboard-key', userId: 'dashboard-user' };
  const cases = [
    ['signing in', withPassword, { 'POST AuthenticateByName': html }, 'logging in'],
    ['listing libraries', withKey, { 'GET Views': html }, 'views'],
  ];
  for (const [what, config, answers, logged] of cases) {
    const host = createHost({
      manifest: loadManifest(dir),
      config,
      transport: scripted(answers),
      storeDir: scratchDir('lp-jellyfin-html-'),
      pluginDir: dir,
    });

    await assert.rejects(() => createEngine({ dir, host }).call('getCategories', []), (error) => {
      assert.equal(error.code, Code.UNAVAILABLE, what);
      assert.match(error.message, /check the server URL/, what);
      assert.ok(!error.message.includes(SERVER), error.message);
      return true;
    });
    assert.ok(
      host.logs.some((line) => line.message === `${logged} got a 2xx that is not a JSON object`),
      `${what}: ${JSON.stringify(host.logs)}`
    );
  }
});

// kangzj/lantern-tv#753: valid JSON that is not an object got past the parse and threw on the
// next line, with no sentence.
test('an answer that is JSON but not an object points at the server URL', async () => {
  const withKey = { serverUrl: SERVER, apiKey: 'dashboard-key', userId: 'dashboard-user' };
  const withBody = (text) => ({ status: 200, headers: {}, bodyBase64: Buffer.from(text).toString('base64') });
  for (const text of ['null', '[]', '"ok"', '42']) {
    for (const [what, config, answers, logged] of [
      ['signing in', withPassword, { 'POST AuthenticateByName': withBody(text) }, 'logging in'],
      ['listing libraries', withKey, { 'GET Views': withBody(text) }, 'views'],
    ]) {
      const host = createHost({
        manifest: loadManifest(dir),
        config,
        transport: scripted(answers),
        storeDir: scratchDir('lp-jellyfin-not-object-'),
        pluginDir: dir,
      });

      await assert.rejects(() => createEngine({ dir, host }).call('getCategories', []), (error) => {
        assert.equal(error.code, Code.UNAVAILABLE, `${what}: ${text}`);
        assert.match(error.message, /check the server URL/, `${what}: ${text}`);
        return true;
      });
      assert.ok(host.logs.some((line) => line.message === `${logged} got a 2xx that is not a JSON object`),
        `${what}: ${JSON.stringify(host.logs)}`);
    }
  }
});

// kangzj/lantern-tv#754: one slot meant B's refusal forgot A's, so going back to A spent
// another of the three attempts Jellyfin allows on the same wrong password.
function sharedStore(transport, prefix) {
  const storeDir = scratchDir(prefix);
  const manifest = loadManifest(dir);
  return (config) => createEngine({ dir, host: createHost({ manifest, config, transport, storeDir, pluginDir: dir }) });
}

function logins(transport) {
  return transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length;
}

test('refusals are kept for every server and username, so going back asks nobody', async () => {
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const engineWith = sharedStore(transport, 'lp-jellyfin-refusals-');
  const other = { ...withPassword, serverUrl: OTHER_SERVER };
  const someone = { ...withPassword, username: 'someone' };

  for (const config of [withPassword, other, someone, withPassword, other, someone]) {
    await assert.rejects(() => engineWith(config).call('getCategories', []), (error) => {
      assert.equal(error.code, Code.UNAUTHENTICATED);
      return true;
    });
  }

  assert.equal(logins(transport), 3);
});

test('a login that works clears only its own server and username\'s refusals', async () => {
  const transport = scripted({
    'POST other-jf.test': loginOk,
    'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) },
    'GET Views': viewsOk,
  });
  const engineWith = sharedStore(transport, 'lp-jellyfin-cleared-own-');

  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));
  await engineWith({ ...withPassword, serverUrl: OTHER_SERVER }).call('getCategories', []);
  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));

  assert.equal(logins(transport), 2, 'the first server was not asked again');
});

// The review of #819: a right password refused for another reason (a lockout the
// administrator then lifts) must not stay refused once another attempt on that account has
// been made.
test('a new refusal on a server and username replaces the last one there', async () => {
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const engineWith = sharedStore(transport, 'lp-jellyfin-replaced-');
  const attempt = (password) =>
    assert.rejects(() => engineWith({ ...withPassword, password }).call('getCategories', []));

  await attempt('right-but-locked');
  await attempt('wrong');
  await attempt('wrong');
  assert.equal(logins(transport), 2);

  await attempt('right-but-locked');
  assert.equal(logins(transport), 3, 'the earlier refusal was let go');
});

test('refusals are kept for the ten latest servers, and an older one is worth asking again', async () => {
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const engineWith = sharedStore(transport, 'lp-jellyfin-kept-');
  const attempt = (n) =>
    assert.rejects(() => engineWith({ ...withPassword, serverUrl: `https://jf-${n}.test` }).call('getCategories', []));

  for (let n = 0; n <= 10; n += 1) await attempt(n);
  assert.equal(logins(transport), 11);

  await attempt(1);
  assert.equal(logins(transport), 11, 'the tenth latest is still kept');
  await attempt(0);
  assert.equal(logins(transport), 12, 'the eleventh latest was let go');
});

// MISCONFIGURED rather than UNAUTHENTICATED since kangzj/lantern-tv#281: a profile saved
// with nothing in it has no session to renew, so "log in again from Settings" sent a viewer
// after a login that had never existed. The app words this one as the form's problem.
test('a source with no credentials at all names what to fill in', async () => {
  const transport = scripted({});

  await assert.rejects(() => hostFor({ serverUrl: SERVER }, transport).call('getCategories', []), (error) => {
    assert.equal(error.code, Code.MISCONFIGURED);
    assert.match(error.message, /username and password, or an API key/);
    return true;
  });
  assert.deepEqual(transport.calls, [], 'nothing is asked of the server without a credential');
});

test('an API key still wins, and no login is attempted', async () => {
  // An administrator's key keeps working exactly as it did — a profile already holding one
  // must not be made to log in with a password it has never been given.
  const transport = scripted({ 'GET Views': viewsOk });
  const config = { serverUrl: SERVER, apiKey: 'dashboard-key', userId: 'dashboard-user' };

  await hostFor(config, transport).call('getCategories', []);

  assert.deepEqual(transport.calls.filter((c) => c.url.includes('AuthenticateByName')), []);
  assert.equal(transport.calls[0].headers.Authorization, 'MediaBrowser Token="dashboard-key"');
  assert.ok(transport.calls[0].url.includes('dashboard-user'));
});

test('artwork is signed with a logged-in session too, and with nothing when there is no credential', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk });

  const signed = await hostFor(withPassword, transport).call('getImageHeaders', []);
  assert.equal(signed.Authorization, `MediaBrowser Token="${TOKEN}"`);

  const unsigned = await hostFor({ serverUrl: SERVER }, scripted({})).call('getImageHeaders', []);
  assert.deepEqual(unsigned, {}, 'a half-filled profile draws grey posters rather than failing to start');
});

test('a refused password is offered once, not on every call that follows', async () => {
  // The dangerous one. Five calls happen before a viewer has done anything — the status
  // probe builds an adapter and asks for artwork headers and a health check, then Home
  // builds another and does the same plus recommendations. Jellyfin's default maximum failed
  // attempts is 3 for an ordinary account, and reaching it *disables the account*, which
  // only the administrator this feature exists to avoid needing can undo.
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const engine = hostFor(withPassword, transport);

  const said = [];
  for (const method of ['getCategories', 'getCategories', 'getRecommendations']) {
    await assert.rejects(() => engine.call(method, []), (error) => said.push(error.message) > 0);
  }
  // The same sentence whether the server or this plugin refused it, since the error screen
  // and the Settings row can each be reading either one.
  assert.equal(new Set(said).size, 1, `got: ${said.join(' | ')}`);

  assert.equal(
    transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length,
    1,
    'the server is asked once; the rest are refused locally'
  );
});

test('editing the password is worth another attempt', async () => {
  // The refusal is remembered against the credential, not against the source — so a viewer
  // who fixes a typo is not locked out of their own server by this plugin.
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const storeDir = scratchDir('lp-jellyfin-retry-');
  const manifest = loadManifest(dir);

  const wrong = createHost({ manifest, config: withPassword, transport, storeDir, pluginDir: dir });
  await assert.rejects(() => createEngine({ dir, host: wrong }).call('getCategories', []));

  // Same store, as a viewer editing one profile would have — a different password.
  const fixed = createHost({
    pluginDir: dir,
    manifest, config: { ...withPassword, password: 'corrected' }, transport, storeDir,
  });
  await assert.rejects(() => createEngine({ dir, host: fixed }).call('getCategories', []));

  assert.equal(transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length, 2);
});

// kangzj/lantern-tv#736: the refusal is remembered against the server and the username as
// well as the password. A viewer who saved the wrong server and corrects only the URL must
// have the new one asked, not be told locally that the password is wrong.
test('a refusal from one server does not stop the same login being tried on another', async () => {
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const storeDir = scratchDir('lp-jellyfin-server-');
  const manifest = loadManifest(dir);
  const engineWith = (config) =>
    createEngine({ dir, host: createHost({ manifest, config, transport, storeDir, pluginDir: dir }) });
  const logins = () => transport.calls.filter((c) => c.url.includes('AuthenticateByName')).map((c) => c.url);

  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));
  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));
  assert.deepEqual(logins(), [`${SERVER}/Users/AuthenticateByName`], 'the same combination is not sent again');

  await assert.rejects(() => engineWith({ ...withPassword, serverUrl: OTHER_SERVER }).call('getCategories', []));
  assert.deepEqual(logins(), [`${SERVER}/Users/AuthenticateByName`, `${OTHER_SERVER}/Users/AuthenticateByName`]);
});

test('a refusal for one username does not stop another username being tried', async () => {
  const transport = scripted({ 'POST AuthenticateByName': { status: 401, headers: {}, bodyBase64: body({}) } });
  const storeDir = scratchDir('lp-jellyfin-username-');
  const manifest = loadManifest(dir);
  const engineWith = (config) =>
    createEngine({ dir, host: createHost({ manifest, config, transport, storeDir, pluginDir: dir }) });
  const usernames = () =>
    transport.calls.filter((c) => c.url.includes('AuthenticateByName')).map((c) => JSON.parse(c.body).Username);

  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));
  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));
  assert.deepEqual(usernames(), ['demo'], 'the same combination is not sent again');

  await assert.rejects(() => engineWith({ ...withPassword, username: 'someone' }).call('getCategories', []));
  assert.deepEqual(usernames(), ['demo', 'someone']);
});

test('a password that works clears the refusal it had before', async () => {
  let refuse = true;
  const transport = scripted({
    'POST AuthenticateByName': () => (refuse ? { status: 401, headers: {}, bodyBase64: body({}) } : loginOk),
    'GET Views': viewsOk,
  });
  const storeDir = scratchDir('lp-jellyfin-cleared-');
  const manifest = loadManifest(dir);
  const engineWith = (config) =>
    createEngine({ dir, host: createHost({ manifest, config, transport, storeDir, pluginDir: dir }) });

  await assert.rejects(() => engineWith(withPassword).call('getCategories', []));
  refuse = false;
  // A different password, so the marker does not block it; it now works.
  await engineWith({ ...withPassword, password: 'right-one' }).call('getCategories', []);
  // Another username replaces the cached session, so the next call has to log in again.
  await engineWith({ ...withPassword, username: 'demo2' }).call('getCategories', []);
  // The password refused before is asked again rather than refused here.
  await engineWith(withPassword).call('getCategories', []);

  assert.equal(logins(transport), 4);
});

test('one revoked token means one login, however many callers want one', async () => {
  // `loadHome` fans out a listing per category at once. Without coalescing a revoked token
  // meant one AuthenticateByName per category: a row each in the viewer's device list, a
  // failed attempt each against the lockout, and — since the server replaces a session per
  // device id — logins invalidating one another.
  const transport = scripted({
    'POST AuthenticateByName': loginOk,
    'GET Views': { status: 401, headers: {}, bodyBase64: body({}) },
  });
  const engine = hostFor(withPassword, transport);

  await assert.rejects(() => engine.call('getCategories', []));

  // Two: the first login, and one renewal after the 401. Not one per caller.
  assert.equal(transport.calls.filter((c) => c.url.includes('AuthenticateByName')).length, 2);
});

// Coalescing covers callers that ask while a login is in flight, not one whose 401 for the
// old token lands after the renewal finished. Forgetting on that 401 threw away the renewed
// token and logged in again, and since the server keeps one session per device id the
// first caller's retry was refused and told a viewer with full access to check the
// account's permissions.
test('a late refusal of an old token does not throw away the one that replaced it', async () => {
  let logins = 0;
  let live = null;
  let answerLateRefusal;
  const renewed = new Promise((resolve) => { answerLateRefusal = resolve; });
  let releaseRetry;
  const otherCallerDone = new Promise((resolve) => { releaseRetry = resolve; });
  const presented = (req) => (/Token="([^"]+)"/.exec(req.headers.Authorization || '') || [])[1];
  const refused = { status: 401, headers: {}, bodyBase64: body({}) };
  const itemsOk = { status: 200, headers: {}, bodyBase64: body({ Items: [{ Id: 'm1', Name: 'Film', Type: 'Movie' }] }) };

  const transport = {
    calls: [],
    async request(req) {
      this.calls.push(req);
      if (req.url.includes('AuthenticateByName')) {
        logins += 1;
        // The server keeps only the newest session for this device id.
        live = `TOKEN-${logins}`;
        return { status: 200, headers: {}, bodyBase64: body({ AccessToken: live, User: { Id: USER } }) };
      }
      const token = presented(req);
      // The listing's 401 for the revoked token arrives only once the other call has renewed
      // and is retrying, and that retry is answered only after the listing has finished.
      if (req.url.includes('/Items') && token === 'TOKEN-1') await renewed;
      if (req.url.includes('/Views') && logins > 1) {
        answerLateRefusal();
        await otherCallerDone;
      }
      if (token !== live) return refused;
      return req.url.includes('/Views') ? viewsOk : itemsOk;
    },
  };
  const engine = hostFor(withPassword, transport);
  await engine.call('getCategories', []);
  // Dashboard > Devices: the session is removed, and nothing is live until the next login.
  live = null;

  const listing = engine.call('getMediaList', ['lib1', {}]).finally(releaseRetry);
  const [categories, media] = await Promise.all([engine.call('getCategories', []), listing]);

  assert.deepEqual(categories.map((c) => c.id), ['lib1']);
  assert.deepEqual(media.map((m) => m.id), ['m1']);
  assert.equal(logins, 2, 'the first login, and one renewal shared by both callers');
});

test('an API key with no user id says which field is missing', async () => {
  // `userId` cannot be `required` in the manifest — a viewer logging in has none to type —
  // so the plugin asks. Without this the empty id became an empty path segment,
  // `/Users//Views`, and came back as "couldn't find that".
  //
  // MISCONFIGURED rather than UNAUTHENTICATED since kangzj/lantern-tv#281. Nothing has
  // expired and there is no login to go back to: the field they left blank is on the form
  // they just left, and the screen used to send them to a sign-in that does not exist.
  const transport = scripted({ 'GET Views': viewsOk });

  await assert.rejects(
    () => hostFor({ serverUrl: SERVER, apiKey: 'dashboard-key' }, transport).call('getCategories', []),
    (error) => {
      assert.equal(error.code, Code.MISCONFIGURED);
      assert.match(error.message, /API key but no user ID/);
      return true;
    }
  );
  assert.deepEqual(transport.calls, [], 'nothing is asked of the server with half a credential');
});

// Two televisions being two devices is a property of the *host*, not of this plugin, since
// kangzj/lantern-tv#134: the plugin asks `yonto.installId()` and sends what it is given.
// The device host proves it in `InstallIdentityTest` — where two installs can actually be
// constructed — and this host cannot, because two of its hosts over one checkout are one
// install by definition. What is left to prove here is what the plugin does with the
// answer, which is send it and not invent one.
test('the device a login announces is the one the host named', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': viewsOk });
  const engine = hostFor(withPassword, transport);

  await engine.call('getCategories', []);

  const announced = /DeviceId="([^"]+)"/.exec(transport.calls[0].headers.Authorization)[1];
  // Asked of a host rather than recomputed here: a test that hashes the same inputs the
  // host hashes is two copies of one derivation, and the day one moves the other agrees
  // with a value nothing produces.
  const { yonto } = createHost({
    manifest: loadManifest(dir),
    config: withPassword,
    transport: scripted({}),
    storeDir: scratchDir('lp-jellyfin-device-'),
    pluginDir: dir,
  });
  assert.equal(announced, `lantern-${yonto.installId()}`, 'the plugin must send the host id rather than mint one');
});

test('a device id is kept, so logging in again replaces the session rather than adding one', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': viewsOk });
  const storeDir = scratchDir('lp-jellyfin-device-');
  const manifest = loadManifest(dir);
  const engineWith = () =>
    createEngine({ dir, host: createHost({ manifest, config: withPassword, transport, storeDir, pluginDir: dir }) });

  await engineWith().call('getCategories', []);
  // A second runtime over the same store: a fresh id each time would leave a row behind on
  // the server for every login.
  await engineWith().call('getCategories', []);

  const ids = transport.calls
    .filter((c) => c.url.includes('AuthenticateByName'))
    .map((c) => /DeviceId="([^"]+)"/.exec(c.headers.Authorization)[1]);
  assert.equal(new Set(ids).size, 1, ids.join(' vs '));
});

// The two facts kangzj/lantern-tv#133's host-side fix rests on. They belong here rather
// than beside that fix, because they are claims about *this plugin* — a host that re-signs
// on a refusal and retries only when the answer changed is reasoning about what these two
// tests pin, and the first version of that fix was written against an assumption instead.
test('asking again wins nothing on its own: a session is renewed by a call, not by asking', async () => {
  let logins = 0;
  const transport = scripted({
    'POST AuthenticateByName': () => {
      logins += 1;
      return { status: 200, headers: {}, bodyBase64: body({ AccessToken: `TOKEN-${logins}`, User: { Id: USER } }) };
    },
  });
  const engine = hostFor(withPassword, transport);

  const first = await engine.call('getImageHeaders', []);
  const second = await engine.call('getImageHeaders', []);

  // `getImageHeaders` awaits `session()`, which answers from the store whenever the server
  // and the username still match — and a revoked token matches both, because revocation is
  // a server-side fact this plugin cannot observe.
  assert.deepEqual(first, second);
  assert.equal(logins, 1);
});

test('a call that met a refusal renews the session, and artwork asked afterwards gets it', async () => {
  let logins = 0;
  let revoked = false;
  const transport = scripted({
    'POST AuthenticateByName': () => {
      logins += 1;
      return { status: 200, headers: {}, bodyBase64: body({ AccessToken: `TOKEN-${logins}`, User: { Id: USER } }) };
    },
    'GET Views': (_, req) => req,
  });
  // Scripted by hand rather than by path: what matters is which token was presented.
  transport.request = async function (req) {
    this.calls.push(req);
    if (req.url.includes('AuthenticateByName')) {
      logins += 1;
      return { status: 200, headers: {}, bodyBase64: body({ AccessToken: `TOKEN-${logins}`, User: { Id: USER } }) };
    }
    if (revoked && (req.headers.Authorization || '').includes('TOKEN-1')) {
      return { status: 401, headers: {}, bodyBase64: body({}) };
    }
    return viewsOk;
  };
  const engine = hostFor(withPassword, transport);

  const atStart = await engine.call('getImageHeaders', []);
  revoked = true;
  await engine.call('getCategories', []);
  const afterListing = await engine.call('getImageHeaders', []);

  assert.notDeepEqual(atStart, afterListing, 'the listing renewed the session and artwork should see it');
  assert.equal(logins, 2, 'one login at the start and one when the gate met the refusal');
});

// The half those two leave open, and what #136 adds: being *told* is what makes the next
// ask win something. Asking alone is pinned above as winning nothing.
test('a refused artwork credential is forgotten when the host says so, and the next ask is fresh', async () => {
  let logins = 0;
  const transport = scripted({
    'POST AuthenticateByName': () => {
      logins += 1;
      return { status: 200, headers: {}, bodyBase64: body({ AccessToken: `TOKEN-${logins}`, User: { Id: USER } }) };
    },
  });
  const engine = hostFor(withPassword, transport);

  const first = await engine.call('getImageHeaders', []);
  assert.equal(await engine.call('getImageHeaders', []).then((h) => h.Authorization), first.Authorization);
  assert.equal(logins, 1, 'asking again reuses the session, which is what makes telling necessary');

  // Handed the header that was refused, which is what the host passes.
  assert.deepEqual(await engine.call('onImageHeadersRefused', [first]), { renewable: true });

  const afterTelling = await engine.call('getImageHeaders', []);
  assert.notDeepEqual(afterTelling, first);
  assert.equal(logins, 2);
});

// The case being told exists to protect. A call that met a 401 has already logged in and
// stored a live session; forgetting it would throw away the token the rest of the app is
// carrying and win another — and this server replaces a session per device id, so that
// login invalidates the one in flight.
test('a session already renewed by an ordinary call is not thrown away by being told', async () => {
  let logins = 0;
  const transport = scripted({
    'POST AuthenticateByName': () => {
      logins += 1;
      return { status: 200, headers: {}, bodyBase64: body({ AccessToken: `TOKEN-${logins}`, User: { Id: USER } }) };
    },
  });
  const engine = hostFor(withPassword, transport);

  const signedAtStart = await engine.call('getImageHeaders', []);
  await engine.call('onImageHeadersRefused', [signedAtStart]);
  const renewedByTelling = await engine.call('getImageHeaders', []);
  assert.equal(logins, 2, 'the stale one is forgotten, which is the whole point');

  // Now tell it about the *old* header again, as a poster signed before the renewal would.
  assert.deepEqual(await engine.call('onImageHeadersRefused', [signedAtStart]), { renewable: true });

  assert.deepEqual(await engine.call('getImageHeaders', []), renewedByTelling);
  assert.equal(logins, 2, 'it already held something newer, so there was nothing to forget');
});

test('an api key says it cannot be renewed, so the host stops rather than spending an attempt', async () => {
  // Only the server's owner can replace a dashboard key. A host that kept asking would be
  // asking a plugin to change something it has no way to change.
  const transport = scripted({});
  const withKey = { serverUrl: SERVER, apiKey: 'dashboard-key', userId: 'dashboard-user' };

  assert.deepEqual(
    await hostFor(withKey, transport).call('onImageHeadersRefused', []),
    { renewable: false },
  );
  assert.deepEqual(transport.calls.filter((c) => c.url.includes('AuthenticateByName')), []);
});
