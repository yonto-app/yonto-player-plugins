import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';
import { CONFIG, DEVICE, MOVIE_ID, PLAY_SESSION, SERIES_ID } from '../scripts/write-jellyfin-fixtures.js';

// A fixtures-only regression test for a plugin that lives outside this package, the way
// iyingshi.test.js is: plugins/jellyfin is otherwise only exercised by `doctor --replay`,
// a manual command, so a regression there would not fail `npm test`.
//
// The real gate is JsJellyfinPluginAdapterTest, which runs the same plugin against
// MockWebServer with the deleted Kotlin adapter's own unedited assertions. What this file adds is
// that the URLs the plugin builds stay exactly the ones the fixtures were written for —
// fixture identity is sha256(url + "\n" + body), so a changed query parameter fails here
// as NO_FIXTURE rather than quietly against a live server.
const dir = fileURLToPath(new URL('../../../plugins/jellyfin/', import.meta.url));

function engine() {
  const manifest = loadManifest(dir);
  const replay = createReplayTransport({ dir: join(dir, 'fixtures') });
  // What went out, bodies included, which the host's own log of requests leaves out.
  const sent = [];
  const transport = { request: (req) => { sent.push(req); return replay.request(req); } };
  const storeDir = scratchDir('lp-jellyfin-');
  const host = createHost({
    pluginDir: dir,
    // The manifest as it ships, not one edited to allow the server: serverUrl is a `url`
    // field, so the configured host is contributed by the rule both hosts apply. A test
    // that arranged the allowlist would be arranging the thing it means to prove.
    manifest,
    config: CONFIG,
    transport,
    storeDir,
  });
  return { engine: createEngine({ dir, host }), requests: host.requests, sent };
}

test('only movie and tv show libraries become categories', async () => {
  const categories = await engine().engine.call('getCategories', []);

  assert.deepEqual(categories.map((c) => c.id), ['lib-movies', 'lib-shows']);
  assert.ok(categories[0].thumbnailUrl.includes('/Items/lib-movies/Images/Primary'));
});

test('filters offer type statically, and the genres and years the library actually holds', async () => {
  const filters = await engine().engine.call('getFilters', ['lib-movies']);

  assert.deepEqual(filters.map((f) => f.id), ['type', 'genre', 'year']);
  assert.deepEqual(filters[0].options.map((o) => o.id), ['Movie', 'Series']);
  assert.deepEqual(filters[1].options.map((o) => o.id), ['Action', 'Drama']);
  assert.deepEqual(filters[2].options.map((o) => o.id), ['2014', '2010', '2008']);
});

test('a listing asks for the year and the ids alone, never the fields a summary cannot carry', async () => {
  const { engine: e, requests } = engine();
  await e.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);

  const { url } = requests[0];
  assert.ok(url.includes('Fields=ProductionYear%2CProviderIds'));
  assert.ok(!url.includes('Overview'));
  assert.ok(!url.includes('Genres'));
});

test('a title carries the database ids the server knows it by', async () => {
  const items = await engine().engine.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);

  assert.deepEqual(items.find((item) => item.id === MOVIE_ID).ids, { tmdb: '9003', imdb: 'tt9000003' });
  assert.equal(items.find((item) => item.type === 'SERIES').ids, undefined);

  const detail = await engine().engine.call('getMediaDetail', [MOVIE_ID]);
  assert.deepEqual(detail.ids, { tmdb: '9003', imdb: 'tt9000003' });
});

test('images are asked for at the size they will be drawn at, not the size they are stored at', async () => {
  const items = await engine().engine.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);

  const movie = items.find((item) => item.id === MOVIE_ID);
  assert.ok(movie.posterUrl.includes('maxWidth=480'));
  assert.ok(movie.posterUrl.includes('quality=90'));
  assert.ok(movie.backdropUrl.includes('maxWidth=1920'));
});

// A track, redeemed on Play, because what the server sends is for one play on one device and a
// detail is cached and kept.
test('a movie has one Play option, a track the direct-play endpoint redeems when no device is named', async () => {
  const { engine: e, requests } = engine();
  const detail = await e.call('getMediaDetail', [MOVIE_ID]);

  assert.equal(detail.type, 'MOVIE');
  assert.deepEqual(detail.playbackOptions, [{ label: 'Play', id: MOVIE_ID, track: MOVIE_ID, video: { width: 3840, height: 1606, range: 'dolbyVision' } }]);
  assert.equal(requests.some((r) => r.url.includes('/MediaSegments/')), false, 'a detail asks for no stream');

  const stream = await e.call('getStream', [MOVIE_ID]);
  assert.ok(stream.url.includes(`/Videos/${MOVIE_ID}/stream`));
  assert.ok(stream.url.includes('static=true'));
  assert.equal(stream.mimeType, 'video/mp4');
  assert.equal(stream.session, undefined);
  assert.equal(requests.some((r) => r.url.includes('/PlaybackInfo')), false, 'a download asks the server nothing');
});

test('a movie offers its text subtitle files, a format the host cannot play asked for as SubRip', async () => {
  const stream = await engine().engine.call('getStream', [MOVIE_ID]);
  const subtitles = `${CONFIG.serverUrl}/Videos/${MOVIE_ID}/${MOVIE_ID}/Subtitles`;

  // The PGS file is a picture and the MOV_TEXT track is inside the video, so neither is offered.
  assert.deepEqual(stream.subtitles, [
    { url: `${subtitles}/0/Stream.srt`, label: 'English', language: 'eng', mimeType: 'application/x-subrip', forced: false, default: true },
    { url: `${subtitles}/1/Stream.srt`, label: 'Korean', language: 'kor', mimeType: 'application/x-subrip', forced: false, default: false },
  ]);
});

test('an episode is a track whose stream offers its own subtitle files, and one without any offers none', async () => {
  const { engine: e, requests } = engine();
  const options = (await e.call('getMediaDetail', [SERIES_ID])).playbackOptions;
  const first = await e.call('getStream', [options[0].track]);
  const second = await e.call('getStream', [options[1].track]);

  assert.deepEqual(options.map((o) => o.track), ['ep1', 'ep2']);
  // The listing asks for each episode's size and never its streams, which would weigh every open of the show.
  assert.ok(requests[1].url.includes('Fields=Width%2CHeight&'), requests[1].url);
  assert.ok(!requests[1].url.includes('MediaStreams'), requests[1].url);
  assert.ok(requests[2].url.includes('/Items/ep1?Fields=MediaStreams'), requests[2].url);
  assert.ok(first.url.includes('/Videos/ep1/stream'), first.url);
  assert.equal(first.headers.Authorization, `MediaBrowser Token="${CONFIG.apiKey}"`);
  assert.deepEqual(first.subtitles, [{
    url: `${CONFIG.serverUrl}/Videos/ep1/ep1/Subtitles/0/Stream.ass`,
    label: 'Chinese',
    language: 'chi',
    mimeType: 'text/x-ssa',
    forced: true,
    default: false,
  }]);
  assert.equal(second.subtitles, undefined);
});

test('an episode says its size from the listing, and only the film its range, from its own streams', async () => {
  const options = (await engine().engine.call('getMediaDetail', [SERIES_ID])).playbackOptions;

  assert.deepEqual(options.map((o) => o.video), [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]);
});

test('a series becomes one option per episode, labelled, seasoned and numbered', async () => {
  const detail = await engine().engine.call('getMediaDetail', [SERIES_ID]);

  assert.equal(detail.type, 'SERIES');
  assert.deepEqual(detail.playbackOptions.map((o) => o.label),
    ['S1E01 · Earthfall', 'S1E02 · Caches']);
  assert.deepEqual(detail.playbackOptions.map((o) => o.season), [1, 1]);
  assert.deepEqual(detail.playbackOptions.map((o) => o.episode), [1, 2]);
});

test('an episode with no artwork of its own borrows the series backdrop', async () => {
  const items = await engine().engine.call('getMediaList', ['lib-shows', { page: 1, filters: {} }]);

  const episode = items.find((item) => item.id === 'ep1');
  assert.ok(episode.backdropUrl.includes(`/Items/${SERIES_ID}/Images/Backdrop`),
    `expected the series backdrop, got ${episode.backdropUrl}`);
  assert.ok(episode.backdropUrl.includes('tag=pioneerBackdropTag'));
});

test('unrated titles are dropped from recommendations rather than shown as picks', async () => {
  const picks = await engine().engine.call('getRecommendations', []);

  assert.deepEqual(picks.map((p) => p.id), [MOVIE_ID, 'm2']);
});

test('the api key travels as a header and never in a url', async () => {
  const { engine: e, requests } = engine();
  const detail = await e.call('getMediaDetail', [MOVIE_ID]);
  const stream = await e.call('getStream', [MOVIE_ID]);
  const expected = `MediaBrowser Token="${CONFIG.apiKey}"`;

  assert.equal(requests[0].requestHeaders.Authorization, expected);
  assert.ok(!requests[0].url.includes(CONFIG.apiKey), 'an API call carries the key in its header, not its URL');

  // A poster goes to the image loader and a stream to the player, neither of which speaks
  // yonto.fetch. A 12.x server reads a key from one place only — an `Authorization`
  // header — so those two say what to send rather than signing themselves, and the key
  // stays out of every URL that gets logged, cached or put in a bug report.
  assert.equal(stream.headers.Authorization, expected);
  assert.ok(!stream.url.includes(CONFIG.apiKey));
  assert.ok(!detail.posterUrl.includes(CONFIG.apiKey));
  assert.deepEqual(await e.call('getImageHeaders', []), { Authorization: expected });
});

test('a url the fixtures were not written for is a miss, never a silently wrong answer', async () => {
  const { engine: e } = engine();

  await assert.rejects(
    () => e.call('getMediaList', ['lib-movies', { page: 7, filters: {} }]),
    (error) => error.code === Code.NO_FIXTURE,
  );
});

test('a movie\'s intro and outro become segments in seconds, and an Unknown one is left out', async () => {
  const { engine: e, requests } = engine();
  const stream = await e.call('getStream', [MOVIE_ID]);

  assert.deepEqual(stream.segments, [{ type: 'intro', start: 5, end: 20 }, { type: 'credits', start: 580, end: 596 }]);
  assert.ok(requests.some((r) => r.url.endsWith(`/MediaSegments/${MOVIE_ID}`)));
});

test('an episode asked for by its track carries its recap, and a server that has no segments still plays it', async () => {
  const e = engine().engine;

  // The intro that ends where it starts is dropped, and the outro with no end runs to the end.
  assert.deepEqual((await e.call('getStream', ['ep1'])).segments, [{ type: 'recap', start: 0, end: 12.5 }, { type: 'credits', start: 500 }]);
  assert.equal((await e.call('getStream', ['ep3'])).segments.length, 32);
  const plain = await e.call('getStream', ['ep2']);
  assert.match(plain.url, /\/Videos\/ep2\/stream/);
  assert.equal('segments' in plain, false);
});

test('with what the device plays, the server is asked, and a stream it converts is its HLS without the key it wrote in', async () => {
  const { engine: e, requests } = engine();
  const stream = await e.call('getStream', [MOVIE_ID, { device: DEVICE }]);

  const asked = requests.find((r) => r.url.includes(`/Items/${MOVIE_ID}/PlaybackInfo`));
  assert.ok(asked, 'the server was asked to decide');
  assert.equal(asked.method, 'POST');
  assert.equal(stream.mimeType, 'application/x-mpegURL');
  assert.ok(stream.url.startsWith(`${CONFIG.serverUrl}/videos/${MOVIE_ID}/master.m3u8?`), stream.url);
  assert.ok(stream.url.includes(`PlaySessionId=${PLAY_SESSION}`), stream.url);
  assert.equal(/ApiKey|api_key/i.test(stream.url), false, stream.url);
  assert.equal(stream.headers.Authorization, `MediaBrowser Token="${CONFIG.apiKey}"`);
  assert.deepEqual(JSON.parse(stream.session), { playSessionId: PLAY_SESSION, mediaSourceId: MOVIE_ID, playMethod: 'Transcode' });
  // A conversion's HLS carries no subtitle track, so the text one inside the file is offered as a
  // file beside the two that already were, and the stream keeps its segments.
  assert.deepEqual(stream.subtitles.map((s) => s.label), ['English', 'Korean', 'German']);
  assert.equal(stream.subtitles[2].url, `${CONFIG.serverUrl}/Videos/${MOVIE_ID}/${MOVIE_ID}/Subtitles/3/Stream.srt`);
  assert.deepEqual(stream.segments, [{ type: 'intro', start: 5, end: 20 }, { type: 'credits', start: 580, end: 596 }]);
});

test('the device the server is told about is its decoders, sizes, bit depth and the screen\'s range', async () => {
  const { engine: e, sent } = engine();
  await e.call('getStream', [MOVIE_ID, { device: DEVICE }]);

  const { DeviceProfile, SubtitleStreamIndex } = JSON.parse(sent.find((r) => r.url.includes('/PlaybackInfo')).body);
  assert.equal(SubtitleStreamIndex, -1, 'no subtitle is ever burned in');
  assert.deepEqual(DeviceProfile.DirectPlayProfiles, [{
    Type: 'Video', Container: 'mp4,m4v,mov,mkv,webm,ts,mpegts,m2ts', VideoCodec: 'h264,hevc', AudioCodec: 'aac,mp3,ac3,eac3,dts,dca',
  }]);
  assert.deepEqual(DeviceProfile.CodecProfiles.map((p) => p.Codec), ['h264', 'hevc']);
  assert.deepEqual(DeviceProfile.CodecProfiles[1].Conditions.map((c) => [c.Property, c.Value]), [
    ['Width', '1920'], ['Height', '1080'], ['VideoBitDepth', '8'], ['VideoRangeType', 'SDR|DOVIWithSDR'],
  ]);
  // Encoded to H.264, and HEVC the device plays copied, in fMP4, the HLS container AVPlayer takes HEVC in.
  assert.equal(DeviceProfile.TranscodingProfiles[0].Protocol, 'hls');
  assert.equal(DeviceProfile.TranscodingProfiles[0].VideoCodec, 'h264,hevc');
  assert.equal(DeviceProfile.TranscodingProfiles[0].Container, 'mp4');
});

test('a device with no HEVC decoder is sent H.264 in transport stream', async () => {
  const { engine: e, sent } = engine();
  // Not recorded: the request is what is checked, so the miss after it is expected.
  await e.call('getStream', [MOVIE_ID, { device: { ...DEVICE, video: [DEVICE.video[0]] } }]).catch(() => {});

  const { DeviceProfile } = JSON.parse(sent.find((r) => r.url.includes('/PlaybackInfo')).body);
  assert.equal(DeviceProfile.TranscodingProfiles[0].VideoCodec, 'h264');
  assert.equal(DeviceProfile.TranscodingProfiles[0].Container, 'ts');
});

test('a screen that shows HDR10 lets HDR10, HDR10+ and Dolby Vision with an HDR10 layer play as stored', async () => {
  const { engine: e, sent } = engine();
  // Not recorded: the request is what is checked, so the miss after it is expected.
  await e.call('getStream', [MOVIE_ID, { device: { ...DEVICE, hdr: ['hdr10'] } }]).catch(() => {});

  const { DeviceProfile } = JSON.parse(sent.find((r) => r.url.includes('/PlaybackInfo')).body);
  assert.equal(DeviceProfile.CodecProfiles[0].Conditions[3].Value, 'SDR|DOVIWithSDR|HDR10|HDR10Plus|DOVIWithHDR10');
});

test('a file the server says plays as stored is the direct-play endpoint, under the server\'s own session', async () => {
  const stream = await engine().engine.call('getStream', ['ep1', { device: DEVICE }]);

  assert.match(stream.url, /\/Videos\/ep1\/stream\?static=true/);
  assert.equal(stream.mimeType, 'video/mp4');
  assert.deepEqual(JSON.parse(stream.session), { playSessionId: 'play-session-2', mediaSourceId: 'ep1', playMethod: 'DirectPlay' });
});

test('a server that cannot decide still plays the file as stored', async () => {
  const stream = await engine().engine.call('getStream', ['ep2', { device: DEVICE }]);

  assert.match(stream.url, /\/Videos\/ep2\/stream\?static=true/);
  assert.equal(stream.session, undefined);
});

test('a report hands the server back its own play session and method, so the stop ends its conversion', async () => {
  const { engine: e, sent } = engine();
  const { session } = await e.call('getStream', [MOVIE_ID, { device: DEVICE }]);
  // The one without a session is jellyfin-play-state.test.js's, scripted: its session is made from
  // the install id, which the CLI derives from this checkout's path, so no fixture could hold it.
  await e.call('reportPlayback', [{ mediaId: MOVIE_ID, event: 'stop', paused: true, position: 30, session }]);

  const decided = JSON.parse(sent.find((r) => r.url.endsWith('/Sessions/Playing/Stopped')).body);
  assert.equal(decided.PlaySessionId, PLAY_SESSION);
  assert.equal(decided.PlayMethod, 'Transcode');
});

// Dolby Vision with any other layer is Dolby Vision, the strongest thing the file is.
test('each range type Jellyfin names becomes the contract\'s, and one it does not know says no range', async () => {
  const rangeFor = async (VideoRangeType) => {
    const film = { Id: 'f', Name: 'Film', Type: 'Movie', MediaStreams: [{ Type: 'Video', Width: 1920, Height: 1080, VideoRangeType }] };
    const transport = { async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from(JSON.stringify(film)).toString('base64') }; } };
    const host = createHost({ pluginDir: dir, manifest: loadManifest(dir), config: CONFIG, transport, storeDir: scratchDir('lp-jellyfin-') });
    return (await createEngine({ dir, host }).call('getMediaDetail', ['f'])).playbackOptions[0].video.range;
  };

  assert.deepEqual(
    await Promise.all(['SDR', 'HDR10', 'HDR10Plus', 'HLG', 'DOVI', 'DOVIWithHDR10', 'DOVIWithHLG', 'DOVIWithSDR', 'Unknown'].map(rangeFor)),
    ['sdr', 'hdr10', 'hdr10plus', 'hlg', 'dolbyVision', 'dolbyVision', 'dolbyVision', 'dolbyVision', undefined],
  );
});
