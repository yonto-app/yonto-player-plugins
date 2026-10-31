import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { validateResult } from '../src/contract.js';
import { scratchDir } from '../src/scratch-dir.js';
import { CONFIG, MOVIE_ID, SERIES_ID } from '../scripts/write-jellyfin-fixtures.js';

// Contract 23: what the server says about the viewer's place, and what is written back.
// The reads replay the generator's fixtures (a movie with a played mark, an episode half way
// in, a series with no user data at all); the writes are scripted, since a fixture set cannot
// say what a POST carried. Both servers' real answers were checked on a live Jellyfin 12.2.
const dir = fileURLToPath(new URL('../../../plugins/jellyfin/', import.meta.url));
const SERVER = 'https://jf.test';
const withKey = { serverUrl: SERVER, apiKey: 'key', userId: 'u1' };

function engineFor(config, transport) {
  const host = createHost({ manifest: loadManifest(dir), config, transport, storeDir: scratchDir('lp-jf-state-'), pluginDir: dir });
  return createEngine({ dir, host });
}

function replayed() {
  return engineFor(CONFIG, createReplayTransport({ dir: join(dir, 'fixtures') }));
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

test('a played mark and the date it was last played ride on the film', async () => {
  const detail = await replayed().call('getMediaDetail', [MOVIE_ID]);

  assert.equal(detail.played, true);
  assert.equal(detail.playedAt, '2026-10-01T20:30:00.0000000Z');
  assert.equal(detail.position, undefined);
  assert.equal(detail.playbackOptions[0].id, MOVIE_ID);
  assert.equal(validateResult('getMediaDetail', detail).valid, true);
});

test('an episode carries its server id and its resume point in seconds', async () => {
  const detail = await replayed().call('getMediaDetail', [SERIES_ID]);

  const [first, second] = detail.playbackOptions;
  assert.deepEqual([first.id, first.played, first.position, first.playedAt], ['ep1', false, 750, '2026-10-17T21:05:09.1234567Z']);
  assert.deepEqual([second.id, second.played, second.position, second.playedAt], ['ep2', undefined, undefined, undefined]);
  assert.equal(validateResult('getMediaDetail', detail).valid, true);
});

test('a title the server sends no user data for says nothing about it', async () => {
  const detail = await replayed().call('getMediaDetail', [SERIES_ID]);

  for (const field of ['played', 'position', 'playedAt']) assert.ok(!(field in JSON.parse(JSON.stringify(detail))), field);
});

test('every item call asks for user data by name', async () => {
  const newestEpisodes = (call) => call.url.includes('IncludeItemTypes=Episode');
  const transport = scripted((req) => json({ Items: newestEpisodes(req) ? [{ Id: 'e1', Type: 'Episode', SeriesId: 's1' }] : [] }));
  const engine = engineFor(withKey, transport);
  await engine.call('getMediaList', ['lib', { page: 1, filters: {} }]);
  await engine.call('search', ['x']);
  await engine.call('getRecommendations', []);

  // The newest episodes are read for their series alone, which is asked for with the user data.
  const titles = transport.calls.filter((call) => !newestEpisodes(call));
  assert.equal(titles.length, 4);
  assert.ok(titles.some((call) => call.url.includes('Ids=s1')));
  assert.ok(titles.every((call) => call.url.includes('EnableUserData=true')), 'user data is asked for');
});

test('a listing is the latest first unless another sort is picked', async () => {
  const sorted = async (filters) => {
    const transport = scripted(() => json({ Items: [] }));
    await engineFor(withKey, transport).call('getMediaList', ['lib', { page: 1, filters }]);
    const params = new URL(transport.calls.find((call) => call.url.includes('StartIndex=')).url).searchParams;
    return [params.get('SortBy'), params.get('SortOrder')];
  };

  assert.deepEqual(await sorted({}), ['DateLastContentAdded,DateCreated', 'Descending']);
  assert.deepEqual(await sorted({ sort: 'title' }), ['SortName', 'Ascending']);
  assert.deepEqual(await sorted({ sort: 'year' }), ['ProductionYear,SortName', 'Descending,Ascending']);
  assert.deepEqual(await sorted({ sort: 'rating' }), ['CommunityRating,SortName', 'Descending,Ascending']);
});

// Jellyfin never moves a series' own date when an episode arrives, so its newest episodes decide.
test('the latest first page leads with the series of the newest episodes, narrowed like the listing', async () => {
  const listed = [{ Id: 'old', Name: 'Old', Type: 'Series' }, { Id: 's2', Name: 'Second', Type: 'Series' }, { Id: 'm1', Name: 'Film', Type: 'Movie' }];
  const transport = scripted((req) => {
    const params = new URL(req.url).searchParams;
    if (params.get('IncludeItemTypes') === 'Episode') {
      return json({ Items: ['s1', 's2', 's1', 'gone'].map((SeriesId, i) => ({ Id: `e${i}`, Type: 'Episode', SeriesId })) });
    }
    // The server keeps what the genre allows, in its own order; `gone` is not in it.
    if (params.has('Ids')) return json({ Items: [{ Id: 's2', Name: 'Second', Type: 'Series' }, { Id: 's1', Name: 'First', Type: 'Series' }] });
    return json({ Items: listed });
  });
  const engine = engineFor(withKey, transport);

  const items = await engine.call('getMediaList', ['lib', { page: 1, filters: { genre: 'Drama' } }]);

  assert.deepEqual(items.map((item) => item.id), ['s1', 's2', 'old', 'm1']);
  const ids = new URL(transport.calls.find((call) => call.url.includes('Ids=')).url).searchParams;
  assert.equal(ids.get('Ids'), 's1,s2,gone');
  assert.equal(ids.get('Genres'), 'Drama');

  for (const filters of [{ sort: 'title' }, { type: 'Movie' }]) {
    const quiet = scripted(() => json({ Items: listed }));
    await engineFor(withKey, quiet).call('getMediaList', ['lib', { page: 1, filters }]);
    assert.equal(quiet.calls.length, 1, `no episodes are read for ${JSON.stringify(filters)}`);
  }
  const later = scripted(() => json({ Items: listed }));
  await engineFor(withKey, later).call('getMediaList', ['lib', { page: 2, filters: {} }]);
  assert.equal(later.calls.length, 1, 'only the first page is led');
});

test('a lead that fails leaves the listing as the server sorts it, and names forty series at most', async () => {
  const listed = [{ Id: 's1', Name: 'First', Type: 'Series' }];
  const refusing = scripted((req) => (req.url.includes('IncludeItemTypes=Episode') ? json({}, 500) : json({ Items: listed })));
  const items = await engineFor(withKey, refusing).call('getMediaList', ['lib', { page: 1, filters: {} }]);
  assert.deepEqual(items.map((item) => item.id), ['s1']);

  const busy = scripted((req) => json({
    Items: req.url.includes('IncludeItemTypes=Episode') ? Array.from({ length: 60 }, (_, i) => ({ Id: `e${i}`, Type: 'Episode', SeriesId: `s${i}` })) : [],
  }));
  await engineFor(withKey, busy).call('getMediaList', ['lib', { page: 1, filters: {} }]);
  const ids = new URL(busy.calls.find((call) => call.url.includes('Ids=')).url).searchParams.get('Ids').split(',');
  assert.equal(ids.length, 40);
  assert.equal(ids[0], 's0');
});

test('reportPlayback maps each event to its session endpoint, in ticks', async () => {
  const transport = scripted(() => ({ status: 204, headers: {}, bodyBase64: '' }));
  const engine = engineFor(withKey, transport);
  const report = { mediaId: 'show', optionId: 'ep1', paused: false, position: 12.5, duration: 100 };

  await engine.call('reportPlayback', [{ ...report, event: 'start' }]);
  await engine.call('reportPlayback', [{ ...report, event: 'progress', paused: true }]);
  await engine.call('reportPlayback', [{ ...report, event: 'stop', finished: true }]);

  assert.deepEqual(transport.calls.map((c) => [c.method, c.url.replace(SERVER, '')]), [
    ['POST', '/Sessions/Playing'],
    ['POST', '/Sessions/Playing/Progress'],
    ['POST', '/Sessions/Playing/Stopped'],
  ]);
  const [start, progress, stop] = transport.calls.map((c) => JSON.parse(c.body));
  assert.equal(start.ItemId, 'ep1');
  assert.equal(start.MediaSourceId, 'ep1');
  assert.equal(start.PositionTicks, 125000000);
  assert.equal(start.IsPaused, false);
  assert.equal(progress.IsPaused, true);
  assert.equal(stop.PlaySessionId, start.PlaySessionId);
  // No `session`: a stream the server did not decide is direct play under a session made from the item.
  assert.equal(start.PlayMethod, 'DirectPlay');
  assert.match(start.PlaySessionId, /-ep1$/);
  assert.equal('Played' in stop, false, 'the server decides played from the position; finished is only a hint');
  assert.equal(transport.calls[0].headers.Authorization, 'MediaBrowser Token="key"');
});

test('a film is reported under the title id when no option id is given', async () => {
  const transport = scripted(() => ({ status: 204, headers: {}, bodyBase64: '' }));

  await engineFor(withKey, transport).call('reportPlayback', [{ mediaId: 'film', event: 'start', paused: false, position: 0 }]);

  assert.equal(JSON.parse(transport.calls[0].body).ItemId, 'film');
});

test('a refused report is an error, not a silent success', async () => {
  const engine = engineFor(withKey, scripted(() => ({ status: 500, headers: {}, bodyBase64: '' })));

  await assert.rejects(
    () => engine.call('reportPlayback', [{ mediaId: 'f', event: 'stop', paused: false, position: 1 }]),
    (error) => error.code === Code.UNAVAILABLE,
  );
});

test('setPlayed marks with POST and unmarks with DELETE on the option when there is one', async () => {
  const transport = scripted(() => json({}));
  const engine = engineFor(withKey, transport);

  await engine.call('setPlayed', [{ mediaId: 'show', optionId: 'ep1', played: true }]);
  await engine.call('setPlayed', [{ mediaId: 'film', played: false }]);

  assert.deepEqual(transport.calls.map((c) => [c.method, c.url.replace(SERVER, '')]), [
    ['POST', '/Users/u1/PlayedItems/ep1'],
    ['DELETE', '/Users/u1/PlayedItems/film'],
  ]);
});

test('continue watching lists an episode as its series with the episode to resume', async () => {
  const transport = scripted(() => json({ Items: [
    {
      Id: 'ep3', Name: 'Third', Type: 'Episode', SeriesId: 's9', SeriesName: 'Show', SeriesPrimaryImageTag: 'tag',
      UserData: { PlaybackPositionTicks: 600000000, Played: false, LastPlayedDate: '2026-10-17T21:05:09.0000000Z' },
    },
    { Id: 'm1', Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 30000000, Played: false } },
  ] }));

  const result = await engineFor(withKey, transport).call('getContinueWatching', []);

  assert.ok(transport.calls[0].url.includes('/Users/u1/Items/Resume?'), transport.calls[0].url);
  assert.ok(transport.calls[0].url.includes('EnableUserData=true'), 'the resume list carries user data');
  assert.deepEqual(result.items.map((i) => [i.id, i.title, i.optionId, i.position]), [
    ['s9', 'Show', 'ep3', 60],
    ['m1', 'Film', undefined, 3],
  ]);
  assert.ok(result.items[0].posterUrl.includes('/Items/s9/Images/Primary'));
  assert.equal(validateResult('getContinueWatching', result).valid, true);
});
