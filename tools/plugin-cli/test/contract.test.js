import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, validateResult, isEmptyResult, itemsOf, cursorOf } from '../src/contract.js';

test('the contract methods are listed in the order doctor calls them', () => {
  assert.deepEqual(METHODS, [
    'getCategories', 'getFilters', 'getMediaList',
    'getMediaDetail', 'search', 'getRecommendations', 'checkHealth', 'getImageHeaders',
    'onImageHeadersRefused',
    // After the detail, because that is where its argument comes from.
    'getStream',
    // After the library, not before it: activeId is what a source is reading.
    'getSubSources',
  ]);
});

test('accepts a well-formed category list', () => {
  const result = validateResult('getCategories', [{ id: 'dianying', name: '电影' }]);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('names the JSON path of a bad item', () => {
  const { valid, errors } = validateResult('getCategories', [{ id: 'dianying' }]);
  assert.equal(valid, false);
  assert.equal(errors[0].path, '/0');
  assert.match(errors[0].message, /name/);
});

// The field is what names the redeemer, and `oneOf` over three `required` branches is
// exactly-one rather than at-least-one: an option carrying two satisfies two branches and is
// refused, which `anyOf` would not give.
test('a playback option may carry a stream, a pan or a track', () => {
  const detail = (option) => ({ id: 'm', title: 'M', playbackOptions: [option] });

  assert.equal(validateResult('getMediaDetail', detail({ label: 'a', stream: { url: 'https://v/1' } })).valid, true);
  assert.equal(validateResult('getMediaDetail', detail({ label: 'a', pan: { share: 'https://p/1' } })).valid, true);
  assert.equal(validateResult('getMediaDetail', detail({ label: 'a', track: 'ext-1' })).valid, true);
});

test('an option carrying two of them, or none, is refused', () => {
  const detail = (option) => ({ id: 'm', title: 'M', playbackOptions: [option] });

  assert.equal(validateResult('getMediaDetail', detail({ label: 'a' })).valid, false);
  assert.equal(
    validateResult('getMediaDetail', detail({ label: 'a', track: 'ext-1', stream: { url: 'https://v/1' } })).valid,
    false,
  );
});

// It carries no drive: which client opens a share is decided by the share URL's own host, so
// that nothing a plugin writes selects which of the host's code runs.
test('a pan needs a share and nothing else, and an empty one is refused', () => {
  const detail = (pan) => ({ id: 'm', title: 'M', playbackOptions: [{ label: 'a', pan }] });

  assert.equal(validateResult('getMediaDetail', detail({ share: 'https://p/1', password: '1234' })).valid, true);
  assert.equal(validateResult('getMediaDetail', detail({ password: '1234' })).valid, false);
  assert.equal(validateResult('getMediaDetail', detail({ share: '' })).valid, false);
});

// A forty-episode ddys title carries forty whole `ext` objects across the QuickJS boundary as
// one JSON string, and the loader cannot prune them because it cannot know which fields a
// given catalog's getPlayinfo will read back. The bound is the difference between that being
// large and that being unbounded; a token over it is not a track option, and the title falls
// back to its refusal sentence rather than failing silently.
test('a track is bounded, and an empty one is not a token', () => {
  const detail = (track) => ({ id: 'm', title: 'M', playbackOptions: [{ label: 'a', track }] });

  assert.equal(validateResult('getMediaDetail', detail('x'.repeat(2048))).valid, true);
  assert.equal(validateResult('getMediaDetail', detail('x'.repeat(2049))).valid, false);
  assert.equal(validateResult('getMediaDetail', detail('')).valid, false);
});

// What a token redeems to is a stream, never another option: an option that came back could
// carry another token, and nothing would bound the redemption.
test('getStream answers a stream, and one without a url is malformed rather than empty', () => {
  assert.equal(validateResult('getStream', { url: 'https://v/1.mp4', mimeType: 'video/mp4' }).valid, true);
  assert.equal(validateResult('getStream', { mimeType: 'video/mp4' }).valid, false);
  assert.equal(validateResult('getStream', { url: '' }).valid, false);
});

// A name that is not a token, or a value OkHttp would refuse, never reaches a player or an
// image loader. The shape is `$defs/headers`, shared by a stream and getImageHeaders.
test('a header name is a token and its value is printable ASCII, for streams and artwork alike', () => {
  const answers = (headers) => [
    validateResult('getStream', { url: 'https://v/1.mp4', headers }),
    validateResult('getMediaDetail', { id: 'm', title: 'M', playbackOptions: [{ label: 'a', stream: { url: 'https://v/1', headers } }] }),
    validateResult('getImageHeaders', headers),
  ].map((r) => r.valid);

  for (const headers of [
    { Referer: 'https://example.test/' },
    { "X-!#$%&'*+.^_`|~0-9": 'a' },
    { Cookie: '' },
    { 'User-Agent': 'Mozilla/5.0\t(tab kept)' },
  ]) {
    assert.deepEqual(answers(headers), [true, true, true], JSON.stringify(headers));
  }
  for (const headers of [
    { 'X-A\r\nInjected': 'y' },
    { 'X-A: y': 'z' },
    { 'X-A:': 'y' },
    { 'X(A)': 'y' },
    { 'X A': 'y' },
    { '': 'y' },
    { 'X-Ä': 'y' },
    { 'X-A': 'y\r\nInjected: z' },
    { 'X-A': 'y\u007f' },
    { 'X-A': '电影' },
    { 'X-A\n': 'y' },
    { 'X-A': 'y\n' },
  ]) {
    assert.deepEqual(answers(headers), [false, false, false], JSON.stringify(headers));
  }
});

// A group may name the option its listing is already on, and only one of its own
// (kangzj/lantern-tv#358). The schema cannot say "one of its own", so validateResult does.
test('a filter group\'s init names one of its own options, or the answer is refused', () => {
  const group = (init) => ({ id: 'sort', name: '排序', options: [{ id: 'hot', name: '最热' }], ...(init === undefined ? {} : { init }) });

  assert.equal(validateResult('getFilters', [group()]).valid, true);
  assert.equal(validateResult('getFilters', [group('hot')]).valid, true);
  const refused = validateResult('getFilters', [group('hot'), group('cold')]);
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.errors.map((e) => e.path), ['/1/init']);
  assert.equal(validateResult('getFilters', [group('')]).valid, false);
});

test('a summary needs an id and a title and nothing else', () => {
  assert.equal(validateResult('getMediaList', [{ id: '1', title: '庆余年' }]).valid, true);
});

test('accepts an unknown media type, because the contract says the client maps it to a safe default', () => {
  const result = validateResult('getMediaList', [{ id: '1', title: 'x', type: 'ALBUM' }]);
  assert.equal(result.valid, true);
});

test('rejects a non-string media type', () => {
  const { valid, errors } = validateResult('getMediaList', [{ id: '1', title: 'x', type: 123 }]);
  assert.equal(valid, false);
  assert.equal(errors[0].path, '/0/type');
});

test('a detail needs playbackOptions, each with a label and a stream url', () => {
  const ok = validateResult('getMediaDetail', {
    id: '1', title: '庆余年',
    playbackOptions: [{ label: 'S01E01', stream: { url: 'https://h/a.m3u8' } }],
  });
  assert.equal(ok.valid, true);
  const bad = validateResult('getMediaDetail', {
    id: '1', title: '庆余年', playbackOptions: [{ label: 'S01E01', stream: {} }],
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].path, '/playbackOptions/0/stream');
});

test('an empty list is empty for the list-shaped methods', () => {
  assert.equal(isEmptyResult('getMediaList', []), true);
  assert.equal(isEmptyResult('getMediaList', [{ id: '1', title: 'x' }]), false);
});

test('an empty filter list is not a failure — plenty of sources have no filters', () => {
  assert.equal(isEmptyResult('getFilters', []), false);
});

test('a detail with no playback options is empty, because nothing can be played', () => {
  assert.equal(isEmptyResult('getMediaDetail', { id: '1', title: 'x', playbackOptions: [] }), true);
});

test('getMediaList may answer a page object as well as a bare array', () => {
  const page = { items: [{ id: '1', title: '庆余年' }], nextCursor: 'eyJvIjoyMH0=' };

  assert.equal(validateResult('getMediaList', page).valid, true);
  assert.equal(validateResult('getMediaList', { items: [], nextCursor: null }).valid, true);
  assert.equal(validateResult('getMediaList', { nextCursor: 'x' }).valid, false, 'items is what makes it a page');
  assert.equal(validateResult('getMediaList', { items: [{ id: '1' }] }).valid, false, 'its items are still summaries');
});

test('a listing reads the same whichever shape it arrived in', () => {
  const item = { id: '1', title: '庆余年' };

  assert.deepEqual(itemsOf([item]), [item]);
  assert.deepEqual(itemsOf({ items: [item], nextCursor: 'c2' }), [item]);
  assert.deepEqual(itemsOf(undefined), []);

  assert.equal(cursorOf([item]), null);
  assert.equal(cursorOf({ items: [item], nextCursor: 'c2' }), 'c2');
  assert.equal(cursorOf({ items: [item], nextCursor: '  ' }), null, 'a blank cursor is no cursor');
});

test('an empty page is as empty as an empty array, however it is wrapped', () => {
  assert.equal(isEmptyResult('getMediaList', { items: [], nextCursor: 'c2' }), true);
  assert.equal(isEmptyResult('getMediaList', { items: [{ id: '1', title: 'x' }] }), false);
});
