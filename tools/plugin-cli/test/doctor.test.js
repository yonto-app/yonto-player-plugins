import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_LOGGED_IN, runDoctor } from '../src/doctor.js';
import { Code, PluginError } from '../src/errors.js';

function fakeEngine(impl) {
  return {
    async exports() { return Object.keys(impl); },
    async call(method, args) { return impl[method](...args); },
  };
}

const healthy = {
  getCategories: () => [{ id: 'dianying', name: '电影' }],
  getFilters: () => [],
  // One page in all: page 2 is empty, which is a category that fits on one page.
  getMediaList: (categoryId, options) => (options?.page === 2 ? [] : [{ id: '13141', title: '庆余年' }]),
  getMediaDetail: () => ({ id: '13141', title: '庆余年',
    playbackOptions: [{ label: 'S01E01', stream: { url: 'https://h.tv/1.m3u8' } }] }),
  search: () => [{ id: '13141', title: '庆余年' }],
  getRecommendations: () => [],
  checkHealth: () => ({ usable: true }),
};

test('a healthy plugin passes every step', async () => {
  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: '庆余年' });
  assert.equal(report.ok, true);
  assert.equal(report.steps.every((s) => s.ok), true);
});

test('feeds each step from the one before it', async () => {
  const seen = {};
  const engine = fakeEngine({
    ...healthy,
    getFilters: (id) => { seen.filters = id; return []; },
    getMediaList: (id) => { seen.list = id; return [{ id: '13141', title: '庆余年' }]; },
    getMediaDetail: (id) => { seen.detail = id; return healthy.getMediaDetail(); },
  });
  await runDoctor({ engine, requests: [], query: '庆余年' });
  assert.equal(seen.filters, 'dianying');
  assert.equal(seen.list, 'dianying');
  assert.equal(seen.detail, '13141');
});

test('searches for the query it was given, which is where a manifest probeQuery lands', async () => {
  let asked = null;
  const engine = fakeEngine({ ...healthy, search: (query) => { asked = query; return healthy.search(); } });
  await runDoctor({ engine, requests: [], query: '庆余年' });
  assert.equal(asked, '庆余年');
});

test('lists and pages the category it was told to, which is where a manifest probeCategory lands', async () => {
  const listed = [];
  const engine = fakeEngine({
    ...healthy,
    getCategories: () => [{ id: 'home', name: '推荐' }, { id: 'dianying', name: '电影' }],
    getFilters: (id) => { listed.push(`filters ${id}`); return []; },
    getMediaList: (id, options) => { listed.push(`${id} ${options.page}`); return healthy.getMediaList(id, options); },
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年', category: 'dianying' });
  assert.equal(report.ok, true);
  assert.deepEqual(listed, ['filters dianying', 'dianying 1', 'dianying 2']);
});

test('a probeCategory the plugin does not answer fails getCategories, rather than probing another', async () => {
  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: '庆余年', category: 'document' });
  const step = report.steps.find((s) => s.method === 'getCategories');
  assert.equal(step.ok, false);
  assert.equal(step.code, Code.MANIFEST_INVALID);
  assert.match(step.message, /probeCategory "document" is not one of the 1 categories/);
  assert.equal(report.steps.find((s) => s.method === 'getMediaList').skipped, true);
});

test('a successful but empty listing is a failure, not a pass', async () => {
  const requests = [];
  const engine = fakeEngine({ ...healthy, getMediaList: () => { requests.push({ url: 'https://h.tv/list', status: 200 }); return []; } });
  const report = await runDoctor({ engine, requests, query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaList');
  assert.equal(step.ok, false);
  assert.equal(step.code, Code.EMPTY_RESULT);
  assert.match(step.message, /markup has most likely changed/);
  assert.equal(step.requests, 1);
  assert.equal(report.ok, false);
});

// A plugin's first run is a stub answering [], and "the site's markup has changed" is about a
// site it has not written a line against (kangzj/lantern-tv#343). The step's own requests,
// not the run's: a plugin answering from what an earlier step fetched asked nothing here.
test('an empty answer from a step that asked nothing says so, rather than blaming a site', async () => {
  const requests = [];
  const engine = fakeEngine({
    ...healthy,
    getCategories: () => { requests.push({ url: 'https://h.tv/', failed: false, blocked: false }); return healthy.getCategories(); },
    getMediaList: () => [],
  });
  const report = await runDoctor({ engine, requests, query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaList');
  assert.equal(step.code, Code.EMPTY_RESULT);
  assert.equal(step.message, 'the result was empty, and this step made no request — the plugin answered without asking a site');
  assert.equal(step.requests, 0);
});

test('an empty answer blames the markup only when some request in the step got a page', async () => {
  const failed = { status: null, failed: true, blocked: false };
  const blocked = { status: null, failed: false, blocked: true };
  const noPage = 'the result was empty, and every request this step made failed or was refused — the plugin answered [] without a page to read';
  const markup = 'the request succeeded and the result was empty — the site\'s markup has most likely changed';
  const cases = {
    'a failed request, caught': [[failed], noPage],
    'a refused request, caught': [[blocked], noPage],
    'a 404, caught': [[{ status: 404 }], noPage],
    'a 302 whose next hop was refused': [[{ status: 302 }, blocked], noPage],
    'a dead first site, then one that answered': [[failed, { status: 200 }], markup],
  };
  for (const [how, [made, expected]] of Object.entries(cases)) {
    const requests = [];
    const engine = fakeEngine({ ...healthy, getMediaList: () => { requests.push(...made); return []; } });
    const report = await runDoctor({ engine, requests, query: '庆余年' });
    assert.equal(report.steps.find((s) => s.method === 'getMediaList').message, expected, how);
  }
});

test('a step failing with a typed not-found reports that code, not METHOD_THREW', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => { throw new PluginError(Code.NOT_FOUND, 'not found: 13141'); },
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.equal(step.code, Code.NOT_FOUND);
  assert.notEqual(step.code, Code.METHOD_THREW);
  assert.equal(step.ok, false);
  assert.equal(report.ok, false);
});

test('a step whose input never arrived is skipped, not blamed', async () => {
  const engine = fakeEngine({ ...healthy, getMediaList: () => [] });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const detail = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.equal(detail.skipped, true);
  assert.equal(detail.ok, false);
  assert.match(detail.message, /no item id/);
});

// `getStream` is handed a token the *previous* step answered, which is the same shape
// `getMediaDetail` already has with an item id — and not the trap where a later step reads a
// cached response the step before it fetched. A library whose detail carried no token has
// nothing to ask it with.
test('getStream is asked with a track the detail itself answered', async () => {
  const asked = [];
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年',
      playbackOptions: [{ label: 'S01E01', track: 'ext-1' }] }),
    getStream: (token) => { asked.push(token); return { url: 'https://h.tv/1.m3u8' }; },
  });

  const report = await runDoctor({ engine, requests: [], query: '庆余年' });

  assert.deepEqual(asked, ['ext-1']);
  assert.equal(report.steps.find((s) => s.method === 'getStream').ok, true);
});

// The forward half of `lint`'s pairing rule, which only `doctor` can check: `lint` reads a
// manifest and a source, and whether a detail actually *answers* a track is something only a
// run knows. A token nothing can redeem is a silently unplayable title, so it is a failure
// rather than an optional skip.
test('a detail that answers a track with no getStream to redeem it is a failure, not an optional skip', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年',
      playbackOptions: [{ label: 'S01E01', track: 'ext-1' }] }),
  });

  const report = await runDoctor({ engine, requests: [], query: '庆余年' });

  const step = report.steps.find((s) => s.method === 'getStream');
  assert.equal(step.ok, false);
  assert.match(step.message, /track/);
  assert.equal(report.ok, false);
});

// And the ordinary case stays an optional skip: a source that never answers a token has no
// business exporting the method, and saying so would be a warning nobody can act on.
test('a source that answers no track is not asked for a getStream it does not need', async () => {
  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: '庆余年' });

  const step = report.steps.find((s) => s.method === 'getStream');
  assert.equal(step.ok, true);
  assert.equal(step.skipped, true);
  assert.equal(report.ok, true);
});

// Skipped rather than called with `undefined`, and the sentence has to name the thing that
// is missing: every skip but `getMediaDetail`'s used to be worded as a category id, so this
// one would have reported the wrong thing entirely.
//
// **And the skip is not a failure**, which this test asserted nothing about until
// kangzj/lantern-tv#463 — a source that exports `getStream` and is pointed at a library with
// no tokens has done nothing wrong, and marking it red made `doctor` unpassable for a
// source that answered tokens for one kind of library and URLs for another. The step above covers the unexported case and
// always got this right; this one is the exported-but-unused case and did not.
test('a getStream with no token to redeem is skipped, says what it wanted, and has not failed', async () => {
  const engine = fakeEngine({ ...healthy, getStream: () => ({ url: 'https://h.tv/1.m3u8' }) });

  const report = await runDoctor({ engine, requests: [], query: '庆余年' });

  const step = report.steps.find((s) => s.method === 'getStream');
  assert.equal(step.skipped, true);
  assert.match(step.message, /no track token/);
  assert.equal(step.ok, true);
  assert.equal(report.ok, true, report.steps.filter((s) => !s.ok).map((s) => s.method).join(', '));
});

// The other three keep the old answer, and the difference is the point: a missing category id
// means `getCategories` answered nothing, which is already red a step earlier — so the skip is
// reporting a real failure rather than a step that had nothing to do.
test('a skip for want of a category id is still a failure', async () => {
  const engine = fakeEngine({ ...healthy, getCategories: () => [] });

  const report = await runDoctor({ engine, requests: [], query: '庆余年' });

  const step = report.steps.find((s) => s.method === 'getMediaList');
  assert.equal(step.skipped, true);
  assert.equal(step.ok, false);
});

// The names, never the values, and never the address either: a redeemed URL is signed and
// short-lived, and this report gets pasted into issues.
test('a redeemed stream is described without its address or its header values', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年',
      playbackOptions: [{ label: 'S01E01', track: 'ext-1' }] }),
    getStream: () => ({ url: 'https://h.tv/signed?token=s3cret', mimeType: 'video/mp4',
      headers: { Referer: 'https://ddys.mov/', Cookie: 'sid=s3cret' } }),
  });

  const report = await runDoctor({ engine, requests: [], query: '庆余年' });

  const { message } = report.steps.find((s) => s.method === 'getStream');
  assert.doesNotMatch(message, /s3cret/);
  assert.match(message, /h\.tv/);
  assert.match(message, /Referer, Cookie/);
});

test('a malformed answer is reported with its json path', async () => {
  const engine = fakeEngine({ ...healthy, getCategories: () => [{ id: 'dianying' }] });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getCategories');
  assert.equal(step.code, Code.RESULT_INVALID);
  assert.match(step.message, /name/);
});

test('a method the plugin does not export is skipped, because every method is optional', async () => {
  const { getRecommendations, ...withoutRecommendations } = healthy;
  const report = await runDoctor({ engine: fakeEngine(withoutRecommendations), requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getRecommendations');
  assert.equal(step.skipped, true);
  assert.equal(report.ok, true, 'not exporting an optional method is not a failure');
});

test('an unrecognized type is a warning, not a failure', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaList: (categoryId, options) => (options.page === 2 ? [] : [{ id: '13141', title: '庆余年', type: 'SERIE' }]),
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaList');
  assert.equal(step.ok, true, 'an unrecognized type does not fail the step');
  assert.match(step.warnings[0], /SERIE/);
});

test('an unrecognized type does not fail the report', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaList: (categoryId, options) => (options.page === 2 ? [] : [{ id: '13141', title: '庆余年', type: 'SERIE' }]),
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  assert.equal(report.ok, true);
});

test('a type the app recognises is not warned about, whatever case it is written in', async () => {
  // The app is the answer here: ContractDtos.kt's `toMediaType` matches MediaType.entries
  // `ignoreCase = true`, so `series` is a SERIES on a television. doctor used to warn that
  // it "maps to MOVIE", which was a claim about the app that was not true of it
  // (kangzj/lantern-tv#306).
  const engine = fakeEngine({
    ...healthy,
    getMediaList: () => [
      { id: '13141', title: '庆余年', type: 'series' },
      { id: '13142', title: '狂飙', type: 'movie' },
      { id: '13143', title: '漫长的季节', type: 'Series' },
    ],
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaList');
  assert.deepEqual(step.warnings, []);
});

test('a type the app recognises is not warned about in getMediaDetail either', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年', type: 'series',
      playbackOptions: [{ label: 'S01E01', stream: { url: 'https://h.tv/1.m3u8' } }] }),
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.deepEqual(step.warnings, []);
});

test('an unrecognized type in getMediaDetail (single-object branch) is a warning, not a failure', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年', type: 'FILME',
      playbackOptions: [{ label: 'S01E01', stream: { url: 'https://h.tv/1.m3u8' } }] }),
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.equal(step.ok, true, 'an unrecognized type does not fail the step');
  assert.match(step.warnings[0], /FILME/);
  assert.equal(report.ok, true, 'the report is still ok with a warning');
});

test('describe correctly pluralizes single playback option', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年',
      playbackOptions: [{ label: 'S01E01', stream: { url: 'https://h.tv/1.m3u8' } }] }),
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.match(step.message, /1 playback option/);
});

test('describe correctly pluralizes multiple playback options', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaDetail: () => ({ id: '13141', title: '庆余年',
      playbackOptions: [
        { label: 'S01E01', stream: { url: 'https://h.tv/1.m3u8' } },
        { label: 'S01E02', stream: { url: 'https://h.tv/2.m3u8' } },
      ] }),
  });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.match(step.message, /2 playback options/);
});

// The arguments a caller hands a plugin are part of the contract, and for a while the two
// callers disagreed: the Android adapter passed (categoryId, page, filters) while this
// one passed (categoryId, { page, filters }). A plugin that read `page` had it here and
// `undefined` on a television, and nothing noticed because the only plugin there is
// ignores every argument after the first. See contracts/content-source-http.md.
test('calls each method with the argument shape the contract documents', async () => {
  const seen = {};
  const recording = {
    async exports() { return Object.keys(healthy); },
    async call(method, args) { seen[method] = args; return healthy[method](...args); },
  };

  await runDoctor({ engine: recording, requests: [], query: '庆余年' });

  assert.deepEqual(seen.getCategories, []);
  assert.deepEqual(seen.getFilters, ['dianying']);
  // The last call is page 2's, which is asked for the same way page 1 is.
  assert.deepEqual(seen.getMediaList, ['dianying', { page: 2, filters: {} }]);
  assert.deepEqual(seen.getMediaDetail, ['13141']);
  assert.deepEqual(seen.search, ['庆余年']);
  assert.deepEqual(seen.getRecommendations, []);
  assert.deepEqual(seen.checkHealth, []);
});

// Which library is active is the host's answer rather than an argument — `yonto.subSource()`
// — so a doctor that passed one here would be documenting a shape no television sends.
test('asks a source which libraries it has without telling it which one to read', async () => {
  const seen = {};
  const several = {
    ...healthy,
    getSubSources: () => ({ items: [{ id: 'suoni', name: '索尼资源' }], activeId: 'suoni' }),
  };
  const recording = {
    async exports() { return Object.keys(several); },
    async call(method, args) { seen[method] = args; return several[method](...args); },
  };

  const report = await runDoctor({ engine: recording, requests: [], query: '庆余年' });

  assert.deepEqual(seen.getSubSources, []);
  assert.match(report.steps.find((s) => s.method === 'getSubSources').message, /1 library, reading 索尼资源/);
});

// A source that is one library exports neither half, which is every plugin but one.
test('a source with no sub-sources is not failed for having none', async () => {
  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getSubSources');

  assert.equal(step.ok, true);
  assert.equal(step.skipped, true);
  assert.match(step.message, /optional/);
});

// An exported picker with nothing in it is a television showing a viewer an empty list, so
// it fails here rather than reaching one.
test('a source that offers an empty list of libraries fails', async () => {
  const engine = fakeEngine({ ...healthy, getSubSources: () => ({ items: [], activeId: null }) });
  const report = await runDoctor({ engine, requests: [], query: '庆余年' });
  const step = report.steps.find((s) => s.method === 'getSubSources');

  assert.equal(step.ok, false);
  assert.equal(step.code, Code.EMPTY_RESULT);
});

// The divergence this section of the contract exists for, on the newest method: the device
// hands `onImageHeadersRefused` the headers that were refused, and a doctor that handed
// `undefined` instead would certify the one implementation the argument makes unnecessary —
// a source that cannot see what was refused can only forget everything it holds.
test('a refusal is told with the headers that were signed, the way the device tells it', async () => {
  const seen = {};
  const withArtwork = {
    ...healthy,
    getImageHeaders: () => ({ Authorization: 'TOKEN' }),
    onImageHeadersRefused: () => ({ renewable: true }),
  };
  const recording = {
    async exports() { return Object.keys(withArtwork); },
    async call(method, args) { seen[method] = args; return withArtwork[method](...args); },
  };

  await runDoctor({ engine: recording, requests: [], query: '庆余年' });

  assert.deepEqual(seen.getImageHeaders, []);
  assert.deepEqual(seen.onImageHeadersRefused, [{ Authorization: 'TOKEN' }]);
});

test('doctor walks a source that answers with a page, and says there is more', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaList: () => ({ items: [{ id: '13141', title: '庆余年' }], nextCursor: 'eyJvIjoyMH0=' }),
  });

  const report = await runDoctor({ engine, requests: [], pagination: 'cursor' });
  const step = report.steps.find((s) => s.method === 'getMediaList');

  assert.equal(step.ok, true);
  assert.match(step.message, /one more page/);
  // The next step still got an id out of it, which is what a page shape must not break.
  assert.equal(report.steps.find((s) => s.method === 'getMediaDetail').skipped, false);
});

test('a page with no items is the same failure an empty array is', async () => {
  const engine = fakeEngine({ ...healthy, getMediaList: () => ({ items: [], nextCursor: null }) });

  const report = await runDoctor({ engine, requests: [] });
  const step = report.steps.find((s) => s.method === 'getMediaList');

  assert.equal(step.ok, false);
  assert.equal(step.code, Code.EMPTY_RESULT);
});

test('a cursor is handed back, because only a second call proves it works', async () => {
  const seen = [];
  const engine = fakeEngine({
    ...healthy,
    getMediaList: (categoryId, options) => {
      seen.push(options.cursor);
      return options.cursor === undefined
        ? { items: [{ id: '13141', title: '庆余年' }], nextCursor: 'eyJvIjoyMH0=' }
        : { items: [{ id: '13142', title: '庆余年 2' }], nextCursor: null };
    },
  });

  const report = await runDoctor({ engine, requests: [], pagination: 'cursor' });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.deepEqual(seen, [undefined, 'eyJvIjoyMH0=']);
  assert.equal(step.ok, true);
});

test('a plugin that issues a cursor and then answers nothing fails on the second call', async () => {
  const engine = fakeEngine({
    ...healthy,
    getMediaList: (categoryId, options) => (options.cursor === undefined
      ? { items: [{ id: '13141', title: '庆余年' }], nextCursor: 'c2' }
      : { items: [], nextCursor: null }),
  });

  const report = await runDoctor({ engine, requests: [], pagination: 'cursor' });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.ok, false);
  assert.equal(step.code, Code.EMPTY_RESULT);
  assert.equal(report.ok, false);
});

test('a listing that pages by number is asked for page 2, and an empty one is one page in all', async () => {
  const seen = [];
  const engine = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => { seen.push(options.page); return healthy.getMediaList(categoryId, options); } });

  const report = await runDoctor({ engine, requests: [] });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.deepEqual(seen, [1, 2]);
  assert.equal(step.ok, true);
  assert.equal(report.ok, true);
});

test('a plugin that ignores options.page fails on page 2, naming why', async () => {
  // Page 2 answering page 1 again is the most common thing a scraper gets wrong, and a
  // television shows it as the same titles forever (kangzj/lantern-tv#331).
  const engine = fakeEngine({ ...healthy, getMediaList: () => [{ id: '13141', title: '庆余年' }] });

  const report = await runDoctor({ engine, requests: [] });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.ok, false);
  assert.match(step.message, /page 2 answered the same items as page 1/);
});

test('a plugin that hands back the cursor it was given fails, rather than paging forever', async () => {
  const engine = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => (options.cursor === undefined
    ? { items: [{ id: '1', title: 'A' }], nextCursor: 'same' }
    : { items: [{ id: '2', title: 'B' }], nextCursor: 'same' }) });

  const report = await runDoctor({ engine, requests: [], pagination: 'cursor' });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.ok, false);
  assert.match(step.message, /the same cursor/);
});

test('a nextCursor from a plugin that does not declare cursor paging is refused', async () => {
  // A television pages it by number and never hands the cursor back.
  const engine = fakeEngine({ ...healthy, getMediaList: () => ({ items: [{ id: '1', title: 'A' }], nextCursor: 'c2' }) });

  const report = await runDoctor({ engine, requests: [] });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.ok, false);
  assert.match(step.message, /"pagination": "cursor"/);
});

test('a page 2 the plugin reports on its own terms is still skipped when no fixture was recorded', async () => {
  // A plugin may catch the host's NO_FIXTURE and raise its own UNAVAILABLE, so the throw
  // alone does not say the fixture was missing; the request the host logged does.
  const requests = [];
  const engine = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => {
    if (options.page === 2) {
      requests.push({ method: 'GET', url: 'https://h.tv/list/2', failed: true, code: Code.NO_FIXTURE });
      throw new PluginError(Code.UNAVAILABLE, 'the site did not answer');
    }
    return [{ id: '1', title: 'A' }];
  } });

  const report = await runDoctor({ engine, requests });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.skipped, true);
  assert.equal(step.ok, true);
});

test('a page 2 that failed for any other reason stays a failure, however the plugin re-raises it', async () => {
  // Only a missing fixture is skipped: a site that is down is not an input that never arrived.
  const requests = [];
  const engine = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => {
    if (options.page === 2) {
      requests.push({ method: 'GET', url: 'https://h.tv/list/2', failed: true, code: Code.REQUEST_FAILED });
      throw new PluginError(Code.UNAVAILABLE, 'the site did not answer');
    }
    return [{ id: '1', title: 'A' }];
  } });

  const report = await runDoctor({ engine, requests });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.ok, false);
  assert.equal(step.code, Code.UNAVAILABLE);
});

test('signed out, a page 2 refused with signIn false fails with the plugin\'s words rather than needing the login', async () => {
  const refusing = (signIn) => fakeEngine({ ...healthy, getMediaList: (categoryId, options) => {
    if (options.page === 2) throw Object.assign(new PluginError(Code.UNAUTHENTICATED, 'The server refused the token.'), { signIn });
    return [{ id: '1', title: 'A' }];
  } });

  const declined = await runDoctor({ engine: refusing(false), requests: [], loggedOut: true });
  const offered = await runDoctor({ engine: refusing(true), requests: [], loggedOut: true });
  const pageTwo = (report) => report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(declined.ok, false);
  assert.deepEqual({ ok: pageTwo(declined).ok, code: pageTwo(declined).code, message: pageTwo(declined).message },
    { ok: false, code: Code.UNAUTHENTICATED, message: 'The server refused the token.' });
  assert.equal(pageTwo(offered).message, NOT_LOGGED_IN);
});

test('a page 2 that shares most of page 1 is a site that moved, not one ignoring the page', async () => {
  // A new title at the top pushes everything down one; only a page 2 identical to page 1
  // says the page was never read.
  const engine = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => (options.page === 2
    ? [{ id: '2', title: 'B' }, { id: '3', title: 'C' }]
    : [{ id: '1', title: 'A' }, { id: '2', title: 'B' }]) });

  const report = await runDoctor({ engine, requests: [] });

  assert.equal(report.steps.find((s) => s.method === 'getMediaList (next page)').ok, true);

  // And one pinned title on top of every page is not a page left unread either.
  const pinned = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => (options.page === 2
    ? [{ id: 'pin', title: 'P' }, { id: '3', title: 'C' }]
    : [{ id: 'pin', title: 'P' }, { id: '2', title: 'B' }]) });
  const pinnedReport = await runDoctor({ engine: pinned, requests: [] });
  assert.equal(pinnedReport.steps.find((s) => s.method === 'getMediaList (next page)').ok, true);
});

test('a page 2 nobody recorded is skipped under --replay, not blamed', async () => {
  const engine = fakeEngine({ ...healthy, getMediaList: (categoryId, options) => {
    if (options.page === 2) throw new PluginError(Code.NO_FIXTURE, 'no recorded fixture for GET https://h.tv/list?page=2');
    return [{ id: '1', title: 'A' }];
  } });

  const report = await runDoctor({ engine, requests: [] });
  const step = report.steps.find((s) => s.method === 'getMediaList (next page)');

  assert.equal(step.skipped, true);
  assert.equal(step.ok, true);
  assert.match(step.message, /--record/);
});

// A plugin may still reach for QuickJS's own Date — nothing takes it away — and then
// whatever it timed cannot be tested, because no host can wind that clock. doctor names
// the line rather than leaving the next author to find out the way the TVBox cooldown did.
test('reading a clock QuickJS owns is a warning, naming the line and the call', async () => {
  const sources = {
    'probe-plugin.js': [
      'const DAY = 24 * 60 * 60 * 1000;',
      'function stale(at) { return Date.now() - at > DAY; }',
      'const stamped = new Date();',
      'const bare = new Date;',
    ].join('\n'),
  };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.equal(report.ok, true, 'a clock is a warning, never a failure');
  assert.deepEqual(report.sourceWarnings.map((w) => w.split(' — ')[0]), [
    'probe-plugin.js:2 reads Date.now',
    'probe-plugin.js:3 reads new Date()',
    'probe-plugin.js:4 reads new Date',
  ]);
  assert.match(report.sourceWarnings[0], /yonto\.now\(\)/);
});

// esbuild bundles the entry's imports, so a staleness check tucked into another file
// reaches a television just the same.
test('a clock in a file the entry imports is warned about too', async () => {
  const sources = {
    'probe-plugin.js': 'import { stale } from "./util.js";',
    'src/util.js': 'export const stale = (at) => Date.now() - at > 1000;',
  };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.deepEqual(report.sourceWarnings.map((w) => w.split(' — ')[0]), ['src/util.js:1 reads Date.now']);
});

// Parsing an air date a site sent is legitimate and yonto.now() cannot replace it, so a
// warning here would be one an author cannot act on — which teaches them to skip warnings.
test('parsing a date a site sent is not a clock read', async () => {
  const sources = {
    'probe-plugin.js': [
      'const aired = new Date(item.pubdate);',
      'const y = new Date(2020, 1, 1).getFullYear();',
    ].join('\n'),
  };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.deepEqual(report.sourceWarnings, []);
});

// Captured rather than called is still the clock: `const c = Date.now; c() - at > DAY`.
test('a reference to Date.now is a clock read too', async () => {
  const sources = { 'probe-plugin.js': 'const clock = Date.now;' };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.deepEqual(report.sourceWarnings.map((w) => w.split(' — ')[0]), ['probe-plugin.js:1 reads Date.now']);
});

// The trade this guard makes on purpose: it over-reports rather than staying quiet. A
// lexer could tell prose from code, and the one that used to live here was silently blind
// three ways — every failure a clean report over a real clock read. Warning about a comment
// is a warning someone can act on; the other kind reached a television.
test('a clock named in a comment or a string warns too, on purpose', async () => {
  const sources = {
    'probe-plugin.js': [
      '// never Date.now() — a host cannot wind it',
      'const note = "we used to call Date.now() here";',
    ].join('\n'),
  };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.deepEqual(report.sourceWarnings.map((w) => w.split(' — ')[0]),
    ['probe-plugin.js:1 reads Date.now', 'probe-plugin.js:2 reads Date.now']);
});

// A call wrapped across lines is still a call, and matching line by line would miss it.
test('a clock read broken across lines is found, on the line it starts', async () => {
  const sources = { 'probe-plugin.js': 'const at = Date\n  .now();' };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.deepEqual(report.sourceWarnings.map((w) => w.split(' — ')[0]), ['probe-plugin.js:1 reads Date.now']);
});

test('a plugin that reads the clock through the host draws no warning', async () => {
  const sources = { 'probe-plugin.js': 'function stale(at) { return yonto.now() - at > 1000; }' };

  const report = await runDoctor({ engine: fakeEngine(healthy), requests: [], query: 'x', sources });

  assert.deepEqual(report.sourceWarnings, []);
});

// The check that would have caught the scanner going blind: run it over every plugin that
// ships, and over each one with a clock read appended. A scanner that desyncs anywhere in
// a real file reports nothing for the probe, or reports it on the wrong line.
test('the scan stays in sync through every plugin that ships', async () => {
  const root = fileURLToPath(new URL('../../../plugins/', import.meta.url));
  const ids = readdirSync(root).filter((id) => existsSync(join(root, id, `${id}-plugin.js`)));
  assert.ok(ids.length >= 4, `expected the shipped plugins, found ${ids}`);

  for (const id of ids) {
    const source = readFileSync(join(root, id, `${id}-plugin.js`), 'utf8');
    const engine = fakeEngine(healthy);

    const asShipped = await runDoctor({ engine, requests: [], query: 'x', sources: { 'probe-plugin.js': source } });
    assert.deepEqual(asShipped.sourceWarnings, [], `${id} reads a clock it should not`);

    const probed = await runDoctor({
      engine, requests: [], query: 'x',
      sources: { 'probe-plugin.js': `${source}\nconst probe = Date.now();\n` },
    });
    assert.deepEqual(probed.sourceWarnings.map((w) => w.split(' — ')[0]),
      [`probe-plugin.js:${source.split('\n').length + 1} reads Date.now`],
      `${id}: the scan lost its place before the end of the file`);
  }
});

// Which version an export or a host call costs is lint's answer: it reads the source,
// derives the number and refuses a manifest that disagrees in either direction. doctor
// could only say it and hope, and a plugin already declaring 2 was told it needed 2.
test('doctor says nothing about which contract version a plugin needs', async () => {
  const withHeaders = { ...healthy, getImageHeaders: () => ({ Authorization: 'x' }) };
  const sources = { 'probe-plugin.js': 'function stale(at) { return Date.now() - at > 1000; }' };

  const report = await runDoctor({ engine: fakeEngine(withHeaders), requests: [], query: 'x', sources });

  const said = [...report.steps.flatMap((s) => s.warnings ?? []), ...report.sourceWarnings];
  assert.deepEqual(said.filter((w) => /contractVersion/.test(w)), []);
  // The advice itself is doctor's own and stays: it is about a clock no host can wind.
  assert.match(report.sourceWarnings[0], /Use yonto\.now\(\)/);
});

// ------------------------------------------------------- what the plugin said while it ran

/**
 * Everything a plugin wrote to `yonto.log`, handed to `runDoctor` the way `cli.js` hands
 * it — and attributed to the step it was written in.
 *
 * `doctor` reported what a call returned and dropped everything the plugin said about
 * getting there, which is the half that answers *why*. The XPTV loader is where that bites:
 * every library whose program fails refuses in the same sentence, naming the library and not
 * the cause, and the line naming the cause went to `yonto.log` and nowhere else
 * (kangzj/lantern-tv#374, and kangzj/lantern-tv#360 for the general complaint).
 */
function talkingEngine(lines, impl = healthy) {
  return {
    async exports() {
      lines.push({ level: 'info', pluginId: 'p', message: 'loaded' });
      return Object.keys(impl);
    },
    async call(method, args) {
      lines.push({ level: 'info', pluginId: 'p', message: `about to ${method}` });
      return impl[method](...args);
    },
  };
}

test('what the plugin said lands on the step that provoked it, and is read once', async () => {
  const lines = [];

  const report = await runDoctor({ engine: talkingEngine(lines), requests: [], logs: lines, query: 'x' });

  const list = report.steps.find((s) => s.method === 'getMediaList');
  assert.deepEqual(list.said.map((line) => line.message), ['about to getMediaList']);
  // Read once, so no line is reported under two steps — the count below would be nine if
  // each step re-read the whole log.
  assert.equal(report.steps.flatMap((s) => s.said ?? []).length, lines.length);
});

test('a line written before the first call is carried, not dropped', async () => {
  const lines = [];

  const report = await runDoctor({ engine: talkingEngine(lines), requests: [], logs: lines, query: 'x' });

  // A device defers a module body to the first call and this host evaluates it eagerly, so
  // which side of the first step a module-scope line falls on depends on the host. Dropping
  // it would lose exactly the lines a plugin writes while loading.
  assert.deepEqual(report.steps[0].said.map((line) => line.message), ['loaded', 'about to getCategories']);
});

test('a step that never ran carries nothing, rather than the previous step\'s words', async () => {
  const lines = [];
  const engine = talkingEngine(lines, { ...healthy, getMediaList: () => [] });

  const report = await runDoctor({ engine, requests: [], logs: lines, query: 'x' });

  const detail = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.equal(detail.skipped, true);
  assert.deepEqual(detail.said, []);
});

test('a failing step keeps what the plugin said on its way to failing', async () => {
  const lines = [];
  const engine = talkingEngine(lines, {
    ...healthy,
    getMediaDetail: () => {
      lines.push({ level: 'warn', pluginId: 'p', message: 'the page had no player' });
      throw new PluginError(Code.UNAVAILABLE, 'this title will not play');
    },
  });

  const report = await runDoctor({ engine, requests: [], logs: lines, query: 'x' });

  const detail = report.steps.find((s) => s.method === 'getMediaDetail');
  assert.equal(detail.ok, false);
  assert.deepEqual(detail.said.map((line) => line.message),
    ['about to getMediaDetail', 'the page had no player']);
});

test('checkHealth is described as a sentence, summary and all', async () => {
  const engine = fakeEngine({ ...healthy, checkHealth: () => ({ usable: true, summary: '81/81' }) });

  const report = await runDoctor({ engine, requests: [], query: 'x' });

  assert.equal(report.steps.find((s) => s.method === 'checkHealth').message, 'usable, 81/81');
});

test('a source calling itself unusable says so in words', async () => {
  const engine = fakeEngine({ ...healthy, checkHealth: () => ({ usable: false, summary: '0/14' }) });

  const report = await runDoctor({ engine, requests: [], query: 'x' });

  assert.equal(report.steps.find((s) => s.method === 'checkHealth').message, 'not usable, 0/14');
});

test('a source calling itself unusable fails the step and the run, with its summary as the reason', async () => {
  // The one thing checkHealth exists to say, and the report used to tick it and exit 0
  // because the call itself had succeeded (kangzj/lantern-tv#438).
  const engine = fakeEngine({ ...healthy, checkHealth: () => ({ usable: false, summary: '0/81' }) });

  const report = await runDoctor({ engine, requests: [], query: 'x' });

  const step = report.steps.find((s) => s.method === 'checkHealth');
  assert.equal(step.ok, false);
  assert.equal(step.message, 'not usable, 0/81');
  assert.equal(report.ok, false);
});

test('a source that is usable, or does not say, passes its health step', async () => {
  for (const verdict of [{ usable: true, summary: '81/81' }, { summary: '3/3' }]) {
    const engine = fakeEngine({ ...healthy, checkHealth: () => verdict });

    const report = await runDoctor({ engine, requests: [], query: 'x' });

    assert.equal(report.steps.find((s) => s.method === 'checkHealth').ok, true, JSON.stringify(verdict));
    assert.equal(report.ok, true, JSON.stringify(verdict));
  }
});

test('onImageHeadersRefused says what renewable means, rather than printing its JSON', async () => {
  // The same fall-through `checkHealth` had, in the same function, found in review of it.
  // `renewable: false` means a host stops asking until the viewer replaces the credential,
  // which is not something an author should have to look up to read their own report.
  const can = fakeEngine({ ...healthy, getImageHeaders: () => ({ Authorization: 'x' }),
    onImageHeadersRefused: () => ({ renewable: true }) });
  const cannot = fakeEngine({ ...healthy, getImageHeaders: () => ({ Authorization: 'x' }),
    onImageHeadersRefused: () => ({ renewable: false }) });

  const yes = await runDoctor({ engine: can, requests: [], query: 'x' });
  const no = await runDoctor({ engine: cannot, requests: [], query: 'x' });

  assert.match(yes.steps.find((s) => s.method === 'onImageHeadersRefused').message, /^renewable —/);
  assert.match(no.steps.find((s) => s.method === 'onImageHeadersRefused').message, /^not renewable —/);
})

// ------------------------------------------------------ a module body that will not load

/**
 * An engine whose module body fails, which is the moment both hosts defer it to: the first
 * `exports()`. Whatever the body wrote is already in the host's log by the time the
 * rejection arrives, which is why the log is handed in the same way a passing run hands it.
 */
function refusingEngine(error) {
  return {
    async exports() { throw error; },
    async call() { throw new Error('nothing is callable on a plugin that did not load'); },
  };
}

test('a module body that logs and then throws keeps what it said', async () => {
  const lines = [
    { level: 'info', pluginId: 'p', message: 'index names 81 catalogs, 0 readable' },
    { level: 'error', pluginId: 'p', message: 'the index answered 520' },
  ];

  // Two requests the body made before it died, so the step reports them the way a step that
  // ran does — a body that fetched an index and then threw did not fail on nothing.
  const report = await runDoctor({
    engine: refusingEngine(new PluginError(Code.METHOD_THREW, 'no catalog survived the index')),
    requests: [{}, {}], logs: lines, query: 'x',
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.steps.map((s) => s.method), ['load']);
  assert.equal(report.steps[0].message, 'no catalog survived the index');
  assert.equal(report.steps[0].requests, 2);
  assert.deepEqual(report.steps[0].said.map((line) => line.message),
    ['index names 81 catalogs, 0 readable', 'the index answered 520']);
});

test('a plugin that will not evaluate still gets its clock warnings', async () => {
  // The comment above `clockWarnings` has always claimed this; the rejection travelling out
  // of `runDoctor` took the warnings with it (kangzj/lantern-tv#439).
  const report = await runDoctor({
    engine: refusingEngine(new Error('no catalog survived the index')),
    requests: [], query: 'x', sources: { 'p-plugin.js': 'const age = Date.now();' },
  });

  assert.equal(report.ok, false);
  assert.match(report.sourceWarnings[0], /p-plugin\.js:1 reads Date\.now/);
});

test('a load that fails for a reason the host typed keeps that code', async () => {
  // A plugin with no default export is a MISSING_EXPORT the engine raises before any of the
  // plugin's own code runs, and flattening it to METHOD_THREW would blame that code for a
  // failure it had no part in — `engines/quickjs.js` calls this the first failure most
  // authors ever see.
  const report = await runDoctor({
    engine: refusingEngine(new PluginError(Code.MISSING_EXPORT, 'p-plugin.js must default-export an object of methods')),
    requests: [], query: 'x',
  });

  assert.equal(report.steps[0].code, Code.MISSING_EXPORT);
  assert.notEqual(report.steps[0].code, Code.METHOD_THREW);
  assert.equal(report.ok, false);
});

/**
 * The same thing on the real engine, through the command an author runs.
 *
 * The three above hand `runDoctor` a rejection, which is the shape of a failed load rather
 * than the thing: only QuickJS evaluates a module body, and only `cli.js` hands the host's
 * log to `runDoctor` at all. The fixture writes two lines and then throws, which is what an
 * XPTV catalog's program does when the site behind it has gone.
 */
test('doctor prints what a module body said before it threw, through the command an author runs', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const dir = fileURLToPath(new URL('../test-plugins/says-then-throws/', import.meta.url));

  assert.throws(
    () => execFileSync('node', [cli, 'doctor', dir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.equal(error.status, 1);
      // `\s+` rather than a count of spaces: the gap is `format.js`'s method column, which
      // is already too narrow for `onImageHeadersRefused` and has nothing to do with this.
      assert.match(error.stdout, /✗ load\s+METHOD_THREW\s+.*no catalog survived the index/);
      assert.match(error.stdout, /\n {4}· info {2}index names 81 catalogs, 0 readable\n/);
      assert.match(error.stdout, /\n {4}· error the index answered 520\n/);
      return true;
    },
  );
});

/**
 * The other way a load fails, and the one an author hits first: a file with no default
 * export, refused by the engine before any of the plugin's own code runs. It reaches the
 * same step, and it has to keep `MISSING_EXPORT` — `METHOD_THREW` here would send an author
 * looking for a throw in code that never ran.
 */
test('a plugin with no default export is refused under load, not blamed for throwing', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const dir = fileURLToPath(new URL('../test-plugins/no-export/', import.meta.url));

  assert.throws(
    () => execFileSync('node', [cli, 'doctor', dir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stdout, /✗ load\s+MISSING_EXPORT\s+.*must default-export an object of methods/);
      assert.doesNotMatch(error.stdout, /METHOD_THREW/);
      // The manifest line survives, which the bare CLI error it used to print did not carry.
      assert.match(error.stdout, /^✓ manifest\s+id=no-export/m);
      return true;
    },
  );
});

/** The warnings every step of a report gave, one list. */
async function warningsOf(impl) {
  const report = await runDoctor({ engine: fakeEngine({ ...healthy, ...impl }), requests: [], query: 'x' });
  return report.steps.flatMap((step) => step.warnings ?? []);
}

test('a display field a television would clean is named, with what it carries', async () => {
  // What SourceText.kt does to a title before a viewer sees it, from the record both hosts
  // are held to (kangzj/lantern-tv#487).
  const warnings = await warningsOf({
    getMediaList: () => [{ id: 'a', title: 'Alpha\u0001Beta' }, { id: 'b', title: 'Movie ‮esrever‬ end' }, { id: 'c', title: 'Clean' }],
  });

  assert.ok(warnings.includes('summary.title carries U+0001, U+202E, U+202C in 2 of 3, which a television removes'), warnings.join('\n'));
});

test('a line break or tab in a one-line field is said to become a space', async () => {
  const warnings = await warningsOf({
    getCategories: () => [{ id: 'dianying', name: '电\t影' }],
  });

  assert.ok(warnings.includes('category.name carries a line break or tab in 1 of 1, which a television shows as a space'), warnings.join('\n'));
});

test('a synopsis keeps its line breaks, and loses what every field loses', async () => {
  const warnings = await warningsOf({
    getMediaDetail: () => ({ ...healthy.getMediaDetail(), synopsis: 'One.\n\nTwo ⁦isolated⁩.' }),
  });

  assert.deepEqual(warnings.filter((warning) => warning.startsWith('detail.synopsis')),
    ['detail.synopsis carries U+2066, U+2069 in 1 of 1, which a television removes']);
});

test('a field nested inside an answer is looked at too', async () => {
  const warnings = await warningsOf({
    getFilters: () => [{ id: 'year', name: 'Year', options: [{ id: '2024', name: '2024\u0007' }] }],
    getMediaDetail: () => ({ ...healthy.getMediaDetail(), genres: ['剧情\n'],
      playbackOptions: [{ label: 'S01E01\u007F', stream: { url: 'https://h.tv/1.m3u8' } }] }),
    getSubSources: () => ({ items: [{ id: 'a', name: '线路\u0002' }] }),
    getRecommendations: () => [{ id: 'r', title: 'Pick\u0003' }],
    checkHealth: () => ({ usable: true, summary: '1/1\n' }),
  });

  assert.ok(warnings.includes('filterOption.name carries U+0007 in 1 of 1, which a television removes'), warnings.join('\n'));
  assert.ok(warnings.includes('detail.genres carries a line break or tab in 1 of 1, which a television shows as a space'), warnings.join('\n'));
  assert.ok(warnings.includes('playbackOption.label carries U+007F in 1 of 1, which a television removes'), warnings.join('\n'));
  assert.ok(warnings.includes('subSource.name carries U+0002 in 1 of 1, which a television removes'), warnings.join('\n'));
  // Home's hero draws these, decoded as the same summary a listing is.
  assert.ok(warnings.includes('summary.title carries U+0003 in 1 of 1, which a television removes'), warnings.join('\n'));
  assert.ok(warnings.includes('health.summary carries a line break or tab in 1 of 1, which a television shows as a space'), warnings.join('\n'));
});

test('a plugin whose text is clean is told nothing about it', async () => {
  assert.deepEqual(await warningsOf({}), []);
});

test('an id or an address is not a display field, whatever it carries', async () => {
  const warnings = await warningsOf({
    getMediaList: () => [{ id: 'a\u0001b', title: 'T', posterUrl: 'https://h.tv/p\t.jpg' }],
  });

  assert.deepEqual(warnings, []);
});

test('a filter group that opens on an option says which, by name and id', async () => {
  // Browse opens a group with an `init` on that option and shows no "All" for it, so an
  // author sees here what a television will open on (kangzj/lantern-tv#526).
  const report = await runDoctor({ engine: fakeEngine({ ...healthy, getFilters: () => [
    { id: 'type', name: '类型', init: 'all', options: [{ id: 'all', name: '全部' }, { id: 'tv', name: '剧集' }] },
    { id: 'year', name: '年份', options: [{ id: '2024', name: '2024' }] },
  ] }), requests: [], query: 'x' });

  assert.deepEqual(report.steps.find((s) => s.method === 'getFilters').notes, ['类型 opens on 全部 (all)']);
});

test('filter groups without an init add nothing to the report', async () => {
  const report = await runDoctor({ engine: fakeEngine({ ...healthy, getFilters: () => [
    { id: 'year', name: '年份', options: [{ id: '2024', name: '2024' }] },
  ] }), requests: [], query: 'x' });

  assert.deepEqual(report.steps.find((s) => s.method === 'getFilters').notes ?? [], []);
});

// kangzj/lantern-tv#357: a television reads the sentence off an answer, so a step that got none
// shows none, and what it said is taken with it rather than left for the next step to show.
for (const [code, detail] of [
  [Code.METHOD_THREW, () => { throw new Error('详情页打不开'); }],
  [Code.RESULT_INVALID, () => ({ id: '13141' })],
]) {
  test(`doctor shows no partial sentence under a ${code} step, nor under the step after it`, async () => {
    let said = null;
    const partial = (reason) => { said = reason; };
    const takePartial = () => { const taken = said; said = null; return taken; };
    const engine = fakeEngine({
      ...healthy,
      getMediaList: (categoryId, options) => { partial('一号站没有回应。'); return healthy.getMediaList(categoryId, options); },
      getMediaDetail: () => { partial('第二条线路暂时无法获取。'); return detail(); },
    });

    const { steps } = await runDoctor({ engine, requests: [], takePartial, query: '庆余年' });
    const step = (method) => steps.find((s) => s.method === method);

    assert.equal(step('getMediaList').partial, '一号站没有回应。');
    assert.equal(step('getMediaDetail').code, code);
    assert.equal(step('getMediaDetail').partial, null);
    assert.equal(step('search').partial, null);
  });
}
