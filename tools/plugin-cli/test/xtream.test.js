import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { PluginError, Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** `plugins/xtream`, against a scripted panel: what is under test is the reading of its API. */
const dir = fileURLToPath(new URL('../../../plugins/xtream/', import.meta.url));

const SERVER = 'http://panel.test:8080';
const LOGIN = { username: 'viewer', password: 's3cret&x' };

const ACCOUNT = { user_info: { auth: 1, status: 'Active', allowed_output_formats: ['m3u8', 'ts'] } };

const CATEGORIES = {
  get_live_categories: [{ category_id: '1', category_name: 'News' }, { category_id: '2', category_name: 'Sport' }],
  get_vod_categories: [{ category_id: '10', category_name: 'New films' }, { category_id: '11', category_name: 'Classics' }],
  get_series_categories: [{ category_id: '20', category_name: 'Drama' }],
};

const STREAMS = {
  get_live_streams: {
    1: [{ num: 2, name: 'World News', stream_id: 7, stream_icon: 'http://img.test/news.png' }, { num: 1, name: 'Local News', stream_id: 8 }],
    2: [{ num: 3, name: 'Sport One', stream_id: 9 }],
  },
  get_vod_streams: {
    10: [
      { name: 'Heist (2025)', title: 'Heist', year: '2025', stream_id: 100, added: '100', container_extension: 'mkv', stream_icon: 'http://img.test/heist.jpg' },
      { name: 'Later Heist', stream_id: 101, added: '200', container_extension: 'mp4', release_date: '2026-01-02' },
    ],
    // A film in two categories is one title.
    11: [{ name: 'Old Film', stream_id: 102, added: '50', container_extension: 'avi' }, { name: 'Heist (2025)', title: 'Heist', stream_id: 100, added: '100' }],
  },
  get_series: {
    20: [{ name: 'The Show (2024)', title: 'The Show', series_id: 300, cover: 'http://img.test/show.jpg', last_modified: '10' }],
  },
};

const VOD_INFO = {
  100: {
    info: { name: 'Heist', plot: 'A plan.', genre: 'Crime, Drama', releasedate: '2025-03-01', cover_big: 'http://img.test/heist-big.jpg', backdrop_path: ['http://img.test/heist-bg.jpg'] },
    movie_data: { stream_id: 100, title: 'Heist', name: 'Heist (2025)', year: '2025', container_extension: 'mkv' },
  },
};

const SERIES_INFO = {
  300: {
    info: { name: 'The Show (2024)', title: 'The Show', plot: 'People.', cover: 'http://img.test/show.jpg', year: '2024' },
    episodes: {
      2: [{ id: '3002', episode_num: '1', title: 'The Show - S02E01 - Return', container_extension: 'mkv', season: 2 }],
      1: [
        { id: '3011', episode_num: '2', title: 'The Show - S01E02 - Second', container_extension: 'mp4', season: 1 },
        { id: '3010', episode_num: '1', title: 'S01E01 - Pilot', container_extension: 'mp4', season: 1 },
      ],
    },
  },
};

const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(JSON.stringify(value)).toString('base64') });

/** The panel's answer to one request, or a tweak's: return undefined from [answer] to fall through. */
function panelAnswer(url, answer) {
  const query = new URL(url).searchParams;
  const tweaked = answer?.(query);
  if (tweaked !== undefined) return tweaked;
  const action = query.get('action');
  if (action === null) return json(ACCOUNT);
  if (CATEGORIES[action]) return json(CATEGORIES[action]);
  if (STREAMS[action]) {
    const category = query.get('category_id');
    return json(category === null ? Object.values(STREAMS[action]).flat() : STREAMS[action][category] ?? []);
  }
  if (action === 'get_vod_info') return json(VOD_INFO[query.get('vod_id')] ?? { info: [] });
  if (action === 'get_series_info') return json(SERIES_INFO[query.get('series_id')] ?? { info: {}, episodes: [] });
  return json({}, 404);
}

function engineOver({ answer, config = {}, now = Date.now, cacheDir = scratchDir('lp-xtream-cache-') } = {}) {
  const transport = {
    calls: [],
    inFlight: 0,
    mostInFlight: 0,
    async request(req) {
      this.calls.push(req.url);
      this.inFlight += 1;
      this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return panelAnswer(req.url, answer);
      } finally {
        this.inFlight -= 1;
      }
    },
  };
  const host = createHost({
    manifest: loadManifest(dir),
    config: { server: SERVER, ...LOGIN, ...config },
    transport,
    storeDir: scratchDir('lp-xtream-'),
    cacheDir,
    pluginDir: dir,
    now,
  });
  return { transport, host, engine: createEngine({ dir, host }) };
}

const failure = (promise) => promise.then(() => null, (error) => error);
const actions = (calls) => calls.map((url) => new URL(url).searchParams.get('action') ?? 'account');

test('the libraries are Live TV, Films and Series, each only where the panel has a category of it', async () => {
  const { engine } = engineOver();
  assert.deepEqual(await engine.call('getCategories', []), [
    { id: 'live', name: 'Live TV' },
    { id: 'movie', name: 'Films' },
    { id: 'series', name: 'Series' },
  ]);

  const noSeries = engineOver({ answer: (q) => (q.get('action') === 'get_series_categories' ? json([]) : undefined) });
  assert.deepEqual((await noSeries.engine.call('getCategories', [])).map((c) => c.id), ['live', 'movie']);
});

test("a library's filter is the panel's categories, on the first, with no all", async () => {
  const { engine } = engineOver();

  assert.deepEqual(await engine.call('getFilters', ['movie']), [{
    id: 'category',
    name: 'Category',
    init: '10',
    options: [{ id: '10', name: 'New films' }, { id: '11', name: 'Classics' }],
  }]);
});

test('a listing is one category, the first when none is named, films the latest first and channels in panel order', async () => {
  const { engine, transport } = engineOver();

  const films = await engine.call('getMediaList', ['movie', { page: 1 }]);
  const classics = await engine.call('getMediaList', ['movie', { page: 1, filters: { category: '11' } }]);
  const news = await engine.call('getMediaList', ['live', { page: 1 }]);

  assert.deepEqual(films, [
    { id: 'movie:101', title: 'Later Heist', type: 'MOVIE', year: '2026' },
    { id: 'movie:100', title: 'Heist', type: 'MOVIE', posterUrl: 'http://img.test/heist.jpg', year: '2025' },
  ]);
  assert.deepEqual(classics.map((m) => m.title), ['Heist', 'Old Film']);
  assert.deepEqual(news.map((m) => m.title), ['Local News', 'World News']);
  // One category per request: a panel's whole film list can be larger than a plugin may read.
  assert.ok(transport.calls.every((url) => !/action=get_vod_streams(?!&category_id=)/.test(url)));
  assert.deepEqual(await engine.call('getMediaList', ['movie', { page: 2 }]), []);
});

test('a series lists as one, and its page has every episode in order with the stream on the series path', async () => {
  const { engine } = engineOver();

  const [show] = await engine.call('getMediaList', ['series', { page: 1 }]);
  const detail = await engine.call('getMediaDetail', [show.id]);

  assert.equal(show.type, 'SERIES');
  assert.equal(detail.title, 'The Show');
  assert.deepEqual(detail.playbackOptions.map((o) => [o.label, o.season, o.episode]), [
    ['S1E01 · Pilot', 1, 1],
    ['S1E02 · Second', 1, 2],
    ['S2E01 · Return', 2, 1],
  ]);
  assert.deepEqual(detail.playbackOptions[0].stream, { url: `${SERVER}/series/viewer/s3cret%26x/3010.mp4`, mimeType: 'video/mp4' });
});

test('a film plays its file, its page says what the panel says about it', async () => {
  const { engine } = engineOver();

  const detail = await engine.call('getMediaDetail', ['movie:100']);

  assert.deepEqual(detail, {
    id: 'movie:100',
    title: 'Heist',
    type: 'MOVIE',
    posterUrl: 'http://img.test/heist-big.jpg',
    backdropUrl: 'http://img.test/heist-bg.jpg',
    year: '2025',
    genres: ['Crime', 'Drama'],
    synopsis: 'A plan.',
    playbackOptions: [{ label: 'Heist', stream: { url: `${SERVER}/movie/viewer/s3cret%26x/100.mkv`, mimeType: 'video/mp4' } }],
  });
});

test('a channel plays live as TS, and as HLS for an account that may not have TS', async () => {
  const { engine } = engineOver();
  const hlsOnly = engineOver({ answer: (q) => (q.get('action') === null ? json({ user_info: { ...ACCOUNT.user_info, allowed_output_formats: ['m3u8'] } }) : undefined) });

  const ts = await engine.call('getMediaDetail', ['live:7']);
  const hls = await hlsOnly.engine.call('getMediaDetail', ['live:7']);

  assert.equal(ts.title, 'World News');
  assert.deepEqual(ts.playbackOptions[0].stream, { url: `${SERVER}/live/viewer/s3cret%26x/7.ts`, mimeType: 'video/mp4', live: true });
  assert.deepEqual(hls.playbackOptions[0].stream, { url: `${SERVER}/live/viewer/s3cret%26x/7.m3u8`, mimeType: 'application/x-mpegURL', live: true });
});

test('a title the panel does not have is not found', async () => {
  const { engine } = engineOver();

  for (const id of ['movie:999', 'series:999', 'live:999', 'nonsense', 'radio:1']) {
    assert.equal((await failure(engine.call('getMediaDetail', [id]))).code, 'NOT_FOUND', id);
  }
});

test('search reads each library once, one request at a time, and asks nothing the next time', async () => {
  const { engine, transport } = engineOver();

  const first = await engine.call('search', ['HEIST']);
  const before = transport.calls.length;
  const second = await engine.call('search', ['news']);

  assert.deepEqual(first.map((m) => m.id), ['movie:100', 'movie:101']);
  assert.deepEqual(second.map((m) => m.title), ['World News', 'Local News']);
  assert.deepEqual(actions(transport.calls), ['account', 'get_live_streams', 'get_vod_streams', 'get_series']);
  assert.equal(transport.calls.length, before);
  assert.equal(transport.mostInFlight, 1);
});

test('the index outlives the runtime: a search after a restart asks the panel for the account alone', async () => {
  const cacheDir = scratchDir('lp-xtream-kept-');
  await engineOver({ cacheDir }).engine.call('search', ['heist']);

  const { engine, transport } = engineOver({ cacheDir });
  const found = await engine.call('search', ['heist']);

  assert.deepEqual(found, [
    { id: 'movie:100', title: 'Heist', type: 'MOVIE', posterUrl: 'http://img.test/heist.jpg', year: '2025' },
    { id: 'movie:101', title: 'Later Heist', type: 'MOVIE', year: '2026' },
  ]);
  assert.deepEqual(actions(transport.calls), ['account']);
});

test("an index kept for another account, or kept too long, is read again", async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-xtream-owner-');
  await engineOver({ cacheDir, now: () => clock }).engine.call('search', ['heist']);

  const otherAccount = engineOver({ cacheDir, now: () => clock, config: { username: 'someone-else' } });
  await otherAccount.engine.call('search', ['heist']);
  clock += 12 * 60 * 60 * 1000;
  const later = engineOver({ cacheDir, now: () => clock, config: { username: 'someone-else' } });
  await later.engine.call('search', ['heist']);

  assert.deepEqual(actions(otherAccount.transport.calls), ['account', 'get_live_streams', 'get_vod_streams', 'get_series']);
  assert.deepEqual(actions(later.transport.calls), ['account', 'get_live_streams', 'get_vod_streams', 'get_series']);
});

test('an index carried on by category is kept as far as it got, and the next runtime carries on from there', async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-xtream-partial-');
  const answer = (q) => {
    if (q.get('action') === 'get_vod_streams' && q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
    if (q.get('action') === 'get_vod_streams') clock += 12_000;
    return undefined;
  };
  await engineOver({ cacheDir, now: () => clock, answer }).engine.call('search', ['heist']);

  const { engine, transport, host } = engineOver({ cacheDir, now: () => clock, answer });
  const found = await engine.call('search', ['old']);

  assert.deepEqual(found.map((m) => m.id), ['movie:102']);
  assert.match(host.takePartial(), /Search again/);
  assert.deepEqual(actions(transport.calls), ['account', 'get_vod_categories', 'get_vod_streams']);
  assert.equal(new URL(transport.calls[2]).searchParams.get('category_id'), '11');
});

test('an index read by category is begun again once it is twelve hours old, however recently it was kept', async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-xtream-aged-');
  const answer = (q) => {
    if (q.get('action') === 'get_vod_streams' && q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
    if (q.get('action') === 'get_vod_streams') clock += 12_000;
    return undefined;
  };
  await engineOver({ cacheDir, now: () => clock, answer }).engine.call('search', ['heist']);
  clock += 11 * 60 * 60 * 1000;
  const carriedOn = engineOver({ cacheDir, now: () => clock, answer });
  await carriedOn.engine.call('search', ['old']);
  clock += 60 * 60 * 1000;
  const begunAgain = engineOver({ cacheDir, now: () => clock, answer });
  await begunAgain.engine.call('search', ['old']);

  const films = (calls) => calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));
  assert.deepEqual(films(carriedOn.transport.calls), ['11']);
  assert.deepEqual(films(begunAgain.transport.calls), [null, '10']);
});

test('an index the cache does not keep is held for the runtime, so a second search reads no list again', async () => {
  const { engine, transport } = engineOver({ cacheDir: null });
  await engine.call('search', ['heist']);
  const before = transport.calls.length;

  const found = await engine.call('search', ['later']);

  assert.deepEqual(found.map((m) => m.id), ['movie:101']);
  assert.deepEqual(actions(transport.calls.slice(before)), []);
});

test('an index read by category that the cache does not keep carries on in memory, every chunk it read before kept', async () => {
  let clock = 1_000_000;
  const listings = { 10: bigFilms(1, 5000, '10'), 11: bigFilms(5001, 10, '11') };
  const answer = (q) => {
    if (q.get('action') !== 'get_vod_streams') return undefined;
    if (q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
    clock += 12_000;
    return json(listings[q.get('category_id')]);
  };
  const { engine, transport } = engineOver({ cacheDir: null, now: () => clock, answer });
  const films = () => transport.calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));

  await engine.call('search', ['nothing like it']);
  const added = await engine.call('search', ['big film 5010']);
  const first = await engine.call('search', ['big film 1']);

  assert.deepEqual(films(), [null, '10', '11']);
  assert.deepEqual(added.map((m) => m.id), ['movie:5010']);
  assert.equal(first[0].id, 'movie:1');
});

test('a search finds at most a hundred titles', async () => {
  const films = Array.from({ length: 150 }, (_, i) => ({ name: `Film ${i}`, stream_id: 1000 + i, added: String(i) }));
  const { engine } = engineOver({ answer: (q) => (q.get('action') === 'get_vod_streams' ? json(films) : undefined) });

  assert.equal((await engine.call('search', ['film'])).length, 100);
});

// Films with long poster addresses, so a few thousand of them pass the plugin's 2 Mi characters a chunk.
const bigFilms = (from, count, category, prefix = 'Big') => Array.from({ length: count }, (_, i) => ({
  name: `${prefix} Film ${from + i}`, stream_id: from + i, added: String(from + i), category_id: category,
  stream_icon: `http://img.test/${'p'.repeat(500)}/${from + i}.jpg`,
}));
const chunkFile = (cacheDir, key) => join(cacheDir, createHash('sha256').update(key).digest('hex'));

test('an index larger than a chunk survives a restart, and its last chunk is searched', async () => {
  const cacheDir = scratchDir('lp-xtream-chunks-');
  const films = bigFilms(1, 6000, '10');
  const answer = (q) => (q.get('action') === 'get_vod_streams' ? json(films) : undefined);
  await engineOver({ cacheDir, answer }).engine.call('search', ['nothing like it']);

  const { engine, transport } = engineOver({ cacheDir, answer });
  const found = await engine.call('search', ['big film 6000']);

  assert.deepEqual(found.map((m) => m.id), ['movie:6000']);
  assert.deepEqual(actions(transport.calls), ['account']);
  assert.ok(readdirSync(cacheDir).includes(chunkFile(cacheDir, 'index:movie:1').slice(cacheDir.length + 1)));
});

test('an index that lost a chunk is read again, rather than searched in part', async () => {
  const cacheDir = scratchDir('lp-xtream-lost-');
  const films = bigFilms(1, 6000, '10');
  const answer = (q) => (q.get('action') === 'get_vod_streams' ? json(films) : undefined);
  await engineOver({ cacheDir, answer }).engine.call('search', ['nothing like it']);
  rmSync(chunkFile(cacheDir, 'index:movie:1'));

  const { engine, transport } = engineOver({ cacheDir, answer });
  const found = await engine.call('search', ['big film 600']);
  const again = engineOver({ cacheDir, answer });
  await again.engine.call('search', ['big film 600']);

  assert.deepEqual(found.map((m) => m.id), ['movie:600', 'movie:6000']);
  assert.deepEqual(actions(transport.calls), ['account', 'get_vod_streams']);
  assert.deepEqual(actions(again.transport.calls), ['account']);
});

test('an index read by category keeps its progress across restarts, a chunk boundary and all', async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-xtream-chunked-categories-');
  // Film 4999, kept in an earlier chunk, is listed again in the second category, and is still one title.
  const listings = { 10: bigFilms(1, 5000, '10'), 11: [...bigFilms(5001, 5000, '11'), ...bigFilms(4999, 1, '11')] };
  const answer = (q) => {
    if (q.get('action') !== 'get_vod_streams') return undefined;
    if (q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
    clock += 12_000;
    return json(listings[q.get('category_id')]);
  };
  const runtime = () => engineOver({ cacheDir, now: () => clock, answer });
  const films = (calls) => calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));

  const first = runtime();
  await first.engine.call('search', ['nothing like it']);
  const second = runtime();
  const secondFound = await second.engine.call('search', ['big film 10000']);
  const third = runtime();
  const thirdFound = await third.engine.call('search', ['big film 4999']);

  assert.deepEqual(films(first.transport.calls), [null, '10']);
  assert.deepEqual(films(second.transport.calls), ['11']);
  assert.deepEqual(secondFound.map((m) => m.id), ['movie:10000']);
  assert.deepEqual(films(third.transport.calls), []);
  assert.deepEqual(thirdFound.map((m) => m.id), ['movie:4999']);
  assert.ok(!third.host.takePartial());
  // The last chunk was carried on rather than a new one begun after it.
  const files = readdirSync(cacheDir);
  assert.ok(files.includes(chunkFile(cacheDir, 'index:movie:2').slice(cacheDir.length + 1)));
  assert.ok(!files.includes(chunkFile(cacheDir, 'index:movie:3').slice(cacheDir.length + 1)));
});

test('a chunk that could not be kept keeps the state from naming it, so the category is read again', async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-xtream-chunk-refused-');
  const listings = { 10: bigFilms(1, 5000, '10'), 11: bigFilms(5001, 5000, '11') };
  const answer = (q) => {
    if (q.get('action') !== 'get_vod_streams') return undefined;
    if (q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
    clock += 12_000;
    return json(listings[q.get('category_id')]);
  };
  const runtime = () => engineOver({ cacheDir, now: () => clock, answer });
  await runtime().engine.call('search', ['nothing like it']);
  const refusing = runtime();
  const { set } = refusing.host.yonto.cache;
  refusing.host.yonto.cache.set = async (key, ...rest) => {
    if (key === 'index:movie:1') throw new PluginError(Code.STORE_REFUSED, 'yonto.cache.set refused: no room');
    return set(key, ...rest);
  };
  await refusing.engine.call('search', ['nothing like it']);

  const after = runtime();
  const found = await after.engine.call('search', ['big film 5001']);

  assert.deepEqual(found.map((m) => m.id), ['movie:5001']);
  assert.ok(after.transport.calls.some((url) => new URL(url).searchParams.get('category_id') === '11'));
});

test('an index read by category that lost a chunk begins again', async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-xtream-category-lost-');
  const answer = (q) => {
    if (q.get('action') !== 'get_vod_streams') return undefined;
    if (q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
    clock += 12_000;
    return json(bigFilms(1, 5000, q.get('category_id')));
  };
  await engineOver({ cacheDir, now: () => clock, answer }).engine.call('search', ['nothing like it']);
  rmSync(chunkFile(cacheDir, 'index:movie:0'));

  const { engine, transport } = engineOver({ cacheDir, now: () => clock, answer });
  await engine.call('search', ['nothing like it']);

  const films = transport.calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));
  assert.deepEqual(films, [null, '10']);
});

test('an index built again smaller removes the chunks it no longer names', async () => {
  const cacheDir = scratchDir('lp-xtream-smaller-');
  const big = (q) => (q.get('action') === 'get_vod_streams' ? json(bigFilms(1, 6000, '10')) : undefined);
  await engineOver({ cacheDir, answer: big }).engine.call('search', ['nothing like it']);

  await engineOver({ cacheDir, config: { username: 'someone-else' } }).engine.call('search', ['nothing like it']);

  assert.ok(readdirSync(cacheDir).includes(chunkFile(cacheDir, 'index:movie:0').slice(cacheDir.length + 1)));
  assert.ok(!readdirSync(cacheDir).includes(chunkFile(cacheDir, 'index:movie:1').slice(cacheDir.length + 1)));
});

/** [engine]'s cache, whose write of [key] waits for the answer of [hold] (a promise) before it is made, or fails if [hold] does. */
function holdingWrite(engine, key, hold) {
  const { set } = engine.host.yonto.cache;
  let reached;
  const writing = new Promise((resolve) => { reached = resolve; });
  engine.host.yonto.cache.set = async (written, ...rest) => {
    if (written === key) {
      reached();
      await hold();
    }
    return set(written, ...rest);
  };
  return writing;
}

test("an old call finishing after the source was edited leaves no chunk of its panel under the new one's state", async () => {
  const cacheDir = scratchDir('lp-xtream-edited-');
  const panelOf = (prefix) => (q) => (q.get('action') === 'get_vod_streams' ? json(bigFilms(1, 6000, '10', prefix)) : undefined);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const edited = engineOver({ cacheDir, config: { username: 'someone-else' }, answer: panelOf('New') });
  const editedAtState = holdingWrite(edited, 'index:movie', () => released);
  const editedSearch = edited.engine.call('search', ['nothing like it']);
  await editedAtState;
  // The old call writes its chunks over the edited one's, and ends before its state is kept.
  const old = engineOver({ cacheDir, answer: panelOf('Old') });
  holdingWrite(old, 'index:movie', () => Promise.reject(new PluginError(Code.TIMEOUT, 'refused rather than started')));
  await old.engine.call('search', ['nothing like it']);
  release();
  await editedSearch;

  const after = engineOver({ cacheDir, config: { username: 'someone-else' }, answer: panelOf('New') });
  const found = await after.engine.call('search', ['new film 6000']);

  assert.deepEqual(found.map((m) => m.id), ['movie:6000']);
  assert.ok(actions(after.transport.calls).includes('get_vod_streams'));
});

test("two builds of one index at once never leave one's state naming the other's chunks", async () => {
  const cacheDir = scratchDir('lp-xtream-interleaved-');
  // One clock for both, so the two builds are told apart by more than when they began.
  const now = () => 1_000_000;
  const first = (q) => (q.get('action') === 'get_vod_streams' ? json(bigFilms(1, 9000, '10', 'First')) : undefined);
  const second = (q) => (q.get('action') === 'get_vod_streams' ? json(bigFilms(1, 6000, '10', 'Second')) : undefined);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const a = engineOver({ cacheDir, now, answer: first });
  const aAtState = holdingWrite(a, 'index:movie', () => released);
  const aSearch = a.engine.call('search', ['nothing like it']);
  await aAtState;
  await engineOver({ cacheDir, now, answer: second }).engine.call('search', ['nothing like it']);
  release();
  await aSearch;

  const after = engineOver({ cacheDir, now, answer: second });
  const found = await after.engine.call('search', ['film 600']);

  assert.deepEqual(found.map((m) => m.title), ['Second Film 600', 'Second Film 6000']);
  assert.ok(actions(after.transport.calls).includes('get_vod_streams'));
});

test('a cache that refuses or fails still searches, and the index is held for the runtime instead', async () => {
  const { engine, transport, host } = engineOver();
  host.yonto.cache = {
    get: async () => { throw new PluginError(Code.TIMEOUT, 'refused rather than started'); },
    set: async () => { throw new PluginError(Code.STORE_REFUSED, 'yonto.cache.set refused: too large'); },
    remove: async () => {},
  };

  const first = await engine.call('search', ['heist']);
  const second = await engine.call('search', ['heist']);

  assert.deepEqual(first.map((m) => m.id), ['movie:100', 'movie:101']);
  assert.deepEqual(second, first);
  assert.equal(actions(transport.calls).filter((action) => action === 'get_vod_streams').length, 1);
  assert.ok(host.logs.some(({ message }) => /index was not kept: STORE_REFUSED/.test(message)));
});

test('a title whose fields hold a tab, a line break or a lone surrogate is still one title', async () => {
  const { engine } = engineOver({
    answer: (q) => (q.get('action') === 'get_vod_streams'
      ? json([{ name: 'Tab\tand\nbreak \ud800 film', stream_id: 500, added: '1', stream_icon: 'http://img.test/a.jpg' }]) : undefined),
  });

  const found = await engine.call('search', ['break']);
  const again = await engine.call('search', ['film']);

  assert.deepEqual(found, [{ id: 'movie:500', title: 'Tab and break \ufffd film', type: 'MOVIE', posterUrl: 'http://img.test/a.jpg' }]);
  assert.deepEqual(again, found);
});

test('a library too large to read whole is searched a category at a time, each search carrying on where the last stopped', async () => {
  let clock = 1_000_000;
  const { engine, transport, host } = engineOver({
    now: () => clock,
    answer: (q) => {
      if (q.get('action') === 'get_vod_streams' && q.get('category_id') === null) {
        throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
      }
      // Each category takes the whole of a search's reading time.
      if (q.get('action') === 'get_vod_streams') clock += 12_000;
      return undefined;
    },
  });

  const first = await engine.call('search', ['heist']);
  const firstPartial = host.takePartial();
  const second = await engine.call('search', ['old']);
  const secondPartial = host.takePartial();
  // The second search spent its time on the last film category, so the series wait for this one.
  const third = await engine.call('search', ['show']);
  const thirdPartial = host.takePartial();

  assert.deepEqual(first.map((m) => m.id), ['movie:100', 'movie:101']);
  assert.match(firstPartial, /Search again/);
  assert.deepEqual(second.map((m) => m.id), ['movie:102']);
  assert.match(secondPartial, /Search again/);
  assert.deepEqual(third.map((m) => m.id), ['series:300']);
  assert.ok(!thirdPartial, thirdPartial);
  const films = transport.calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));
  assert.deepEqual(films, [null, '10', '11']);
  assert.equal(transport.mostInFlight, 1);
});

test('a refused login, an expired account and a missing panel each say so, and none is the network', async () => {
  const failing = async (answer) => {
    const { engine } = engineOver({ answer });
    return failure(engine.call('getCategories', []));
  };

  const refused = await failing((q) => (q.get('action') === null ? json({ user_info: { auth: 0 } }) : undefined));
  const unauthorised = await failing(() => json({}, 401));
  const expired = await failing((q) => (q.get('action') === null ? json({ user_info: { auth: 1, status: 'Expired' } }) : undefined));
  const banned = await failing((q) => (q.get('action') === null ? json({ user_info: { auth: 1, status: 'Banned' } }) : undefined));
  const missing = await failing(() => json({}, 404));
  const down = await failing(() => json({}, 502));
  const html = await failing(() => ({ status: 200, headers: {}, bodyBase64: Buffer.from('<html>').toString('base64') }));

  assert.deepEqual([refused.code, unauthorised.code], ['UNAUTHENTICATED', 'UNAUTHENTICATED']);
  assert.match(refused.message, /username and password/);
  assert.equal(expired.code, 'UNAVAILABLE');
  assert.match(expired.message, /expired/);
  assert.match(banned.message, /isn't active/);
  assert.match(missing.message, /no Xtream Codes panel/);
  assert.equal(down.code, 'UNREACHABLE');
  assert.match(html.message, /isn't an Xtream Codes panel/);
});

test('a provider link pasted whole as the server is read as its server', async () => {
  const { engine, transport } = engineOver({ config: { server: `${SERVER}/get.php?username=viewer&password=x&type=m3u_plus` } });

  await engine.call('getCategories', []);

  assert.ok(transport.calls.every((url) => url.startsWith(`${SERVER}/player_api.php?`)));
});

test('a server that is not http(s) is the form to fix, and nothing is sent', async () => {
  const { engine, transport } = engineOver({ config: { server: 'ftp://panel.test' } });

  assert.equal((await failure(engine.call('getCategories', []))).code, 'MISCONFIGURED');
  assert.equal(transport.calls.length, 0);
});

test('the password is in no log line, whatever fails', async () => {
  const { engine, host } = engineOver({ answer: (q) => (q.get('action') === 'get_vod_streams' ? json({}, 500) : undefined) });

  await engine.call('getMediaDetail', ['series:300']);
  await failure(engine.call('getMediaList', ['movie', { page: 1 }]));

  assert.ok(host.logs.length > 0);
  for (const { message } of host.logs) {
    assert.ok(!message.includes('s3cret') && !message.includes('s3cret%26x'), message);
  }
});

test('a category the panel cannot answer leaves the rest searched: one over the limit for good, one that failed until it answers', async () => {
  let brokenAnswers = false;
  const { engine, transport, host } = engineOver({
    answer: (q) => {
      if (q.get('action') !== 'get_vod_streams') return undefined;
      if (q.get('category_id') === null || q.get('category_id') === '10') throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
      if (q.get('category_id') === '11' && !brokenAnswers) return json({}, 500);
      return undefined;
    },
  });

  const first = await engine.call('search', ['old']);
  const firstPartial = host.takePartial();
  brokenAnswers = true;
  const second = await engine.call('search', ['old']);
  const secondPartial = host.takePartial();
  const third = await engine.call('search', ['news']);
  const thirdPartial = host.takePartial();

  assert.deepEqual(first, []);
  assert.match(firstPartial, /Search again/);
  assert.deepEqual(second.map((m) => m.id), ['movie:102']);
  assert.match(secondPartial, /couldn.t be searched/);
  assert.deepEqual(third.map((m) => m.title), ['World News', 'Local News']);
  assert.match(thirdPartial, /couldn.t be searched/);
  const films = transport.calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));
  assert.deepEqual(films, [null, '10', '11', '11']);
});

test('a panel that answers no library at all fails the search, rather than finding nothing', async () => {
  const { engine } = engineOver({ answer: (q) => (/_streams$|^get_series$/.test(q.get('action') ?? '') ? json({}, 502) : undefined) });

  assert.equal((await failure(engine.call('search', ['news']))).code, 'UNREACHABLE');
});

test("a request the host gave up on keeps its code, and the host's words, which name the address, stay out", async () => {
  const { engine } = engineOver({
    answer: (q) => {
      if (q.get('action') === 'get_vod_streams') throw new PluginError(Code.TIMEOUT, `${SERVER}/player_api.php?password=s3cret%26x had not answered`);
      return undefined;
    },
  });

  const error = await failure(engine.call('getMediaList', ['movie', { page: 1 }]));

  assert.equal(error.code, 'TIMEOUT');
  assert.ok(!error.message.includes('s3cret'), error.message);
});

test('a library whose list fails leaves the others searched, and is asked for again by the next search', async () => {
  let seriesUp = false;
  const { engine, host } = engineOver({ answer: (q) => (q.get('action') === 'get_series' && !seriesUp ? json({}, 500) : undefined) });

  const first = await engine.call('search', ['the']);
  const firstPartial = host.takePartial();
  seriesUp = true;
  const second = await engine.call('search', ['the']);

  assert.deepEqual(first, []);
  assert.match(firstPartial, /Search again/);
  assert.deepEqual(second.map((m) => m.id), ['series:300']);
});

test('a category that times out every time cannot hold up the others, and is given up on after three searches', async () => {
  let clock = 1_000_000;
  const { engine, transport, host } = engineOver({
    now: () => clock,
    answer: (q) => {
      if (q.get('action') !== 'get_vod_streams') return undefined;
      if (q.get('category_id') === null) throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large');
      if (q.get('category_id') === '10') {
        clock += 21_000;
        throw new PluginError(Code.TIMEOUT, 'had not answered');
      }
      return undefined;
    },
  });

  const answers = [];
  for (let search = 0; search < 5; search += 1) {
    const found = await engine.call('search', ['old']);
    answers.push([found.map((m) => m.id), host.takePartial()]);
  }

  assert.deepEqual(answers[1][0], ['movie:102']);
  const films = transport.calls.filter((url) => url.includes('get_vod_streams')).map((url) => new URL(url).searchParams.get('category_id'));
  assert.equal(films.filter((id) => id === '10').length, 3);
  assert.ok(transport.calls.some((url) => url.includes('action=get_series')));
  assert.match(answers[4][1], /couldn.t be searched/);
  assert.deepEqual(answers[4][0], ['movie:102']);
});
