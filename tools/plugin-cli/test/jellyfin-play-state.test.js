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
  const transport = scripted(() => json({ Items: [] }));
  const engine = engineFor(withKey, transport);
  await engine.call('getMediaList', ['lib', { page: 1, filters: {} }]);
  await engine.call('search', ['x']);
  await engine.call('getRecommendations', []);

  assert.equal(transport.calls.length, 3);
  assert.ok(transport.calls.every((call) => call.url.includes('EnableUserData=true')), 'user data is asked for');
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
