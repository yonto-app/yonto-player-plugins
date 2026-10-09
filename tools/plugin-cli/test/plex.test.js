import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createEngine } from '../src/engines/quickjs.js';
import { linkRecord } from '../src/link-login.js';
import { scratchDir } from '../src/scratch-dir.js';

// The fixtures are recorded from a real Plex Media Server (plugins/plex/AGENTS.md says which),
// so the replayed tests hold the plugin to answers a server really gave. What a recording
// cannot hold — a refused token, a hub this library has nothing in — is scripted below.
const dir = fileURLToPath(new URL('../../../plugins/plex/', import.meta.url));
const RECORDED = JSON.parse(readFileSync(join(dir, 'doctor.json'), 'utf8'));
const TOKEN = 'fixture-plex-token';
const MOVIE_ID = '1';
const SHOW_ID = '3';

function engineOver(transport, config) {
  const storeDir = scratchDir('lp-plex-');
  // The manifest as it ships: `serverUrl` is a `url` field, so the typed host is what the
  // allowlist rule contributes.
  const host = createHost({ pluginDir: dir, manifest: loadManifest(dir), config, transport, storeDir });
  return { engine: createEngine({ dir, host }), requests: host.requests, logs: host.logs };
}

function replayed(config = RECORDED) {
  return engineOver(createReplayTransport({ dir: join(dir, 'fixtures') }), config);
}

function body(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function answering(status, value) {
  return engineOver({
    async request() {
      return { status, headers: {}, bodyBase64: body(value) };
    },
  }, { ...RECORDED, token: TOKEN });
}

test('only movie and show libraries become categories', async () => {
  const categories = await replayed().engine.call('getCategories', []);

  assert.deepEqual(categories, [{ id: '1', name: 'Movies' }, { id: '2', name: 'TV Shows' }]);
});

test('a listing pages with the container start and size', async () => {
  const { engine, requests } = replayed();
  await engine.call('getMediaList', ['1', { page: 2 }]);

  assert.ok(requests[0].url.includes('X-Plex-Container-Start=60'), requests[0].url);
  assert.ok(requests[0].url.includes('X-Plex-Container-Size=60'), requests[0].url);
});

test('a movie is a summary with its artwork resized by the server', async () => {
  const items = await replayed().engine.call('getMediaList', ['1', { page: 1 }]);

  const bunny = items.find((item) => item.id === MOVIE_ID);
  assert.equal(bunny.title, 'Big Buck Bunny');
  assert.equal(bunny.type, 'MOVIE');
  assert.equal(bunny.year, '2008');
  assert.match(bunny.posterUrl, /\/photo\/:\/transcode\?url=%2Flibrary%2Fmetadata%2F1%2Fthumb%2F\d+&width=480&height=720/);
  assert.match(bunny.backdropUrl, /url=%2Flibrary%2Fmetadata%2F1%2Fart%2F\d+&width=1920&height=1080/);
});

test('a show lists as a series', async () => {
  const items = await replayed().engine.call('getMediaList', ['2', { page: 1 }]);

  assert.deepEqual(items.map((item) => [item.id, item.type]), [[SHOW_ID, 'SERIES']]);
});

test('a movie plays its part directly', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [MOVIE_ID]);

  assert.deepEqual(detail.genres, ['Animation', 'Comedy', 'Family', 'Short']);
  assert.ok(detail.synopsis.startsWith('In the thick and undisturbed forest'));
  assert.equal(detail.playbackOptions.length, 1);
  assert.equal(detail.playbackOptions[0].label, 'Play');
  assert.match(detail.playbackOptions[0].stream.url, /^http:\/\/localhost:18400\/library\/parts\/1\/\d+\/file\.mp4$/);
  // Without a type the app reads a file as an HLS playlist.
  assert.equal(detail.playbackOptions[0].stream.mimeType, 'video/mp4');
});

test('a file names its container, so the player never takes it for a playlist', async () => {
  const { engine } = answering(200, {
    MediaContainer: {
      Metadata: [{
        ratingKey: 9,
        type: 'movie',
        title: 'Two versions',
        Media: [
          { videoResolution: '1080', container: 'mkv', Part: [{ key: '/library/parts/9/1/file.mkv' }] },
          { videoResolution: 'sd', container: 'avi', Part: [{ key: '/library/parts/10/1/file.avi' }] },
        ],
      }],
    },
  });

  const detail = await engine.call('getMediaDetail', ['9']);

  assert.deepEqual(detail.playbackOptions.map((o) => [o.label, o.stream.mimeType]),
    [['Play 1080', 'video/x-matroska'], ['Play sd', 'video/mp4']]);
});

test('a show becomes one option per episode, labelled and seasoned', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [SHOW_ID]);

  assert.equal(detail.type, 'SERIES');
  assert.deepEqual(detail.playbackOptions.map((o) => o.label), ['S1E01 · Episode 1', 'S1E02 · Episode 2']);
  assert.deepEqual(detail.playbackOptions.map((o) => o.season), [1, 1]);
  assert.match(detail.playbackOptions[1].stream.url, /\/library\/parts\/4\/\d+\/file\.mp4$/);
});

test('the token travels as a header, never in a url', async () => {
  const { engine, requests } = replayed({ ...RECORDED, token: TOKEN });
  const detail = await engine.call('getMediaDetail', [MOVIE_ID]);

  assert.equal(requests[0].requestHeaders['X-Plex-Token'], TOKEN);
  assert.ok(!requests[0].url.includes(TOKEN));
  assert.deepEqual(detail.playbackOptions[0].stream.headers, { 'X-Plex-Token': TOKEN });
  assert.ok(!detail.playbackOptions[0].stream.url.includes(TOKEN));
  assert.ok(!detail.posterUrl.includes(TOKEN));
  assert.deepEqual(await engine.call('getImageHeaders', []), { 'X-Plex-Token': TOKEN });
});

test('with no token nothing is signed and no header is sent', async () => {
  const { engine, requests } = replayed();
  const detail = await engine.call('getMediaDetail', [MOVIE_ID]);

  assert.equal(requests[0].requestHeaders['X-Plex-Token'], undefined);
  assert.equal(detail.playbackOptions[0].stream.headers, undefined);
  assert.deepEqual(await engine.call('getImageHeaders', []), {});
});

test('search keeps the movie and show hubs', async () => {
  const { engine } = answering(200, {
    MediaContainer: {
      Hub: [
        { type: 'movie', Metadata: [{ ratingKey: 1, type: 'movie', title: 'Big Buck Bunny' }] },
        { type: 'episode', Metadata: [{ ratingKey: 5, type: 'episode', title: 'Episode 1' }] },
        { type: 'show', Metadata: [{ ratingKey: 3, type: 'show', title: 'Blender Shorts' }] },
        { type: 'artist', size: 0 },
      ],
    },
  });

  const found = await engine.call('search', ['b']);

  assert.deepEqual(found.map((item) => [item.id, item.type]), [['1', 'MOVIE'], ['3', 'SERIES']]);
});

test('a refused token says to check it, a missing one says to add one, and neither offers the plex.tv sign-in', async () => {
  const refused = await answering(401, {}).engine.call('getCategories', []).catch((error) => error);
  const wanted = await engineOver({
    async request() {
      return { status: 401, headers: {}, bodyBase64: body({}) };
    },
  }, RECORDED).engine.call('getCategories', []).catch((error) => error);

  assert.equal(refused.code, 'UNAUTHENTICATED');
  assert.equal(wanted.code, 'UNAUTHENTICATED');
  assert.match(refused.message, /refused the token/);
  assert.match(wanted.message, /asks for a Plex token/);
  assert.equal(refused.signIn, false);
  assert.equal(wanted.signIn, false);
});

test('a server error rests the source, and a missing title is not found', async () => {
  const broken = await answering(500, {}).engine.call('getCategories', []).catch((error) => error);
  const gone = await answering(404, {}).engine.call('getMediaDetail', ['99']).catch((error) => error);

  assert.equal(broken.code, 'UNREACHABLE');
  assert.equal(gone.code, 'NOT_FOUND');
});

test('an answer that is not a Plex container is unavailable, not a crash', async () => {
  const error = await answering(200, { hello: 'world' }).engine.call('getCategories', []).catch((e) => e);

  assert.equal(error.code, 'UNAVAILABLE');
});

// The part key is the server's string, joined straight onto the typed address, and the
// stream carries the token wherever its URL points.
test('a part key that is not a path on the typed server plays nothing', async () => {
  const hostile = ['@evil.example/x', '//evil.example/x', '/\\evil.example/x', 'http://evil.example/x', 'x', 42];
  const { engine } = answering(200, {
    MediaContainer: {
      Metadata: [{
        ratingKey: 9,
        type: 'movie',
        title: 'Versions',
        Media: [...hostile, '/library/parts/9/1/file.mp4'].map((key, i) => (
          { videoResolution: `v${i}`, container: 'mp4', Part: [{ key }] })),
      }],
    },
  });

  const detail = await engine.call('getMediaDetail', ['9']);

  assert.deepEqual(detail.playbackOptions.map((o) => o.stream.url), [`${RECORDED.serverUrl}/library/parts/9/1/file.mp4`]);
});

test('an episode whose part points off the server is left out, and a title with nothing else is unplayable', async () => {
  const episodes = (key) => answering(200, {
    MediaContainer: {
      Metadata: [
        { ratingKey: 3, type: 'show', title: 'Show', parentIndex: 1, index: 1, Media: [{ Part: [{ key }] }] },
      ],
    },
  });

  const error = await episodes('@evil.example/x').engine.call('getMediaDetail', ['3']).catch((e) => e);

  assert.equal(error.code, 'UNAVAILABLE');
});

test('a 403 is a refused token too, not an outage', async () => {
  const error = await answering(403, {}).engine.call('getCategories', []).catch((e) => e);

  assert.equal(error.code, 'UNAUTHENTICATED');
  assert.match(error.message, /refused the token/);
  assert.equal(error.signIn, false);
});

test('a refused poster is not renewable, since only the viewer can replace a typed token', async () => {
  const answer = await replayed({ ...RECORDED, token: TOKEN }).engine
    .call('onImageHeadersRefused', [{ 'X-Plex-Token': TOKEN }]);

  assert.deepEqual(answer, { renewable: false });
});

// A television keeps the plugin log in release builds, so it must never hold the server's
// address, a path, what was searched for, or the token.
test('no log line names the server, a path, the search or the token', async () => {
  // A transport that throws is a fetch that failed, and on the CLI its message is the
  // method and URL: the one failure whose own text would leak if it were logged.
  const refusing = {
    async request(req) {
      throw new Error(`${req.method} ${req.url} — connection refused`);
    },
  };
  const lines = [];
  for (const [engineAndLogs, method, args] of [
    [answering(401, {}), 'getCategories', []],
    [answering(403, {}), 'getMediaDetail', ['1']],
    [answering(500, {}), 'getMediaList', ['1', { page: 1 }]],
    [answering(200, { hello: 'world' }), 'search', ['secret-query']],
    [answering(200, { MediaContainer: { Metadata: [{ ratingKey: 1, type: 'movie', title: 'x', Media: [] }] } }), 'getMediaDetail', ['1']],
    [engineOver(refusing, { ...RECORDED, token: TOKEN }), 'search', ['secret-query']],
  ]) {
    const { engine, logs } = engineAndLogs;
    await engine.call(method, args).catch(() => {});
    lines.push(...logs.map((line) => line.message));
  }

  assert.ok(lines.length >= 6, `expected every failure to log, got ${JSON.stringify(lines)}`);
  for (const line of lines) {
    for (const leak of ['localhost', '18400', '/library', '/hubs', 'secret-query', TOKEN]) {
      assert.ok(!line.includes(leak), `${JSON.stringify(line)} carries ${leak}`);
    }
  }
});

// Signed in with a code. No Plex account exists, so the account's server list is
// plugins/plex/fixtures/linked/resources.json, written by hand and saying so; each shared
// server answers with the typed server's recordings, replayed under its own address.
const DISCOVER = 'https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1';
const RESOURCES = JSON.parse(readFileSync(join(dir, 'fixtures', 'linked', 'resources.json'), 'utf8')).body;
const ACCOUNT = 'account-token-eeeeeeee';
const FRIEND = { id: 'server-friend', token: 'friend-token-aaaaaaaa' };
const NEIGHBOUR = { id: 'server-neighbour', token: 'neighbour-token-bbbbbbbb' };
const FRIEND_LOCAL = 'https://192-168-1-5.aaaa.plex.direct:32400';
const FRIEND_REMOTE = 'https://203-0-113-7.aaaa.plex.direct:32400';
const FRIEND_RELAY = 'https://198-51-100-2.aaaa.plex.direct:8443';
const NEIGHBOUR_REMOTE = 'https://203-0-113-9.bbbb.plex.direct:32400';
const ACCOUNT_HOSTS = /^https?:\/\/([^/]*\.)?plex\.tv(:|\/|$)/i;

const baseOf = (url) => url.match(/^https?:\/\/[^/]+/)[0];

// Past the plugin's one-second relay grace, so the relay has won before a hanging probe gives up.
const HANG_MS = 2000;

/**
 * A linked Plex. [dead] is the connections refused at once, [hanging] those that never answer, so
 * fail at a connect timeout scaled to [HANG_MS] (a call waits for every request it made), and
 * [slow] those that answer after so many milliseconds, [broken] those answering 503 to everything,
 * [answers] a status per server base where it is not the recording (its probes answer as usual), [resources] the account's
 * answer, and [clock] the host's. `servers.calls` is what the plugin asked for and
 * `servers.probes` its `/identity` probes, each with the time it was asked `at`.
 */
function linked({
  config = {}, dead = [], hanging = [], slow = {}, broken = [], answers = {}, resources = RESOURCES, accountDown = false, subSource = null, clock = { now: 1_700_000_000_000 },
} = {}) {
  const replay = createReplayTransport({ dir: join(dir, 'fixtures') });
  const account = {
    calls: [],
    async request(req) {
      this.calls.push(req);
      if (req.url !== DISCOVER) throw new Error(`the host asked ${req.url}`);
      if (accountDown) throw new Error('plex.tv did not answer');
      return { status: 200, headers: {}, bodyBase64: body(resources) };
    },
  };
  const servers = {
    calls: [],
    probes: [],
    async request(req) {
      const base = baseOf(req.url);
      const probe = req.url === `${base}/identity`;
      (probe ? this.probes : this.calls).push({ ...req, at: Date.now() });
      if (hanging.includes(base)) {
        await new Promise((resolve) => { setTimeout(resolve, HANG_MS); });
        throw new Error('connect timed out');
      }
      if (slow[base]) await new Promise((resolve) => { setTimeout(resolve, slow[base]); });
      if (dead.includes(base)) throw new Error('connection refused');
      if (broken.includes(base)) return { status: 503, headers: {}, bodyBase64: body({}) };
      if (answers[base] !== undefined && !probe) return { status: answers[base], headers: {}, bodyBase64: body({}) };
      if (probe) return { status: 200, headers: {}, bodyBase64: body({ MediaContainer: { machineIdentifier: 'x' } }) };
      return replay.request({ ...req, url: `${RECORDED.serverUrl}${req.url.slice(base.length)}` });
    },
  };
  const manifest = loadManifest(dir);
  const host = createHost({
    pluginDir: dir, manifest, config, transport: servers, hostTransport: account, subSource, now: () => clock.now,
    storeDir: scratchDir('lp-plex-'), session: { credential: ACCOUNT, record: linkRecord(manifest, 0) },
  });
  return { engine: createEngine({ dir, host }), servers, account, clock, logs: host.logs };
}

function signedOut(config = {}) {
  const asked = [];
  const nothing = { async request(req) { asked.push(req); throw new Error(`asked ${req.url}`); } };
  const host = createHost({
    pluginDir: dir, manifest: loadManifest(dir), config, transport: nothing, hostTransport: nothing,
    storeDir: scratchDir('lp-plex-'),
  });
  return { engine: createEngine({ dir, host }), asked, logs: host.logs };
}

test('signed out with no typed server, every call says to log in and asks nothing', async () => {
  const { engine, asked } = signedOut({ token: TOKEN });

  for (const [method, args] of [
    ['getSubSources', []], ['getCategories', []], ['getMediaList', ['1', { page: 1 }]],
    ['getMediaDetail', ['server-friend|1']], ['search', ['bunny']],
  ]) {
    const error = await engine.call(method, args).catch((e) => e);
    assert.equal(error.code, 'UNAUTHENTICATED', method);
    assert.match(error.message, /Log in/, method);
    assert.equal(error.signIn, true, method);
  }
  assert.deepEqual(asked, []);
});

test('signed in, a typed server refusing its token leaves the plex.tv sign-in offered, since the host may have bound its credential there', async () => {
  const { engine } = linked({ config: { ...RECORDED, token: TOKEN }, answers: { [baseOf(RECORDED.serverUrl)]: 401 } });

  const error = await engine.call('getCategories', []).catch((e) => e);

  assert.equal(error.code, 'UNAUTHENTICATED');
  assert.match(error.message, /refused the token/);
  assert.equal(error.signIn, true);
});

test('the typed catalog is read as it always was, with the session never asked', async () => {
  const { engine, servers, account } = linked({ config: { ...RECORDED, token: TOKEN } });

  const categories = await engine.call('getCategories', []);
  const detail = await engine.call('getMediaDetail', [MOVIE_ID]);

  assert.deepEqual(categories.map((c) => c.id), ['1', '2']);
  assert.equal(detail.id, MOVIE_ID);
  assert.equal(servers.calls[0].url, `${RECORDED.serverUrl}/library/sections/all`);
  assert.equal(servers.calls[0].headers['X-Plex-Token'], TOKEN);
  assert.deepEqual(detail.playbackOptions[0].stream.headers, { 'X-Plex-Token': TOKEN });
  assert.equal(account.calls.length, 0);
});

test('a typed server and a login are both catalogs, the typed one first and read unless another is picked', async () => {
  const { engine } = linked({ config: { ...RECORDED, token: TOKEN } });

  assert.deepEqual(await engine.call('getSubSources', []), {
    items: [
      { id: 'typed', name: 'localhost:18400' },
      { id: FRIEND.id, name: 'Friend\'s server' },
      { id: NEIGHBOUR.id, name: 'Neighbour\'s server' },
    ],
    activeId: 'typed',
  });
});

test('beside a typed server, a picked shared server is read with no typed token, and a bare id is still the typed server\'s', async () => {
  const unsigned = RESOURCES.map((entry) => {
    if (entry.clientIdentifier !== NEIGHBOUR.id) return entry;
    const { accessToken, ...rest } = entry;
    return rest;
  });
  const { engine, servers } = linked({ config: { ...RECORDED, token: TOKEN }, resources: unsigned, subSource: NEIGHBOUR.id });

  const items = await engine.call('getMediaList', ['1', { page: 1 }]);
  const shared = await engine.call('getMediaDetail', [`${NEIGHBOUR.id}|${MOVIE_ID}`]);
  const typed = await engine.call('getMediaDetail', [MOVIE_ID]);

  assert.equal((await engine.call('getSubSources', [])).activeId, NEIGHBOUR.id);
  assert.ok(items.every((item) => item.id.startsWith(`${NEIGHBOUR.id}|`)));
  assert.deepEqual(servers.calls.map((c) => [baseOf(c.url), c.headers['X-Plex-Token']]), [
    [NEIGHBOUR_REMOTE, undefined], [NEIGHBOUR_REMOTE, undefined], [RECORDED.serverUrl, TOKEN],
  ]);
  assert.equal(shared.playbackOptions[0].stream.headers, undefined);
  assert.deepEqual(typed.playbackOptions[0].stream.headers, { 'X-Plex-Token': TOKEN });
  assert.equal(typed.id, MOVIE_ID);
});

test('a typed server stands alone when the login is out, cannot be read, or no longer lists the pick', async () => {
  const signedOutTyped = signedOut({ ...RECORDED });
  const down = linked({ config: { ...RECORDED }, accountDown: true });
  const gone = linked({ config: { ...RECORDED }, subSource: 'server-gone' });
  const alone = { items: [{ id: 'typed', name: 'localhost:18400' }], activeId: 'typed' };

  assert.deepEqual(await signedOutTyped.engine.call('getSubSources', []), alone);
  assert.deepEqual(await down.engine.call('getSubSources', []), alone);
  await down.engine.call('getCategories', []);
  await gone.engine.call('getCategories', []);

  assert.deepEqual(signedOutTyped.asked, []);
  assert.deepEqual(signedOutTyped.logs, []);
  assert.deepEqual(down.servers.calls.map((c) => baseOf(c.url)), [RECORDED.serverUrl]);
  assert.deepEqual(gone.servers.calls.map((c) => baseOf(c.url)), [RECORDED.serverUrl]);
});

test('a picked shared server whose login cannot be read says so, rather than reading the typed server', async () => {
  const { engine, servers } = linked({ config: { ...RECORDED }, accountDown: true, subSource: FRIEND.id });

  for (const method of ['getSubSources', 'getCategories']) {
    const error = await engine.call(method, []).catch((e) => e);
    assert.equal(error.code, 'UNREACHABLE', method);
    assert.match(error.message, /list of your Plex servers/, method);
  }
  assert.deepEqual(servers.calls, []);
});

test('with no typed server, a bare id is not found rather than read on whichever server is picked', async () => {
  const { engine, servers } = linked({ subSource: NEIGHBOUR.id });

  const error = await engine.call('getMediaDetail', [MOVIE_ID]).catch((e) => e);

  assert.equal(error.code, 'NOT_FOUND');
  assert.deepEqual(servers.calls, []);
});

test('linked, each server shared with the account is a catalog, and one it owns is not', async () => {
  const { engine } = linked();

  const offered = await engine.call('getSubSources', []);

  assert.deepEqual(offered, {
    items: [{ id: FRIEND.id, name: 'Friend\'s server' }, { id: NEIGHBOUR.id, name: 'Neighbour\'s server' }],
    activeId: FRIEND.id,
  });
});

test('the picked catalog is the server a call reads, with that server\'s own token attached by the host', async () => {
  const { engine, servers } = linked({ subSource: NEIGHBOUR.id });

  assert.equal((await engine.call('getSubSources', [])).activeId, NEIGHBOUR.id);
  const categories = await engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.name), ['Movies', 'TV Shows']);
  assert.equal(servers.calls[0].url, `${NEIGHBOUR_REMOTE}/library/sections/all`);
  assert.equal(servers.calls[0].headers['X-Plex-Token'], NEIGHBOUR.token);
});

test('a shared server\'s title keeps its server in its id, and opens there whichever catalog is picked', async () => {
  const { engine, servers } = linked({ subSource: NEIGHBOUR.id, dead: [FRIEND_LOCAL] });

  const detail = await engine.call('getMediaDetail', [`${FRIEND.id}|${MOVIE_ID}`]);

  assert.equal(detail.id, `${FRIEND.id}|${MOVIE_ID}`);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_REMOTE]);
  assert.ok(detail.playbackOptions[0].stream.url.startsWith(`${FRIEND_REMOTE}/library/parts/1/`));
  assert.ok(detail.posterUrl.startsWith(`${FRIEND_REMOTE}/photo/:/transcode?`));
});

test('every connection is probed at once, a direct one wins over a relay, and it is asked straight away next time', async () => {
  const { engine, servers } = linked();

  await engine.call('getCategories', []);
  const probed = servers.probes.map((c) => baseOf(c.url));
  const first = servers.calls.map((c) => baseOf(c.url));
  servers.probes.length = 0;
  servers.calls.length = 0;
  await engine.call('getMediaList', ['1', { page: 1 }]);

  assert.deepEqual(probed, [FRIEND_LOCAL, FRIEND_REMOTE, FRIEND_RELAY]);
  assert.deepEqual(first, [FRIEND_LOCAL]);
  assert.deepEqual(servers.probes, []);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_LOCAL]);
});

test('a connection answering its probe with an error does not win it', async () => {
  const { engine, servers } = linked({ broken: [FRIEND_LOCAL] });

  await engine.call('getCategories', []);

  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_REMOTE]);
});

test('a remembered connection that starts answering with an error is let go and the connections probed again', async () => {
  const broken = [];
  const { engine, servers } = linked({ broken });
  await engine.call('getCategories', []);

  broken.push(FRIEND_LOCAL);
  servers.calls.length = 0;
  const categories = await engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.name), ['Movies', 'TV Shows']);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_LOCAL, FRIEND_REMOTE]);
});

test('a direct connection answering shortly after the relay is still the one read', async () => {
  const { engine, servers } = linked({ slow: { [FRIEND_LOCAL]: 200, [FRIEND_REMOTE]: 200 } });

  await engine.call('getCategories', []);

  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_LOCAL]);
});

// A friend behind CGNAT: from outside, the direct connections drop packets and never answer.
test('a server whose direct connections hang is read over its relay well within the call\'s budget', async () => {
  const { engine, servers } = linked({ hanging: [FRIEND_LOCAL, FRIEND_REMOTE] });

  const started = Date.now();
  const categories = await engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.name), ['Movies', 'TV Shows']);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_RELAY]);
  // Asked over the relay once its grace was up, not once the hanging probes gave up: the call
  // itself still waits for them, as a television's does.
  const askedAfterMs = servers.calls[0].at - started;
  assert.ok(askedAfterMs < HANG_MS, `the relay was first asked ${askedAfterMs} ms in, not before the ${HANG_MS} ms hang ended`);
});

test('a relay is kept ten minutes, then probed past, so a direct connection that came back is used', async () => {
  const dead = [FRIEND_LOCAL, FRIEND_REMOTE];
  const { engine, servers, clock } = linked({ dead });
  await engine.call('getCategories', []);

  dead.length = 0;
  servers.probes.length = 0;
  servers.calls.length = 0;
  clock.now += 9 * 60_000;
  await engine.call('getCategories', []);
  const kept = [servers.probes.length, ...servers.calls.map((c) => baseOf(c.url))];
  servers.probes.length = 0;
  servers.calls.length = 0;
  clock.now += 2 * 60_000;
  await engine.call('getCategories', []);

  assert.deepEqual(kept, [0, FRIEND_RELAY]);

  assert.deepEqual(servers.probes.map((c) => baseOf(c.url)), [FRIEND_LOCAL, FRIEND_REMOTE, FRIEND_RELAY]);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_LOCAL]);
});

test('a remembered connection that stops answering is probed past, and one none of whose connections answer is unreachable', async () => {
  const dead = [];
  const { engine, servers } = linked({ dead });
  await engine.call('getCategories', []);

  dead.push(FRIEND_LOCAL);
  servers.calls.length = 0;
  await engine.call('getCategories', []);
  const moved = servers.calls.map((c) => baseOf(c.url));
  dead.push(FRIEND_REMOTE, FRIEND_RELAY);
  const error = await engine.call('getCategories', []).catch((e) => e);
  dead.length = 0;
  servers.calls.length = 0;
  await engine.call('getCategories', []);

  assert.deepEqual(moved, [FRIEND_LOCAL, FRIEND_REMOTE]);
  assert.equal(error.code, 'UNREACHABLE');
  assert.match(error.message, /None of the server's addresses answered/);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_LOCAL]);
});

test('a shared server refusing its token is unavailable, and the host asks plex.tv again on the next call', async () => {
  const answers = { [FRIEND_LOCAL]: 401 };
  const { engine, account, clock } = linked({ answers });

  const error = await engine.call('getCategories', []).catch((e) => e);
  clock.now += 61_000;
  delete answers[FRIEND_LOCAL];
  await engine.call('getCategories', []);

  assert.equal(error.code, 'UNAVAILABLE');
  assert.match(error.message, /refused this login/);
  assert.equal(account.calls.length, 2);
});

// Misconfigured, not unauthenticated: the viewer is logged in, and what is missing is the form's server.
test('logged in with nothing shared and no server typed, every call says to type your own server', async () => {
  const { engine, servers } = linked({ resources: RESOURCES.filter((entry) => entry.owned) });

  for (const [method, args] of [['getSubSources', []], ['getCategories', []], ['search', ['bunny']]]) {
    const error = await engine.call(method, args).catch((e) => e);
    assert.equal(error.code, 'MISCONFIGURED', method);
    assert.match(error.message, /No Plex server is shared with this account\. For your own server, add its address and token/, method);
  }
  assert.equal(servers.calls.length, 0);
});

test('an account whose server list cannot be read rests the source rather than signing it out', async () => {
  const { engine, servers } = linked({ accountDown: true });

  const error = await engine.call('getCategories', []).catch((e) => e);

  assert.equal(error.code, 'UNREACHABLE');
  assert.match(error.message, /list of your Plex servers/);
  assert.equal(servers.calls.length, 0);
});

test('linked, the plugin asks plex.tv nothing: only the host does', async () => {
  const { engine, servers, account } = linked();

  await engine.call('getSubSources', []);
  await engine.call('getCategories', []);
  await engine.call('getMediaList', ['1', { page: 1 }]);
  await engine.call('getMediaDetail', [`${FRIEND.id}|${SHOW_ID}`]);
  await engine.call('search', ['bunny']);
  await engine.call('getImageHeaders', []);

  assert.equal(servers.calls.length, 5);
  assert.deepEqual([...servers.calls, ...servers.probes].filter((c) => ACCOUNT_HOSTS.test(c.url)).map((c) => c.url), []);
  assert.deepEqual(account.calls.map((c) => c.url), [DISCOVER]);
});

// A server listed with no token is one the host binds nothing to, so what reaches it is
// exactly what the plugin sent; the typed token must not be among it.
test('a shared server is sent no token of the plugin\'s: not in a header, a stream or a poster\'s signature', async () => {
  const unsigned = RESOURCES.map((entry) => {
    if (entry.clientIdentifier !== FRIEND.id) return entry;
    const { accessToken, ...rest } = entry;
    return rest;
  });
  const { engine, servers } = linked({ config: { token: TOKEN }, resources: unsigned });

  const detail = await engine.call('getMediaDetail', [`${FRIEND.id}|${MOVIE_ID}`]);

  assert.equal(servers.calls[0].headers['X-Plex-Token'], undefined);
  assert.equal(detail.playbackOptions[0].stream.headers, undefined);
  assert.deepEqual(await engine.call('getImageHeaders', []), {});
  for (const text of [JSON.stringify(detail), ...[...servers.calls, ...servers.probes].map((c) => JSON.stringify(c))]) {
    assert.ok(!text.includes(TOKEN), text);
  }
});

function doctor(config) {
  const env = { ...process.env };
  delete env.YONTO_PLUGIN_SESSION;
  delete env.YONTO_PLUGIN_CONFIG;
  if (config) env.YONTO_PLUGIN_CONFIG = JSON.stringify(config);
  return spawnSync('node', [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'doctor', dir, '--replay'], { encoding: 'utf8', env });
}

test('doctor is green on the typed server\'s recordings, and signed out names each step that needs the login', () => {
  const typed = doctor();
  const out = doctor({ serverUrl: '' });

  assert.equal(typed.status, 0, typed.stdout + typed.stderr);
  assert.doesNotMatch(typed.stdout, /not logged in/);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  for (const step of ['getSubSources', 'getCategories', 'search']) {
    assert.match(out.stdout, new RegExp(`✓ ${step} +not logged in`), step);
  }
});
