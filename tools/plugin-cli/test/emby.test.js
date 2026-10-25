import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code, PluginError } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

// Two halves: the fixtures recorded from a real Emby 4.10 (plugins/emby/AGENTS.md says which),
// replayed, for what the plugin asks and makes of the answers; and a scripted server for the
// sign-in, where what matters is how often a login is spent.
const dir = fileURLToPath(new URL('../../../plugins/emby/', import.meta.url));
const RECORDED = JSON.parse(readFileSync(join(dir, 'doctor.json'), 'utf8'));
const MOVIES = '3';
const SHOWS = '5';
const SERIES = '11';

function hostFor(config, transport, storeDir = scratchDir('lp-emby-')) {
  const host = createHost({ manifest: loadManifest(dir), config, transport, storeDir, pluginDir: dir });
  return { engine: createEngine({ dir, host }), requests: host.requests, yonto: host.yonto, logs: host.logs };
}

function replayed() {
  return hostFor(RECORDED, createReplayTransport({ dir: join(dir, 'fixtures') }));
}

test('only movie and tv show libraries become categories', async () => {
  const categories = await replayed().engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id), [MOVIES, SHOWS]);
});

test('genres and years come from their own endpoints, since Emby has no /Items/Filters', async () => {
  const { engine, requests } = replayed();
  const filters = await engine.call('getFilters', [MOVIES]);

  assert.deepEqual(filters.map((f) => f.id), ['type', 'genre', 'year']);
  assert.deepEqual(filters[1].options.map((o) => o.id), ['Documentary', 'Drama', 'Science Fiction']);
  assert.deepEqual(filters[2].options.map((o) => o.id), ['2014', '2010']);
  assert.deepEqual(requests.map((r) => r.url.split('?')[0].split('/emby/')[1]).sort(), ['Genres', 'Years']);
});

test('a listing names the fields a summary reads, and no more', async () => {
  const { engine, requests } = replayed();
  const listed = await engine.call('getMediaList', [MOVIES, { page: 1, filters: {} }]);

  const { url } = requests[0];
  assert.ok(url.includes('Fields=ProductionYear%2COfficialRating%2CProviderIds'), url);
  assert.ok(!url.includes('Overview') && !url.includes('Genres'), url);
  // Emby leaves both out of a listing unless asked.
  const pattern = listed.find((item) => item.title === 'Test Pattern');
  assert.equal(pattern.year, '2010');
  assert.equal(pattern.rating, 'PG');
});

test('a title the server matched carries its database ids, and one it did not carries none', async () => {
  const { engine } = replayed();
  const listed = await engine.call('getMediaList', [MOVIES, { page: 1, filters: {} }]);

  assert.deepEqual(listed.find((item) => item.title === 'Test Pattern').ids, { tmdb: '9001', imdb: 'tt9000001' });

  const shows = await engine.call('getMediaList', [SHOWS, { page: 1, filters: {} }]);
  assert.equal(shows.find((item) => item.title === 'Pioneer Clips').ids, undefined);

  const detail = await engine.call('getMediaDetail', ['9']);
  assert.deepEqual(detail.ids, { tmdb: '9002', imdb: 'tt9000002' });
});

test('recommendations ask for the rating they rank by, and drop the unrated', async () => {
  const { engine, requests } = replayed();
  const picks = await engine.call('getRecommendations', []);

  assert.ok(requests[0].url.includes('Fields=ProductionYear%2COfficialRating%2CProviderIds%2CCommunityRating'), requests[0].url);
  assert.deepEqual(picks.map((p) => p.title), ['Pioneer Clips', 'Test Pattern']);
});

test('search sends SearchTerm', async () => {
  const { engine, requests } = replayed();
  const found = await engine.call('search', ['pattern']);

  assert.ok(requests[0].url.includes('SearchTerm=pattern'), requests[0].url);
  assert.deepEqual(found.map((f) => f.title), ['Test Pattern']);
});

test('a series plays each episode as a track redeemed directly, with the token in a header and in no url', async () => {
  const { engine, requests } = replayed();
  const detail = await engine.call('getMediaDetail', [SERIES]);

  assert.equal(detail.type, 'SERIES');
  assert.deepEqual(detail.genres, ['Drama', 'Science Fiction']);
  assert.deepEqual(detail.playbackOptions.map((o) => o.label),
    ['S1E01 · Pioneer Clips - S01E01', 'S1E02 · Pioneer Clips - S01E02']);
  assert.deepEqual(detail.playbackOptions.map((o) => [o.season, o.episode]), [[1, 1], [1, 2]]);
  assert.deepEqual(detail.playbackOptions.map((o) => o.track), ['13', '14']);
  const stream = await engine.call('getStream', ['13']);
  // No MediaSourceId: Emby answers 400 to the item id there.
  assert.equal(stream.url, `${RECORDED.serverUrl}/emby/Videos/13/stream?Static=true`);
  assert.deepEqual(stream.headers, { 'X-Emby-Token': RECORDED.apiKey });

  for (const request of requests) {
    assert.equal(request.requestHeaders['X-Emby-Token'], RECORDED.apiKey);
    assert.ok(request.url.startsWith(`${RECORDED.serverUrl}/emby/`), request.url);
  }
  const urls = [...requests.map((r) => r.url), detail.posterUrl, detail.backdropUrl, stream.url];
  assert.ok(urls.every((u) => !u.includes(RECORDED.apiKey)), 'the key rides in no url');
});

// A track, redeemed on Play, because what the server sends is for one play on one device and a
// detail is cached and kept.
test('a film is one Play option, a track the direct-play endpoint redeems when no device is named', async () => {
  const { engine, requests } = replayed();
  const detail = await engine.call('getMediaDetail', ['9']);

  // As recorded: a 320x240 test clip, which Emby calls SDR.
  assert.deepEqual(detail.playbackOptions, [{ label: 'Play', id: '9', track: '9', video: { width: 320, height: 240, range: 'sdr' } }]);
  const stream = await engine.call('getStream', ['9']);
  assert.equal(stream.url, `${RECORDED.serverUrl}/emby/Videos/9/stream?Static=true`);
  assert.equal(stream.session, undefined);
  assert.equal(requests.some((r) => r.url.includes('PlaybackInfo') || r.url.includes('Registrations')), false);
});

test('a film offers its text subtitle files, a format the host cannot play asked for as SubRip', async () => {
  const stream = await replayed().engine.call('getStream', ['9']);
  const subtitles = `${RECORDED.serverUrl}/emby/Videos/9/mediasource_9/Subtitles`;

  // The PGS file is a picture and the MOV_TEXT track is inside the video, so neither is offered.
  assert.deepEqual(stream.subtitles, [
    { url: `${subtitles}/2/Stream.srt`, label: 'English', language: 'en', mimeType: 'application/x-subrip', forced: false, default: true },
    { url: `${subtitles}/3/Stream.srt`, label: 'Korean', language: 'ko', mimeType: 'application/x-subrip', forced: false, default: false },
  ]);
});

test('an episode offers its own subtitle files when played, under its own media source, and the listing asks for none', async () => {
  const { engine, requests } = replayed();
  await engine.call('getMediaDetail', [SERIES]);
  const stream = await engine.call('getStream', ['13']);

  // The listing asks for each episode's size and never its media sources, which would weigh every open of the show.
  assert.ok(requests[1].url.includes('Fields=Width%2CHeight&'), requests[1].url);
  assert.ok(!requests[1].url.includes('MediaSources'), requests[1].url);
  assert.ok(requests[2].url.endsWith('/Items/13?Fields=MediaSources%2CChapters'), requests[2].url);
  assert.deepEqual(stream.subtitles.map(({ url, mimeType, forced }) => ({ url, mimeType, forced })), [
    { url: `${RECORDED.serverUrl}/emby/Videos/13/mediasource_13/Subtitles/2/Stream.srt`, mimeType: 'application/x-subrip', forced: false },
    { url: `${RECORDED.serverUrl}/emby/Videos/13/mediasource_13/Subtitles/3/Stream.ass`, mimeType: 'text/x-ssa', forced: true },
  ]);
});

test('artwork is asked for at the size it is drawn at', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [SERIES]);

  assert.ok(detail.posterUrl.includes(`/emby/Items/${SERIES}/Images/Primary?tag=`), detail.posterUrl);
  assert.ok(detail.posterUrl.includes('maxWidth=480'));
  assert.ok(detail.backdropUrl.includes('maxWidth=1920'));
});

// ---------------------------------------------------------------------------- signing in

const SERVER = 'https://emby.test';
const TOKEN = 'token-from-login';
const USER = 'user-id-from-login';
const withPassword = { serverUrl: SERVER, username: 'demo', password: 'hunter2' };
const withKey = { serverUrl: SERVER, apiKey: 'dashboard-key', userId: 'dashboard-user' };

function body(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

const refused = { status: 401, headers: {}, bodyBase64: body({}) };
const loginOk = { status: 200, headers: {}, bodyBase64: body({ AccessToken: TOKEN, User: { Id: USER } }) };
const viewsOk = {
  status: 200,
  headers: {},
  bodyBase64: body({ Items: [
    { Id: '3', Name: 'Movies', CollectionType: 'movies' },
    { Id: '7', Name: 'Music', CollectionType: 'music' },
    { Id: '8', Name: 'Collections', CollectionType: 'boxsets' },
  ] }),
};
const namesOk = { status: 200, headers: {}, bodyBase64: body({ Items: [{ Name: 'Drama' }] }) };

/** Answers by method and a fragment of the url, and keeps every request. */
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
      return typeof answer === 'function' ? answer(req) : answer;
    },
    logins() {
      return this.calls.filter((c) => c.url.includes('AuthenticateByName')).length;
    },
  };
}

test('an episode says its size from the listing, and only a film its range, from its own media source', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [SERIES]);

  assert.deepEqual(detail.playbackOptions.map((o) => o.video), [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]);
});

test('each range Emby names becomes the contract\'s, and one it does not know says no range', async () => {
  const rangeFor = async (VideoRange) => {
    const film = { Id: '9', Name: 'Film', Type: 'Movie', MediaSources: [{ Id: 'mediasource_9', MediaStreams: [{ Type: 'Video', Width: 3840, Height: 2160, VideoRange }] }] };
    const transport = scripted({ 'GET Items/9': { status: 200, headers: {}, bodyBase64: body(film) } });
    return (await hostFor(withKey, transport).engine.call('getMediaDetail', ['9'])).playbackOptions[0].video.range;
  };

  assert.deepEqual(
    await Promise.all(['SDR', 'HDR 10', 'HDR 10+', 'HLG', 'DolbyVision', 'Dolby Vision'].map(rangeFor)),
    ['sdr', 'hdr10', 'hdr10plus', 'hlg', 'dolbyVision', undefined],
  );
});

test('an episode the server has not numbered keeps its label and season but sends no episode number', async () => {
  const transport = scripted({
    'GET ParentId=11': { status: 200, headers: {}, bodyBase64: body({ Items: [
      { Id: '12', Name: 'Unaired', Type: 'Episode', ParentIndexNumber: 2 },
      { Id: '13', Name: 'Special', Type: 'Episode', IndexNumber: 4 },
    ] }) },
    'GET Items/11': { status: 200, headers: {}, bodyBase64: body({ Id: '11', Name: 'Show', Type: 'Series' }) },
  });

  const detail = await hostFor(withKey, transport).engine.call('getMediaDetail', ['11']);

  assert.deepEqual(detail.playbackOptions.map((o) => [o.label, o.season, o.episode]),
    [['S2E00 · Unaired', 2, undefined], ['S1E04 · Special', 1, undefined]]);
});

test('a username and password are exchanged for a token that later calls carry', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': viewsOk });
  const { engine, yonto } = hostFor(withPassword, transport);

  const categories = await engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id), ['3'], 'music and collections are not libraries this app plays');
  const [login, views] = transport.calls;
  assert.equal(login.url, `${SERVER}/emby/Users/AuthenticateByName`);
  assert.equal(login.headers['X-Emby-Authorization'],
    `Emby Client="Yonto Player", Device="Android TV", DeviceId="lantern-${yonto.installId()}", Version="1.0"`);
  assert.deepEqual(JSON.parse(login.body), { Username: 'demo', Pw: 'hunter2' });
  assert.equal(views.headers['X-Emby-Token'], TOKEN);
  assert.equal(views.url, `${SERVER}/emby/Users/${USER}/Views`);
});

test('an address typed with /emby on the end is not given a second one', async () => {
  const transport = scripted({ 'GET Views': viewsOk });

  await hostFor({ ...withKey, serverUrl: `${SERVER}/emby/` }, transport).engine.call('getCategories', []);

  assert.equal(transport.calls[0].url, `${SERVER}/emby/Users/dashboard-user/Views`);
});

test('the session is kept, and the two filter calls share one login', async () => {
  const transport = scripted({
    'POST AuthenticateByName': loginOk, 'GET Views': viewsOk, 'GET Genres': namesOk, 'GET Years': namesOk,
  });
  const { engine } = hostFor(withPassword, transport);

  await engine.call('getFilters', ['3']);
  await engine.call('getCategories', []);

  assert.equal(transport.logins(), 1);
});

test('a revoked token logs in again and retries the call once', async () => {
  let refusals = 0;
  const transport = scripted({
    'POST AuthenticateByName': loginOk,
    'GET Views': () => (refusals++ === 0 ? refused : viewsOk),
  });

  const categories = await hostFor(withPassword, transport).engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id), ['3']);
  assert.equal(transport.logins(), 2);
});

test('an episode played after its session was revoked carries the token the retry won', async () => {
  let logins = 0;
  let refusals = 0;
  const transport = scripted({
    'POST AuthenticateByName': () => {
      logins += 1;
      return { status: 200, headers: {}, bodyBase64: body({ AccessToken: `token-${logins}`, User: { Id: USER } }) };
    },
    'GET /Items/13': () => (refusals++ === 0
      ? refused
      : { status: 200, headers: {}, bodyBase64: body({ Id: '13', Type: 'Episode', MediaSources: [] }) }),
  });

  const stream = await hostFor(withPassword, transport).engine.call('getStream', ['13']);

  assert.equal(logins, 2);
  assert.deepEqual(stream.headers, { 'X-Emby-Token': 'token-2' });
});

// The listing's 401 for the old token lands after the other call has renewed it; forgetting
// then would throw the renewed token away and log in a third time.
test('a late refusal of an old token does not throw away the one that replaced it', async () => {
  let logins = 0;
  let live = null;
  let answerLateRefusal;
  const renewed = new Promise((resolve) => { answerLateRefusal = resolve; });
  let releaseRetry;
  const otherCallerDone = new Promise((resolve) => { releaseRetry = resolve; });
  const itemsOk = { status: 200, headers: {}, bodyBase64: body({ Items: [{ Id: 'm1', Name: 'Film', Type: 'Movie' }] }) };
  const transport = {
    async request(req) {
      if (req.url.includes('AuthenticateByName')) {
        logins += 1;
        live = `TOKEN-${logins}`;
        return { status: 200, headers: {}, bodyBase64: body({ AccessToken: live, User: { Id: USER } }) };
      }
      const token = req.headers['X-Emby-Token'];
      if (req.url.includes('/Items') && token === 'TOKEN-1') await renewed;
      if (req.url.includes('/Views') && logins > 1) {
        answerLateRefusal();
        await otherCallerDone;
      }
      if (token !== live) return refused;
      return req.url.includes('/Views') ? viewsOk : itemsOk;
    },
  };
  const { engine } = hostFor(withPassword, transport);
  await engine.call('getCategories', []);
  live = null;

  const listing = engine.call('getMediaList', ['3', {}]).finally(releaseRetry);
  const [categories, media] = await Promise.all([engine.call('getCategories', []), listing]);

  assert.deepEqual(categories.map((c) => c.id), ['3']);
  assert.deepEqual(media.map((m) => m.id), ['m1']);
  assert.equal(logins, 2);
});

test('a second refusal is the account, not the password, and stops there', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': refused });

  await assert.rejects(() => hostFor(withPassword, transport).engine.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    assert.match(error.message, /permissions/);
    return true;
  });
  assert.equal(transport.logins(), 2);
});

test('a refused password is sent once, and the calls after it are refused here', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const { engine } = hostFor(withPassword, transport);

  const said = [];
  for (const method of ['getCategories', 'getCategories', 'getRecommendations']) {
    await assert.rejects(() => engine.call(method, []), (error) => {
      assert.equal(error.code, Code.UNAUTHENTICATED);
      return said.push(error.message) > 0;
    });
  }
  assert.match(said[0], /username and password/);
  assert.equal(new Set(said).size, 1);
  assert.equal(transport.logins(), 1);
});

test('an edited password is worth another attempt', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const storeDir = scratchDir('lp-emby-edited-');

  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  await assert.rejects(() => hostFor({ ...withPassword, password: 'fixed' }, transport, storeDir)
    .engine.call('getCategories', []));

  assert.equal(transport.logins(), 2);
});

// kangzj/lantern-tv#736: a viewer who saved the wrong server and corrects only the URL must
// have the new one asked, not be told locally that the password is wrong.
test('a refusal from one server does not stop the same login being tried on another', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const storeDir = scratchDir('lp-emby-server-');
  const other = 'https://other-emby.test';
  const logins = () => transport.calls.filter((c) => c.url.includes('AuthenticateByName')).map((c) => c.url);

  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  assert.deepEqual(logins(), [`${SERVER}/emby/Users/AuthenticateByName`], 'the same combination is not sent again');

  await assert.rejects(() => hostFor({ ...withPassword, serverUrl: other }, transport, storeDir)
    .engine.call('getCategories', []));
  assert.deepEqual(logins(), [`${SERVER}/emby/Users/AuthenticateByName`, `${other}/emby/Users/AuthenticateByName`]);
});

test('a refusal for one username does not stop another username being tried', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const storeDir = scratchDir('lp-emby-username-');
  const usernames = () =>
    transport.calls.filter((c) => c.url.includes('AuthenticateByName')).map((c) => JSON.parse(c.body).Username);

  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  assert.deepEqual(usernames(), ['demo'], 'the same combination is not sent again');

  await assert.rejects(() => hostFor({ ...withPassword, username: 'someone' }, transport, storeDir)
    .engine.call('getCategories', []));
  assert.deepEqual(usernames(), ['demo', 'someone']);
});

// kangzj/lantern-tv#754: one slot meant B's refusal forgot A's, so going back to A spent
// another attempt on the same wrong password.
test('refusals are kept for every server and username, so going back asks nobody', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const storeDir = scratchDir('lp-emby-refusals-');
  const other = { ...withPassword, serverUrl: 'https://other-emby.test' };
  const someone = { ...withPassword, username: 'someone' };

  for (const config of [withPassword, other, someone, withPassword, other, someone]) {
    await assert.rejects(() => hostFor(config, transport, storeDir).engine.call('getCategories', []), (error) => {
      assert.equal(error.code, Code.UNAUTHENTICATED);
      return true;
    });
  }

  assert.equal(transport.logins(), 3);
});

test('a login that works clears only its own server and username\'s refusals', async () => {
  const otherServer = 'https://other-emby.test';
  const transport = scripted({
    'POST other-emby.test': loginOk, 'POST AuthenticateByName': refused, 'GET Views': viewsOk,
  });
  const storeDir = scratchDir('lp-emby-cleared-own-');

  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  await hostFor({ ...withPassword, serverUrl: otherServer }, transport, storeDir).engine.call('getCategories', []);
  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));

  assert.equal(transport.logins(), 2, 'the first server was not asked again');
});

// The review of #819: a right password refused for another reason (a lockout, a disabled
// account) must not stay refused once another attempt on that account has been made.
test('a new refusal on a server and username replaces the last one there', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const storeDir = scratchDir('lp-emby-replaced-');
  const attempt = (password) =>
    assert.rejects(() => hostFor({ ...withPassword, password }, transport, storeDir).engine.call('getCategories', []));

  await attempt('right-but-locked');
  await attempt('wrong');
  await attempt('wrong');
  assert.equal(transport.logins(), 2);

  await attempt('right-but-locked');
  assert.equal(transport.logins(), 3, 'the earlier refusal was let go');
});

test('refusals are kept for the ten latest servers, and an older one is worth asking again', async () => {
  const transport = scripted({ 'POST AuthenticateByName': refused });
  const storeDir = scratchDir('lp-emby-kept-');
  const attempt = (n) => assert.rejects(() =>
    hostFor({ ...withPassword, serverUrl: `https://emby-${n}.test` }, transport, storeDir).engine.call('getCategories', []));

  for (let n = 0; n <= 10; n += 1) await attempt(n);
  assert.equal(transport.logins(), 11);

  await attempt(1);
  assert.equal(transport.logins(), 11, 'the tenth latest is still kept');
  await attempt(0);
  assert.equal(transport.logins(), 12, 'the eleventh latest was let go');
});

test('an API key wins, logs nobody in, and names itself when refused', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': refused });

  await assert.rejects(() => hostFor({ ...withPassword, ...withKey }, transport).engine.call('getCategories', []),
    (error) => {
      assert.equal(error.code, Code.UNAUTHENTICATED);
      assert.match(error.message, /API key and user ID/);
      return true;
    });
  assert.equal(transport.logins(), 0);
  assert.equal(transport.calls[0].headers['X-Emby-Token'], 'dashboard-key');
});

test('a form with no credential, or a key with no user id, asks nothing of the server', async () => {
  for (const [config, words] of [
    [{ serverUrl: SERVER }, /username and password, or an API key/],
    [{ serverUrl: SERVER, apiKey: 'dashboard-key' }, /no user ID/],
  ]) {
    const transport = scripted({});
    await assert.rejects(() => hostFor(config, transport).engine.call('getCategories', []), (error) => {
      assert.equal(error.code, Code.MISCONFIGURED);
      assert.match(error.message, words);
      return true;
    });
    assert.deepEqual(transport.calls, []);
  }
});

// Only a server that gave no answer is `unreachable`; nothing wraps a plugin profile to rest
// it, and a status is an answer.
test('a server that does not answer is unreachable, and every status is an answer', async () => {
  const html = { status: 200, headers: {}, bodyBase64: Buffer.from('<html>Sign in</html>').toString('base64') };
  const cases = [
    ['no answer', { 'GET Views': () => { throw new Error(`connect refused: ${SERVER}`); } }, Code.UNREACHABLE],
    ['a 503', { 'GET Views': { status: 503, headers: {}, bodyBase64: body({}) } }, Code.UNAVAILABLE],
    ['a 400', { 'GET Views': { status: 400, headers: {}, bodyBase64: body({}) } }, Code.UNAVAILABLE],
    ['a page that is not JSON', { 'GET Views': html }, Code.UNAVAILABLE],
    ['a 404', {}, Code.NOT_FOUND],
    ['a timeout', { 'GET Views': () => { throw new PluginError(Code.TIMEOUT, 'too slow'); } }, Code.TIMEOUT],
    ['a redirect it gave up on', {
      'GET Views': { status: 302, headers: { location: 'https://who:pw@emby.test/x' }, bodyBase64: body({}) },
    }, Code.REDIRECT_REFUSED],
  ];
  for (const [what, answers, code] of cases) {
    await assert.rejects(() => hostFor(withKey, scripted(answers)).engine.call('getCategories', []), (error) => {
      assert.equal(error.code, code, what);
      // The host's own codes keep the host's message; only the plugin's sentences are held here.
      if (code === Code.UNREACHABLE || code === Code.UNAVAILABLE) assert.ok(!error.message.includes(SERVER), error.message);
      return true;
    });
  }
});

test('a sign-in answered with a page that is not JSON says so in a sentence', async () => {
  const html = { status: 200, headers: {}, bodyBase64: Buffer.from('<html>Sign in</html>').toString('base64') };

  await assert.rejects(() => hostFor(withPassword, scripted({ 'POST AuthenticateByName': html }))
    .engine.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAVAILABLE);
    assert.match(error.message, /server URL/);
    return true;
  });
});

// kangzj/lantern-tv#753: valid JSON that is not an object got past the parse and threw on the
// next line, with no sentence.
test('an answer that is JSON but not an object points at the server URL', async () => {
  const withBody = (text) => ({ status: 200, headers: {}, bodyBase64: Buffer.from(text).toString('base64') });
  for (const text of ['null', '[]', '"ok"', '42']) {
    for (const [what, config, answers, logged] of [
      ['signing in', withPassword, { 'POST AuthenticateByName': withBody(text) }, 'logging in'],
      ['listing libraries', withKey, { 'GET Views': withBody(text) }, 'views'],
    ]) {
      const { engine, logs } = hostFor(config, scripted(answers));
      await assert.rejects(() => engine.call('getCategories', []), (error) => {
        assert.equal(error.code, Code.UNAVAILABLE, `${what}: ${text}`);
        assert.match(error.message, /check the server URL/, `${what}: ${text}`);
        return true;
      });
      assert.ok(logs.some((line) => line.message === `${logged} got a 2xx that is not a JSON object`),
        `${what}: ${JSON.stringify(logs)}`);
    }
  }
});

test('a session is not reused for another server or another username', async () => {
  const transport = scripted({ 'POST AuthenticateByName': loginOk, 'GET Views': viewsOk });
  const storeDir = scratchDir('lp-emby-cached-');

  await hostFor(withPassword, transport, storeDir).engine.call('getCategories', []);
  await hostFor({ ...withPassword, serverUrl: 'https://other.test' }, transport, storeDir).engine.call('getCategories', []);
  const someoneElse = { ...withPassword, serverUrl: 'https://other.test', username: 'someone' };
  await hostFor(someoneElse, transport, storeDir).engine.call('getCategories', []);
  await hostFor(someoneElse, transport, storeDir).engine.call('getCategories', []);

  assert.equal(transport.logins(), 3, 'one per server and username, and the last one kept');
});

test('a password that works clears the refusal, so the refused one is worth asking again', async () => {
  const accepted = new Set(['fixed']);
  const transport = scripted({
    'POST AuthenticateByName': (req) => (accepted.has(JSON.parse(req.body).Pw) ? loginOk : refused),
    'GET Views': viewsOk,
  });
  const storeDir = scratchDir('lp-emby-cleared-');

  await assert.rejects(() => hostFor(withPassword, transport, storeDir).engine.call('getCategories', []));
  await hostFor({ ...withPassword, password: 'fixed' }, transport, storeDir).engine.call('getCategories', []);
  accepted.add(withPassword.password);
  await hostFor({ ...withPassword, username: 'demo2' }, transport, storeDir).engine.call('getCategories', []);
  await hostFor(withPassword, transport, storeDir).engine.call('getCategories', []);

  assert.equal(transport.logins(), 4);
});

test('an id is one path segment, whatever it holds', async () => {
  const transport = scripted({});

  await assert.rejects(() => hostFor(withKey, transport).engine.call('getMediaDetail', ['a/b?c#d']));

  assert.equal(transport.calls[0].url.split('?')[0], `${SERVER}/emby/Users/dashboard-user/Items/a%2Fb%3Fc%23d`);
});

test('a film\'s IntroStart and IntroEnd chapters become an intro and its CreditsStart credits to the end', async () => {
  const stream = await replayed().engine.call('getStream', ['9']);

  assert.deepEqual(stream.segments, [{ type: 'intro', start: 5, end: 20 }, { type: 'credits', start: 280 }]);
});

test('an IntroStart with no IntroEnd after it is not an intro, and an ordinary chapter is not a segment', async () => {
  const stream = await replayed().engine.call('getStream', ['13']);

  assert.equal('segments' in stream, false);
});

test('segments are paired in order: an IntroStart takes only the intro mark right after it, and the cap is 32', async () => {
  const T = 10000000;
  const chapters = (marks) => marks.map(([MarkerType, seconds]) => ({ MarkerType, StartPositionTicks: seconds * T, Name: MarkerType }));
  const film = (Chapters) => ({
    Id: '9', Name: 'Film', Type: 'Movie', MediaSources: [{ Id: 'mediasource_9', MediaStreams: [] }], Chapters,
  });
  const streamOf = async (Chapters) => {
    const transport = scripted({ 'GET Items/9': { status: 200, headers: {}, bodyBase64: body(film(Chapters)) } });
    const { engine } = hostFor(withKey, transport);
    return engine.call('getStream', ['9']);
  };

  const crossed = await streamOf(chapters([['IntroStart', 3], ['CreditsStart', 50], ['IntroEnd', 9]]));
  assert.deepEqual(crossed.segments, [{ type: 'intro', start: 3, end: 9 }, { type: 'credits', start: 50 }]);
  const doubled = await streamOf(chapters([['IntroStart', 3], ['IntroStart', 5], ['IntroEnd', 9]]));
  assert.deepEqual(doubled.segments, [{ type: 'intro', start: 5, end: 9 }]);
  const many = await streamOf(chapters(Array.from({ length: 40 }, (_, i) => ['CreditsStart', i])));
  assert.equal(many.segments.length, 32);
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

// A film as Emby 4.10 answers it: its default source's id is not the item id, and one SubRip track
// is inside the file beside a SubRip file.
function decidedFilm({ subType = 'None' } = {}) {
  return {
    Id: '9', Name: 'Film', Type: 'Movie',
    MediaSources: [{
      Id: 'mediasource_9',
      MediaStreams: [
        { Type: 'Video', Index: 0, Codec: 'hevc', VideoRange: 'HDR 10', ExtendedVideoType: 'Hdr10', ExtendedVideoSubType: subType },
        { Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'en', DisplayLanguage: 'English', IsExternal: false, IsTextSubtitleStream: true },
        { Type: 'Subtitle', Index: 3, Codec: 'subrip', Language: 'ko', DisplayLanguage: 'Korean', IsExternal: true, IsTextSubtitleStream: true },
      ],
    }],
    Chapters: [{ MarkerType: 'CreditsStart', StartPositionTicks: 280 * 10000000 }],
  };
}

const CONVERTED = {
  PlaySessionId: 'server-play-session',
  MediaSources: [{
    Id: 'mediasource_9',
    SupportsDirectPlay: false,
    SupportsTranscoding: true,
    TranscodingUrl: '/videos/9/master.m3u8?DeviceId=d&MediaSourceId=mediasource_9&PlaySessionId=server-play-session&api_key=server-written-key&VideoCodec=h264&TranscodeReasons=VideoResolutionNotSupported',
  }],
};

function deciding({ film = decidedFilm(), premiere = { IsRegistered: false }, decision = CONVERTED } = {}) {
  const answer = (value) => (typeof value === 'number'
    ? { status: value, headers: {}, bodyBase64: body({}) }
    : { status: 200, headers: {}, bodyBase64: body(value) });
  return scripted({
    'GET Items/9': answer(film),
    'GET Registrations/premiere': answer(premiere),
    'POST PlaybackInfo': answer(decision),
    'POST Sessions/Playing': { status: 204, headers: {}, bodyBase64: '' },
  });
}

function profileSent(transport) {
  return JSON.parse(transport.calls.find((c) => c.url.includes('/PlaybackInfo')).body).DeviceProfile;
}

test('with what the device plays, the server is asked, and a stream it converts is its HLS under /emby without the key it wrote in', async () => {
  const transport = deciding();
  const stream = await hostFor(withKey, transport).engine.call('getStream', ['9', { device: DEVICE }]);

  const asked = transport.calls.find((c) => c.url.includes('/PlaybackInfo'));
  assert.equal(asked.url, `${SERVER}/emby/Items/9/PlaybackInfo?UserId=dashboard-user`);
  assert.equal(stream.url, `${SERVER}/emby/videos/9/master.m3u8?DeviceId=d&MediaSourceId=mediasource_9&PlaySessionId=server-play-session&VideoCodec=h264&TranscodeReasons=VideoResolutionNotSupported`);
  assert.equal(stream.mimeType, 'application/x-mpegURL');
  assert.deepEqual(stream.headers, { 'X-Emby-Token': 'dashboard-key' });
  assert.deepEqual(JSON.parse(stream.session), { playSessionId: 'server-play-session', mediaSourceId: 'mediasource_9', playMethod: 'Transcode' });
  // A conversion's HLS carries no subtitle track, so the one inside the file is offered as a file too.
  assert.deepEqual(stream.subtitles.map((s) => s.url), [
    `${SERVER}/emby/Videos/9/mediasource_9/Subtitles/2/Stream.srt`,
    `${SERVER}/emby/Videos/9/mediasource_9/Subtitles/3/Stream.srt`,
  ]);
  assert.deepEqual(stream.segments, [{ type: 'credits', start: 280 }]);
  assert.equal(JSON.parse(asked.body).SubtitleStreamIndex, -1, 'no subtitle is ever burned in');
});

test('the device the server is told about is its decoders, sizes and bit depth, and HEVC it plays is copied into fMP4', async () => {
  const transport = deciding();
  await hostFor(withKey, transport).engine.call('getStream', ['9', { device: DEVICE }]);

  const profile = profileSent(transport);
  assert.deepEqual(profile.DirectPlayProfiles, [{
    Type: 'Video', Container: 'mp4,m4v,mov,mkv,webm,ts,mpegts,m2ts', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3,dts,dca',
  }]);
  assert.deepEqual(profile.CodecProfiles[1].Conditions.map((c) => [c.Property, c.Value]), [
    ['Width', '1920'], ['Height', '1080'], ['VideoBitDepth', '10'],
  ]);
  assert.equal(profile.TranscodingProfiles[0].VideoCodec, 'h264,hevc');
  assert.equal(profile.TranscodingProfiles[0].Container, 'mp4');
  assert.equal(profile.TranscodingProfiles[0].MaxAudioChannels, '6');
});

test('a device with no HEVC decoder is sent H.264 in transport stream', async () => {
  const transport = deciding();
  await hostFor(withKey, transport).engine.call('getStream', ['9', { device: { ...DEVICE, video: [DEVICE.video[0]] } }]);

  const profile = profileSent(transport);
  assert.equal(profile.TranscodingProfiles[0].VideoCodec, 'h264');
  assert.equal(profile.TranscodingProfiles[0].Container, 'ts');
});

// Without Premiere, Emby 4.10 converts HDR to SDR without tone mapping ("requires an active Emby
// Premiere subscription"), which is no truer to the colours than the file.
test('the screen\'s range is a condition only on a server with Premiere, and an unreadable registration is none', async () => {
  for (const premiere of [{ IsRegistered: false }, 404]) {
    const transport = deciding({ premiere });
    await hostFor(withKey, transport).engine.call('getStream', ['9', { device: DEVICE }]);
    assert.equal(profileSent(transport).CodecProfiles[0].Conditions.some((c) => c.Property === 'VideoRange'), false);
  }

  const transport = deciding({ premiere: { IsRegistered: true } });
  await hostFor(withKey, transport).engine.call('getStream', ['9', { device: DEVICE }]);
  assert.deepEqual(profileSent(transport).CodecProfiles.map((p) => p.Conditions[3]), [
    { Condition: 'EqualsAny', Property: 'VideoRange', Value: 'SDR', IsRequired: false },
    { Condition: 'EqualsAny', Property: 'VideoRange', Value: 'SDR', IsRequired: false },
  ]);
});

test('a refused Premiere read says nothing about the login: no second sign-in, and the play is still decided', async () => {
  const json = (value, status = 200) => ({ status, headers: {}, bodyBase64: body(value) });
  const transport = scripted({
    'POST AuthenticateByName': json({ AccessToken: TOKEN, User: { Id: USER } }),
    'GET Items/9': json(decidedFilm()),
    'GET Registrations/premiere': json({}, 401),
    'POST PlaybackInfo': json(CONVERTED),
  });
  const stream = await hostFor(withPassword, transport).engine.call('getStream', ['9', { device: DEVICE }]);

  assert.equal(transport.logins(), 1);
  assert.equal(stream.mimeType, 'application/x-mpegURL');
  assert.equal(profileSent(transport).CodecProfiles[0].Conditions.some((c) => c.Property === 'VideoRange'), false);
});

test('a screen that shows HDR10 lets HDR10 and HDR10+ play as stored, in the names Emby compares', async () => {
  const transport = deciding({ premiere: { IsRegistered: true } });
  await hostFor(withKey, transport).engine.call('getStream', ['9', { device: { ...DEVICE, hdr: ['hdr10'] } }]);

  assert.equal(profileSent(transport).CodecProfiles[0].Conditions[3].Value, 'SDR|HDR 10|HDR 10+');
});

// Emby's `VideoRange` is `DolbyVision` for every profile, so the item's own profile decides.
test('Dolby Vision plays as stored only where the screen shows its base layer', async () => {
  const rangesFor = async (subType, hdr) => {
    const transport = deciding({ film: decidedFilm({ subType }), premiere: { IsRegistered: true } });
    await hostFor(withKey, transport).engine.call('getStream', ['9', { device: { ...DEVICE, hdr } }]);
    return profileSent(transport).CodecProfiles[0].Conditions[3].Value.split('|');
  };

  assert.ok((await rangesFor('DoviProfile81', ['hdr10'])).includes('DolbyVision'));
  assert.ok((await rangesFor('DoviProfile76', ['hdr10'])).includes('DolbyVision'));
  assert.ok((await rangesFor('DoviProfile84', ['hlg'])).includes('DolbyVision'));
  assert.ok((await rangesFor('DoviProfile82', [])).includes('DolbyVision'), 'an SDR base layer plays on any screen');
  assert.equal((await rangesFor('DoviProfile50', ['hdr10'])).includes('DolbyVision'), false, 'profile 5 has no layer but its own');
  assert.equal((await rangesFor('DoviProfile81', [])).includes('DolbyVision'), false);
  assert.ok((await rangesFor('DoviProfile50', ['dolbyVision'])).includes('DolbyVision'));
});

test('a file the server says plays as stored is the direct-play endpoint, under the server\'s own session', async () => {
  const decision = { PlaySessionId: 'server-play-session', MediaSources: [{ Id: 'mediasource_9', SupportsDirectPlay: true }] };
  const stream = await hostFor(withKey, deciding({ decision })).engine.call('getStream', ['9', { device: DEVICE }]);

  assert.equal(stream.url, `${SERVER}/emby/Videos/9/stream?Static=true`);
  assert.equal(stream.mimeType, 'video/mp4');
  assert.deepEqual(JSON.parse(stream.session), { playSessionId: 'server-play-session', mediaSourceId: 'mediasource_9', playMethod: 'DirectPlay' });
  assert.deepEqual(stream.subtitles.map((s) => s.url), [`${SERVER}/emby/Videos/9/mediasource_9/Subtitles/3/Stream.srt`]);
});

test('a server that cannot decide still plays the file as stored', async () => {
  const stream = await hostFor(withKey, deciding({ decision: 500 })).engine.call('getStream', ['9', { device: DEVICE }]);

  assert.equal(stream.url, `${SERVER}/emby/Videos/9/stream?Static=true`);
  assert.equal(stream.session, undefined);
});

test('a report hands the server back its own play session, media source and method, so the stop ends its conversion', async () => {
  const transport = deciding();
  const { engine } = hostFor(withKey, transport);
  const { session } = await engine.call('getStream', ['9', { device: DEVICE }]);
  await engine.call('reportPlayback', [{ mediaId: '9', event: 'stop', paused: false, position: 30, session }]);
  await engine.call('reportPlayback', [{ mediaId: '9', event: 'stop', paused: false, position: 30 }]);

  const [decided, plain] = transport.calls.filter((c) => c.url.endsWith('/Sessions/Playing/Stopped')).map((c) => JSON.parse(c.body));
  assert.deepEqual([decided.PlaySessionId, decided.MediaSourceId, decided.PlayMethod], ['server-play-session', 'mediasource_9', 'Transcode']);
  // Without one, as before: an id derived from the item, and no MediaSourceId, which the item id is not.
  assert.match(plain.PlaySessionId, /^lantern-.+-9$/);
  assert.equal('MediaSourceId' in plain, false);
  assert.equal(plain.PlayMethod, 'DirectPlay');
});
