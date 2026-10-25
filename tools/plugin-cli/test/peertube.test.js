import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

// Two halves: fixtures recorded from a real PeerTube 8.3.1 (plugins/peertube/AGENTS.md says how),
// replayed, for what the plugin asks and makes of the answers; and a scripted instance for signing
// in, where what matters is how often a password is spent and where the token goes.
const dir = fileURLToPath(new URL('../../../plugins/peertube/', import.meta.url));
const RECORDED = JSON.parse(readFileSync(join(dir, 'doctor.json'), 'utf8'));
const WEB_VIDEO = '5a43dadf-b544-4af1-9c69-cfb78cc65f61';
const HLS_VIDEO = '438e31b9-0e7b-4b4f-a3ca-f8611c5ffc07';

function hostFor(config, transport, { storeDir = scratchDir('lp-peertube-'), now } = {}) {
  const host = createHost({
    manifest: loadManifest(dir), config, transport, storeDir, pluginDir: dir, ...(now ? { now } : {}),
  });
  return { engine: createEngine({ dir, host }), requests: host.requests };
}

function replayed(config = RECORDED) {
  return hostFor(config, createReplayTransport({ dir: join(dir, 'fixtures') }));
}

test('the categories are what is new, what is trending, and each of the instance\'s own channels', async () => {
  const categories = await replayed().engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id),
    ['recent', 'trending', 'channel:garden_diaries', 'channel:root_channel']);
  assert.equal(categories[2].name, 'Garden Diaries');
});

test('a listing is the instance\'s own videos unless the viewer asked for the ones it follows too', async () => {
  const { engine, requests } = replayed();
  const listed = await engine.call('getMediaList', ['recent', { page: 1, filters: {} }]);

  assert.ok(requests[0].url.includes('sort=-publishedAt') && requests[0].url.includes('isLocal=true'), requests[0].url);
  assert.ok(listed.length > 0);
  for (const item of listed) {
    assert.equal(item.type, 'movie');
    assert.match(item.posterUrl, /^https:\/\/peertube\.example\.com\/lazy-static\/thumbnails\//);
  }

  const transport = scripted({ 'GET /api/v1/videos?': ok({ total: 0, data: [] }) });
  await hostFor({ ...RECORDED, federated: 'true' }, transport).engine.call('getMediaList', ['trending', { page: 2 }]);
  const { url } = transport.calls[0];
  assert.ok(!url.includes('isLocal'), url);
  assert.ok(url.includes('start=50') && url.includes('sort=-trending'), url);
});

test('the poster is a landscape thumbnail at least 480 wide and never the square one', async () => {
  const [item] = await replayed().engine.call('search', ['tomatoes']);
  const recorded = fixtureBody(`${RECORDED.instanceUrl}/api/v1/search/videos?`).data[0];
  const sized = Object.fromEntries(recorded.thumbnails.map((t) => [t.fileUrl, t]));

  assert.equal(sized[item.posterUrl].width, 850);
  assert.equal(sized[item.backdropUrl].width, 1920);
  assert.notEqual(sized[item.posterUrl].aspectRatio, '1:1');
});

test('a web video plays its best file, with the captions beside it as subtitles', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [WEB_VIDEO]);
  const [{ stream }] = detail.playbackOptions;

  assert.equal(stream.mimeType, 'video/mp4');
  assert.match(stream.url, /-720\.mp4$/);
  assert.deepEqual(stream.subtitles.map((s) => [s.language, s.label, s.mimeType]),
    [['en', 'English', 'text/vtt'], ['fr', 'French', 'text/vtt']]);
  for (const subtitle of stream.subtitles) assert.equal(new URL(subtitle.url).host, new URL(stream.url).host);
  assert.equal(stream.headers, undefined, 'a public video sends nothing of a session');
});

test('an HLS video plays its master playlist, whose own captions are not offered twice', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [HLS_VIDEO]);
  const [{ stream }] = detail.playbackOptions;

  assert.equal(stream.mimeType, 'application/x-mpegURL');
  assert.match(stream.url, /-master\.m3u8$/);
  assert.equal(stream.subtitles, undefined);
});

test('the synopsis opens with the channel and the length, and the description is text, not Markdown', async () => {
  const detail = await replayed().engine.call('getMediaDetail', [HLS_VIDEO]);

  assert.equal(detail.synopsis.split('\n')[0], 'Garden Diaries · 2:30');
  assert.ok(detail.synopsis.includes('tomatoes go in'), detail.synopsis);
  assert.ok(!detail.synopsis.includes('**'), detail.synopsis);
  assert.deepEqual(detail.genres, ['Science & Technology']);
});

// --- A scripted instance.

const INSTANCE = 'https://videos.test';
const withPassword = { instanceUrl: INSTANCE, username: 'jasper', password: 'hunter2' };
const CLIENT = { client_id: 'client-id', client_secret: 'client-secret' };

function body(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function ok(value) {
  return { status: 200, headers: {}, bodyBase64: body(value) };
}

function problem(status, code) {
  return { status, headers: {}, bodyBase64: body({ status, ...(code ? { code } : {}) }) };
}

/** The JSON a recorded answer carries, found by the start of the url it answered. */
function fixtureBody(urlPrefix) {
  const fixtures = join(dir, 'fixtures');
  const found = readdirSync(fixtures)
    .map((name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8')))
    .find((fixture) => fixture.request.url.startsWith(urlPrefix));
  return JSON.parse(Buffer.from(found.response.bodyBase64, 'base64').toString('utf8'));
}

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
      if (!key) return problem(404);
      const answer = answers[key];
      return typeof answer === 'function' ? answer(req) : answer;
    },
    grants(type) {
      return this.calls.filter((c) => c.url.endsWith('/users/token') && new URLSearchParams(c.body).get('grant_type') === type);
    },
  };
}

function tokens(access, expiresIn = 86400) {
  return ok({ token_type: 'Bearer', access_token: access, refresh_token: `refresh-${access}`, expires_in: expiresIn });
}

const channels = ok({ total: 0, data: [] });

const privateVideo = {
  uuid: 'p1', name: 'Family only', isLocal: true, duration: 61, privacy: { id: 3 },
  streamingPlaylists: [{ type: 1, playlistUrl: `${INSTANCE}/static/streaming-playlists/hls/private/p1/m-master.m3u8` }],
  files: [],
};

test('a username and password are exchanged once for a token that every call carries', async () => {
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT), 'POST users/token': tokens('access-1'), 'GET video-channels': channels,
  });
  const { engine } = hostFor(withPassword, transport);

  const categories = await engine.call('getCategories', []);
  await engine.call('getCategories', []);

  assert.ok(categories.some((c) => c.id === 'mine' && c.name === 'My videos'));
  const [grant] = transport.grants('password');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(grant.body)), {
    client_id: 'client-id', client_secret: 'client-secret', grant_type: 'password', username: 'jasper', password: 'hunter2',
  });
  assert.equal(grant.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(transport.grants('password').length, 1);
  const listings = transport.calls.filter((c) => c.url.includes('video-channels'));
  assert.equal(listings.length, 2);
  for (const call of listings) assert.equal(call.headers.Authorization, 'Bearer access-1');
});

test('a private video\'s stream carries the token, to its own instance\'s private files only', async () => {
  const remote = {
    ...privateVideo, uuid: 'r1', isLocal: false,
    streamingPlaylists: [{ type: 1, playlistUrl: 'https://elsewhere.test/static/streaming-playlists/hls/private/r1/m-master.m3u8' }],
  };
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT), 'POST users/token': tokens('access-1'),
    'GET /videos/p1/captions': ok({ data: [] }), 'GET /videos/p1': ok(privateVideo),
    'GET /videos/r1/captions': ok({ data: [] }), 'GET /videos/r1': ok(remote),
  });
  const { engine } = hostFor(withPassword, transport);

  const [mine] = (await engine.call('getMediaDetail', ['p1'])).playbackOptions;
  const [theirs] = (await engine.call('getMediaDetail', ['r1'])).playbackOptions;

  assert.deepEqual(mine.stream.headers, { Authorization: 'Bearer access-1' });
  assert.equal(theirs.stream.headers, undefined, 'a token for this instance never goes to another');
});

test('a signed-in viewer\'s token goes to no public file, even one on another host such as object storage', async () => {
  const stored = {
    ...privateVideo, uuid: 'o1', privacy: { id: 1 },
    streamingPlaylists: [{ type: 1, playlistUrl: 'https://bucket.storage.test/streaming-playlists/hls/o1/m-master.m3u8' }],
  };
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT), 'POST users/token': tokens('access-1'),
    'GET /videos/o1/captions': ok({ data: [] }), 'GET /videos/o1': ok(stored),
  });
  const [{ stream }] = (await hostFor(withPassword, transport).engine.call('getMediaDetail', ['o1'])).playbackOptions;

  assert.equal(stream.headers, undefined);
});

test('an instance that does not answer is unreachable, not unavailable', async () => {
  const transport = { async request() { throw new Error('connect refused'); } };
  await assert.rejects(() => hostFor({ instanceUrl: INSTANCE }, transport).engine.call('getCategories', []),
    (error) => error.code === Code.UNREACHABLE);
});

test('two-factor and a blocked account each say so, and a sign-in refused for no stated reason is the instance\'s', async () => {
  const cases = [
    [problem(401, 'missing_two_factor'), Code.UNAUTHENTICATED, /two-factor/],
    [problem(400, 'account_blocked'), Code.UNAUTHENTICATED, /blocked/],
    [problem(429), Code.UNAVAILABLE, /a few minutes/],
    [problem(401), Code.UNAVAILABLE, /Signing in failed/],
  ];
  for (const [answer, code, said] of cases) {
    const transport = scripted({ 'GET oauth-clients/local': ok(CLIENT), 'POST users/token': answer });
    await assert.rejects(() => hostFor(withPassword, transport).engine.call('getCategories', []), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, said);
      return true;
    });
  }
});

test('a client the instance no longer knows is fetched again by the next attempt', async () => {
  const transport = scripted({ 'GET oauth-clients/local': ok(CLIENT), 'POST users/token': problem(400, 'invalid_client') });
  const { engine } = hostFor(withPassword, transport);

  await assert.rejects(() => engine.call('getCategories', []), (error) => error.code === Code.UNAVAILABLE);
  await assert.rejects(() => engine.call('getCategories', []), (error) => error.code === Code.UNAVAILABLE);
  assert.equal(transport.calls.filter((c) => c.url.endsWith('/oauth-clients/local')).length, 2);
});

test('a refused password is tried again once the viewer changes it, and forgotten once one works', async () => {
  const storeDir = scratchDir('lp-peertube-');
  // A token that is already in its last minute, so every call signs in again.
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT),
    'POST users/token': (req) => (new URLSearchParams(req.body).get('password') === 'fixed' ? tokens('access-1', 1) : problem(400, 'invalid_grant')),
    'GET video-channels': channels,
  });
  const sent = () => transport.grants('password').map((grant) => new URLSearchParams(grant.body).get('password'));

  await assert.rejects(() => hostFor(withPassword, transport, { storeDir }).engine.call('getCategories', []));
  await assert.rejects(() => hostFor(withPassword, transport, { storeDir }).engine.call('getCategories', []));
  await hostFor({ ...withPassword, password: 'fixed' }, transport, { storeDir }).engine.call('getCategories', []);
  await assert.rejects(() => hostFor(withPassword, transport, { storeDir }).engine.call('getCategories', []));

  assert.deepEqual(sent(), ['hunter2', 'fixed', 'hunter2']);
});

test('without an account a private video says to sign in, and with one only both fields will do', async () => {
  const transport = scripted({ 'GET /videos/p1': problem(401) });
  await assert.rejects(() => hostFor({ instanceUrl: INSTANCE }, transport).engine.call('getMediaDetail', ['p1']), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    assert.match(error.message, /username and password/);
    return true;
  });

  await assert.rejects(
    () => hostFor({ instanceUrl: INSTANCE, username: 'jasper' }, scripted({})).engine.call('getCategories', []),
    (error) => error.code === Code.MISCONFIGURED);
});

test('a refused password is sent once, and the calls after it are refused here', async () => {
  const transport = scripted({ 'GET oauth-clients/local': ok(CLIENT), 'POST users/token': problem(400, 'invalid_grant') });
  const { engine } = hostFor(withPassword, transport);

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => engine.call('getCategories', []), (error) => {
      assert.equal(error.code, Code.UNAUTHENTICATED);
      assert.match(error.message, /username and password/);
      return true;
    });
  }
  assert.equal(transport.grants('password').length, 1);
});

test('a revoked token is renewed once, and a second refusal is the account', async () => {
  let issued = 0;
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT),
    'POST users/token': () => tokens(`access-${issued += 1}`),
    'GET video-channels': (req) => (req.headers.Authorization === 'Bearer access-1' ? problem(401) : channels),
  });
  await hostFor(withPassword, transport).engine.call('getCategories', []);
  assert.equal(transport.grants('password').length, 2);

  const refusing = scripted({ 'GET oauth-clients/local': ok(CLIENT), 'POST users/token': tokens('a'), 'GET video-channels': problem(401) });
  await assert.rejects(() => hostFor(withPassword, refusing).engine.call('getCategories', []), (error) => {
    assert.equal(error.code, Code.UNAUTHENTICATED);
    assert.match(error.message, /permissions/);
    return true;
  });
  assert.equal(refusing.grants('password').length, 2);
});

test('a token in its last minute is renewed with its refresh token, not the password', async () => {
  let clock = 1_000_000;
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT),
    'POST users/token': (req) => tokens(new URLSearchParams(req.body).get('grant_type') === 'password' ? 'first' : 'second', 3600),
    'GET video-channels': channels,
  });
  const { engine } = hostFor(withPassword, transport, { now: () => clock });

  await engine.call('getCategories', []);
  clock += 3600 * 1000 - 30 * 1000;
  await engine.call('getCategories', []);

  const [refresh] = transport.grants('refresh_token');
  assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), 'refresh-first');
  assert.equal(transport.grants('password').length, 1);
  assert.equal(transport.calls.at(-1).headers.Authorization, 'Bearer second');
});

test('a video with a password of its own is unavailable, and costs the session nothing', async () => {
  const transport = scripted({
    'GET oauth-clients/local': ok(CLIENT), 'POST users/token': tokens('access-1'),
    'GET /videos/pw': problem(401, 'video_requires_password'),
  });
  await assert.rejects(() => hostFor(withPassword, transport).engine.call('getMediaDetail', ['pw']), (error) => {
    assert.equal(error.code, Code.UNAVAILABLE);
    return true;
  });
  assert.equal(transport.grants('password').length, 1);
});

test('a square thumbnail is never the poster, however wide it is', async () => {
  const thumbnail = (width, height, aspectRatio) => ({ width, height, aspectRatio, fileUrl: `${INSTANCE}/t-${width}.jpg` });
  const video = { uuid: 's', name: 'Square', thumbnails: [thumbnail(280, 157, '16:9'), thumbnail(1400, 1400, '1:1')] };
  const transport = scripted({ 'GET /videos?': ok({ data: [video] }) });
  const [item] = await hostFor({ instanceUrl: INSTANCE }, transport).engine.call('getMediaList', ['recent', { page: 1 }]);

  assert.equal(item.posterUrl, `${INSTANCE}/t-280.jpg`);
  assert.equal(item.backdropUrl, `${INSTANCE}/t-280.jpg`);
});

test('a video still being processed says so rather than offering nothing to play', async () => {
  const transport = scripted({ 'GET /videos/new': ok({ uuid: 'new', name: 'Just uploaded', streamingPlaylists: [], files: [] }) });
  await assert.rejects(() => hostFor({ instanceUrl: INSTANCE }, transport).engine.call('getMediaDetail', ['new']), (error) => {
    assert.equal(error.code, Code.UNAVAILABLE);
    assert.match(error.message, /processed/);
    return true;
  });
});

test('an audio-only file is passed over for one with a picture', async () => {
  const video = {
    uuid: 'w', name: 'Web', isLocal: true, streamingPlaylists: [],
    files: [
      { resolution: { id: 0 }, hasVideo: false, fileUrl: `${INSTANCE}/static/web-videos/w-0.mp4` },
      { resolution: { id: 480 }, fileUrl: `${INSTANCE}/static/web-videos/w-480.mp4` },
      { resolution: { id: 1080 }, fileUrl: `${INSTANCE}/static/web-videos/w-1080.mp4` },
    ],
  };
  const transport = scripted({ 'GET /videos/w/captions': ok({ data: [] }), 'GET /videos/w': ok(video) });
  const [{ stream }] = (await hostFor({ instanceUrl: INSTANCE }, transport).engine.call('getMediaDetail', ['w'])).playbackOptions;

  assert.equal(stream.url, `${INSTANCE}/static/web-videos/w-1080.mp4`);
});

test('no sentence a viewer reads names the instance', async () => {
  const failures = [
    scripted({ 'GET /videos/p1': problem(401) }),
    scripted({ 'GET /videos/p1': problem(500) }),
    scripted({ 'GET /videos/p1': { status: 200, headers: {}, bodyBase64: body('<html>') } }),
  ];
  for (const transport of failures) {
    await assert.rejects(() => hostFor({ instanceUrl: INSTANCE }, transport).engine.call('getMediaDetail', ['p1']), (error) => {
      assert.ok(!error.message.includes('videos.test'), error.message);
      return true;
    });
  }
});
