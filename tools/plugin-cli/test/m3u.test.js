import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { scratchDir } from '../src/scratch-dir.js';
import { PluginError, Code } from '../src/errors.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `plugins/m3u`, scripted: what is under test is the reading of a playlist. */
const dir = fileURLToPath(new URL('../../../plugins/m3u/', import.meta.url));

const PLAYLIST_URL = 'https://lists.test/tv/playlist.m3u';

const PLAYLIST = `﻿#EXTM3U
#EXTINF:-1 tvg-id="news1" tvg-logo="https://lists.test/logo/news.png" group-title="News, World",World News
https://cdn.test/news.m3u8
#EXTINF:-1 group-title="Movies",Heist
#EXTVLCOPT:http-referrer=https://lists.test/
#EXTVLCOPT:http-user-agent=Probe/1.0
https://cdn.test/heist.mp4
#EXTGRP:Movies
#EXTINF:-1,Second Heist
rel/second.mp4|User-Agent=Kodi%2F1&Bad Name=x
#EXTINF:-1,Loose
https://cdn.test/loose.ts
#EXTINF:-1 group-title="Movies",Heist
https://cdn.test/heist.mp4
`;

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const text = (body, { status = 200, headers = {} } = {}) => ({ status, headers, bodyBase64: b64(body) });

function engineOver(answer, { config = {}, now = Date.now, cacheDir = scratchDir('lp-m3u-cache-') } = {}) {
  const transport = {
    calls: [],
    async request(req) {
      this.calls.push(req.url);
      return typeof answer === 'function' ? answer(req) : answer;
    },
  };
  const host = createHost({
    manifest: loadManifest(dir),
    config: { playlist: PLAYLIST_URL, ...config },
    transport,
    storeDir: scratchDir('lp-m3u-'),
    cacheDir,
    pluginDir: dir,
    now,
  });
  return { transport, host, engine: createEngine({ dir, host }) };
}

const failure = (promise) => promise.then(() => null, (error) => error);

test('groups become categories in playlist order, under All', async () => {
  const { engine } = engineOver(text(PLAYLIST));

  assert.deepEqual(await engine.call('getCategories', []), [
    { id: 'all', name: 'All' },
    { id: 'g:News, World', name: 'News, World' },
    { id: 'g:Movies', name: 'Movies' },
    { id: 'g:Other', name: 'Other' },
  ]);
});

test('a group lists its entries, a repeated one once, and All lists every entry', async () => {
  const { engine } = engineOver(text(PLAYLIST));

  const movies = await engine.call('getMediaList', ['g:Movies', { page: 1 }]);
  const all = await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.deepEqual(movies.map((m) => m.title), ['Heist', 'Second Heist']);
  assert.deepEqual(all.map((m) => m.title), ['World News', 'Heist', 'Second Heist', 'Loose']);
  assert.equal(all[0].posterUrl, 'https://lists.test/logo/news.png');
});

test('a listing is paged and a page past the end is empty', async () => {
  const many = ['#EXTM3U', ...Array.from({ length: 130 }, (_, i) => `#EXTINF:-1,Ch ${i}\nhttps://cdn.test/${i}.ts`)].join('\n');
  const { engine } = engineOver(text(many));

  const page = async (n) => (await engine.call('getMediaList', ['all', { page: n }])).length;

  assert.deepEqual([await page(1), await page(2), await page(3), await page(4)], [60, 60, 10, 0]);
});

test('a title plays its stream with the headers the playlist asked for', async () => {
  const { engine } = engineOver(text(PLAYLIST));
  const [heist, second, news] = await engine.call('getMediaList', ['all', { page: 1 }])
    .then((list) => [list[1], list[2], list[0]]);

  const detail = await engine.call('getMediaDetail', [heist.id]);
  const relative = await engine.call('getMediaDetail', [second.id]);
  const hls = await engine.call('getMediaDetail', [news.id]);

  assert.deepEqual(detail.playbackOptions, [{
    label: 'Heist',
    stream: { url: 'https://cdn.test/heist.mp4', mimeType: 'video/mp4', headers: { Referer: 'https://lists.test/', 'User-Agent': 'Probe/1.0' } },
  }]);
  assert.deepEqual(detail.genres, ['Movies']);
  // Resolved against the playlist's own address; the Kodi suffix keeps only a header that can be sent.
  assert.deepEqual(relative.playbackOptions[0].stream, {
    url: 'https://lists.test/tv/rel/second.mp4',
    mimeType: 'video/mp4',
    headers: { 'User-Agent': 'Kodi/1' },
  });
  assert.equal(hls.playbackOptions[0].stream.mimeType, 'application/x-mpegURL');
});

test('every stream says what it is, because the host reads a missing type as HLS', async () => {
  const body = [
    '#EXTM3U',
    '#EXTINF:-1,Hls\nhttps://cdn.test/a.m3u8?token=1',
    '#EXTINF:-1,Flv\nhttps://cdn.test/channel/b?streamid=9',
    '#EXTINF:-1,Ts\nhttp://cdn.test/c.ts',
  ].join('\n');
  const { engine } = engineOver(text(body));
  const list = await engine.call('getMediaList', ['all', { page: 1 }]);

  const mimes = [];
  for (const { id } of list) mimes.push((await engine.call('getMediaDetail', [id])).playbackOptions[0].stream.mimeType);

  assert.deepEqual(mimes, ['application/x-mpegURL', 'video/mp4', 'video/mp4']);
});

test('an entry with no length is live, and one that states a length is a video', async () => {
  const body = [
    '#EXTM3U',
    '#EXTINF:-1,Channel\nhttps://cdn.test/a.m3u8',
    '#EXTINF:0,Zero\nhttps://cdn.test/b.m3u8',
    '#EXTINF:5400 group-title="Films",Film\nhttps://cdn.test/c.mp4',
    '#EXTINF:,Blank\nhttps://cdn.test/d.ts',
    '#EXTINF:-1,Movie\nhttps://cdn.test/e.MKV?token=1',
  ].join('\n');
  const { engine } = engineOver(text(body));
  const list = await engine.call('getMediaList', ['all', { page: 1 }]);

  const live = {};
  for (const { id, title } of list) live[title] = (await engine.call('getMediaDetail', [id])).playbackOptions[0].stream.live;

  assert.deepEqual(live, { Channel: true, Zero: true, Film: undefined, Blank: true, Movie: undefined });
});

test('a protocol-relative entry keeps the playlist scheme, and one header is one however it is cased', async () => {
  const body = [
    '#EXTM3U',
    '#EXTINF:-1,Rel\n#EXTVLCOPT:http-referrer=https://a.test/\n//cdn.test/x.m3u8|referer=https://b.test/',
  ].join('\n');
  const { engine } = engineOver(text(body));
  const [{ id }] = await engine.call('getMediaList', ['all', { page: 1 }]);

  const stream = (await engine.call('getMediaDetail', [id])).playbackOptions[0].stream;

  assert.equal(stream.url, 'https://cdn.test/x.m3u8');
  assert.deepEqual(stream.headers, { referer: 'https://b.test/' });
});

test('a stray #EXT-X tag does not turn a playlist of channels into a stream', async () => {
  const { engine } = engineOver(text('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:-1,A\nhttps://cdn.test/a.m3u8'));

  assert.equal((await engine.call('getMediaList', ['all', { page: 1 }])).length, 1);
});

test('an unknown id is not found', async () => {
  const { engine } = engineOver(text(PLAYLIST));

  assert.equal((await failure(engine.call('getMediaDetail', ['nope']))).code, 'NOT_FOUND');
});

test('search matches titles and groups, ignoring case', async () => {
  const { engine } = engineOver(text(PLAYLIST));

  assert.deepEqual((await engine.call('search', ['HEIST'])).map((m) => m.title), ['Heist', 'Second Heist']);
  assert.deepEqual((await engine.call('search', ['world'])).map((m) => m.title), ['World News']);
  assert.deepEqual(await engine.call('search', ['  ']), []);
});

test('the playlist is fetched once within its cache window and again after it', async () => {
  let clock = 1_000_000;
  const { transport, engine } = engineOver(text(PLAYLIST), { now: () => clock });

  await engine.call('getCategories', []);
  await engine.call('search', ['heist']);
  assert.equal(transport.calls.length, 1);
  clock += 301_000;
  await engine.call('search', ['heist']);
  assert.equal(transport.calls.length, 2);
});

test('a charset the server names is honoured', async () => {
  const gbk = Buffer.from([0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55, 0x0a, 0x23, 0x45, 0x58, 0x54, 0x49, 0x4e, 0x46, 0x3a, 0x2d, 0x31, 0x2c, 0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f, 0x63, 0x2e, 0x74, 0x65, 0x73, 0x74, 0x2f, 0x61, 0x2e, 0x74, 0x73, 0x0a]);
  const { engine } = engineOver({ status: 200, headers: { 'content-type': 'audio/x-mpegurl; charset=gbk' }, bodyBase64: gbk.toString('base64') });

  assert.deepEqual((await engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.title), ['中文']);
});

test('what is not a playlist is refused in a sentence that names the part that failed', async () => {
  const cases = [
    ['<html>hi</html>', /isn't a playlist/],
    ['#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts', /single stream/],
    ['#EXTM3U\n', /nothing in it/],
  ];
  for (const [body, expected] of cases) {
    const { engine } = engineOver(text(body));
    const error = await failure(engine.call('getCategories', []));
    assert.equal(error.code, 'UNAVAILABLE', body);
    assert.match(error.message, expected);
  }
});

test('a failing server is told apart: gone, gated, down', async () => {
  const code = async (answer) => {
    const { engine } = engineOver(answer);
    const error = await failure(engine.call('getCategories', []));
    return [error.code, error.message];
  };

  assert.match((await code(text('', { status: 404 })))[1], /no playlist at this address/);
  assert.match((await code(text('', { status: 403 })))[1], /refused access/);
  assert.equal((await code(text('', { status: 502 })))[0], 'UNREACHABLE');
});

test('an address that is not http(s) is the form to fix', async () => {
  const { engine, transport } = engineOver(text(PLAYLIST), { config: { playlist: 'ftp://x/y.m3u' } });

  const error = await failure(engine.call('getCategories', []));

  assert.equal(error.code, 'MISCONFIGURED');
  assert.equal(transport.calls.length, 0);
});

test('a playlist too large to read says so, and an Xtream panel\'s link points at the Xtream Codes source', async () => {
  const tooLarge = () => { throw new PluginError(Code.RESPONSE_TOO_LARGE, 'too large'); };
  const plain = engineOver(tooLarge);
  const panel = engineOver(tooLarge, { config: { playlist: 'http://panel.test/get.php?username=a&password=b&type=m3u_plus' } });

  const plainError = await failure(plain.engine.call('getCategories', []));
  const panelError = await failure(panel.engine.call('getCategories', []));

  assert.deepEqual([plainError.code, plainError.message], ['UNAVAILABLE', 'This playlist is too large to read.']);
  assert.equal(panelError.code, 'UNAVAILABLE');
  assert.match(panelError.message, /too large to read\. Add it as an Xtream Codes source/);
});

test("a request the host gave up on keeps its code, and the host's words, which name the address, stay out", async () => {
  const keyed = 'https://lists.test/tv/playlist.m3u?token=k3y';
  const { engine } = engineOver(() => { throw new PluginError(Code.TIMEOUT, `${keyed} had not answered`); }, { config: { playlist: keyed } });

  const error = await failure(engine.call('getCategories', []));

  assert.equal(error.code, 'TIMEOUT');
  assert.ok(!error.message.includes('k3y'), error.message);
});

test("an entry's id is the md5 of its group and title, so History and the Watch list keep finding it", async () => {
  const { createHash } = await import('node:crypto');
  const { engine } = engineOver(text(PLAYLIST));

  const [news] = await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.equal(news.id, createHash('md5').update('News, World\nWorld News').digest('hex'));
  assert.equal((await engine.call('getMediaDetail', [news.id])).title, 'World News');
});

test('a playlist whose lines end in a bare CR, or open on a byte order mark, reads the same', async () => {
  const cr = engineOver(text('#EXTM3U\r#EXTINF:-1 group-title="A",One\rhttps://cdn.test/1.ts\r#EXTINF:-1,Two\rhttps://cdn.test/2.ts'));
  const bom = engineOver(text('﻿#EXTM3U\n#EXTINF:-1,One\nhttps://cdn.test/1.ts'));

  assert.deepEqual((await cr.engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.title), ['One', 'Two']);
  assert.deepEqual((await bom.engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.title), ['One']);
});

test("an address's own query is never read as headers, and only a Kodi suffix after a bar is", async () => {
  const body = [
    '#EXTM3U',
    '#EXTINF:-1,Query\n#EXTVLCOPT:http-user-agent=Probe/1.0\nhttps://cdn.test/a.ts?token=abc&Referer=x',
    '#EXTINF:-1,Bare\nhttps://cdn.test/b.ts?token=abc&Referer=x',
  ].join('\n');
  const { engine } = engineOver(text(body));
  const [query, bare] = await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.deepEqual((await engine.call('getMediaDetail', [query.id])).playbackOptions[0].stream.headers, { 'User-Agent': 'Probe/1.0' });
  assert.equal((await engine.call('getMediaDetail', [bare.id])).playbackOptions[0].stream.headers, undefined);
});

test('a header line with attributes, an HLS tag deep in a manifest and mixed line breaks read as they always did', async () => {
  const header = engineOver(text('#EXTM3U x-tvg-url="http://epg.test/a.xml"\nhttps://cdn.test/1.ts'));
  const master = ['#EXTM3U', ...Array.from({ length: 60 }, (_, i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${i}"`), '#EXT-X-STREAM-INF:BANDWIDTH=1', 'v.m3u8'].join('\n');
  const hls = engineOver(text(master));
  const mixed = engineOver(text('#EXTM3U\r#EXTINF:-1,One\rhttps://cdn.test/1.ts\n#EXTINF:-1,Two\r\nhttps://cdn.test/2.ts'));

  assert.deepEqual((await header.engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.title), ['1']);
  assert.match((await failure(hls.engine.call('getCategories', []))).message, /single stream/);
  assert.deepEqual((await mixed.engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.title), ['One', 'Two']);
});

test('an HLS tag is one only as the spec writes it, in capitals', async () => {
  const { engine } = engineOver(text('#EXTM3U\n#ext-x-targetduration:10\n#EXTINF:-1,One\nhttps://cdn.test/1.ts'));

  assert.deepEqual((await engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.title), ['One']);
});

// ---------------------------------------------------------------------------- the kept playlist

const md5 = (text) => createHash('md5').update(text).digest('hex');
const chunkFile = (cacheDir, key) => join(cacheDir, createHash('sha256').update(key).digest('hex'));
const SECOND_HEIST = 'https://lists.test/tv/rel/second.mp4';

/** Every page of [categoryId] until an empty one, or [most] pages, past which it pages forever. */
async function everyPage(engine, categoryId, most = 1000) {
  const all = [];
  for (let page = 1; page <= most; page += 1) {
    const list = await engine.call('getMediaList', [categoryId, { page }]);
    if (list.length === 0) return all;
    all.push(...list);
  }
  throw new Error(`${categoryId} has more than ${most} pages`);
}

test('a new runtime answers a page, a group, a title and a search from the cache, with no download', async () => {
  const cacheDir = scratchDir('lp-m3u-kept-');
  const first = engineOver(text(PLAYLIST), { cacheDir });
  await first.engine.call('getCategories', []);

  const { engine, transport } = engineOver(text(PLAYLIST), { cacheDir });
  const all = await engine.call('getMediaList', ['all', { page: 1 }]);
  const movies = await engine.call('getMediaList', ['g:Movies', { page: 1 }]);
  const detail = await engine.call('getMediaDetail', [all[2].id]);
  const found = await engine.call('search', ['heist']);

  assert.deepEqual(all.map((m) => m.title), ['World News', 'Heist', 'Second Heist', 'Loose']);
  assert.deepEqual(movies.map((m) => m.title), ['Heist', 'Second Heist']);
  assert.deepEqual(detail.playbackOptions[0].stream, { url: SECOND_HEIST, mimeType: 'video/mp4', headers: { 'User-Agent': 'Kodi/1' } });
  assert.deepEqual(detail.genres, ['Movies']);
  assert.deepEqual(found.map((m) => m.title), ['Heist', 'Second Heist']);
  assert.equal(first.transport.calls.length, 1);
  assert.equal(transport.calls.length, 0);
});

test("every entry's id is the md5 of its group and title, never its address", async () => {
  const { engine } = engineOver(text(PLAYLIST));

  const ids = (await engine.call('getMediaList', ['all', { page: 1 }])).map((m) => m.id);

  assert.deepEqual(ids, [
    md5('News, World\nWorld News'),
    md5('Movies\nHeist'),
    md5('Movies\nSecond Heist'),
    md5('Other\nLoose'),
  ]);
});

/** A provider's playlist that signs every address afresh on each download, its titles alike. */
const signed = (signature) => `#EXTM3U
#EXTINF:-1 group-title="Sport",Arena 1
https://cdn.test/live/${signature}-a.m3u8
#EXTINF:-1 group-title="Sport",Arena 1
https://backup.test/live/${signature}-b.m3u8
#EXTINF:-1 group-title="News",Arena 1
https://cdn.test/live/${signature}-c.m3u8
#EXTINF:-1 group-title="Sport",Arena 2
https://cdn.test/live/${signature}-d.m3u8
`;

test('a playlist read again with every address signed afresh keeps every id, so a title page still opens', async () => {
  let clock = 1_000_000;
  let signature = 'aaa';
  const { engine, transport } = engineOver((_req) => text(signed(signature)), { now: () => clock });

  const before = await engine.call('getMediaList', ['all', { page: 1 }]);
  signature = 'bbb';
  clock += 301_000;
  const detail = await engine.call('getMediaDetail', [before[3].id]);
  const after = await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.equal(transport.calls.length, 2);
  assert.equal(detail.title, 'Arena 2');
  assert.equal(detail.playbackOptions[0].stream.url, 'https://cdn.test/live/bbb-d.m3u8');
  assert.deepEqual(after, before);
});

test('entries of one group and title are a title each, told apart by their order, and the same title in another group is its own', async () => {
  const { engine } = engineOver(text(signed('aaa')));

  const all = await engine.call('getMediaList', ['all', { page: 1 }]);
  const backup = await engine.call('getMediaDetail', [all[1].id]);

  assert.deepEqual(all.map((m) => m.id), [md5('Sport\nArena 1'), md5('Sport\nArena 1\n1'), md5('News\nArena 1'), md5('Sport\nArena 2')]);
  assert.equal(backup.playbackOptions[0].stream.url, 'https://backup.test/live/aaa-b.m3u8');
});

/** Groups interleaved in runs of every length, repeats among them, and a group past ASCII, over more than one chunk. */
function interleaved(count) {
  const groups = ['News', 'İstanbul', 'Sport', 'Films', 'Kids'];
  const lines = ['#EXTM3U'];
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    // A repeat of an earlier entry, which is that entry and not a second one.
    const n = i % 97 === 96 ? i - 50 : i;
    const group = groups[Math.floor(n / ((n % 7) + 1)) % groups.length];
    const entry = { title: `Channel ${n}`, group, url: `https://cdn.test/${'x'.repeat(120)}/${n}.ts` };
    lines.push(`#EXTINF:-1 group-title="${entry.group}",${entry.title}`, entry.url);
    entries.push(entry);
  }
  return { body: lines.join('\n'), entries };
}

/** The playlist's entries as the in-memory index read them: the first of each address and title, groups in first appearance, ids by group and title. */
function modelOf(entries) {
  const seen = new Set();
  const namesakes = new Map();
  const all = [];
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.url}\n${entry.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = `${entry.group}\n${entry.title}`;
    const before = namesakes.get(name) ?? 0;
    namesakes.set(name, before + 1);
    const summary = { id: md5(before === 0 ? name : `${name}\n${before}`), title: entry.title, type: 'MOVIE' };
    all.push(summary);
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(summary);
  }
  return { all, groups };
}

test('All and every group keep the playlist order across chunks, as the in-memory index did', async () => {
  const { body, entries } = interleaved(5_000);
  const model = modelOf(entries);
  const cacheDir = scratchDir('lp-m3u-order-');
  const { engine, transport } = engineOver(text(body), { cacheDir });

  const categories = await engine.call('getCategories', []);

  assert.ok(readdirSync(cacheDir).includes(chunkFile(cacheDir, 'playlist:1').slice(cacheDir.length + 1)), 'more than one chunk');
  assert.deepEqual(categories.map((c) => c.name), ['All', ...model.groups.keys()]);
  assert.deepEqual(await everyPage(engine, 'all'), model.all);
  for (const [name, summaries] of model.groups) assert.deepEqual(await everyPage(engine, `g:${name}`), summaries, name);
  assert.deepEqual(await engine.call('search', ['İSTANBUL']), model.groups.get('İstanbul').slice(0, 100));
  const last = model.all.at(-1);
  assert.equal((await engine.call('getMediaDetail', [last.id])).title, last.title);
  assert.deepEqual(await engine.call('search', [last.title]), [last]);
  assert.equal(transport.calls.length, 1);
});

test('a chunk the cache lost means the playlist is read again, never answered in part', async () => {
  const { body, entries } = interleaved(5_000);
  const model = modelOf(entries);
  const cacheDir = scratchDir('lp-m3u-lost-');
  await engineOver(text(body), { cacheDir }).engine.call('getCategories', []);
  rmSync(chunkFile(cacheDir, 'playlist:1'));

  const { engine, transport } = engineOver(text(body), { cacheDir });
  const last = model.all.at(-1);
  const detail = await engine.call('getMediaDetail', [last.id]);
  const again = engineOver(text(body), { cacheDir });
  const page = await again.engine.call('getMediaList', ['all', { page: Math.ceil(model.all.length / 60) }]);

  assert.equal(detail.title, last.title);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(page, model.all.slice(Math.floor((model.all.length - 1) / 60) * 60));
  assert.equal(again.transport.calls.length, 0);
});

test('a chunk another build wrote reads as lost too', async () => {
  const cacheDir = scratchDir('lp-m3u-other-build-');
  let clock = 1_000_000;
  await engineOver(text(PLAYLIST), { cacheDir, now: () => clock }).engine.call('getCategories', []);
  const state = chunkFile(cacheDir, 'playlist');
  const kept = readFileSync(state, 'utf8');
  clock += 1;
  // A later build's chunks under the earlier build's state.
  await engineOver(text(PLAYLIST), { cacheDir, now: () => clock + 301_000 }).engine.call('getCategories', []);
  writeFileSync(state, kept);

  const { engine, transport } = engineOver(text(PLAYLIST), { cacheDir, now: () => clock });
  const all = await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.equal(all.length, 4);
  assert.equal(transport.calls.length, 1);
});

test('a cache that keeps nothing holds the playlist for the runtime, so it is downloaded once across calls', async () => {
  let clock = 1_000_000;
  const { engine, transport } = engineOver(text(PLAYLIST), { cacheDir: null, now: () => clock });

  await engine.call('getCategories', []);
  const [news] = await engine.call('getMediaList', ['all', { page: 1 }]);
  await engine.call('getMediaList', ['g:Movies', { page: 1 }]);
  await engine.call('getMediaDetail', [news.id]);
  assert.deepEqual((await engine.call('search', ['heist'])).map((m) => m.title), ['Heist', 'Second Heist']);
  assert.equal(transport.calls.length, 1);
  clock += 301_000;
  await engine.call('getCategories', []);
  assert.equal(transport.calls.length, 2);
});

test('a write the cache refuses holds the playlist for the runtime too', async () => {
  const { engine, transport, host } = engineOver(text(PLAYLIST));
  host.yonto.cache = {
    get: async () => null,
    set: async () => { throw new PluginError(Code.STORE_REFUSED, 'yonto.cache.set refused: too large'); },
    remove: async () => {},
  };

  await engine.call('getCategories', []);
  await engine.call('search', ['heist']);

  assert.equal(transport.calls.length, 1);
  assert.ok(host.logs.some(({ message }) => /playlist was not kept: STORE_REFUSED/.test(message)));
});

test('a state the cache did not keep holds the playlist too, though every chunk was kept', async () => {
  const { engine, transport, host } = engineOver(text(PLAYLIST));
  const cache = host.yonto.cache;
  host.yonto.cache = { ...cache, set: async (key, ...rest) => (key === 'playlist' ? false : cache.set(key, ...rest)) };

  await engine.call('getCategories', []);
  await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.equal(transport.calls.length, 1);
});

test('ids the cache did not keep hold the playlist too', async () => {
  const { engine, transport, host } = engineOver(text(PLAYLIST));
  const cache = host.yonto.cache;
  host.yonto.cache = { ...cache, set: async (key, ...rest) => (key === 'playlist:ids:0' ? false : cache.set(key, ...rest)) };

  const [news] = await engine.call('getMediaList', ['all', { page: 1 }]);
  await engine.call('getMediaDetail', [news.id]);

  assert.equal(transport.calls.length, 1);
});

test('an ids piece another build wrote reads as lost, though the chunk is this build\'s', async () => {
  const cacheDir = scratchDir('lp-m3u-ids-build-');
  await engineOver(text(PLAYLIST), { cacheDir }).engine.call('getCategories', []);
  const { build } = JSON.parse(readFileSync(chunkFile(cacheDir, 'playlist'), 'utf8').split('\n')[1]);
  const ids = chunkFile(cacheDir, 'playlist:ids:0');
  writeFileSync(ids, readFileSync(ids, 'utf8').replace(build, 'x'.repeat(build.length)));

  const { engine, transport } = engineOver(text(PLAYLIST), { cacheDir });
  const id = md5('Movies\nHeist');

  assert.equal((await engine.call('getMediaDetail', [id])).title, 'Heist');
  assert.equal(transport.calls.length, 1);
});

test('a playlist past what the cache holds is held for the runtime and none of it written', async () => {
  // Each relative entry is read against a long address of characters three bytes each in UTF-8.
  const address = `https://lists.test/${'频'.repeat(1000)}/playlist.m3u`;
  const body = ['#EXTM3U', ...Array.from({ length: 22_000 }, (_, i) => `#EXTINF:-1,C${i}\n${i}.ts`)].join('\n');
  const cacheDir = scratchDir('lp-m3u-over-');
  const { engine, transport, host } = engineOver(text(body), { cacheDir, config: { playlist: address } });

  await engine.call('getCategories', []);
  const page = await engine.call('getMediaList', ['all', { page: 367 }]);
  const detail = await engine.call('getMediaDetail', [page[0].id]);

  assert.deepEqual(page.map((m) => m.title), ['C21960', 'C21961', 'C21962', 'C21963', 'C21964', 'C21965', 'C21966', 'C21967', 'C21968', 'C21969', 'C21970', 'C21971', 'C21972', 'C21973', 'C21974', 'C21975', 'C21976', 'C21977', 'C21978', 'C21979', 'C21980', 'C21981', 'C21982', 'C21983', 'C21984', 'C21985', 'C21986', 'C21987', 'C21988', 'C21989', 'C21990', 'C21991', 'C21992', 'C21993', 'C21994', 'C21995', 'C21996', 'C21997', 'C21998', 'C21999']);
  assert.ok(detail.playbackOptions[0].stream.url.endsWith('/21960.ts'));
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(readdirSync(cacheDir), []);
  assert.ok(host.logs.some(({ message }) => /too large to keep/.test(message)));
});

test('a playlist is read again five minutes after it was read, whichever runtime asks', async () => {
  let clock = 1_000_000;
  const cacheDir = scratchDir('lp-m3u-aged-');
  await engineOver(text(PLAYLIST), { cacheDir, now: () => clock }).engine.call('getCategories', []);

  clock += 299_000;
  const within = engineOver(text(PLAYLIST), { cacheDir, now: () => clock });
  await within.engine.call('getMediaList', ['all', { page: 1 }]);
  clock += 2_000;
  const after = engineOver(text(PLAYLIST), { cacheDir, now: () => clock });
  await after.engine.call('getMediaList', ['all', { page: 1 }]);

  assert.equal(within.transport.calls.length, 0);
  assert.equal(after.transport.calls.length, 1);
});

test('a tab in a title or a group is a space, and the entry keeps its id and its stream', async () => {
  const { engine } = engineOver(text('#EXTM3U\n#EXTINF:-1 group-title="Ne\tws",Tab\tbed\nhttps://cdn.test/t.m3u8'));

  const [entry] = await engine.call('getMediaList', ['all', { page: 1 }]);
  const detail = await engine.call('getMediaDetail', [entry.id]);

  assert.deepEqual(entry, { id: md5('Ne\tws\nTab\tbed'), title: 'Tab bed', type: 'MOVIE' });
  assert.deepEqual(detail.genres, ['Ne ws']);
  assert.equal(detail.playbackOptions[0].stream.url, 'https://cdn.test/t.m3u8');
});

test('a search reads lowercased chunks: İ lengthens a line, a hit only in the address is none, and order holds', async () => {
  const body = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="İİİİ İzmir",İİİİİİİİ',
    'https://cdn.test/1.ts',
    '#EXTINF:-1 group-title="Haberler",İstanbul Haber',
    'https://cdn.test/2.ts',
    '#EXTINF:-1,Spor',
    'https://cdn.test/haber/3.ts',
    '#EXTINF:-1 tvg-logo="https://img.test/haber.png",Film',
    'https://cdn.test/4.ts',
    '#EXTINF:-1,Akşam haberleri',
    'https://cdn.test/5.ts',
  ].join('\n');
  const { engine } = engineOver(text(body));

  assert.deepEqual((await engine.call('search', ['haber'])).map((m) => m.title), ['İstanbul Haber', 'Akşam haberleri']);
  assert.deepEqual((await engine.call('search', ['İSTANBUL'])).map((m) => [m.title, m.id]), [['İstanbul Haber', md5('Haberler\nİstanbul Haber')]]);
  assert.deepEqual((await engine.call('search', ['izmir'.replace('i', 'İ')])).map((m) => m.title), ['İİİİİİİİ']);
  assert.deepEqual(await engine.call('search', ['spor\tother']), []);
  const [first] = await engine.call('getMediaList', ['all', { page: 1 }]);
  assert.deepEqual(await engine.call('search', [first.id.slice(0, 12)]), []);
});

test("a title page finds its id only where an id begins, and a lost ids piece reads the playlist again", async () => {
  const cacheDir = scratchDir('lp-m3u-ids-');
  await engineOver(text(PLAYLIST), { cacheDir }).engine.call('getCategories', []);
  const { engine, transport } = engineOver(text(PLAYLIST), { cacheDir });
  const [a, b] = await engine.call('getMediaList', ['all', { page: 1 }]);

  const straddling = await failure(engine.call('getMediaDetail', [a.id.slice(16) + b.id.slice(0, 16)]));
  assert.equal(straddling.code, 'NOT_FOUND');
  assert.equal((await engine.call('getMediaDetail', [b.id])).title, 'Heist');
  assert.equal(transport.calls.length, 0);

  rmSync(chunkFile(cacheDir, 'playlist:ids:0'));
  const again = engineOver(text(PLAYLIST), { cacheDir });
  assert.equal((await again.engine.call('getMediaDetail', [b.id])).title, 'Heist');
  assert.equal(again.transport.calls.length, 1);
});

test('a search reads only the search pieces, and then only the chunks holding its hits', async () => {
  // Titles long enough that the search pieces are more than one.
  const entries = Array.from({ length: 5_000 }, (_, i) => ({ title: `Channel ${i} ${'y'.repeat(120)}`, group: 'News', url: `https://cdn.test/${i}.ts` }));
  const body = ['#EXTM3U', ...entries.map((e) => `#EXTINF:-1 group-title="News",${e.title}\n${e.url}`)].join('\n');
  const model = modelOf(entries);
  const cacheDir = scratchDir('lp-m3u-search-reads-');
  await engineOver(text(body), { cacheDir }).engine.call('getCategories', []);
  const { engine, host } = engineOver(text(body), { cacheDir });
  const cache = host.yonto.cache;
  const read = [];
  host.yonto.cache = { ...cache, get: async (key) => { read.push(key); return cache.get(key); } };

  assert.deepEqual(await engine.call('search', ['nothing like it']), []);
  const none = read.splice(0);
  const last = model.all.at(-1);
  assert.deepEqual(await engine.call('search', [last.title.toUpperCase()]), [last]);

  assert.deepEqual(none, ['playlist', 'playlist:search:0', 'playlist:search:1']);
  assert.deepEqual(read, ['playlist', 'playlist:search:0', 'playlist:search:1', 'playlist:1']);
});

test('a lost search piece, or one another build wrote, reads the playlist again', async () => {
  const cacheDir = scratchDir('lp-m3u-search-lost-');
  await engineOver(text(PLAYLIST), { cacheDir }).engine.call('getCategories', []);
  const { build } = JSON.parse(readFileSync(chunkFile(cacheDir, 'playlist'), 'utf8').split('\n')[1]);
  const piece = chunkFile(cacheDir, 'playlist:search:0');
  writeFileSync(piece, readFileSync(piece, 'utf8').replace(build, 'x'.repeat(build.length)));

  const other = engineOver(text(PLAYLIST), { cacheDir });
  const found = await other.engine.call('search', ['heist']);
  rmSync(piece);
  const lost = engineOver(text(PLAYLIST), { cacheDir });
  const again = await lost.engine.call('search', ['heist']);

  assert.deepEqual(found.map((m) => m.title), ['Heist', 'Second Heist']);
  assert.deepEqual(again, found);
  assert.equal(other.transport.calls.length, 1);
  assert.equal(lost.transport.calls.length, 1);
});

test('a search piece the cache did not keep holds the playlist too', async () => {
  const { engine, transport, host } = engineOver(text(PLAYLIST));
  const cache = host.yonto.cache;
  host.yonto.cache = { ...cache, set: async (key, ...rest) => (key === 'playlist:search:0' ? false : cache.set(key, ...rest)) };

  await engine.call('getCategories', []);
  assert.deepEqual((await engine.call('search', ['world'])).map((m) => m.title), ['World News']);
  assert.equal(transport.calls.length, 1);
});
