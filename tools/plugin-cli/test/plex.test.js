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

test('a title carries the database ids Plex lists as guids, and a listing and a search ask for them', async () => {
  const { engine, requests } = replayed();
  const bunny = { imdb: 'tt1254207', tmdb: '10378', tvdb: '12352' };

  const items = await engine.call('getMediaList', ['1', { page: 1 }]);
  assert.ok(requests.at(-1).url.includes('includeGuids=1'), requests.at(-1).url);
  assert.deepEqual(items.find((item) => item.id === MOVIE_ID).ids, bunny);

  const found = await engine.call('search', ['bunny']);
  assert.ok(requests.at(-1).url.includes('includeGuids=1'), requests.at(-1).url);
  assert.deepEqual(found.find((item) => item.id === MOVIE_ID).ids, bunny);

  // As recorded: a detail lists them without being asked, and a show the server never matched has none.
  assert.deepEqual((await engine.call('getMediaDetail', [MOVIE_ID])).ids, bunny);
  assert.equal((await engine.call('getMediaDetail', [SHOW_ID])).ids, undefined);
});

test('a show lists as a series', async () => {
  const items = await replayed().engine.call('getMediaList', ['2', { page: 1 }]);

  assert.deepEqual(items.map((item) => [item.id, item.type]), [[SHOW_ID, 'SERIES']]);
});

// A track, redeemed on Play, because what the server sends is for one play on one device and a
// detail is cached and kept.
test('a movie is a track that plays its part directly when no device is named', async () => {
  const { engine, requests } = replayed();
  const detail = await engine.call('getMediaDetail', [MOVIE_ID]);

  assert.deepEqual(detail.genres, ['Animation', 'Comedy', 'Family', 'Short']);
  assert.ok(detail.synopsis.startsWith('In the thick and undisturbed forest'));
  assert.deepEqual(detail.playbackOptions, [{ label: 'Play', id: MOVIE_ID, track: MOVIE_ID, video: { width: 640, height: 360, range: 'sdr' } }]);
  const stream = await engine.call('getStream', [MOVIE_ID]);
  assert.match(stream.url, /^http:\/\/localhost:18400\/library\/parts\/1\/\d+\/file\.mp4$/);
  // Without a type the app reads a file as an HLS playlist.
  assert.equal(stream.mimeType, 'video/mp4');
  assert.equal(stream.session, undefined);
  assert.equal(requests.some((r) => r.url.includes('/transcode/')), false);
});

test('a file names its container, so the player never takes it for a playlist', async () => {
  const { engine } = answering(200, {
    MediaContainer: {
      Metadata: [{
        ratingKey: 9,
        type: 'movie',
        title: 'Two versions',
        Media: [
          { id: 91, videoResolution: '1080', container: 'mkv', Part: [{ key: '/library/parts/9/1/file.mkv' }] },
          { id: 92, videoResolution: 'sd', container: 'avi', Part: [{ key: '/library/parts/10/1/file.avi' }] },
        ],
      }],
    },
  });

  const detail = await engine.call('getMediaDetail', ['9']);

  // Each version is its own track, so the one picked is the one redeemed.
  assert.deepEqual(detail.playbackOptions.map((o) => [o.label, o.track]), [['Play 1080', '9#91'], ['Play sd', '9#92']]);
  const streams = await Promise.all(detail.playbackOptions.map((o) => engine.call('getStream', [o.track])));
  assert.deepEqual(streams.map((s) => [s.url, s.mimeType]), [
    [`${RECORDED.serverUrl}/library/parts/9/1/file.mkv`, 'video/x-matroska'],
    [`${RECORDED.serverUrl}/library/parts/10/1/file.avi`, 'video/mp4'],
  ]);
});

test('a show becomes one option per episode, labelled, seasoned and numbered, each played by asking for it', async () => {
  const { engine } = replayed();
  const detail = await engine.call('getMediaDetail', [SHOW_ID]);

  assert.equal(detail.type, 'SERIES');
  assert.deepEqual(detail.playbackOptions.map((o) => o.label), ['S1E01 · Episode 1', 'S1E02 · Episode 2']);
  assert.deepEqual(detail.playbackOptions.map((o) => o.season), [1, 1]);
  assert.deepEqual(detail.playbackOptions.map((o) => o.episode), [1, 2]);
  assert.deepEqual(detail.playbackOptions.map((o) => o.track), ['5', '6']);
  const stream = await engine.call('getStream', [detail.playbackOptions[1].track]);
  assert.match(stream.url, /^http:\/\/localhost:18400\/library\/parts\/4\/\d+\/file\.mp4$/);
  assert.equal(stream.mimeType, 'video/mp4');
});

test('a movie offers its subtitle files, on its own server and with no token in their address', async () => {
  const { engine } = replayed({ ...RECORDED, token: TOKEN });
  const stream = await engine.call('getStream', [MOVIE_ID]);

  assert.deepEqual(stream.subtitles, [{
    url: `${RECORDED.serverUrl}/library/streams/3`,
    label: 'English',
    language: 'en',
    mimeType: 'application/x-subrip',
    forced: false,
    default: false,
  }]);
  // The player fetches a subtitle with the stream's own headers.
  assert.deepEqual(stream.headers, { 'X-Plex-Token': TOKEN });
});

// `allLeaves` lists no streams (recorded), so the episode's own detail is what has them.
test('an episode\'s subtitle files come with its stream, and a format the host cannot play is left out', async () => {
  const stream = await replayed().engine.call('getStream', ['6']);

  assert.deepEqual(stream.subtitles.map(({ url, label, language, mimeType, forced }) => [url, label, language, mimeType, forced]), [
    [`${RECORDED.serverUrl}/library/streams/7`, '中文', 'zh', 'application/x-subrip', false],
    [`${RECORDED.serverUrl}/library/streams/8`, 'English (Forced)', 'en', 'text/x-ssa', true],
  ]);
});

test('a subtitle whose key is not a path on the server is not offered', async () => {
  const subtitle = (key) => ({ streamType: 3, codec: 'srt', key, displayTitle: 'English' });
  const { engine } = answering(200, {
    MediaContainer: {
      Metadata: [{
        ratingKey: 9,
        type: 'movie',
        title: 'Hostile',
        Media: [{ container: 'mp4', Part: [{
          key: '/library/parts/9/1/file.mp4',
          Stream: [subtitle('//evil.example/x.srt'), subtitle('@evil.example/x.srt'), subtitle(42), subtitle('/library/streams/1')],
        }] }],
      }],
    },
  });

  const stream = await engine.call('getStream', ['9']);

  assert.deepEqual(stream.subtitles.map((s) => s.url), [`${RECORDED.serverUrl}/library/streams/1`]);
});

test('the token travels as a header, never in a url', async () => {
  const { engine, requests } = replayed({ ...RECORDED, token: TOKEN });
  const detail = await engine.call('getMediaDetail', [MOVIE_ID]);
  const stream = await engine.call('getStream', [MOVIE_ID]);

  assert.equal(requests[0].requestHeaders['X-Plex-Token'], TOKEN);
  assert.ok(!requests[0].url.includes(TOKEN));
  assert.deepEqual(stream.headers, { 'X-Plex-Token': TOKEN });
  assert.ok(!stream.url.includes(TOKEN));
  assert.ok(!detail.posterUrl.includes(TOKEN));
  assert.deepEqual(await engine.call('getImageHeaders', []), { 'X-Plex-Token': TOKEN });
});

test('with no token nothing is signed and no header is sent', async () => {
  const { engine, requests } = replayed();
  const stream = await engine.call('getStream', [MOVIE_ID]);

  assert.equal(requests[0].requestHeaders['X-Plex-Token'], undefined);
  assert.equal(stream.headers, undefined);
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

  assert.deepEqual(detail.playbackOptions.map((o) => o.track), ['9']);
  assert.equal((await engine.call('getStream', ['9'])).url, `${RECORDED.serverUrl}/library/parts/9/1/file.mp4`);
});

test('an episode the server has not numbered keeps its label and season but sends no episode number', async () => {
  const part = { Media: [{ Part: [{ key: '/library/parts/3/1/file.mp4' }] }] };
  const { engine } = answering(200, {
    MediaContainer: {
      Metadata: [
        { ratingKey: 3, type: 'show', title: 'Show', parentIndex: 2, ...part },
        { ratingKey: 4, type: 'show', title: 'Show', index: 5, ...part },
      ],
    },
  });

  const detail = await engine.call('getMediaDetail', ['3']);

  assert.deepEqual(detail.playbackOptions.map((o) => [o.label, o.season, o.episode]),
    [['S2E00 · Show', 2, undefined], ['S1E05 · Show', 1, undefined]]);
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
  refusedPaths = [],
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
      if (refusedPaths.some((path) => new URL(req.url).pathname === path)) return { status: 403, headers: {}, bodyBase64: body({}) };
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
  const stream = await engine.call('getStream', [MOVIE_ID]);

  assert.deepEqual(categories.map((c) => c.id), ['1', '2']);
  assert.equal(detail.id, MOVIE_ID);
  assert.equal(servers.calls[0].url, `${RECORDED.serverUrl}/library/sections/all`);
  assert.equal(servers.calls[0].headers['X-Plex-Token'], TOKEN);
  assert.deepEqual(stream.headers, { 'X-Plex-Token': TOKEN });
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
  const shared = await engine.call('getStream', [`${NEIGHBOUR.id}|${MOVIE_ID}`]);
  const typed = await engine.call('getStream', [MOVIE_ID]);

  assert.equal((await engine.call('getSubSources', [])).activeId, NEIGHBOUR.id);
  assert.ok(items.every((item) => item.id.startsWith(`${NEIGHBOUR.id}|`)));
  assert.deepEqual(servers.calls.map((c) => [baseOf(c.url), c.headers['X-Plex-Token']]), [
    [NEIGHBOUR_REMOTE, undefined], [NEIGHBOUR_REMOTE, undefined], [RECORDED.serverUrl, TOKEN],
  ]);
  assert.equal(shared.headers, undefined);
  assert.deepEqual(typed.headers, { 'X-Plex-Token': TOKEN });
  assert.equal(typed.url.startsWith(`${RECORDED.serverUrl}/library/parts/1/`), true);
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
  const stream = await engine.call('getStream', [detail.playbackOptions[0].track]);

  assert.equal(detail.id, `${FRIEND.id}|${MOVIE_ID}`);
  assert.equal(detail.playbackOptions[0].track, `${FRIEND.id}|${MOVIE_ID}`);
  assert.deepEqual(servers.calls.map((c) => baseOf(c.url)), [FRIEND_REMOTE, FRIEND_REMOTE]);
  assert.ok(stream.url.startsWith(`${FRIEND_REMOTE}/library/parts/1/`));
  assert.ok(detail.posterUrl.startsWith(`${FRIEND_REMOTE}/photo/:/transcode?`));
});

test('a shared server\'s episode is asked for on its own server, whichever catalog is picked', async () => {
  const { engine, servers } = linked({ subSource: NEIGHBOUR.id, dead: [FRIEND_LOCAL] });

  const detail = await engine.call('getMediaDetail', [`${FRIEND.id}|${SHOW_ID}`]);
  const stream = await engine.call('getStream', [detail.playbackOptions[1].track]);

  assert.equal(detail.playbackOptions[1].track, `${FRIEND.id}|6`);
  assert.ok(stream.url.startsWith(`${FRIEND_REMOTE}/library/parts/4/`), stream.url);
  assert.deepEqual(stream.subtitles.map((s) => s.url), [7, 8].map((id) => `${FRIEND_REMOTE}/library/streams/${id}`));
  assert.ok(servers.calls.every((c) => baseOf(c.url) === FRIEND_REMOTE));
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

// A friend may keep conversions, or the server's root, to themselves; that is not the login refused.
test('a shared server refusing its decision plays the file as stored, keeps the login and the kept connection', async () => {
  const { engine, servers, account, clock } = linked({ refusedPaths: ['/', '/video/:/transcode/universal/decision'] });
  await engine.call('getMediaDetail', [`${FRIEND.id}|${MOVIE_ID}`]);
  const probed = servers.probes.length;

  const stream = await engine.call('getStream', [`${FRIEND.id}|${MOVIE_ID}`, { device: DEVICE }]);
  clock.now += 61_000;
  await engine.call('getCategories', []);

  assert.ok(stream.url.startsWith(`${FRIEND_LOCAL}/library/parts/1/`), stream.url);
  assert.equal(stream.session, undefined);
  assert.ok(servers.calls.some((c) => c.url.includes('/transcode/universal/decision')), 'the server was asked');
  assert.equal(servers.probes.length, probed, 'a refusal is an answer, not a dead connection');
  assert.equal(account.calls.length, 1, 'plex.tv is not asked again');
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
  const stream = await engine.call('getStream', [`${FRIEND.id}|${MOVIE_ID}`]);

  assert.equal(servers.calls[0].headers['X-Plex-Token'], undefined);
  assert.equal(stream.headers, undefined);
  assert.deepEqual(await engine.call('getImageHeaders', []), {});
  for (const text of [JSON.stringify(detail), JSON.stringify(stream), ...[...servers.calls, ...servers.probes].map((c) => JSON.stringify(c))]) {
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

// Play state (contract 23). The payload shapes are what a real Plex Media Server 1.43.4 answered
// on 2026-10-18 after /:/scrobble (viewCount, lastViewedAt, a show's leaf counts). A viewOffset
// could not be produced on an unclaimed server, so its millisecond unit is Plex's documented one.
function routed(routes, status = 200) {
  const sent = [];
  const { engine, logs } = engineOver({
    async request(req) {
      sent.push(req);
      const route = routes.find(([part]) => req.url.includes(part));
      if (!route) return { status: 404, headers: {}, bodyBase64: body({}) };
      return { status: route[2] ?? status, headers: {}, bodyBase64: body(route[1]) };
    },
  }, { ...RECORDED, token: TOKEN });
  return { engine, sent, logs };
}

const movie = (extra) => ({ ratingKey: '1', type: 'movie', title: 'Seen', Media: [{ container: 'mp4', Part: [{ key: '/library/parts/1/1/file.mp4' }] }], ...extra });

test('a watched movie is played with its date, and a resumed one has its position in seconds', async () => {
  const { engine } = routed([['/library/metadata/1', { MediaContainer: { Metadata: [movie({ viewCount: 1, lastViewedAt: 1792296850 })] } }]]);
  const watched = await engine.call('getMediaDetail', ['1']);
  assert.equal(watched.played, true);
  assert.equal(watched.position, undefined);
  assert.equal(watched.playedAt, '2026-10-18T04:14:10.000Z');

  const resumed = routed([['/library/metadata/1', { MediaContainer: { Metadata: [movie({ viewOffset: 612500, lastViewedAt: 1792296850 })] } }]]);
  const half = await resumed.engine.call('getMediaDetail', ['1']);
  assert.equal(half.played, false);
  assert.equal(half.position, 612.5);

  // Watched before and being watched again: the offset wins, as in Plex Web.
  const again = routed([['/library/metadata/1', { MediaContainer: { Metadata: [movie({ viewCount: 2, viewOffset: 30000 })] } }]]);
  const second = await again.engine.call('getMediaDetail', ['1']);
  assert.deepEqual([second.played, second.position], [false, 30]);
});

test('an unwatched movie is not played, and the option carries the ratingKey', async () => {
  const { engine } = routed([['/library/metadata/1', { MediaContainer: { Metadata: [movie()] } }]]);
  const detail = await engine.call('getMediaDetail', ['1']);

  assert.equal(detail.played, false);
  assert.equal(detail.position, undefined);
  assert.equal(detail.playedAt, undefined);
  assert.equal(detail.playbackOptions[0].id, '1');
});

test('a show is played when every episode is, and each episode carries its own state and id', async () => {
  const episode = (ratingKey, extra) => ({
    ratingKey, type: 'episode', title: `Episode ${ratingKey}`, index: Number(ratingKey), parentIndex: 1,
    Media: [{ container: 'mp4', Part: [{ key: `/library/parts/${ratingKey}/1/file.mp4` }] }], ...extra,
  });
  const leaves = [episode('4', { viewCount: 1, lastViewedAt: 1792296850 }), episode('5', { viewOffset: 5000 })];
  const detailOf = async (counts) => routed([
    ['/allLeaves', { MediaContainer: { Metadata: leaves } }],
    ['/library/metadata/2', { MediaContainer: { Metadata: [{ ratingKey: '2', type: 'show', title: 'Show', ...counts }] } }],
  ]).engine.call('getMediaDetail', ['2']);

  const partly = await detailOf({ viewCount: 1, leafCount: 2, viewedLeafCount: 1 });
  assert.equal(partly.played, false);
  assert.deepEqual(partly.playbackOptions.map((o) => [o.id, o.played, o.position]), [['4', true, undefined], ['5', false, 5]]);
  assert.equal((await detailOf({ leafCount: 2, viewedLeafCount: 2 })).played, true);
  assert.equal((await detailOf({})).played, undefined);
});

test('a listing carries each title\'s state', async () => {
  const { engine } = routed([['/library/sections/1/all', { MediaContainer: { Metadata: [movie({ viewOffset: 1000 })] } }]]);
  const [item] = await engine.call('getMediaList', ['1', { page: 1 }]);

  assert.deepEqual([item.played, item.position], [false, 1]);
});

const OK = { MediaContainer: {} };

test('a report is a timeline request in milliseconds, signed like every other call', async () => {
  const { engine, sent } = routed([['/:/timeline', OK]]);
  await engine.call('reportPlayback', [{ mediaId: '3', optionId: '4', event: 'progress', paused: false, position: 612.5, duration: 1500 }]);

  const url = new URL(sent[0].url);
  assert.equal(url.pathname, '/:/timeline');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    identifier: 'com.plexapp.plugins.library', ratingKey: '4', key: '/library/metadata/4',
    state: 'playing', time: '612500', duration: '1500000',
  });
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].headers['X-Plex-Token'], TOKEN);
  assert.match(sent[0].headers['X-Plex-Client-Identifier'], /^lantern-/);
});

test('start, pause and stop are playing, paused and stopped, and a film reports under its own id', async () => {
  const states = [];
  for (const [event, paused] of [['start', false], ['progress', true], ['stop', false], ['stop', true]]) {
    const { engine, sent } = routed([['/:/timeline', OK]]);
    await engine.call('reportPlayback', [{ mediaId: '1', event, paused, position: 1 }]);
    const params = new URL(sent[0].url).searchParams;
    assert.equal(params.get('ratingKey'), '1');
    assert.equal(params.has('duration'), false);
    states.push(params.get('state'));
  }

  assert.deepEqual(states, ['playing', 'paused', 'stopped', 'stopped']);
});

test('a finished stop is a timeline and then a scrobble, so the last word is watched', async () => {
  const { engine, sent } = routed([['/:/', OK]]);
  await engine.call('reportPlayback', [{ mediaId: '3', optionId: '5', event: 'stop', paused: false, position: 1490, duration: 1500, finished: true }]);
  const quit = routed([['/:/', OK]]);
  await quit.engine.call('reportPlayback', [{ mediaId: '3', optionId: '5', event: 'stop', paused: false, position: 100, duration: 1500 }]);

  assert.deepEqual(sent.map((r) => new URL(r.url).pathname), ['/:/timeline', '/:/scrobble']);
  assert.deepEqual(Object.fromEntries(new URL(sent[1].url).searchParams), { identifier: 'com.plexapp.plugins.library', key: '5' });
  assert.deepEqual(quit.sent.map((r) => new URL(r.url).pathname), ['/:/timeline']);
});

test('setPlayed scrobbles and unscrobbles the episode, or the film', async () => {
  const paths = [];
  for (const change of [{ mediaId: '3', optionId: '4', played: true }, { mediaId: '1', played: false }]) {
    const { engine, sent } = routed([['/:/', OK]]);
    await engine.call('setPlayed', [change]);
    const url = new URL(sent[0].url);
    paths.push([url.pathname, url.searchParams.get('key')]);
  }

  assert.deepEqual(paths, [['/:/scrobble', '4'], ['/:/unscrobble', '1']]);
});

test('a write the server refuses is dropped without signing the viewer out or asking plex.tv again', async () => {
  const { engine, logs } = routed([['/:/', OK, 403]]);

  await assert.rejects(engine.call('setPlayed', [{ mediaId: '1', played: true }]), (error) => error.code === 'UNAVAILABLE');
  assert.ok(logs.some((line) => line.message.includes('403')));
});

test('On Deck answers a show with the episode to resume, and a film as it is', async () => {
  const { engine } = routed([['/library/onDeck', { MediaContainer: { Metadata: [
    { ratingKey: '5', type: 'episode', title: 'Episode 2', grandparentRatingKey: '2', grandparentTitle: 'Show', grandparentThumb: '/library/metadata/2/thumb/1', viewOffset: 5000, lastViewedAt: 1792296850 },
    movie({ viewOffset: 9000 }),
    { ratingKey: '9', type: 'clip', title: 'Extra' },
  ] } }]]);
  const { items } = await engine.call('getContinueWatching', []);

  assert.deepEqual(items.map((i) => [i.id, i.title, i.type, i.optionId, i.played, i.position]),
    [['2', 'Show', 'SERIES', '5', false, 5], ['1', 'Seen', 'MOVIE', undefined, false, 9]]);
  assert.match(items[0].posterUrl, /url=%2Flibrary%2Fmetadata%2F2%2Fthumb%2F1/);
});

test('a shared server is told on its own address, with its own token and none of the plugin\'s', async () => {
  const { engine, servers } = linked({ dead: [FRIEND_LOCAL] });

  await engine.call('setPlayed', [{ mediaId: `${FRIEND.id}|${MOVIE_ID}`, played: true }]).catch(() => {});

  const [call] = servers.calls;
  assert.equal(baseOf(call.url), FRIEND_REMOTE);
  assert.equal(new URL(call.url).pathname, '/:/scrobble');
  assert.equal(call.headers['X-Plex-Token'], FRIEND.token);
});

test('a shared server refusing a write is dropped: not probed past, and plex.tv is not asked again', async () => {
  const answers = {};
  const { engine, servers, account } = linked({ dead: [FRIEND_LOCAL], answers });
  const mediaId = `${FRIEND.id}|${MOVIE_ID}`;
  await engine.call('getMediaDetail', [mediaId]);
  const before = { servers: servers.calls.length, account: account.calls.length };
  answers[FRIEND_REMOTE] = 403;

  const error = await engine.call('setPlayed', [{ mediaId, played: true }]).catch((e) => e);

  assert.equal(error.code, 'UNAVAILABLE');
  assert.equal(servers.calls.length - before.servers, 1, 'the refused write is the only request');
  assert.equal(account.calls.length, before.account);
});

test('a timeline the server drops does not stop the scrobble of a finished title', async () => {
  const sent = [];
  const { engine } = engineOver({
    async request(req) {
      sent.push(req);
      return { status: req.url.includes('/:/timeline') ? 500 : 200, headers: {}, bodyBase64: body({}) };
    },
  }, { ...RECORDED, token: TOKEN });

  await engine.call('reportPlayback', [{ mediaId: '1', event: 'stop', paused: false, position: 5, finished: true }]).catch(() => {});

  assert.deepEqual(sent.map((r) => new URL(r.url).pathname), ['/:/timeline', '/:/scrobble']);
});

test('a movie\'s intro and final credits become segments in seconds, and a marker type the contract has no use for is left out', async () => {
  const { engine, requests } = replayed({ ...RECORDED, token: TOKEN });
  const stream = await engine.call('getStream', [MOVIE_ID]);

  assert.deepEqual(stream.segments, [{ type: 'intro', start: 5, end: 20 }, { type: 'credits', start: 24 }]);
  assert.ok(requests.some((r) => r.url.includes('/library/metadata/1?includeMarkers=1')), 'the metadata request asks for markers');
});

test('an episode\'s credits that stop short of the end keep their end, and the show\'s listing sends none', async () => {
  const { engine } = replayed();
  const stream = await engine.call('getStream', ['6']);

  assert.deepEqual(stream.segments, [{ type: 'intro', start: 1, end: 9 }, { type: 'credits', start: 20, end: 25 }]);
  const detail = await engine.call('getMediaDetail', [SHOW_ID]);
  assert.equal(JSON.stringify(detail).includes('segments'), false);
});

test('a title with no markers has no segments key', async () => {
  const { engine } = routed([['/library/metadata/1', { MediaContainer: { Metadata: [movie()] } }]]);
  const stream = await engine.call('getStream', ['1']);

  assert.equal('segments' in stream, false);
});

test('a marker that does not end after it starts is dropped unless it is credits, and no more than 32 are sent', async () => {
  const markers = [
    { type: 'intro', startTimeOffset: 1000, endTimeOffset: 1000 },
    { type: 'intro', startTimeOffset: 2000 },
    { type: 'credits', startTimeOffset: 90000, endTimeOffset: 80000 },
    { type: 'credits', startTimeOffset: 95000, endTimeOffset: 99000, final: true },
  ];
  const stream = async (Marker) => routed([['/library/metadata/1', { MediaContainer: { Metadata: [movie({ Marker })] } }]])
    .engine.call('getStream', ['1']);

  assert.deepEqual((await stream(markers)).segments, [{ type: 'credits', start: 90 }, { type: 'credits', start: 95 }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ type: 'intro', startTimeOffset: i * 1000, endTimeOffset: i * 1000 + 500 }));
  assert.equal((await stream(many)).segments.length, 32);
});

// What a television on a 1080p SDR screen plays.
const DEVICE = {
  video: [
    { codec: 'h264', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 8 },
    { codec: 'hevc', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 10 },
  ],
  audio: ['aac', 'ac3', 'eac3', 'dts'],
  maxAudioChannels: 6,
  containers: ['mp4', 'mkv', 'webm', 'ts', 'hls'],
  hdr: [],
  subtitles: ['srt', 'vtt', 'ass'],
};

const DECIDED = (decision) => ({ MediaContainer: { Metadata: [{ Media: [{ Part: [{ decision }] }] }] } });
const subtitled = movie({
  Media: [{ container: 'mkv', Part: [{ key: '/library/parts/1/1/file.mkv', Stream: [
    { streamType: 3, codec: 'srt', key: '/library/streams/5', displayTitle: 'English' },
    { streamType: 3, codec: 'srt', displayTitle: 'Inside' },
  ] }] }],
  Marker: [{ type: 'credits', startTimeOffset: 280000, final: true }],
});

// The server root is routed last: every address on the server holds it.
function deciding({ item = subtitled, decision = DECIDED('transcode'), root = { myPlexSubscription: false } } = {}) {
  const answer = (value) => (typeof value === 'number' ? [{}, value] : [value]);
  return routed([
    ['/video/:/transcode/universal/decision', ...answer(decision)],
    ['/library/metadata/1', { MediaContainer: { Metadata: [item] } }],
    ['/:/timeline', OK],
    [`${RECORDED.serverUrl}/`, ...answer(typeof root === 'number' ? root : { MediaContainer: root })],
  ]);
}

function decisionOf(sent) {
  return new URL(sent.find((r) => r.url.includes('/transcode/universal/decision')).url).searchParams;
}

test('with what the device plays, the server decides, and a conversion is its HLS with everything in its address but the token', async () => {
  const { engine, sent } = deciding();
  const stream = await engine.call('getStream', ['1', { device: DEVICE }]);

  const asked = decisionOf(sent);
  const started = new URL(stream.url);
  assert.equal(`${started.origin}${started.pathname}`, `${RECORDED.serverUrl}/video/:/transcode/universal/start.m3u8`);
  // The same session and profile as the decision, which Plex refuses to start without.
  assert.deepEqual([...started.searchParams], [...asked]);
  assert.equal(asked.get('X-Plex-Session-Identifier'), asked.get('session'));
  assert.equal(asked.get('X-Plex-Platform'), 'Generic');
  assert.equal(asked.get('path'), '/library/metadata/1');
  assert.equal(asked.get('subtitles'), 'none');
  assert.equal(asked.get('maxVideoBitrate'), null, 'a cap makes Plex convert a file it has not analysed');
  assert.ok(!stream.url.includes(TOKEN));
  assert.deepEqual(stream.headers, { 'X-Plex-Token': TOKEN });
  assert.equal(stream.mimeType, 'application/x-mpegURL');
  assert.deepEqual(JSON.parse(stream.session), { playSession: asked.get('session'), method: 'transcode' });
  // Plex serves no file for a track inside the video, so only the file beside it is offered.
  assert.deepEqual(stream.subtitles.map((s) => s.url), [`${RECORDED.serverUrl}/library/streams/5`]);
  assert.deepEqual(stream.segments, [{ type: 'credits', start: 280 }]);
});

test('each play is its own session', async () => {
  const { engine, sent } = deciding();
  await engine.call('getStream', ['1', { device: DEVICE }]);
  await engine.call('getStream', ['1', { device: DEVICE }]);

  const sessions = sent.filter((r) => r.url.includes('/decision')).map((r) => new URL(r.url).searchParams.get('session'));
  assert.equal(new Set(sessions).size, 2);
});

test('the device the server is told about is its decoders, sizes and bit depth, and HEVC it plays is copied into fMP4', async () => {
  const { engine, sent } = deciding();
  await engine.call('getStream', ['1', { device: DEVICE }]);

  const asked = decisionOf(sent);
  assert.equal(asked.get('videoResolution'), '1920x1080');
  assert.deepEqual(asked.get('X-Plex-Client-Profile-Extra').split('+'), [
    'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mp4&videoCodec=h264&audioCodec=aac,ac3,eac3)',
    'append-transcode-target-codec(type=videoProfile&context=streaming&protocol=hls&videoCodec=hevc)',
    'add-direct-play-profile(type=videoProfile&protocol=http&container=mp4,mov,mkv,webm,mpegts&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3,dca)',
    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.width&value=1920&isRequired=false)',
    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.height&value=1080&isRequired=false)',
    'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.bitDepth&value=8&isRequired=false)',
    'add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.width&value=1920&isRequired=false)',
    'add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.height&value=1080&isRequired=false)',
    'add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10&isRequired=false)',
  ]);
});

test('a device with no HEVC decoder is sent H.264 in transport stream, at the size of its largest decoder', async () => {
  const { engine, sent } = deciding();
  const video = [{ codec: 'h264', maxWidth: 1280, maxHeight: 720, maxBitDepth: 8 }];
  await engine.call('getStream', ['1', { device: { ...DEVICE, video } }]);

  const asked = decisionOf(sent);
  const [target, directPlay] = asked.get('X-Plex-Client-Profile-Extra').split('+');
  assert.ok(target.includes('container=mpegts&videoCodec=h264&'), target);
  assert.ok(directPlay.startsWith('add-direct-play-profile('), 'no HEVC appended');
  assert.equal(asked.get('videoResolution'), '1280x720');
});

// Without Plex Pass, Plex 1.43 converts HDR to SDR without tone mapping: no truer to the colours than the file.
test('the screen\'s range is a limitation only on a server with Plex Pass, and an unreadable root is none', async () => {
  const limitsFor = async (root, hdr) => {
    const { engine, sent } = deciding({ root });
    await engine.call('getStream', ['1', { device: { ...DEVICE, video: [DEVICE.video[1]], hdr } }]);
    return decisionOf(sent).get('X-Plex-Client-Profile-Extra').split('+')
      .filter((part) => part.includes('colorTrc') || part.includes('DOVI'))
      .map((part) => part.match(/name=([^&]+)&list=([^&]+)/).slice(1).join(' '));
  };

  assert.deepEqual(await limitsFor({ myPlexSubscription: false }, []), []);
  assert.deepEqual(await limitsFor(401, []), []);
  assert.deepEqual(await limitsFor({ myPlexSubscription: true }, []), ['video.colorTrc smpte2084|arib-std-b67', 'video.DOVIBLCompatID 0']);
  // An HDR10 screen shows HDR10, HDR10+ and Dolby Vision's HDR10 layer; profile 5 has no layer but its own.
  assert.deepEqual(await limitsFor({ myPlexSubscription: true }, ['hdr10']), ['video.colorTrc arib-std-b67', 'video.DOVIBLCompatID 0']);
  assert.deepEqual(await limitsFor({ myPlexSubscription: true }, ['hlg']), ['video.colorTrc smpte2084', 'video.DOVIBLCompatID 0']);
  assert.deepEqual(await limitsFor({ myPlexSubscription: true }, ['hdr10', 'hlg', 'dolbyVision']), []);
});

test('a file the server says plays as stored is its part, under a session of its own', async () => {
  const { engine, sent } = deciding({ decision: DECIDED('directplay') });
  const stream = await engine.call('getStream', ['1', { device: DEVICE }]);

  assert.equal(stream.url, `${RECORDED.serverUrl}/library/parts/1/1/file.mkv`);
  assert.equal(stream.mimeType, 'video/x-matroska');
  assert.deepEqual(JSON.parse(stream.session), { playSession: decisionOf(sent).get('session'), method: 'directplay' });
});

test('a server that cannot decide, or decides neither, still plays the file as stored', async () => {
  for (const decision of [500, 401, { MediaContainer: { generalDecisionCode: 2000 } }]) {
    const stream = await deciding({ decision }).engine.call('getStream', ['1', { device: DEVICE }]);

    assert.equal(stream.url, `${RECORDED.serverUrl}/library/parts/1/1/file.mkv`);
    assert.equal(stream.session, undefined);
  }
});

test('the version picked is the one the server decides, by its place among the title\'s media', async () => {
  const versions = movie({ Media: [
    { id: 91, container: 'mkv', Part: [{ key: '/library/parts/1/1/file.mkv' }] },
    { id: 92, container: 'mp4', Part: [{ key: '/library/parts/2/1/file.mp4' }] },
  ] });
  const { engine, sent } = deciding({ item: versions, decision: DECIDED('directplay') });
  const stream = await engine.call('getStream', ['1#92', { device: DEVICE }]);

  assert.equal(decisionOf(sent).get('mediaIndex'), '1');
  assert.equal(stream.url, `${RECORDED.serverUrl}/library/parts/2/1/file.mp4`);
});

test('a report names the play\'s session, so the stopped timeline ends the server\'s conversion', async () => {
  const { engine, sent } = deciding();
  const { session } = await engine.call('getStream', ['1', { device: DEVICE }]);
  await engine.call('reportPlayback', [{ mediaId: '1', event: 'stop', paused: false, position: 30, session }]);
  await engine.call('reportPlayback', [{ mediaId: '1', event: 'stop', paused: false, position: 30 }]);

  const [decided, plain] = sent.filter((r) => r.url.includes('/:/timeline')).map((r) => new URL(r.url).searchParams);
  assert.equal(decided.get('X-Plex-Session-Identifier'), JSON.parse(session).playSession);
  assert.equal(decided.get('state'), 'stopped');
  assert.equal(plain.get('X-Plex-Session-Identifier'), null);
});

test('each version says its own size and range, and an episode its size alone', async () => {
  const stream = (extra) => ({ Part: [{ key: '/library/parts/1/1/file.mkv', Stream: [{ streamType: 1, codec: 'hevc', ...extra }] }] });
  const versions = movie({ Media: [
    { id: 91, videoResolution: '4k', width: 3840, height: 1606, ...stream({ DOVIPresent: true, colorTrc: 'smpte2084' }) },
    { id: 92, videoResolution: '1080', width: 1920, height: 1080, ...stream({}) },
  ] });
  const film = await routed([['/library/metadata/1', { MediaContainer: { Metadata: [versions] } }]]).engine.call('getMediaDetail', ['1']);
  assert.deepEqual(film.playbackOptions.map((o) => [o.label, o.video]), [
    ['Play 4k', { width: 3840, height: 1606, range: 'dolbyVision' }],
    ['Play 1080', { width: 1920, height: 1080, range: 'sdr' }],
  ]);

  const show = await replayed().engine.call('getMediaDetail', [SHOW_ID]);
  assert.ok(show.playbackOptions.every((o) => o.video && o.video.width > 0 && o.video.range === undefined), JSON.stringify(show.playbackOptions.map((o) => o.video)));
});

test('a transfer Plex names becomes the contract\'s range', async () => {
  const rangeFor = async (extra) => {
    const item = movie({ Media: [{ width: 3840, height: 2160, Part: [{ key: '/library/parts/1/1/file.mkv', Stream: [{ streamType: 1, ...extra }] }] }] });
    return (await routed([['/library/metadata/1', { MediaContainer: { Metadata: [item] } }]]).engine.call('getMediaDetail', ['1'])).playbackOptions[0].video.range;
  };

  assert.deepEqual(
    await Promise.all([{ colorTrc: 'smpte2084' }, { colorTrc: 'arib-std-b67' }, { colorTrc: 'bt709' }, {}].map(rangeFor)),
    ['hdr10', 'hlg', 'sdr', 'sdr'],
  );
});
