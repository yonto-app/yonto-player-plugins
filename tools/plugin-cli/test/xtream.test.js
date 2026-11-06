import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { PluginError, Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

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

function engineOver({ answer, config = {}, now = Date.now } = {}) {
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
