import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { validateResult } from '../src/contract.js';
import { scratchDir } from '../src/scratch-dir.js';

// Contract 23 on Emby. The reads replay the recorded fixtures (re-keyed for `EnableUserData`, with
// a resume point and a played mark added by hand: see plugins/emby/AGENTS.md); the writes are scripted. Emby 4.9.3 was
// also driven live through the same calls.
const dir = fileURLToPath(new URL('../../../plugins/emby/', import.meta.url));
const RECORDED = JSON.parse(readFileSync(join(dir, 'doctor.json'), 'utf8'));
const SERVER = 'https://emby.test';
const withKey = { serverUrl: SERVER, apiKey: 'key', userId: 'u1' };

function engineFor(config, transport) {
  const host = createHost({ manifest: loadManifest(dir), config, transport, storeDir: scratchDir('lp-emby-state-'), pluginDir: dir });
  return createEngine({ dir, host });
}

function replayed() {
  return engineFor(RECORDED, createReplayTransport({ dir: join(dir, 'fixtures') }));
}

function json(value, status = 200) {
  return { status, headers: {}, bodyBase64: Buffer.from(JSON.stringify(value)).toString('base64') };
}

function scripted(answer) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      return answer(req);
    },
  };
}

test('a played mark rides on the title the listing says it for, and only there', async () => {
  const listed = await replayed().call('getMediaList', ['3', { page: 1, filters: {} }]);

  const pattern = listed.find((item) => item.title === 'Test Pattern');
  assert.equal(pattern.played, true);
  assert.equal(pattern.position, undefined);
  assert.equal(pattern.playedAt, undefined, 'a listing carries no LastPlayedDate on Emby');
  assert.equal(listed.find((item) => item.title !== 'Test Pattern').played, false, 'the recording had Played: false');
});

test('an episode carries its server id and its resume point in seconds', async () => {
  const detail = await replayed().call('getMediaDetail', ['11']);

  const [first, second] = detail.playbackOptions;
  assert.deepEqual([first.id, first.played, first.position], ['13', false, 750]);
  assert.deepEqual([second.played, second.position], [false, undefined]);
  assert.equal(validateResult('getMediaDetail', detail).valid, true);
});

test('a title the server sends no user data for says nothing about it', async () => {
  const transport = scripted(() => json({ Items: [{ Id: '5', Name: 'Bare', Type: 'Movie' }] }));

  const [bare] = await engineFor(withKey, transport).call('getMediaList', ['lib', { page: 1, filters: {} }]);

  for (const field of ['played', 'position', 'playedAt']) assert.ok(!(field in bare), field);
});

test('every item call asks for user data by name', async () => {
  const transport = scripted(() => json({ Items: [] }));
  const engine = engineFor(withKey, transport);
  await engine.call('getMediaList', ['lib', { page: 1, filters: {} }]);
  await engine.call('search', ['x']);
  await engine.call('getRecommendations', []);

  assert.equal(transport.calls.length, 3);
  assert.ok(transport.calls.every((call) => call.url.includes('EnableUserData=true')));
});

test('a listing is the latest first unless another sort is picked, a series by its newest episode', async () => {
  const sorted = async (filters) => {
    const transport = scripted(() => json({ Items: [] }));
    await engineFor(withKey, transport).call('getMediaList', ['lib', { page: 1, filters }]);
    const params = new URL(transport.calls[0].url).searchParams;
    return [params.get('SortBy'), params.get('SortOrder')];
  };

  assert.deepEqual(await sorted({}), ['DateLastContentAdded,DateCreated', 'Descending']);
  assert.deepEqual(await sorted({ sort: 'added' }), ['DateLastContentAdded,DateCreated', 'Descending']);
  assert.deepEqual(await sorted({ sort: 'title' }), ['SortName', 'Ascending']);
  assert.deepEqual(await sorted({ sort: 'year' }), ['ProductionYear,SortName', 'Descending,Ascending']);
  assert.deepEqual(await sorted({ sort: 'rating' }), ['CommunityRating,SortName', 'Descending,Ascending']);
});

test('reportPlayback keeps one play session id across the three events, and no media source id', async () => {
  const transport = scripted(() => ({ status: 204, headers: {}, bodyBase64: '' }));
  const engine = engineFor(withKey, transport);
  const report = { mediaId: '9', optionId: '13', paused: false, position: 12.5 };

  await engine.call('reportPlayback', [{ ...report, event: 'start' }]);
  await engine.call('reportPlayback', [{ ...report, event: 'progress', paused: true }]);
  await engine.call('reportPlayback', [{ ...report, event: 'stop', finished: true }]);

  assert.deepEqual(transport.calls.map((c) => [c.method, c.url.replace(SERVER, '')]), [
    ['POST', '/emby/Sessions/Playing'],
    ['POST', '/emby/Sessions/Playing/Progress'],
    ['POST', '/emby/Sessions/Playing/Stopped'],
  ]);
  const [start, progress, stop] = transport.calls.map((c) => JSON.parse(c.body));
  assert.equal(start.ItemId, '13');
  assert.equal(start.PositionTicks, 125000000);
  assert.equal(progress.IsPaused, true);
  assert.ok(start.PlaySessionId && start.PlaySessionId === progress.PlaySessionId && progress.PlaySessionId === stop.PlaySessionId);
  assert.equal('MediaSourceId' in start, false, 'the item id is not an Emby media source id');
  assert.equal(transport.calls[0].headers['X-Emby-Token'], 'key');
});

test('a refused report is an error, not a silent success', async () => {
  const engine = engineFor(withKey, scripted(() => ({ status: 400, headers: {}, bodyBase64: '' })));

  await assert.rejects(
    () => engine.call('reportPlayback', [{ mediaId: 'f', event: 'stop', paused: false, position: 1 }]),
    (error) => error.code === Code.UNAVAILABLE,
  );
});

test('setPlayed marks with POST and unmarks with DELETE on the option when there is one', async () => {
  const transport = scripted(() => json({}));
  const engine = engineFor(withKey, transport);

  await engine.call('setPlayed', [{ mediaId: '9', optionId: '13', played: true }]);
  await engine.call('setPlayed', [{ mediaId: '8', played: false }]);

  assert.deepEqual(transport.calls.map((c) => [c.method, c.url.replace(SERVER, '')]), [
    ['POST', '/emby/Users/u1/PlayedItems/13'],
    ['DELETE', '/emby/Users/u1/PlayedItems/8'],
  ]);
});

test('continue watching keeps only an unfinished place, an episode as its series with the episode to resume', async () => {
  const transport = scripted(() => json({ Items: [
    {
      Id: '13', Name: 'Third', Type: 'Episode', SeriesId: '9', SeriesName: 'Show', SeriesPrimaryImageTag: 'tag',
      UserData: { PlaybackPositionTicks: 600000000, Played: false },
    },
    { Id: '14', Name: 'Nothing to resume', Type: 'Episode', SeriesId: '9', SeriesName: 'Show', UserData: { PlaybackPositionTicks: 0, Played: false } },
    { Id: '8', Name: 'Finished', Type: 'Movie', UserData: { PlaybackPositionTicks: 590024943, Played: true } },
    { Id: '7', Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 30000000, Played: false } },
  ] }));

  const result = await engineFor(withKey, transport).call('getContinueWatching', []);

  assert.ok(transport.calls[0].url.includes('/emby/Users/u1/Items/Resume?'), transport.calls[0].url);
  assert.ok(transport.calls[0].url.includes('EnableUserData=true'), 'the resume list carries user data');
  assert.deepEqual(result.items.map((i) => [i.id, i.title, i.optionId, i.position]), [
    ['9', 'Show', '13', 60],
    ['7', 'Film', undefined, 3],
  ]);
  assert.equal(validateResult('getContinueWatching', result).valid, true);
});
