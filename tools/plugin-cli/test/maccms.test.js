import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * `plugins/maccms`, the handler for one MacCMS server (kangzj/lantern-tv#615, phase 5).
 *
 * Scripted rather than replayed, as `xptv-cms.test.js` is, from which most of these came: what is
 * under test is the reading, and a recording of one live CMS is a recording of one build's habits.
 * `doctor --replay` over `plugins/maccms/fixtures` is the recording.
 */
const dir = fileURLToPath(new URL('../../../plugins/maccms/', import.meta.url));

const CMS = 'https://cms.test/api.php/provide/vod/';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** Two classes with parentage said, and one child under each. */
const CLASSES = [
  { type_id: 1, type_name: '电影', type_pid: 0 },
  { type_id: 2, type_name: '电视剧', type_pid: 0 },
  { type_id: 36, type_name: '动作片', type_pid: 1 },
  { type_id: 37, type_name: '国产剧', type_pid: 2 },
];

const VOD = {
  vod_id: 42,
  vod_name: '画皮',
  type_name: '动作片',
  vod_pic: 'https://cms.test/pic/42.jpg',
  vod_year: '2008',
  vod_douban_score: '7.2',
  vod_class: '动作,奇幻',
  vod_remarks: 'HD',
  vod_content: '<p>一个&amp;nbsp;故事</p>',
  vod_play_from: '线路一$$$线路二',
  vod_play_url: '第1集$https://cms.test/1.m3u8#第2集$https://cms.test/2.m3u8$$$正片$https://cms.test/x.mp4',
};

/**
 * A transport answering whatever [pages] says, keyed by the `ac=` the request carries, because
 * that is the only thing that tells a class call from a listing call from a detail call.
 */
function engineOver({ pages = {}, config = {}, now = Date.now } = {}) {
  const transport = {
    calls: [],
    async request(req) {
      this.calls.push(req.url);
      const action = /[?&]ac=([^&]*)/.exec(req.url)?.[1] ?? '';
      const answer = pages[action];
      if (answer === undefined) return { status: 200, headers: {}, bodyBase64: b64('{"code":1,"list":[]}') };
      return typeof answer === 'function' ? answer(req) : answer;
    },
  };
  const host = createHost({
    manifest: loadManifest(dir),
    config: { api: CMS, dialect: 'json', searchable: 'true', ...config },
    transport,
    storeDir: scratchDir('lp-maccms-'),
    pluginDir: dir,
    now,
  });
  return { host, transport, engine: createEngine({ dir, host }) };
}

function json(value, { status = 200, headers = {} } = {}) {
  return { status, headers, bodyBase64: b64(JSON.stringify(value)) };
}

function text(body, { status = 200 } = {}) {
  return { status, headers: {}, bodyBase64: b64(body) };
}

/** The query a request carried, as a plain object. */
function query(url) {
  const [, search = ''] = url.split('?');
  return Object.fromEntries(search.split('&').filter(Boolean).map((pair) => {
    const [name, value = ''] = pair.split('=');
    return [name, decodeURIComponent(value)];
  }));
}

const failure = (promise) => promise.then(() => null, (error) => error);

// ------------------------------------------------------------------------ categories and filters

test('a server offers its own top-level classes, under its latest', async () => {
  const { transport, engine } = engineOver({ pages: { list: json({ code: 1, class: CLASSES, list: [] }) } });

  const categories = await engine.call('getCategories', []);

  // The children live in the 分类 filter, because Home asks for a shelf per category at once.
  assert.deepEqual(query(transport.calls[0]), { ac: 'list' });
  assert.deepEqual(categories, [
    { id: 'latest', name: '最新' },
    { id: '1', name: '电影' },
    { id: '2', name: '电视剧' },
  ]);
});

test('a class list that says nothing about parentage is read by the seed ids', async () => {
  const flat = [
    { type_id: 1, type_name: '电影' },
    { type_id: 4, type_name: '动漫' },
    { type_id: 36, type_name: '动作片' },
  ];
  const { engine } = engineOver({ pages: { list: json({ code: 1, class: flat, list: [] }) } });

  const categories = await engine.call('getCategories', []);

  assert.deepEqual(categories.map((category) => category.name), ['最新', '电影', '动漫']);
});

test('a site that renumbered its classes offers its latest rather than a guess', async () => {
  const renumbered = [{ type_id: 91, type_name: '电影' }, { type_id: 92, type_name: '剧集' }];
  const { engine } = engineOver({ pages: { list: json({ code: 1, class: renumbered, list: [] }) } });

  assert.deepEqual(await engine.call('getCategories', []), [{ id: 'latest', name: '最新' }]);
});

test('a class named twice is one category, because Compose keys the list on the id', async () => {
  const repeated = [
    { type_id: 1, type_name: '电影', type_pid: 0 },
    { type_id: 1, type_name: '电影（重复）', type_pid: 0 },
  ];
  const { engine } = engineOver({ pages: { list: json({ code: 1, class: repeated, list: [] }) } });

  const categories = await engine.call('getCategories', []);

  assert.deepEqual(categories.map((category) => category.id), ['latest', '1']);
});

test('the 分类 filter offers the classes under the one being read', async () => {
  const { engine } = engineOver({ pages: { list: json({ code: 1, class: CLASSES, list: [] }) } });

  assert.deepEqual(await engine.call('getFilters', ['1']), [
    { id: 'class', name: '分类', options: [{ id: '36', name: '动作片' }] },
  ]);
  // 动作片 has nothing under it, which is a category with no filters rather than an empty group.
  assert.deepEqual(await engine.call('getFilters', ['36']), []);
});

test('the latest offers every class in the filter', async () => {
  const { engine } = engineOver({ pages: { list: json({ code: 1, class: CLASSES, list: [] }) } });

  const [group] = await engine.call('getFilters', ['latest']);
  assert.deepEqual(group.options.map((option) => option.id), ['1', '2', '36', '37']);
});

// ------------------------------------------------------------------------ listings

test('a listing asks for the class and the page, and its cards carry the site\'s own ids', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  const items = await engine.call('getMediaList', ['36', { page: 3, filters: {} }]);

  assert.deepEqual(query(transport.calls.at(-1)), { ac: 'detail', t: '36', pg: '3' });
  // The site's own id, bare, and a card leaves out what the site did not say rather than
  // carrying it as undefined.
  assert.deepEqual(items, [{
    id: '42',
    title: '画皮',
    type: 'MOVIE',
    posterUrl: 'https://cms.test/pic/42.jpg',
    year: '2008',
    rating: '7.2',
  }]);
});

test('the latest asks with no class at all', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  await engine.call('getMediaList', ['latest', { page: 1, filters: {} }]);

  // Not `t=`, which is a class whose id is the empty string, and not `t=latest`.
  assert.deepEqual(query(transport.calls.at(-1)), { ac: 'detail', pg: '1' });

  // And only `latest` is the latest: an empty id is a class of that name, asked as one.
  await engine.call('getMediaList', ['', { page: 1, filters: {} }]);
  assert.deepEqual(query(transport.calls.at(-1)), { ac: 'detail', t: '', pg: '1' });
});

test('the chosen filter wins over the category, and an empty one is no choice', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  await engine.call('getMediaList', ['1', { page: 1, filters: { class: '36' } }]);
  assert.equal(query(transport.calls.at(-1)).t, '36');

  await engine.call('getMediaList', ['1', { page: 1, filters: { class: '' } }]);
  assert.equal(query(transport.calls.at(-1)).t, '1');
});

test('a page that is not a whole number above zero is the first page', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  for (const [page, sent] of [[2.7, '2'], [0, '1'], [-3, '1'], [Number.NaN, '1']]) {
    await engine.call('getMediaList', ['latest', { page, filters: {} }]);
    assert.equal(query(transport.calls.at(-1)).pg, sent, String(page));
  }
});

test('a title listed twice is one card', async () => {
  const { engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD, { ...VOD, vod_name: '画皮（重复）' }] }) } });

  const items = await engine.call('getMediaList', ['latest', { page: 1, filters: {} }]);

  assert.deepEqual(items.map((item) => item.title), ['画皮']);
});

test('a body in GBK is read in GBK', async () => {
  const body = Buffer.concat([
    Buffer.from('{"code":1,"list":[{"vod_id":7,"vod_name":"', 'utf8'),
    Buffer.from([0xbb, 0xad, 0xc6, 0xa4]),
    Buffer.from('","vod_play_from":"a","vod_play_url":"1$https://cms.test/1.m3u8"}]}', 'utf8'),
  ]);
  const { engine } = engineOver({
    pages: {
      detail: { status: 200, headers: { 'content-type': 'application/json; charset=GBK' }, bodyBase64: body.toString('base64') },
    },
  });

  const items = await engine.call('getMediaList', ['latest', { page: 1, filters: {} }]);

  assert.equal(items[0].title, '画皮');
});

test('an address that already carries a query keeps it', async () => {
  const { transport, engine } = engineOver({
    config: { api: 'https://cms.test/api.php?ac=list&from=tv' },
    pages: { detail: json({ code: 1, list: [VOD] }) },
  });

  await engine.call('getMediaList', ['latest', { page: 1, filters: {} }]);

  const asked = query(transport.calls.at(-1));
  assert.equal(asked.from, 'tv');
  assert.equal(asked.ac, 'detail');
});

// ------------------------------------------------------------------------ a title

test('a detail carries every episode of every line, under the id it was opened by', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  const detail = await engine.call('getMediaDetail', ['42']);

  assert.deepEqual(query(transport.calls.at(-1)), { ac: 'detail', ids: '42' });
  assert.equal(detail.id, '42');
  // 动作片 says film, two episodes on a line or not.
  assert.equal(detail.type, 'MOVIE');
  assert.deepEqual(detail.genres, ['动作', '奇幻']);
  assert.deepEqual(detail.playbackOptions, [
    { label: '第1集', stream: { url: 'https://cms.test/1.m3u8', mimeType: 'application/x-mpegURL' }, line: '线路一' },
    { label: '第2集', stream: { url: 'https://cms.test/2.m3u8', mimeType: 'application/x-mpegURL' }, line: '线路一' },
    { label: '正片', stream: { url: 'https://cms.test/x.mp4', mimeType: 'video/mp4' }, line: '线路二' },
  ]);
});

test('a detail is typed by what the site says, and by its lines only where it says neither', async () => {
  const typed = async (vod) => {
    const { engine } = engineOver({ pages: { detail: json({ code: 1, list: [{ ...VOD, ...vod }] }) } });
    return (await engine.call('getMediaDetail', ['42'])).type;
  };

  assert.equal(await typed({ type_name: '国产剧', vod_play_from: '线路一', vod_play_url: '第1集$https://cms.test/1.m3u8' }), 'SERIES');
  assert.equal(await typed({ type_name: '其他', vod_remarks: '更新至1集', vod_play_from: '线路一', vod_play_url: '第1集$https://cms.test/1.m3u8' }), 'SERIES');
  assert.equal(await typed({ type_name: '其他' }), 'SERIES');
  assert.equal(await typed({ type_name: '其他', vod_play_url: '正片$https://cms.test/1.m3u8$$$正片$https://cms.test/x.mp4' }), 'MOVIE');
});

test('a synopsis is text, and a double-encoded entity in it is the character the site meant', async () => {
  const { engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  const detail = await engine.call('getMediaDetail', ['42']);

  assert.equal(detail.synopsis, '一个 故事');
});

test('a numeric entity no character answers to does not take the title down', async () => {
  const damaged = { ...VOD, vod_content: 'a&#1114112;b&#0;c' };
  const { engine } = engineOver({ pages: { detail: json({ code: 1, list: [damaged] }) } });

  const detail = await engine.call('getMediaDetail', ['42']);

  assert.ok(!detail.synopsis.includes('\u0000'), JSON.stringify(detail.synopsis));
  assert.ok(detail.synopsis.startsWith('a'), JSON.stringify(detail.synopsis));
});

test('a title with nothing to play refuses rather than answering an empty detail', async () => {
  const unfilled = { ...VOD, vod_play_from: '', vod_play_url: '' };
  const { engine } = engineOver({ pages: { detail: json({ code: 1, list: [unfilled] }) } });

  const error = await failure(engine.call('getMediaDetail', ['42']));

  assert.equal(error.code, Code.UNAVAILABLE);
  assert.match(error.message, /画皮/);
});

test('a site answering a one-id question with somebody else opens nothing', async () => {
  const other = { ...VOD, vod_id: 43, vod_name: '别的片子' };
  for (const list of [[other, { ...VOD, vod_id: 44, vod_name: '又一部' }], [other]]) {
    const { engine } = engineOver({ pages: { detail: json({ code: 1, list }) } });

    const error = await failure(engine.call('getMediaDetail', ['42']));

    assert.equal(error?.code, Code.NOT_FOUND, JSON.stringify(list.map((vod) => vod.vod_id)));
  }
});

test('an empty id is not found without asking', async () => {
  const { transport, engine } = engineOver();

  const error = await failure(engine.call('getMediaDetail', ['']));

  assert.equal(error?.code, Code.NOT_FOUND);
  assert.deepEqual(transport.calls, []);
});

// ------------------------------------------------------------------------ search

test('a search asks the server over wd', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD, VOD] }) } });

  const found = await engine.call('search', ['画皮']);

  assert.deepEqual(query(transport.calls.at(-1)), { ac: 'detail', wd: '画皮' });
  assert.deepEqual(found.map((item) => item.id), ['42']);
});

test('a server its repo says does not search is not asked, and says so as a server that answered would', async () => {
  const { transport, engine } = engineOver({ config: { searchable: 'false' } });
  const refused = engineOver({ pages: { detail: text('暂不支持搜索') } });

  const error = await failure(engine.call('search', ['画皮']));
  const answered = await failure(refused.engine.call('search', ['画皮']));

  // `searchable: 0` in the index, as TVBox and FongMi read it (Jasper, 2026-09-23): nothing is
  // sent, and the viewer reads the one sentence this handler has for a catalog with no search.
  assert.deepEqual(transport.calls, []);
  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.equal(error.message, answered.message);
});

test('a search answered with 暂不支持搜索 says the catalog has no search', async () => {
  const answers = {
    plain: text('暂不支持搜索'),
    envelope: json({ code: 0, msg: '暂不支持搜索' }),
  };
  for (const [how, answer] of Object.entries(answers)) {
    const { host, engine } = engineOver({ pages: { detail: answer } });

    const error = await failure(engine.call('search', ['画皮']));

    assert.equal(error.code, Code.UNAVAILABLE, how);
    assert.match(error.message, /doesn't have search/, how);
    assert.ok(host.logs.some((e) => e.level === 'info' && e.message === 'the server has no search'), JSON.stringify(host.logs));
  }
});

test('a listing that says 不支持搜索 is not taken for a search refusal', async () => {
  const { engine } = engineOver({ pages: { detail: text('暂不支持搜索') } });

  const error = await failure(engine.call('getMediaDetail', ['42']));

  assert.match(error?.message ?? '', /can't be read/);
});

test('a query the URL encoder will not take sends nothing', async () => {
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: [VOD] }) } });

  const error = await failure(engine.call('search', ['\ud800']));

  assert.equal(error.code, Code.UNAVAILABLE);
  assert.match(error.message, /This search can't be sent/);
  assert.deepEqual(transport.calls, []);
});

// ------------------------------------------------------------------------ what a server says

test('only a server that did not answer is unreachable, which is what the app rests', async () => {
  // `unreachable` (contract 16) is the one error that rests a source. A request that went out and
  // got nothing back is one, and so is a status that is not 404, 401 or 403; every answer the
  // server did give is `unavailable`, with a sentence of its own.
  const down = {
    'a 503': json({}, { status: 503 }),
    'no connection': () => { throw new Error('connect refused'); },
  };
  const answered = {
    'a 403': json({}, { status: 403 }),
    'code 0': json({ code: 0, msg: '数据获取失败' }),
    'a page nobody can read': text('<html>维护中</html>'),
    'a redirect chain the host gave up on': { status: 302, headers: { location: 'ftp://cms.test/x' }, bodyBase64: '' },
  };
  const sentences = new Map();
  for (const [how, answer] of Object.entries({ ...down, ...answered })) {
    const { engine } = engineOver({ pages: { detail: answer } });
    const error = await failure(engine.call('getMediaList', ['latest', { page: 1, filters: {} }]));
    assert.equal(error?.code, how in down ? Code.UNREACHABLE : Code.UNAVAILABLE, how);
    sentences.set(how, error.message);
  }

  assert.equal(sentences.get('a 503'), sentences.get('no connection'));
  // Nothing retries on its own, so the sentence promises no retry.
  assert.equal(sentences.get('a 503'), "Can't reach this source right now. Try again later.");
  assert.equal(new Set(Object.keys(answered).map((how) => sentences.get(how))).size, Object.keys(answered).length);
  for (const how of Object.keys(answered)) {
    assert.notEqual(sentences.get(how), sentences.get('a 503'), how);
  }
});

test('an address the host will not send is the form\'s to fix, and asks the server nothing', async () => {
  for (const api of ['https://cms.test:99999/api.php', 'https://c%ms.test/api.php']) {
    const { transport, engine } = engineOver({ config: { api } });

    const error = await failure(engine.call('getCategories', []));

    assert.equal(error?.code, Code.MISCONFIGURED, api);
    assert.match(error.message, /API address/, api);
    assert.deepEqual(transport.calls, [], api);
  }
});

test('running out of time is the host\'s answer, not the server\'s', async () => {
  // A clock that has passed the whole call's budget by the time the request would go out, as a
  // call queued behind a slow one's would: the host refuses to send it (kangzj/lantern-tv#560),
  // which says nothing about the server.
  let reads = 0;
  const { transport, engine } = engineOver({
    now: () => 1_700_000_000_000 + (reads++) * 20_001,
    pages: { detail: json({ code: 1, list: [VOD] }) },
  });

  const error = await failure(engine.call('getMediaList', ['latest', { page: 1, filters: {} }]));

  assert.equal(error?.code, Code.TIMEOUT);
  assert.deepEqual(transport.calls, []);
});

test('a redirect to another host is not followed, and is not an outage to wait out', async () => {
  const { transport, engine } = engineOver({
    pages: { detail: { status: 302, headers: { location: 'https://elsewhere.test/api.php/provide/vod/?ac=detail' }, bodyBase64: '' } },
  });
  const down = engineOver({ pages: { detail: json({}, { status: 503 }) } });

  const error = await failure(engine.call('getMediaList', ['latest', { page: 1, filters: {} }]));
  const outage = await failure(down.engine.call('getMediaList', ['latest', { page: 1, filters: {} }]));

  // It reaches its `api`'s host and nothing else, redirect hops included.
  assert.ok(transport.calls.every((url) => url.startsWith(CMS)), JSON.stringify(transport.calls));
  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.notEqual(error.message, outage.message);
  assert.match(error.message, /won't connect to/);
});

test('a 404 is a thing the server does not have', async () => {
  const { engine } = engineOver({ pages: { detail: json({}, { status: 404 }) } });

  const error = await failure(engine.call('getMediaDetail', ['42']));

  assert.equal(error?.code, Code.NOT_FOUND);
});

test('a 403 is a gate rather than an outage, and never a login', async () => {
  const { engine } = engineOver({ pages: { list: json({}, { status: 403 }) } });

  const error = await failure(engine.call('getCategories', []));

  // Never `unauthenticated`: there is no login for a MacCMS site, so it would send a viewer to a
  // screen that does not exist.
  assert.equal(error.code, Code.UNAVAILABLE);
  assert.match(error.message, /refused access/);
});

test('a code nobody here has seen, with titles beside it, is a listing', async () => {
  const { engine } = engineOver({ pages: { detail: json({ code: 200, list: [VOD] }) } });

  const items = await engine.call('getMediaList', ['latest', { page: 1, filters: {} }]);

  assert.equal(items.length, 1);
});

test('a failure is logged by what happened, never by the address, its key or the query', async () => {
  const api = `${CMS}?token=s3cr3t-key`;
  const answers = {
    404: () => json({}, { status: 404 }),
    503: () => json({}, { status: 503 }),
    unreachable: () => { throw new Error(`connect refused: ${api}`); },
  };
  for (const [how, answer] of Object.entries(answers)) {
    const { host, engine } = engineOver({ config: { api }, pages: { detail: answer } });

    await failure(engine.call('search', ['私人搜索词']));

    assert.ok(host.logs.length > 0, how);
    for (const { message } of host.logs) {
      for (const secret of ['cms.test', 's3cr3t-key', '私人搜索词', encodeURIComponent('私人搜索词')]) {
        assert.ok(!message.includes(secret), `${how}: ${secret} in ${message}`);
      }
    }
  }
});

test('an address that is not http(s) is the form\'s fault', async () => {
  const { transport, engine } = engineOver({ config: { api: 'ftp://cms.test/' } });

  const error = await failure(engine.call('getCategories', []));

  assert.equal(error?.code, Code.MISCONFIGURED);
  assert.deepEqual(transport.calls, []);
});

test('a TVBox/XPTV index typed as the API address is the form\'s fault, not an empty catalog (kangzj/lantern-tv#1075)', async () => {
  const index = { sites: [{ name: '哔滴影视', type: 3, api: 'csp_bde4', ext: 'https://example.com/bdys.js' }] };
  const { engine } = engineOver({ pages: { list: json(index) } });

  const error = await failure(engine.call('getCategories', []));

  assert.equal(error?.code, Code.MISCONFIGURED);
  assert.match(error.message, /a repo of many sites/);
});

// ------------------------------------------------------------------------ recommendations

test('recommendations are the latest page by weekly hits, with artwork only', async () => {
  const titles = [
    { ...VOD, vod_id: 1, vod_name: '甲', vod_hits_week: 10 },
    { ...VOD, vod_id: 2, vod_name: '乙', vod_hits_week: 900 },
    { ...VOD, vod_id: 3, vod_name: '丙', vod_hits_week: 5000, vod_pic: '' },
    { ...VOD, vod_id: 4, vod_name: '丁', vod_hits_week: 500 },
  ];
  const { transport, engine } = engineOver({ pages: { detail: json({ code: 1, list: titles }) } });

  const ranked = await engine.call('getRecommendations', []);

  assert.deepEqual(query(transport.calls.at(-1)), { ac: 'detail', pg: '1' });
  assert.deepEqual(ranked.map((item) => item.id), ['2', '4', '1']);
});

test('recommendations are at most ten, and a failure is no ranking rather than an error', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ ...VOD, vod_id: index + 1, vod_hits_week: index }));
  const { engine } = engineOver({ pages: { detail: json({ code: 1, list: many }) } });
  const down = engineOver({ pages: { detail: json({}, { status: 503 }) } });

  assert.equal((await engine.call('getRecommendations', [])).length, 10);
  assert.deepEqual(await down.engine.call('getRecommendations', []), []);
});

// ------------------------------------------------------------------------ the XML dialect

/** One page of the XML dialect, as the `at/xml` sites of #572 serve it. */
function xml(videos, classes = '') {
  return text(`<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="1" pagecount="1">${videos}</list>${classes}</rss>`);
}

const XML_VIDEO = '<video><id>150835</id><name><![CDATA[你的喜欢无与伦比]]></name><type>日剧</type>'
  + '<pic>https://xml.test/p.jpg</pic><year>2026</year><note><![CDATA[全10集]]></note>'
  + '<des><![CDATA[<p>&nbsp;&nbsp;草壁杏奈 <name>假名</name> 只是文字。</p>]]></des>'
  + '<dl><dd flag="snm3u8"><![CDATA[第01集$https://xml.test/1.m3u8#第02集$https://xml.test/2.m3u8]]></dd>'
  + '<dd flag="snbak">第01集$https://xml.test/3.m3u8?id=1&amp;t=2</dd></dl></video>';

test('an XML server is read over videolist, and its classes over list', async () => {
  const { transport, engine } = engineOver({
    config: { dialect: 'xml' },
    pages: {
      videolist: xml(XML_VIDEO),
      list: xml('', '<class><ty id="1">电影</ty><ty id="16">日剧</ty></class>'),
    },
  });

  const categories = await engine.call('getCategories', []);
  const items = await engine.call('getMediaList', ['16', { page: 2, filters: {} }]);
  const detail = await engine.call('getMediaDetail', ['150835']);

  assert.deepEqual(transport.calls.map(query), [
    { ac: 'list' },
    { ac: 'videolist', t: '16', pg: '2' },
    { ac: 'videolist', ids: '150835' },
  ]);
  assert.deepEqual(categories, [{ id: 'latest', name: '最新' }, { id: '1', name: '电影' }]);
  assert.deepEqual(items, [{
    id: '150835', title: '你的喜欢无与伦比', type: 'SERIES', posterUrl: 'https://xml.test/p.jpg', year: '2026',
  }]);
  // CDATA is text, a `<name>` inside the synopsis's is not the title, and a `&amp;` outside one
  // is the `&` a player needs.
  assert.equal(detail.title, '你的喜欢无与伦比');
  assert.equal(detail.synopsis, '草壁杏奈 假名 只是文字。');
  assert.deepEqual(detail.playbackOptions.map((option) => [option.line, option.label, option.stream.url]), [
    ['snm3u8', '第01集', 'https://xml.test/1.m3u8'],
    ['snm3u8', '第02集', 'https://xml.test/2.m3u8'],
    ['snbak', '第01集', 'https://xml.test/3.m3u8?id=1&t=2'],
  ]);
});

test('an XML page is read as XML: a quoted >, a nested video and a self-closing pic', async () => {
  // The inner video comes first and has a line of its own, so a reader that searches the outer
  // video's descendants rather than its children picks up the inner name and line.
  const { engine } = engineOver({
    config: { dialect: 'xml' },
    pages: {
      videolist: xml([
        '<video><video><id>2</id><name>内</name><dl><dd flag="n">内1$https://v.test/2.m3u8</dd></dl></video>',
        '<id>1</id><name>外</name><dl><dd flag="a>b">第1集$https://v.test/1.m3u8</dd></dl></video>',
        '<video><id>3</id><name>丙</name><pic/><type>日剧</type><year>2026</year></video>',
      ].join('')),
    },
  });

  const items = await engine.call('getMediaList', ['latest', { page: 1, filters: {} }]);
  const detail = await engine.call('getMediaDetail', ['1']);

  assert.deepEqual(items.map((item) => item.title), ['外', '丙']);
  assert.equal(items[1].posterUrl, undefined);
  assert.equal(items[1].year, '2026');
  assert.deepEqual(detail.playbackOptions.map((option) => [option.line, option.label]), [['a>b', '第1集']]);
});

test('an XML server answering with something that is not XML says it could not be read', async () => {
  const { engine } = engineOver({
    config: { dialect: 'xml' },
    pages: { videolist: text('<!DOCTYPE html><html><body><h1>维护中</h1></body></html>') },
  });

  const error = await failure(engine.call('getMediaList', ['latest', { page: 1, filters: {} }]));

  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.match(error.message, /can't be read/);
});

test('an XML server answering a search with 暂不支持搜索 has no search', async () => {
  const { engine } = engineOver({ config: { dialect: 'xml' }, pages: { videolist: text('暂不支持搜索') } });

  const error = await failure(engine.call('search', ['画皮']));

  assert.match(error?.message ?? '', /doesn't have search/);
});
