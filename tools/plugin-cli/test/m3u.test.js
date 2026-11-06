import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { scratchDir } from '../src/scratch-dir.js';
import { PluginError, Code } from '../src/errors.js';

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

function engineOver(answer, { config = {}, now = Date.now } = {}) {
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
    pluginDir: dir,
    now,
  });
  return { transport, engine: createEngine({ dir, host }) };
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

test("an entry's id is the md5 of its address and title, so History and the Watch list keep finding it", async () => {
  const { createHash } = await import('node:crypto');
  const { engine } = engineOver(text(PLAYLIST));

  const [news] = await engine.call('getMediaList', ['all', { page: 1 }]);

  assert.equal(news.id, createHash('md5').update('https://cdn.test/news.m3u8\nWorld News').digest('hex'));
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
