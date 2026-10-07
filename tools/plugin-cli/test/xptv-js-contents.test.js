import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { validateResult } from '../src/contract.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * `plugins/xptv-js` reading a catalog's contents — their `getCards`, `getTracks` and `search`
 * mapped onto our listing, detail and search (kangzj/lantern-tv#372).
 *
 * Catalogs written for this suite, for the licence reason `xptv-js-catalogs.test.js` records.
 * What is under test is the mapping, which a real plugin, whose answers depend on a site being
 * up, cannot pin. The three real ones are in `xptv-js-real-catalogs.test.js`.
 */
const dir = fileURLToPath(new URL('../../../plugins/xptv-js/', import.meta.url));

const EXT = 'https://catalogs.test/one.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** One catalog, whose JavaScript is [source]. [site] answers every other URL. */
function engineOver(source, { storeDir = null, site = null, now = Date.now } = {}) {
  const transport = {
    calls: [],
    async request(req) {
      this.calls.push(req.url);
      if (req.url === EXT) return { status: 200, headers: {}, bodyBase64: b64(source) };
      if (site !== null) return site(req);
      return { status: 200, headers: {}, bodyBase64: b64('{"ok":true}') };
    },
  };
  const host = createHost({
    manifest: loadManifest(dir),
    config: { ext: EXT, className: 'csp_test' },
    transport,
    storeDir: storeDir ?? scratchDir('lp-xptv-js-contents-'),
    pluginDir: dir,
    now,
  });
  return { host, transport, engine: createEngine({ dir, host }) };
}

/**
 * A catalog in their shape: top-level `async function`s, `argsify` in and `jsonify` out, and
 * `$print` of what each entry point was asked with — which is how a test sees the `ext` that
 * crossed, since that object is the whole of what this plugin has to get right.
 */
function catalogSource({
  tab = "{ name: '电影', ext: { url: '/movie/' } }",
  cards = 'return jsonify({ list: [] })',
  tracks = 'return jsonify({ list: [] })',
  search = 'return jsonify({ list: [] })',
  // Absent by default: a catalog with no `getPlayinfo` is one whose tokens cannot be redeemed,
  // and every test written before kangzj/lantern-tv#392 was asking with that shape.
  playinfo = null,
} = {}) {
  return `
async function getConfig() {
  return jsonify({ ver: 1, title: 'T', site: 'https://s.test', tabs: [${tab}] })
}
async function getCards(ext) {
  ext = argsify(ext)
  $print('cards ' + jsonify(ext))
  ${cards}
}
async function getTracks(ext) {
  ext = argsify(ext)
  $print('tracks ' + jsonify(ext))
  ${tracks}
}
${search === null ? '' : `async function search(ext) {
  ext = argsify(ext)
  $print('search ' + jsonify(ext))
  ${search}
}`}
${playinfo === null ? '' : `async function getPlayinfo(ext) {
  ext = argsify(ext)
  $print('playinfo ' + jsonify(ext))
  ${playinfo}
}`}
`;
}

/** What one of their entry points was asked with, as it saw it. */
function asked(host, what) {
  const line = host.logs.map((entry) => entry.message).find((message) => message.includes(`${what} {`));
  return line === undefined ? null : JSON.parse(line.slice(line.indexOf('{')));
}

function timesAsked(host, what) {
  return host.logs.filter((entry) => entry.message.includes(`${what} {`)).length;
}

const CARD = "{ vod_id: '/p/1', vod_name: '庆余年', vod_pic: 'https://s.test/1.jpg', vod_remarks: '更新至12集', ext: { url: '/p/1' } }";

async function categoryId(engine) {
  const [category] = await engine.call('getCategories', []);
  return category.id;
}

test("a listing's cards become summaries, and the tab's own ext is what asked for them", async () => {
  const { host, engine } = engineOver(catalogSource({ cards: `return jsonify({ list: [${CARD}] })` }));
  const id = await categoryId(engine);

  const items = await engine.call('getMediaList', [id, { page: 1, filters: {} }]);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, '庆余年');
  assert.equal(items[0].posterUrl, 'https://s.test/1.jpg');
  // The tab's whole `ext`, and a page beside it — not a field read out of the ext, which is
  // what `getCategories` carried the whole object for.
  assert.deepEqual(asked(host, 'cards'), { url: '/movie/', page: 1 });
});

test('a media id carries what a detail screen has to draw, since their getTracks carries none of it', async () => {
  const { host, engine } = engineOver(catalogSource({ cards: `return jsonify({ list: [${CARD}] })` }));
  const id = await categoryId(engine);
  const [item] = await engine.call('getMediaList', [id, { page: 1 }]);

  // Byte for byte what `plugins/xptv` put after its `<entry id>|`, since History keeps these
  // and a migrated source hands them back with that prefix stripped.
  assert.equal(item.id, '{"e":{"url":"/p/1"},"n":"庆余年","p":"https://s.test/1.jpg"}');

  // And the `e` half is what their `getTracks` is asked with, whole.
  await engine.call('getMediaDetail', [item.id]).catch(() => {});
  assert.deepEqual(asked(host, 'tracks'), { url: '/p/1' });
});

test('an id that would run long loses its artwork and never its ext', async () => {
  const pic = `https://s.test/${'a'.repeat(1200)}.jpg`;
  const { host, engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [{ vod_name: '长图', vod_pic: '${pic}', ext: { url: '/p/9' } }] })`,
  }));
  const id = await categoryId(engine);

  const [item] = await engine.call('getMediaList', [id, { page: 1 }]);

  const inner = JSON.parse(item.id);
  assert.deepEqual(inner.e, { url: '/p/9' });
  assert.equal(inner.p, '');
  // The summary still carries the artwork; it is the id that cannot afford it.
  assert.equal(item.posterUrl, pic);
  assert.ok(host.logs.some((entry) => entry.message.includes('dropped the artwork')), JSON.stringify(host.logs));
});

test('page two is their ext.page, and a chosen filter is their ext.filters', async () => {
  const { host, engine } = engineOver(catalogSource());
  const id = await categoryId(engine);

  await engine.call('getMediaList', [id, { page: 2, filters: { cateId: '101' } }]);

  assert.deepEqual(asked(host, 'cards'), { url: '/movie/', page: 2, filters: { cateId: '101' } });
});

test('a filter group the viewer left alone is omitted rather than sent empty', async () => {
  const { host, engine } = engineOver(catalogSource());
  const id = await categoryId(engine);

  await engine.call('getMediaList', [id, { page: 1, filters: {} }]);

  // Their rule read from the other end: a request omitting a key is the key's `init`, so an
  // empty map has to arrive as no `filters` at all.
  assert.deepEqual(asked(host, 'cards'), { url: '/movie/', page: 1 });
});

test('their filter groups become ours, and the ones our contract cannot take are dropped', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [], filter: [
      { key: 'cateId', name: '分类', init: '0', value: [{ n: '全部', v: '' }, { n: '动作片', v: '101' }] },
      { key: 'page', name: '页', value: [{ n: '1', v: '1' }] },
      { key: '', name: '没有 key', value: [{ n: 'x', v: 'x' }] },
      { key: 'year', name: '年份', value: [{ n: '', v: '2024' }] },
    ] })`,
  }));
  const id = await categoryId(engine);

  const filters = await engine.call('getFilters', [id]);

  // Their `init: '0'` names nothing this group offers, so it is not carried: our `init` names
  // one of the group's own options or nothing (contract 13), and their fall-back is not ours.
  // With no `init` the app draws its own All, so their 全部 goes rather than showing twice.
  assert.deepEqual(filters, [
    { id: 'cateId', name: '分类', options: [{ id: '101', name: '动作片' }] },
  ]);
});

test('their 全部 is dropped where the app draws All, and kept where a group opens on an init', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [], filter: [
      { key: 'area', name: '地区', value: [{ n: '大陆', v: 'cn' }, { n: '全部', v: '' }, { n: '香港', v: 'hk' }] },
      { key: 'by', name: '排序', init: 'hits', value: [{ n: '全部', v: '' }, { n: '最热', v: 'hits' }] },
      { key: 'only', name: '只有全部', value: [{ n: '全部', v: '' }] },
    ] })`,
  }));
  const id = await categoryId(engine);

  const filters = await engine.call('getFilters', [id]);

  assert.deepEqual(filters, [
    { id: 'area', name: '地区', options: [{ id: 'cn', name: '大陆' }, { id: 'hk', name: '香港' }] },
    { id: 'by', name: '排序', init: 'hits', options: [{ id: '', name: '全部' }, { id: 'hits', name: '最热' }] },
  ]);
});

// ole's 分类 writes its 全部 as `v: '0'`, and its getCards reads `cateId || '0'`, so the app's
// All (no `cateId`) and 全部 were two chips for one listing (kangzj/lantern-tv#621).
test('a 全部 whose id is not empty is still dropped where the app draws All', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [], filter: [
      { key: 'cateId', name: '分类', value: [{ n: '全部', v: '0' }, { n: '动作片', v: '101' }] },
      { key: 'by', name: '排序', init: 'hits', value: [{ n: '全部', v: '0' }, { n: '最热', v: 'hits' }] },
    ] })`,
  }));
  const id = await categoryId(engine);

  const filters = await engine.call('getFilters', [id]);

  assert.deepEqual(filters, [
    { id: 'cateId', name: '分类', options: [{ id: '101', name: '动作片' }] },
    { id: 'by', name: '排序', init: 'hits', options: [{ id: '0', name: '全部' }, { id: 'hits', name: '最热' }] },
  ]);
});

// bdys calls its unrestricted option 不限 and missav 所有; both are `v: ''`, so it is the empty id
// that drops them, not the name (kangzj/lantern-tv#589). And 全部 goes wherever it sits in the
// group, not only first.
test('an empty-id option goes whatever it is called, and 全部 goes wherever it sits', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [], filter: [
      { key: 'type', name: '类型', value: [{ n: '不限', v: '' }, { n: '剧集', v: 'tv' }] },
      { key: 'filters', name: '过滤', value: [{ n: '所有', v: '' }, { n: '中文字幕', v: 'zh' }] },
      { key: 'cateId', name: '分类', value: [{ n: '动作片', v: '101' }, { n: '全部', v: '0' }, { n: '喜剧片', v: '102' }] },
    ] })`,
  }));
  const id = await categoryId(engine);

  const filters = await engine.call('getFilters', [id]);

  assert.deepEqual(filters, [
    { id: 'type', name: '类型', options: [{ id: 'tv', name: '剧集' }] },
    { id: 'filters', name: '过滤', options: [{ id: 'zh', name: '中文字幕' }] },
    { id: 'cateId', name: '分类', options: [{ id: '101', name: '动作片' }, { id: '102', name: '喜剧片' }] },
  ]);
});

test('a group whose init names one of its own options opens on it', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [], filter: [
      { key: 'by', name: '排序', init: 'hits', value: [{ n: '最新', v: 'time' }, { n: '最热', v: 'hits' }] },
      { key: 'area', name: '地区', init: '', value: [{ n: '全部', v: '' }, { n: '大陆', v: 'cn' }] },
      { key: 'year', name: '年份', value: [{ n: '全部', v: '' }, { n: '2024', v: '2024' }] },
      { key: 'type', name: '类型', init: 'x', value: [{ n: '', v: 'x' }, { n: '剧集', v: 'y' }] },
    ] })`,
  }));
  const id = await categoryId(engine);

  const filters = await engine.call('getFilters', [id]);

  // Their `init: ''` is 全部, the unrestricted state, which an `init` of ours cannot be; and
  // `type`'s `x` has no name, so it is not an option of ours and cannot be opened on either.
  assert.deepEqual(filters.map((group) => [group.id, group.init]),
    [['by', 'hits'], ['area', undefined], ['year', undefined], ['type', undefined]]);
});

test('an init is read the way an option id is, and one that is not a scalar names nothing', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [], filter: [
      { key: 'year', name: '年份', init: 2024, value: [{ n: '2024', v: 2024 }, { n: '2023', v: 2023 }] },
      { key: 'area', name: '地区', init: { v: 'cn' }, value: [{ n: '全部', v: '' }, { n: '大陆', v: 'cn' }] },
    ] })`,
  }));
  const id = await categoryId(engine);

  const filters = await engine.call('getFilters', [id]);

  assert.deepEqual(filters.map((group) => [group.id, group.init]), [['year', '2024'], ['area', undefined]]);
});

test('a catalog with no filters answers none, which is not the empty answer this plugin refuses', async () => {
  const { engine } = engineOver(catalogSource({ cards: `return jsonify({ list: [${CARD}] })` }));
  const id = await categoryId(engine);

  assert.deepEqual(await engine.call('getFilters', [id]), []);
});

test('getFilters and getMediaList each fetch their own page, which is what keeps doctor honest', async () => {
  const { host, engine } = engineOver(catalogSource({ cards: `return jsonify({ list: [${CARD}] })` }));
  const id = await categoryId(engine);

  await engine.call('getFilters', [id]);
  const items = await engine.call('getMediaList', [id, { page: 1, filters: {} }]);

  assert.equal(items.length, 1);
  // Handing `getFilters`'s page to the `getMediaList` after it saved a fetch, and was taken
  // out: `doctor` asks for exactly that pair, so the listing step stopped being a check of
  // its own — it re-reported what the filters step fetched, and nothing that breaks only on
  // the listing path could show up there. And the app caches filters for 24 hours and
  // listings for 15 minutes, so a second visit would have been served a page parked here a
  // day earlier.
  assert.equal(timesAsked(host, 'cards'), 2);
});

test('a card with no name is dropped, and one title offered twice is one card', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [
      ${CARD},
      ${CARD},
      { vod_id: '/p/2', vod_pic: 'https://s.test/2.jpg', ext: { url: '/p/2' } },
    ] })`,
  }));
  const id = await categoryId(engine);

  const items = await engine.call('getMediaList', [id, { page: 1 }]);

  // `BrowseScreen` and `SearchScreen` both key their grid on the media id and Compose throws
  // on a repeated key; the app's own guard covers the pages after the first, not this one.
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '庆余年');
});

test('an empty page is an empty page, not a refusal', async () => {
  // `tianyiso.js` names its only tab 只有搜索功能 and answers `getCards` with an empty list on
  // purpose; page two of a catalog with one page is the same answer for a different reason.
  const { engine } = engineOver(catalogSource());
  const id = await categoryId(engine);

  assert.deepEqual(await engine.call('getMediaList', [id, { page: 1 }]), []);
});

test('a share is pan holding something, never pan being there', async () => {
  // 19 of their 48 write `pan: ''` on an ordinary episode, so `'pan' in track` would read
  // every one of those titles as a cloud-drive share and refuse a title that plays.
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [${CARD}] })`,
    tracks: `return jsonify({ list: [{ title: '在线', tracks: [{ name: '第1集', pan: '', ext: {} }] }] })`,
  }));
  const id = await categoryId(engine);
  const [item] = await engine.call('getMediaList', [id, { page: 1 }]);

  const detail = await engine.call('getMediaDetail', [item.id]);

  assert.equal(detail.playbackOptions.length, 1);
  assert.equal(typeof detail.playbackOptions[0].track, 'string');
});

test('a title with no tracks at all says so, in its own sentence', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [${CARD}] })`,
    tracks: `return jsonify({ list: [{ title: '在线', tracks: [] }] })`,
  }));
  const id = await categoryId(engine);
  const [item] = await engine.call('getMediaList', [id, { page: 1 }]);

  const error = await engine.call('getMediaDetail', [item.id]).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.match(error.message, /has nothing to play/);
});

test('search asks the catalog with the query under their own key', async () => {
  const { host, engine } = engineOver(catalogSource({ search: `return jsonify({ list: [${CARD}] })` }));

  const results = await engine.call('search', ['庆余年']);

  assert.equal(results.length, 1);
  assert.equal(results[0].title, '庆余年');
  assert.deepEqual(asked(host, 'search'), { text: '庆余年', page: 1 });
});

test('a catalog with no search of its own is a sentence, never an empty list', async () => {
  const { engine } = engineOver(catalogSource({ search: null }));

  const error = await engine.call('search', ['庆余年']).then(() => null, (e) => e);

  // An empty list reads as *searched and found nothing*, and a source that asked nobody has
  // not searched — kangzj/lantern-tv#229, and #390's rule for a source of many catalogs.
  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.match(error.message, /doesn't have search/);
});

test("a catalog answering a listing with HTML is the catalog's program, not the engine's words", async () => {
  const { engine } = engineOver(catalogSource({ cards: `return '<html>502</html>'` }));
  const id = await categoryId(engine);

  const error = await engine.call('getMediaList', [id, { page: 1 }]).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE);
  // Not `unexpected token: '<'`, which is the engine's own words about somebody else's file.
  assert.match(error.message, /won't run/);
  assert.doesNotMatch(error.message, /token/);
});

test('an id that still carries a prefix, or is not ours at all, is notFound', async () => {
  const { engine } = engineOver(catalogSource());

  // A migrated source's prefix is stripped before the handler sees an id, so one that reaches
  // it still carrying one was never this handler's.
  const stray = await engine.call('getMediaDetail', ['wogg|{"e":{},"n":"x","p":""}']).then(() => null, (e) => e);
  const mangled = await engine.call('getMediaDetail', ['not json']).then(() => null, (e) => e);

  assert.equal(stray?.code, Code.NOT_FOUND);
  assert.equal(mangled?.code, Code.NOT_FOUND);
});

test('an ext that is on its own over budget keeps its id and says so', async () => {
  // The artwork can go and the `ext` cannot — it is the whole of what `getTracks` is asked
  // with — so the budget is a budget rather than a cap, and a title stays openable.
  const { host, engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [{ vod_name: '长的', vod_pic: '', ext: { url: '/p/1', blob: 'x'.repeat(1500) } }] })`,
  }));
  const id = await categoryId(engine);

  const [item] = await engine.call('getMediaList', [id, { page: 1 }]);

  assert.ok(item.id.length > 1024, String(item.id.length));
  assert.deepEqual(JSON.parse(item.id).e.url, '/p/1');
  assert.ok(
    host.logs.some((entry) => entry.level === 'warn' && entry.message.includes('over budget')),
    JSON.stringify(host.logs),
  );
});

test('a category id and a media id are not read as each other', async () => {
  const { host, engine } = engineOver(catalogSource({ cards: `return jsonify({ list: [${CARD}] })` }));
  const category = await categoryId(engine);
  const [item] = await engine.call('getMediaList', [category, { page: 1 }]);

  // Both halves are this plugin's own strings and neither is the other's. Read as a media id,
  // a category id is a title with no `ext` at all — which would put a real request to a
  // stranger's site behind a refusal naming the catalog as though it were a title.
  const asDetail = await engine.call('getMediaDetail', [category]).then(() => null, (e) => e);
  const asListing = await engine.call('getMediaList', [item.id, { page: 1 }]).then(() => null, (e) => e);

  assert.equal(asDetail?.code, Code.NOT_FOUND);
  assert.equal(asListing?.code, Code.NOT_FOUND);
  // And neither of them asked the catalog anything.
  assert.equal(timesAsked(host, 'tracks'), 0);
  assert.equal(timesAsked(host, 'cards'), 1);
});

test('a tab ext that is not an object is asked with nothing, and logged', async () => {
  const { host, engine } = engineOver(catalogSource({ tab: "{ name: '电影', ext: '/movie/' }" }));
  const id = await categoryId(engine);

  await engine.call('getMediaList', [id, { page: 1 }]);

  // Spreading a string would ask `getCards` with an object of numbered characters. Starting
  // from none is the recoverable answer, and silence about it is what made it a guess.
  assert.deepEqual(asked(host, 'cards'), { page: 1 });
  assert.ok(
    host.logs.some((entry) => entry.level === 'warn' && entry.message.includes('not an object')),
    JSON.stringify(host.logs),
  );
});

// --------------------------------------- a token, and the catalog that issued it redeeming it

/**
 * kangzj/lantern-tv#392: their playback is per track and so is ours now. `getMediaDetail`
 * answers a `track` per episode and `getStream` hands one back to the catalog's own
 * `getPlayinfo` at the moment a viewer presses it.
 *
 * `xptv-js-real-catalogs.test.js` has the other half — `ddys.js` and
 * 独播库 redeemed end to end. What is written here is what a real plugin cannot show: a token
 * over the bound, a token from the wrong catalog, and the sentences at the edges.
 */
const EPISODES = `return jsonify({ list: [{ title: '在线', tracks: [
  { name: '第1集', pan: '', ext: { u: '/1.mp4' } },
  { name: '第2集', pan: '', ext: { u: '/2.mp4' } },
] }] })`;

const RESOLVES = `return jsonify({ urls: ['https://v.test' + ext.u] })`;

const withCards = (extra) => catalogSource({ cards: `return jsonify({ list: [${CARD}] })`, ...extra });

async function detailOf(under) {
  const id = await categoryId(under.engine);
  const [item] = await under.engine.call('getMediaList', [id, { page: 1 }]);
  return under.engine.call('getMediaDetail', [item.id]);
}

test('a token is the track\'s whole ext in its envelope, and redeems in a runtime that did not issue it', async () => {
  // Continue Playing resumes from a token kept for months, under a runtime built long after
  // the one that issued it. Byte for byte what `plugins/xptv` put after its `<entry id>|`.
  const issuing = withCards({ tracks: EPISODES, playinfo: RESOLVES });
  const storeDir = scratchDir('lp-xptv-js-token-');

  const detail = await detailOf(engineOver(issuing, { storeDir }));
  const token = detail.playbackOptions[1].track;
  assert.equal(token, '{"t":{"u":"/2.mp4"}}');

  const stream = await engineOver(issuing, { storeDir }).engine.call('getStream', [token]);

  assert.equal(stream.url, 'https://v.test/2.mp4');
});

test('a track over the token bound is not an option, and a title left with none says so', async () => {
  // The contract bounds a `track` at 2048 characters and the app enforces it at decode time,
  // so an option carrying more is one a television refuses. Nothing is pruned to make it fit:
  // the loader cannot know which fields that catalog's `getPlayinfo` reads, so a shortened
  // token resolves to the wrong thing or to nothing.
  const huge = `return jsonify({ list: [{ title: '在线', tracks: [
    { name: '第1集', pan: '', ext: { u: '/1.mp4' } },
    { name: '第2集', pan: '', ext: { u: 'x'.repeat(2100) } },
  ] }] })`;
  const under = engineOver(withCards({ tracks: huge, playinfo: RESOLVES }));

  const detail = await detailOf(under);

  // The one that fits is still offered — losing one episode beats losing the title.
  assert.deepEqual(detail.playbackOptions.map((option) => option.label), ['第1集']);
  assert.ok(detail.playbackOptions[0].track.length <= 2048);

  const allHuge = `return jsonify({ list: [{ title: '在线', tracks: [
    { name: '第1集', pan: '', ext: { u: 'x'.repeat(2100) } },
  ] }] })`;
  const none = engineOver(withCards({ tracks: allHuge, playinfo: RESOLVES }));
  const error = await detailOf(none).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.match(error.message, /can't be played in this version/);
});

test('getStream asks the catalog its token names, with the ext that track carried', async () => {
  const under = engineOver(withCards({ tracks: EPISODES, playinfo: RESOLVES }));
  const detail = await detailOf(under);

  const stream = await under.engine.call('getStream', [detail.playbackOptions[1].track]);

  assert.equal(stream.url, 'https://v.test/2.mp4');
  assert.equal(stream.mimeType, 'video/mp4');
  // Their whole `ext` went back out, not a field read out of it — the loader cannot know
  // which of them `getPlayinfo` reads.
  assert.deepEqual(asked(under.host, 'playinfo'), { u: '/2.mp4' });
});

test('a token this plugin did not write is notFound, not a question asked of a stranger site', async () => {
  const under = engineOver(withCards({ tracks: EPISODES, playinfo: RESOLVES }));
  await detailOf(under);

  // A category id is the other thing that is an `ext` behind the separator, and a stale token
  // arriving after its catalog changed is the case this is really about: without an envelope
  // of its own it would be handed to `getPlayinfo` as though it were a track's.
  const asCategory = '{"url":"/movie/"}';
  const error = await under.engine.call('getStream', [asCategory]).then(() => null, (e) => e);

  assert.equal(error?.code, Code.NOT_FOUND);
  assert.equal(timesAsked(under.host, 'playinfo'), 0);
});

test('a malformed token compiles no catalog, because it is read before the catalog is', async () => {
  // A stale category id is exactly that shape. Compiling first would fetch a stranger's
  // JavaScript and run it on the way to deciding the input was never a token.
  //
  // **A runtime that has compiled nothing yet**, which is the only place this is visible: after
  // any listing the catalog is already compiled and cached, so the fetch this is about has
  // happened and the count cannot move.
  const under = engineOver(withCards({ tracks: EPISODES, playinfo: RESOLVES }));
  const before = under.transport.calls.length;

  const error = await under.engine.call('getStream', ['{"url":"/movie/"}']).then(() => null, (e) => e);

  assert.equal(error?.code, Code.NOT_FOUND);
  assert.equal(under.transport.calls.length - before, 0, under.transport.calls.join(' '));
});

test('a catalog that answers no url throws a sentence rather than a stream without one', async () => {
  // The contract: a source that cannot produce a URL throws with a sentence naming what
  // failed. Theirs is the opposite convention — 63 of their plugins answer `{urls: []}`.
  const under = engineOver(withCards({ tracks: EPISODES, playinfo: `return jsonify({ urls: [] })` }));
  const detail = await detailOf(under);

  const error = await under.engine.call('getStream', [detail.playbackOptions[0].track]).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.match(error.message, /gave no address to play/);
});

test('a header a player must not be handed is dropped, name as well as value', async () => {
  // The host refuses the whole stream over one of these (`HeaderRule`), so dropping the header
  // here is what keeps the episode playable. `X-A\r\nInjected` is one request pretending to be two.
  const under = engineOver(withCards({
    tracks: EPISODES,
    playinfo: `return jsonify({
      urls: ['https://v.test' + ext.u],
      headers: [{ 'X-A\\r\\nInjected': 'y', '': 'z', 'Bad Name': 'v', Ok: 'kept', Split: 'v\\r\\nmore', Num: 3 }],
    })`,
  }));
  const detail = await detailOf(under);

  const stream = await under.engine.call('getStream', [detail.playbackOptions[0].track]);

  // A name that is not a token, an empty name, a name with a space, a value carrying CRLF,
  // and a value that is not a string. Not an empty *value* — see the test below.
  assert.deepEqual(stream.headers, { Ok: 'kept' });
});

test("the headers that survive are exactly the ones the host's rule admits", async () => {
  // Both halves of `$defs/headers`, read out of the schema the device's `HeaderRule` is held to,
  // so a character either side lets through and the other refuses fails here. The non-ASCII
  // values are kangzj/lantern-tv#495: the host refused the whole stream over one of them.
  const rule = JSON.parse(readFileSync(new URL('../../../contracts/content-source.schema.json', import.meta.url))).$defs.headers;
  const hostName = new RegExp(rule.propertyNames.pattern);
  const hostValue = new RegExp(rule.additionalProperties.pattern);
  const units = [...Array.from({ length: 0x80 }, (_, code) => code), 0x80, 0xa0, 0xff, 0x100, 0x2028, 0x4e2d, 0xd83d, 0xfeff];
  const hex = (code) => code.toString(16).padStart(4, '0');
  const written = {};
  for (const code of units) {
    const unit = String.fromCharCode(code);
    written[`v${hex(code)}`] = `a${unit}b`;
    written[`n${hex(code)}${unit}`] = 'x';
  }
  written.emoji = 'a\u{1f600}b';
  // The two ends of the patterns' quantifiers: an empty value is admitted, an empty name is not.
  written.empty = '';
  written[''] = 'x';
  const under = engineOver(withCards({
    tracks: EPISODES,
    playinfo: `return jsonify({ urls: ['https://v.test' + ext.u], headers: [${JSON.stringify(written)}] })`,
  }));
  const detail = await detailOf(under);

  const stream = await under.engine.call('getStream', [detail.playbackOptions[0].track]);

  const admitted = Object.fromEntries(Object.entries(written).filter(([name, value]) => hostName.test(name) && hostValue.test(value)));
  assert.deepEqual(stream.headers, admitted);
  assert.equal(stream.url, 'https://v.test/1.mp4');
  assert.deepEqual(validateResult('getStream', stream).errors, []);
  // Neither side of the comparison is trivially empty or whole.
  assert.equal(stream.headers.v0020, 'a b');
  assert.equal(stream.headers.v0009, 'a\tb');
  assert.equal(stream.headers.v4e2d, undefined);
  assert.equal(stream.headers.v0080, undefined);
  assert.equal(stream.headers.emoji, undefined);
  assert.equal(stream.headers.empty, '');
  assert.ok(!('' in stream.headers));
});

test('an empty header value is a value, and reaches the player', async () => {
  // The contract's `headers` is `additionalProperties: {type: string}` and an empty string is
  // a string, so a catalog answering one is answering something the contract permits. The
  // injection check above must not quietly take it away: the header that catalog set may be
  // the one its site needs, and removing it produces a playback failure with no sentence
  // explaining why. Found by Copilot on kangzj/lantern-tv#464, where this filter dropped it.
  const under = engineOver(withCards({
    tracks: EPISODES,
    playinfo: `return jsonify({
      urls: ['https://v.test' + ext.u],
      headers: [{ Referer: '', 'User-Agent': 'UA' }],
    })`,
  }));
  const detail = await detailOf(under);

  const stream = await under.engine.call('getStream', [detail.playbackOptions[0].track]);

  assert.deepEqual(stream.headers, { Referer: '', 'User-Agent': 'UA' });
});

test('a header map whose every value is empty still reaches the player', async () => {
  // The edge the `Object.keys(...).length > 0` gate decides: an answer whose only header is
  // empty-valued must not come back as an option with no headers at all.
  const under = engineOver(withCards({
    tracks: EPISODES,
    playinfo: `return jsonify({ urls: ['https://v.test' + ext.u], headers: [{ Referer: '' }] })`,
  }));
  const detail = await detailOf(under);

  const stream = await under.engine.call('getStream', [detail.playbackOptions[0].track]);

  assert.deepEqual(stream.headers, { Referer: '' });
});

test('a headers list of strings is not a header map, and is not read as one', async () => {
  // Their `headers` is a list beside `urls`, and nothing says its first element is an object.
  // `Object.entries` of a string yields index-to-character pairs whose names — '0', '1' — pass
  // an RFC 9110 token check, so a catalog answering `headers: ['Referer: x']` would send the
  // player one header per character. Found by reading the path rather than by a test failing.
  const under = engineOver(withCards({
    tracks: EPISODES,
    playinfo: `return jsonify({ urls: ['https://v.test' + ext.u], headers: ['Referer: https://s.test/'] })`,
  }));
  const detail = await detailOf(under);

  const stream = await under.engine.call('getStream', [detail.playbackOptions[0].track]);

  assert.equal(stream.url, 'https://v.test/1.mp4');
  assert.equal(stream.headers, undefined);
});

test('a check asked for inside getPlayinfo reaches the host as one', async () => {
  const under = engineOver(withCards({
    tracks: EPISODES,
    playinfo: `$utils.openSafari('https://s.test/verify')
    return jsonify({ urls: [] })`,
  }));
  const detail = await detailOf(under);

  const error = await under.engine.call('getStream', [detail.playbackOptions[0].track]).then(() => null, (e) => e);

  assert.equal(error?.code, Code.CHALLENGED);
  assert.equal(error.message, 'https://s.test/verify');
});

test('what a getPlayinfo wrote to the cache survives it throwing afterwards', async () => {
  // `bdys.js` keeps a cookie in `$cache` and puts it back on its own next request, and this is
  // the one call in the plugin where a stranger's code runs inside a `try` — so a flush placed
  // anywhere but a `finally` drops the write on exactly the path that needed it.
  //
  // **One store, two runtimes**, which is the only arrangement that can see this. Within one
  // runtime the write is in memory whether it was flushed or not, and with a store each the
  // second runtime could not read the first's write even if it had been flushed — so either
  // shortcut makes the test pass without the `finally` and prove nothing.
  // **One source and two runtimes**, not two sources: a shared store also shares the cached
  // catalog *code*, so a second engine given different source replays the first's anyway. The
  // catalog below is the one `bdys.js` shape — it writes on its first run and depends on that
  // write on its second.
  const source = withCards({
    tracks: EPISODES,
    playinfo: `if (!$cache.get('seen')) {
      $cache.set('seen', 'yes')
      throw new Error('not this time')
    }
    return jsonify({ urls: ['https://v.test' + ext.u] })`,
  });
  const store = scratchDir('lp-xptv-flush-');

  const first = engineOver(source, { storeDir: store });
  const detail = await detailOf(first);
  const token = detail.playbackOptions[0].track;
  await first.engine.call('getStream', [token]).then(() => null, () => null);

  const second = engineOver(source, { storeDir: store });
  const stream = await second.engine.call('getStream', [token]).then((s) => s, (e) => e);

  assert.equal(stream?.url, 'https://v.test/1.mp4', stream?.message);
});

// ------------------------------------------------- a share, as a pan option the app opens

/**
 * kangzj/lantern-tv#386: a track carrying a `pan` is a cloud-drive share, and it goes out as a
 * `pan` option with the URL exactly as the catalog wrote it. The plugin names no drive and
 * filters by no host — which client opens the share is the app's decision from the URL's host
 * — so a drive the app does not speak yet is still an option here, hidden and counted there
 * (kangzj/lantern-tv#565), and a drive landing in the app reaches every catalog with nothing
 * changed in this file.
 */
const A_QUARK_SHARE = 'https://pan.quark.cn/s/abc';
const A_UC_SHARE = 'https://drive.uc.cn/s/def';

test('a share is a pan option as XPTV wrote it, and a title of nothing but shares answers them', async () => {
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [{ title: '', tracks: [
    { name: '夸克网盘', pan: '${A_QUARK_SHARE}' },
    { name: 'uc网盘', pan: '${A_UC_SHARE}' },
  ] }] })` }));

  const detail = await detailOf(under);

  // Both drives alike, whether or not the app speaks one of them today: the share is passed
  // through whole, with nothing added and nothing read out of it.
  assert.deepEqual(detail.playbackOptions, [
    { label: '夸克网盘', pan: { share: A_QUARK_SHARE }, line: '网盘' },
    { label: 'uc网盘', pan: { share: A_UC_SHARE }, line: '网盘' },
  ]);
  // Two shares are not two episodes. A share is a container, and how many it holds is known
  // only once the app lists it.
  assert.equal(detail.type, undefined);
});

test('a mixed title keeps its episodes on their line and puts the share on one of its own', async () => {
  // `ddys.js` really does answer both kinds off one page. The share line has to be another
  // line: the app reads a title's episode count off its largest line, so a share on the
  // episode line is an episode that was never there.
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [
    { title: '在线', tracks: [
      { name: '第1集', pan: '', ext: { u: '/1.mp4' } },
      { name: '第2集', pan: '', ext: { u: '/2.mp4' } },
    ] },
    { title: '', tracks: [{ name: '夸克网盘', pan: '${A_QUARK_SHARE}' }] },
  ] })` }));

  const detail = await detailOf(under);

  assert.deepEqual(detail.playbackOptions.map((option) => option.label), ['第1集', '第2集', '夸克网盘']);
  assert.deepEqual(detail.playbackOptions.map((option) => option.line), ['在线', '在线', '网盘']);
  assert.equal(typeof detail.playbackOptions[0].track, 'string');
  assert.deepEqual(detail.playbackOptions[2].pan, { share: A_QUARK_SHARE });
  assert.equal(detail.type, 'SERIES');
});

test('the episodes come first whatever order the catalog answered in', async () => {
  // The line a viewer lands on is the first option's, and that should be the episodes, not a
  // 合集 the catalog happened to list at the top.
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [
    { title: '合集', tracks: [{ name: '合集', pan: '${A_QUARK_SHARE}' }] },
    { title: '在线', tracks: [{ name: '第1集', pan: '', ext: { u: '/1.mp4' } }] },
  ] })` }));

  const detail = await detailOf(under);

  assert.deepEqual(detail.playbackOptions.map((option) => option.label), ['第1集', '合集']);
});

test('an episode group with no name gets a line, so the share line is never the only one', async () => {
  // `MediaDetailScreen` offers the lines only when there are two distinct ones, and counts
  // `''` as one. Episodes on no line beside shares on 网盘 would be one line, and the 合集
  // would sit at the end of the episode grid as though it were the last episode.
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [
    { title: '', tracks: [{ name: '第1集', pan: '', ext: { u: '/1.mp4' } }] },
    { title: '', tracks: [{ name: '网盘', pan: '${A_QUARK_SHARE}' }] },
  ] })` }));

  const detail = await detailOf(under);

  assert.deepEqual(detail.playbackOptions.map((option) => option.line), ['线路', '网盘']);
});

test('the share line never collides with an episode line', async () => {
  // A collision is not cosmetic: it merges the shares back into the episode line, and the
  // episode count is wrong again.
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [
    { title: '网盘', tracks: [
      { name: '第1集', pan: '', ext: { u: '/1.mp4' } },
      { name: '第2集', pan: '', ext: { u: '/2.mp4' } },
    ] },
    { title: '', tracks: [{ name: '夸克网盘', pan: '${A_QUARK_SHARE}' }] },
  ] })` }));

  const detail = await detailOf(under);

  const episodeLines = detail.playbackOptions.filter((option) => option.track).map((option) => option.line);
  const [share] = detail.playbackOptions.filter((option) => option.pan);
  assert.deepEqual(episodeLines, ['网盘', '网盘']);
  assert.equal(share.line, '网盘2');
});

test('a share URL keeps its query and fragment, since on 百度 the query is the 提取码', async () => {
  // "As the catalog wrote it" has to include the part after the `?`: the app's client reads
  // `pwd=` off the URL, and a share stripped of it lists and then refuses at the drive.
  const withCode = 'https://pan.baidu.com/s/1yFsX?pwd=q7x2#list/path=%2F';
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [{ title: '', tracks: [
    { name: '百度网盘', pan: '${withCode}' },
  ] }] })` }));

  const detail = await detailOf(under);

  assert.equal(detail.playbackOptions[0].pan.share, withCode);
});

test('a share is not an episode, so two of them do not make a film a series', async () => {
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [
    { title: '在线', tracks: [{ name: '正片', pan: '', ext: { u: '/1.mp4' } }] },
    { title: '', tracks: [
      { name: '夸克网盘', pan: '${A_QUARK_SHARE}' },
      { name: 'uc网盘', pan: '${A_UC_SHARE}' },
    ] },
  ] })` }));

  const detail = await detailOf(under);

  assert.equal(detail.playbackOptions.length, 3);
  assert.equal(detail.type, undefined);
});

test('a share with no name is labelled by its host', async () => {
  // Their fallback names are 合集 and 网盘, and a share with none at all still needs a label
  // the viewer can tell from the next one. The host is what the URL already says.
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [{ title: '', tracks: [
    { pan: '${A_QUARK_SHARE}' },
    { name: '', pan: 'https://user@drive.uc.cn:443/s/def?pwd=1' },
  ] }] })` }));

  const detail = await detailOf(under);

  assert.deepEqual(detail.playbackOptions.map((option) => option.label), ['pan.quark.cn', 'drive.uc.cn']);
});

test('shares the catalog gave one name are told apart by their host, and a share named on its own is not', async () => {
  // 欧哥 names a title's 百度 share and its 夸克 share identically — the recorded 超级骑警3 is
  // two buttons reading 超级骑警3 - 装歌app — and only one of them is a drive the app opens
  // today, so the labels have to tell them apart for as long as both can be on screen.
  const under = engineOver(withCards({ tracks: `return jsonify({ list: [{ title: '', tracks: [
    { name: '超级骑警3', pan: 'https://pan.baidu.com/s/1yFs?pwd=8888' },
    { name: '超级骑警3', pan: '${A_QUARK_SHARE}' },
    { name: 'uc网盘', pan: '${A_UC_SHARE}' },
  ] }] })` }));

  const detail = await detailOf(under);

  assert.deepEqual(
    detail.playbackOptions.map((option) => option.label),
    ['超级骑警3 · pan.baidu.com', '超级骑警3 · pan.quark.cn', 'uc网盘'],
  );
});

test('a pan that is not a URL is left out with a warning, and a title left with none says so', async () => {
  // No drive could ever be read off it — the app derives the drive from the URL's host — so
  // it is dropped here rather than offered and refused. The log line is what makes it visible.
  const beside = engineOver(withCards({ tracks: `return jsonify({ list: [{ title: '', tracks: [
    { name: '提取码', pan: 'https://pan.quark.cn/s/abc 提取码: 1234' },
    { name: '夸克网盘', pan: '${A_QUARK_SHARE}' },
  ] }] })` }));

  const detail = await detailOf(beside);

  assert.deepEqual(detail.playbackOptions.map((option) => option.label), ['夸克网盘']);
  assert.ok(
    beside.host.logs.some((entry) => entry.level === 'warn' && entry.message.includes('not a URL')),
    JSON.stringify(beside.host.logs),
  );

  const alone = engineOver(withCards({ tracks: `return jsonify({ list: [{ title: '', tracks: [
    { name: '磁力', pan: 'magnet:?xt=urn:btih:abc' },
  ] }] })` }));
  const error = await detailOf(alone).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE);
  assert.match(error.message, /can't be played in this version/);
});

// ------------------------------------------------ a site that is down (kangzj/lantern-tv#579)

const SITE_DOWN = "This source's website isn't available right now. Try again later.";
const CLOUDFLARE_520 = () => ({ status: 520, headers: {}, bodyBase64: b64('<html><body>520: Web server is returning an unknown error</body></html>') });
const REFUSED = () => { throw new Error('connect refused'); };
const EMPTY_PAGE = () => ({ status: 200, headers: {}, bodyBase64: b64('<html><body></body></html>') });

// Their shape: fetch, load the page, read rows off it. `status` is never looked at.
const SCRAPE = `const { data } = await $fetch.get('https://s.test/page')
  const $ = createCheerio().load(data)`;

async function refusal(engine, method, args) {
  return engine.call(method, args).then(() => null, (e) => e);
}

async function mediaIdOver(site, tracks) {
  const { engine, host } = engineOver(catalogSource({ cards: `return jsonify({ list: [${CARD}] })`, tracks }), { site });
  const [item] = await engine.call('getMediaList', [await categoryId(engine), { page: 1 }]);
  return { engine, host, id: item.id };
}

test('a detail whose page came back 5xx says the site is down, not that the title has nothing', async () => {
  const tracks = `${SCRAPE}
  return jsonify({ list: [{ title: '线路', tracks: $('a.ep').map((i, a) => ({ name: $(a).text(), ext: {} })).get() }] })`;
  const { engine, id } = await mediaIdOver(CLOUDFLARE_520, tracks);

  const error = await refusal(engine, 'getMediaDetail', [id]);

  assert.equal(error.code, Code.UNAVAILABLE);
  assert.equal(error.message, SITE_DOWN);
});

test('a fetch that rejects inside getTracks says the site is down, not that the program is broken', async () => {
  const { engine, id } = await mediaIdOver(REFUSED, `${SCRAPE}\n  return jsonify({ list: [] })`);

  const error = await refusal(engine, 'getMediaDetail', [id]);

  assert.equal(error.message, SITE_DOWN);
});

// Their other shape: catch the failure and answer with what they have, which is nothing.
const SWALLOWED = `const { data } = await $fetch.get('https://s.test/page').catch(() => ({ data: '' }))
  return jsonify({ list: [] })`;

test('a request that got no answer, swallowed by the catalog, says the site is down and logs why', async () => {
  const { engine, host, id } = await mediaIdOver(REFUSED, SWALLOWED);

  const error = await refusal(engine, 'getMediaDetail', [id]);

  assert.equal(error.message, SITE_DOWN);
  // The sentence has a line behind it, and the line names the code and not the URL, which can
  // carry what a viewer searched for (kangzj/lantern-tv#561).
  const line = host.logs.find((entry) => entry.message.includes('a request got no answer'));
  assert.equal(line?.level, 'warn');
  assert.match(line.message, /^catalog .+: a request got no answer \(REQUEST_FAILED\)$/);
  assert.doesNotMatch(line.message, /s\.test/);
});

test('a call that ran out of time is not the site being down (kangzj/lantern-tv#560)', async () => {
  const clock = { value: 1_700_000_000_000 };
  // The first page takes the whole of the call's budget, so the host refuses the second
  // before asking the site anything.
  const site = (req) => {
    if (req.url.endsWith('/first')) clock.value += 20_001;
    return EMPTY_PAGE();
  };
  const { engine, host } = engineOver(catalogSource({
    cards: `return jsonify({ list: [${CARD}] })`,
    tracks: `await $fetch.get('https://s.test/first')
  const { data } = await $fetch.get('https://s.test/second').catch(() => ({ data: '' }))
  return jsonify({ list: [] })`,
  }), { site, now: () => clock.value });
  const [item] = await engine.call('getMediaList', [await categoryId(engine), { page: 1 }]);

  const error = await refusal(engine, 'getMediaDetail', [item.id]);

  assert.equal(error.message, '"庆余年" has nothing to play.');
  assert.ok(!host.requests.some((request) => request.url.endsWith('/second')));
});

test('a request the host refused is not the site being down', async () => {
  // `HOST_NOT_ALLOWED` is the host's rule answering, here the private floor, and the site was
  // never asked, so an empty answer after it keeps its own sentence.
  const { engine, host } = engineOver(catalogSource({
    cards: `return jsonify({ list: [${CARD}] })`,
    tracks: `const refused = await $fetch.get('http://192.168.1.1/tracks').then(() => '', (e) => e.code)
  $print('refused ' + refused)
  return jsonify({ list: [] })`,
  }), { site: EMPTY_PAGE });
  const [item] = await engine.call('getMediaList', [await categoryId(engine), { page: 1 }]);

  const error = await refusal(engine, 'getMediaDetail', [item.id]);

  assert.ok(host.logs.some((entry) => entry.message.endsWith('refused HOST_NOT_ALLOWED')), JSON.stringify(host.logs));
  assert.equal(error.message, '"庆余年" has nothing to play.');
});

test('a fallback mirror that answers with nothing is nothing found, not the first mirror being down', async () => {
  const site = (req) => (req.url.startsWith('https://down.test/') ? CLOUDFLARE_520() : EMPTY_PAGE());
  const tracks = `let { data } = await $fetch.get('https://down.test/page')
  if (!data.includes('class="ep"')) ({ data } = await $fetch.get('https://up.test/page'))
  return jsonify({ list: [] })`;
  const { engine, id } = await mediaIdOver(site, tracks);

  assert.equal((await refusal(engine, 'getMediaDetail', [id])).message, '"庆余年" has nothing to play.');
});

test("getConfig's fetches are setup, and a site that failed there is not why a title has nothing", async () => {
  // Their getConfig runs in whichever call compiles the catalog, so a fresh runtime is asked
  // for the detail straight away, with the id an earlier one handed out.
  const withSetup = (tracks) => catalogSource({ cards: `return jsonify({ list: [${CARD}] })`, tracks })
    .replace('async function getConfig() {', "async function getConfig() {\n  await $fetch.get('https://s.test/setup')");
  const site = (req) => (req.url.endsWith('/setup') ? CLOUDFLARE_520() : EMPTY_PAGE());
  const { id } = await mediaIdOver(site, 'return jsonify({ list: [] })');
  const { engine, transport } = engineOver(withSetup('return jsonify({ list: [] })'), { site });

  const error = await refusal(engine, 'getMediaDetail', [id]);

  assert.ok(transport.calls.some((url) => url.endsWith('/setup')));
  assert.equal(error.message, '"庆余年" has nothing to play.');
});

test('a search whose page came back 5xx says the site is down rather than finding nothing', async () => {
  const search = `${SCRAPE}
  return jsonify({ list: $('div.card').map((i, d) => ({ vod_name: $(d).text(), ext: {} })).get() })`;
  const { engine } = engineOver(catalogSource({ search }), { site: CLOUDFLARE_520 });

  const error = await refusal(engine, 'search', ['画皮']);

  assert.equal(error.message, SITE_DOWN);
});

test('a 502 or a 503 is the site being down as much as a 520', async () => {
  for (const status of [502, 503]) {
    const site = () => ({ status, headers: {}, bodyBase64: b64('<html><body>Bad Gateway</body></html>') });
    const { engine } = engineOver(catalogSource({ cards: `${SCRAPE}\n  return jsonify({ list: [] })` }), { site });

    const error = await refusal(engine, 'getMediaList', [await categoryId(engine), { page: 1 }]);

    assert.equal(error.message, SITE_DOWN, `HTTP ${status}`);
  }
});

test('a site that failed in an earlier call is not why the next call has nothing', async () => {
  const search = `${SCRAPE}\n  return jsonify({ list: [] })`;
  const { engine } = engineOver(catalogSource({ tab: '', search }), { site: CLOUDFLARE_520 });
  assert.equal((await refusal(engine, 'search', ['画皮'])).message, SITE_DOWN);

  const error = await refusal(engine, 'getCategories', []);

  assert.equal(error.message, 'This source has no categories to browse. Use search instead.');
});

test('an empty listing page while the site answers 5xx says the site is down', async () => {
  const { engine } = engineOver(catalogSource({ cards: `${SCRAPE}\n  return jsonify({ list: [] })` }), { site: CLOUDFLARE_520 });

  const error = await refusal(engine, 'getMediaList', [await categoryId(engine), { page: 1 }]);

  assert.equal(error.message, SITE_DOWN);
});

test('a stream the catalog could not resolve while the site answers 5xx says the site is down', async () => {
  const { engine } = engineOver(catalogSource({
    cards: `return jsonify({ list: [${CARD}] })`,
    tracks: "return jsonify({ list: [{ title: '线路', tracks: [{ name: '1', ext: { u: 1 } }] }] })",
    playinfo: `${SCRAPE}\n  return jsonify({ urls: [] })`,
  }), { site: CLOUDFLARE_520 });
  const [item] = await engine.call('getMediaList', [await categoryId(engine), { page: 1 }]);
  const detail = await engine.call('getMediaDetail', [item.id]);

  const error = await refusal(engine, 'getStream', [detail.playbackOptions[0].track]);

  assert.equal(error.message, SITE_DOWN);
});

test('a site that is up keeps the sentences that were right: no tracks, no results, broken program', async () => {
  const { engine, id } = await mediaIdOver(EMPTY_PAGE, `${SCRAPE}\n  return jsonify({ list: [] })`);
  assert.equal((await refusal(engine, 'getMediaDetail', [id])).message, '"庆余年" has nothing to play.');

  const searching = engineOver(catalogSource({ search: `${SCRAPE}\n  return jsonify({ list: [] })` }), { site: EMPTY_PAGE });
  assert.deepEqual(await searching.engine.call('search', ['画皮']), []);

  const listing = engineOver(catalogSource({ cards: `${SCRAPE}\n  return jsonify({ list: [] })` }), { site: EMPTY_PAGE });
  assert.deepEqual(await listing.engine.call('getMediaList', [await categoryId(listing.engine), { page: 2 }]), []);

  const buggy = await mediaIdOver(EMPTY_PAGE, `${SCRAPE}\n  return null.list`);
  assert.equal((await refusal(buggy.engine, 'getMediaDetail', [buggy.id])).message, "This source's program won't run. It may be out of date.");
});

test('a 4xx is not the site being down: a title the site does not have keeps its own sentence', async () => {
  const notThere = () => ({ status: 404, headers: {}, bodyBase64: b64('not found') });
  const { engine, id } = await mediaIdOver(notThere, `${SCRAPE}\n  return jsonify({ list: [] })`);

  assert.equal((await refusal(engine, 'getMediaDetail', [id])).message, '"庆余年" has nothing to play.');
});

test('a 5xx in one call does not follow the catalog into the next', async () => {
  let down = true;
  const site = () => (down ? CLOUDFLARE_520() : EMPTY_PAGE());
  const { engine, id } = await mediaIdOver(site, `${SCRAPE}\n  return jsonify({ list: [] })`);
  assert.equal((await refusal(engine, 'getMediaDetail', [id])).message, SITE_DOWN);

  down = false;

  assert.equal((await refusal(engine, 'getMediaDetail', [id])).message, '"庆余年" has nothing to play.');
});

test('a check asked for after the site failed is still a check, not the site being down', async () => {
  const { engine, id } = await mediaIdOver(CLOUDFLARE_520, `${SCRAPE}\n  $utils.openSafari('https://s.test')`);

  const error = await refusal(engine, 'getMediaDetail', [id]);

  assert.equal(error.code, Code.CHALLENGED);
});

test('a catalog that builds its tabs off a page that came back 5xx says the site is down, not search-only', async () => {
  const { engine } = engineOver(`
async function getConfig() {
  ${SCRAPE}
  return jsonify({ ver: 1, title: 'T', site: 'https://s.test', tabs: $('a.tab').map((i, a) => ({ name: $(a).text(), ext: {} })).get() })
}
`, { site: CLOUDFLARE_520 });

  assert.equal((await refusal(engine, 'getCategories', [])).message, SITE_DOWN);
});

// A catalog whose tabs are scraped off its homepage in `getConfig`, as `czzy.js` builds them.
const SCRAPED_TABS = `
async function getConfig() {
  ${SCRAPE}
  return jsonify({ ver: 1, title: 'T', site: 'https://s.test', tabs: $('a.tab').map((i, a) => ({ name: $(a).text(), ext: { id: i } })).get() })
}
async function search(ext) {
  return jsonify({ list: [] })
}
`;

function comingBack() {
  const state = { down: true };
  const site = () => (state.down ? CLOUDFLARE_520() : { status: 200, headers: {}, bodyBase64: b64('<a class="tab">电影</a>') });
  return { state, site };
}

test('tabs read while the site was down are asked for again, so the categories come back with it', async () => {
  const { state, site } = comingBack();
  const { engine } = engineOver(SCRAPED_TABS, { site });
  assert.equal((await refusal(engine, 'getCategories', [])).message, SITE_DOWN);
  assert.equal((await refusal(engine, 'getCategories', [])).message, SITE_DOWN);

  state.down = false;

  assert.deepEqual((await engine.call('getCategories', [])).map((category) => category.name), ['电影']);
});

test('a search while the site was down does not leave the categories search-only once it is back', async () => {
  const { state, site } = comingBack();
  const { engine } = engineOver(SCRAPED_TABS, { site });
  assert.deepEqual(await engine.call('search', ['画皮']), []);

  state.down = false;

  assert.deepEqual((await engine.call('getCategories', [])).map((category) => category.name), ['电影']);
});

/**
 * Cards and tracks whose ids straddle both bounds: `n` is the length of each padding string,
 * chosen so the ids run from inside each bound to past it, and a tab, card and track with no
 * `ext` and whitespace around every value ride along.
 */
const NEAR_BOUNDS = `
const pad = (n) => 'x'.repeat(n)
async function getConfig() {
  return jsonify({ tabs: [
    { name: ' 多键 ', ext: { url: '/m/', f: { z: [2, { c: '3' }], a: 1 }, hasMore: false } },
    { name: '没有ext' },
  ] })
}
async function getCards(ext) {
  const list = []
  for (let n = 955; n <= 985; n += 1) {
    list.push({ vod_name: ' 片' + n + ' ', vod_pic: ' https://s.test/' + n + '.jpg ', ext: { u: pad(n) } })
  }
  list.push({ vod_name: '没有ext', vod_pic: '' })
  return jsonify({ list })
}
async function getTracks(ext) {
  const tracks = []
  for (let n = 2025; n <= 2040; n += 1) tracks.push({ name: ' 第' + n + '集 ', pan: '', ext: { u: pad(n) } })
  tracks.push({ name: '没有ext', pan: '' })
  return jsonify({ list: [{ title: ' 在线 ', tracks }] })
}
`;

test('a media id spends the whole 1024 before it drops its artwork, and a token the whole 2048', async () => {
  const { engine } = engineOver(NEAR_BOUNDS);
  const [category] = await engine.call('getCategories', []);
  const cards = await engine.call('getMediaList', [category.id, { page: 1 }]);
  const detail = await engine.call('getMediaDetail', [cards[0].id]);
  const artwork = (card) => JSON.parse(card.id).p !== '';
  const tracks = detail.playbackOptions.map((option) => option.track).filter((track) => track !== undefined);

  // Both sides of each bound are reached, so an edit to the fixture cannot quietly stop testing them.
  assert.deepEqual([...new Set(cards.filter((card) => JSON.parse(card.id).e.u !== undefined).map(artwork))].sort(), [false, true]);
  assert.ok(tracks.length > 1 && tracks.length < 17, tracks.length);
  assert.ok(cards.every((card) => !artwork(card) || card.id.length <= 1024));
  assert.ok(tracks.every((track) => track.length <= 2048));
  // Nothing held back: an id of exactly each bound still keeps what it carries.
  assert.ok(cards.some((card) => artwork(card) && card.id.length === 1024), Math.max(...cards.filter(artwork).map((card) => card.id.length)));
  assert.ok(tracks.some((track) => track.length === 2048), Math.max(...tracks.map((track) => track.length)));
});
