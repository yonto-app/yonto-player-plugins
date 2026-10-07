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
import { CONFIG, MOVIE_ID, SERIES_ID } from '../scripts/write-jellyfin-fixtures.js';

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
  const transport = createReplayTransport({ dir: join(dir, 'fixtures') });
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
  return { engine: createEngine({ dir, host }), requests: host.requests };
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

test('a listing asks for ProductionYear alone, never the fields a summary cannot carry', async () => {
  const { engine: e, requests } = engine();
  await e.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);

  const { url } = requests[0];
  assert.ok(url.includes('Fields=ProductionYear'));
  assert.ok(!url.includes('Overview'));
  assert.ok(!url.includes('Genres'));
});

test('images are asked for at the size they will be drawn at, not the size they are stored at', async () => {
  const items = await engine().engine.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);

  const movie = items.find((item) => item.id === MOVIE_ID);
  assert.ok(movie.posterUrl.includes('maxWidth=480'));
  assert.ok(movie.posterUrl.includes('quality=90'));
  assert.ok(movie.backdropUrl.includes('maxWidth=1920'));
});

test('a movie has one Play option pointing at the direct-play endpoint', async () => {
  const detail = await engine().engine.call('getMediaDetail', [MOVIE_ID]);

  assert.equal(detail.type, 'MOVIE');
  assert.equal(detail.playbackOptions.length, 1);
  assert.equal(detail.playbackOptions[0].label, 'Play');
  assert.ok(detail.playbackOptions[0].stream.url.includes(`/Videos/${MOVIE_ID}/stream`));
  assert.ok(detail.playbackOptions[0].stream.url.includes('static=true'));
  assert.equal(detail.playbackOptions[0].stream.mimeType, 'video/mp4');
});

test('a series becomes one option per episode, labelled and seasoned', async () => {
  const detail = await engine().engine.call('getMediaDetail', [SERIES_ID]);

  assert.equal(detail.type, 'SERIES');
  assert.deepEqual(detail.playbackOptions.map((o) => o.label),
    ['S1E01 · Earthfall', 'S1E02 · Caches']);
  assert.deepEqual(detail.playbackOptions.map((o) => o.season), [1, 1]);
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
  const expected = `MediaBrowser Token="${CONFIG.apiKey}"`;

  assert.equal(requests[0].requestHeaders.Authorization, expected);
  assert.ok(!requests[0].url.includes(CONFIG.apiKey), 'an API call carries the key in its header, not its URL');

  // A poster goes to the image loader and a stream to the player, neither of which speaks
  // yonto.fetch. A 12.x server reads a key from one place only — an `Authorization`
  // header — so those two say what to send rather than signing themselves, and the key
  // stays out of every URL that gets logged, cached or put in a bug report.
  assert.equal(detail.playbackOptions[0].stream.headers.Authorization, expected);
  assert.ok(!detail.playbackOptions[0].stream.url.includes(CONFIG.apiKey));
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
