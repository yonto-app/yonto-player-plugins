#!/usr/bin/env node
// Writes plugins/jellyfin/fixtures/ from the payloads below.
//
// Every other plugin's fixtures are recorded off the live site with `--record`. This one
// cannot be: a Jellyfin server is somebody's own machine and there is none in this
// repository. The payloads are the ones JsJellyfinPluginAdapterTest asserts against,
// which were themselves taken from a live 12.x server.
//
// It drives the real plugin through the real engine with a recording transport, so the
// fixture names come from the URLs the plugin actually builds. Writing the files by hand
// would mean hashing those URLs by hand, and fixture identity is
// sha256(url + "\n" + body) — one wrong query parameter and the replay transport reports
// a miss.
//
// NOT under test/: node --test's default patterns include **/test/**/*.js, so a helper
// living there is executed as a test.
//
//   node tools/plugin-cli/scripts/write-jellyfin-fixtures.js

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createRecordTransport } from '../src/transport/record.js';
import { createEngine } from '../src/engines/quickjs.js';

const dir = fileURLToPath(new URL('../../../plugins/jellyfin/', import.meta.url));

// The plugin's own doctor.json, not a copy of it: these values are what every recorded
// fixture's URL was built from, so the day they are edited here and the fixtures
// regenerated, `doctor --replay` on this plugin has to follow. Two statements of one host
// would let it go NO_FIXTURE with the suite still green.
export const CONFIG = (() => {
  const file = join(dir, 'doctor.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    // A sentence rather than an ENOENT out of an import: the whole test suite reads this
    // through `test/jellyfin.test.js`, so a missing file fails everything at once.
    throw new Error(`${file} is what jellyfin's fixtures were recorded against: ${cause.message}`);
  }
})();

export const MOVIE_ID = 'edb39341c5039551a5157e51fe4a3364';
export const SERIES_ID = 's1';

// A subtitle stream as Jellyfin 12.2 lists one (fields this plugin does not read left out).
function subtitle(Index, Codec, Language, LocalizedLanguage, flags = {}) {
  return {
    Codec, Language, LocalizedLanguage, DisplayTitle: `${LocalizedLanguage} - ${Codec.toUpperCase()} - External`,
    IsDefault: false, IsForced: false, IsHearingImpaired: false, Type: 'Subtitle', Index,
    IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, ...flags,
  };
}

// The film's: two text files beside it (one SAMI, which the server converts), a picture
// format and a track inside the video, so a fixture holds each case the plugin decides.
const MOVIE_STREAMS = [
  subtitle(0, 'subrip', 'eng', 'English', { IsDefault: true }),
  subtitle(1, 'sami', 'kor', 'Korean'),
  subtitle(2, 'PGSSUB', 'fre', 'French', { IsTextSubtitleStream: false, SupportsExternalStream: false }),
  { ...subtitle(3, 'mov_text', 'ger', 'German'), IsExternal: false, DisplayTitle: 'German - MOV_TEXT' },
  // A 2.39:1 4K Dolby Vision copy with an HDR10 layer, so its size reads by width and its range as Dolby Vision.
  { Codec: 'hevc', Type: 'Video', Index: 4, IsExternal: false, IsTextSubtitleStream: false, Width: 3840, Height: 1606, VideoRangeType: 'DOVIWithHDR10' },
];

const MOVIE = {
  Id: MOVIE_ID,
  Name: 'The Boy in the Plastic Bubble',
  Type: 'Movie',
  Container: 'mov,mp4',
  OfficialRating: 'PG',
  Overview: 'Tod Lubitch is born with a deficient immune system.',
  Genres: ['TV Movie', 'Drama'],
  CommunityRating: 5.7,
  ProductionYear: 1976,
  // Hand-added: the live server's library had no matches, so its ProviderIds came back empty.
  ProviderIds: { Tmdb: '9003', Imdb: 'tt9000003' },
  IsFolder: false,
  ImageTags: { Primary: 'a131fdbdca9ddadcda7d3c86756c6b67' },
  BackdropImageTags: ['408be2dfc34f1ce61108cf049a5aa82e'],
  UserData: { PlayCount: 12, Played: true, LastPlayedDate: '2026-10-01T20:30:00.0000000Z' },
};

const SERIES = {
  Id: SERIES_ID,
  Name: 'Pioneer One',
  Type: 'Series',
  Overview: 'A Soviet-era capsule falls over Montana.',
  Genres: ['Drama', 'Science Fiction'],
  ProductionYear: 2010,
  ImageTags: { Primary: 'pioneerPrimaryTag' },
  BackdropImageTags: ['pioneerBackdropTag'],
};

// Neither episode carries artwork of its own, which is the common case and what makes the
// parent-backdrop fallback worth having a fixture for.
const EPISODES = [
  {
    Id: 'ep1', Name: 'Earthfall', Type: 'Episode', IndexNumber: 1, ParentIndexNumber: 1, Width: 1920, Height: 1080,
    // Half way in, the way a server reports a stop: ticks are 100 ns, 750 s here.
    UserData: { PlaybackPositionTicks: 7500000000, PlayCount: 1, Played: false, LastPlayedDate: '2026-10-17T21:05:09.1234567Z' },
    SeriesId: SERIES_ID, SeriesName: 'Pioneer One',
    ParentBackdropItemId: SERIES_ID, ParentBackdropImageTags: ['pioneerBackdropTag'],
  },
  {
    Id: 'ep2', Name: 'Caches', Type: 'Episode', IndexNumber: 2, ParentIndexNumber: 1, Width: 3840, Height: 2160,
    SeriesId: SERIES_ID, SeriesName: 'Pioneer One',
    ParentBackdropItemId: SERIES_ID, ParentBackdropImageTags: ['pioneerBackdropTag'],
  },
];

const VIEWS = {
  Items: [
    { Id: 'lib-movies', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies', ImageTags: { Primary: 'moviesPrimaryTag' } },
    { Id: 'lib-shows', Name: 'Shows', Type: 'CollectionFolder', CollectionType: 'tvshows' },
    { Id: 'lib-music', Name: 'Music', Type: 'CollectionFolder', CollectionType: 'music' },
  ],
  TotalRecordCount: 3,
  StartIndex: 0,
};

const FILTERS = { Genres: ['Drama', 'Action'], Tags: [], OfficialRatings: ['PG-13'], Years: [2008, 2014, 2010] };

const LISTING = { Items: [MOVIE, SERIES], TotalRecordCount: 2, StartIndex: 0 };

// A library whose items include a loose episode, which is how the parent-backdrop
// fallback becomes visible at all: an episode reached through a series' detail is only
// ever a playback option, and a playback option carries no artwork.
const SHOWS_LISTING = { Items: [SERIES, EPISODES[0]], TotalRecordCount: 2, StartIndex: 0 };

const SEARCH = { Items: [MOVIE], TotalRecordCount: 1, StartIndex: 0 };

// The middle title is unrated, so a "best rated" shelf has something to drop.
const RECOMMENDED = {
  Items: [
    MOVIE,
    { Id: 'unrated', Name: 'Nobody Rated This', Type: 'Movie' },
    { Id: 'm2', Name: 'Big Buck Bunny', Type: 'Movie', CommunityRating: 7.9, ProductionYear: 2008 },
  ],
  TotalRecordCount: 3,
  StartIndex: 0,
};

// What the server would resume: the half-watched episode, which stands for its series.
const RESUME = {
  Items: [{ ...EPISODES[0], SeriesPrimaryImageTag: 'pioneerPrimaryTag' }],
  TotalRecordCount: 1,
  StartIndex: 0,
};

// Only an item's own answer carries its streams: the film's detail, and an episode's when it is played.
const DETAILS = {
  [MOVIE_ID]: { ...MOVIE, MediaStreams: MOVIE_STREAMS },
  [SERIES_ID]: SERIES,
  ep1: { ...EPISODES[0], MediaStreams: [subtitle(0, 'ass', 'chi', 'Chinese', { IsForced: true })] },
  ep2: { ...EPISODES[1], MediaStreams: [] },
  ep3: { ...EPISODES[1], Id: 'ep3', MediaStreams: [] },
};

// Media Segments (10.10): ticks of 100 ns. The second episode's answer is a 404, which is what a
// server before 10.10 says for every item.
const TICKS = 10000000;
const SEGMENTS = {
  [MOVIE_ID]: [
    { Id: 'sg1', ItemId: MOVIE_ID, Type: 'Intro', StartTicks: 5 * TICKS, EndTicks: 20 * TICKS },
    { Id: 'sg2', ItemId: MOVIE_ID, Type: 'Outro', StartTicks: 580 * TICKS, EndTicks: 596 * TICKS },
    { Id: 'sg3', ItemId: MOVIE_ID, Type: 'Unknown', StartTicks: 30 * TICKS, EndTicks: 40 * TICKS },
  ],
  // A recap, an intro that ends where it starts (dropped), and an outro with no end (kept, to the end).
  ep1: [
    { Id: 'sg4', ItemId: 'ep1', Type: 'Recap', StartTicks: 0, EndTicks: 12.5 * TICKS },
    { Id: 'sg5', ItemId: 'ep1', Type: 'Intro', StartTicks: 15 * TICKS, EndTicks: 15 * TICKS },
    { Id: 'sg6', ItemId: 'ep1', Type: 'Outro', StartTicks: 500 * TICKS },
  ],
  // More than the contract's 32.
  ep3: Array.from({ length: 40 }, (_, i) => ({ Id: `sc${i}`, ItemId: 'ep3', Type: 'Commercial', StartTicks: i * TICKS, EndTicks: (i + 0.5) * TICKS })),
};

// What a television on a 1080p SDR screen plays: the device the PlaybackInfo fixtures were
// recorded for, which the tests hand getStream as it is.
export const DEVICE = {
  video: [
    { codec: 'h264', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 8 },
    { codec: 'hevc', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 8 },
  ],
  audio: ['aac', 'mp3', 'ac3', 'eac3', 'dts'],
  maxAudioChannels: 8,
  containers: ['mp4', 'mkv', 'webm', 'ts', 'hls'],
  hdr: [],
  subtitles: ['srt', 'vtt', 'ass'],
};

// The server's decisions: the film is converted, with the key the server writes into its
// address (the plugin takes it out); the first episode plays as stored; the second episode's
// answer is a 500, which plays the file as stored too.
export const PLAY_SESSION = 'play-session-1';
const PLAYBACK_INFO = {
  [MOVIE_ID]: {
    PlaySessionId: PLAY_SESSION,
    MediaSources: [{
      Id: MOVIE_ID,
      SupportsDirectPlay: false,
      SupportsDirectStream: false,
      SupportsTranscoding: true,
      TranscodingUrl: `/videos/${MOVIE_ID}/master.m3u8?DeviceId=d&MediaSourceId=${MOVIE_ID}&VideoCodec=h264&ApiKey=server-written-key&PlaySessionId=${PLAY_SESSION}&TranscodeReasons=VideoRangeTypeNotSupported`,
    }],
  },
  ep1: { PlaySessionId: 'play-session-2', MediaSources: [{ Id: 'ep1', SupportsDirectPlay: true, SupportsTranscoding: true }] },
};

/** Answers the way a server would, picked by what the request is asking for. */
function bodyFor(url) {
  const { pathname, searchParams } = new URL(url);
  if (pathname.endsWith('/PlaybackInfo')) return PLAYBACK_INFO[pathname.split('/')[2]] ?? {};
  if (pathname.startsWith('/Sessions/Playing')) return {};
  if (pathname.includes('/MediaSegments/')) {
    const items = SEGMENTS[pathname.split('/MediaSegments/')[1]] ?? [];
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }
  if (pathname.endsWith('/Views')) return VIEWS;
  if (pathname.endsWith('/Items/Resume')) return RESUME;
  if (pathname.endsWith('/Items/Filters')) return FILTERS;
  if (searchParams.get('IncludeItemTypes') === 'Episode') return { Items: EPISODES, TotalRecordCount: 2, StartIndex: 0 };
  if (searchParams.has('searchTerm')) return SEARCH;
  if (searchParams.get('SortBy') === 'CommunityRating') return RECOMMENDED;

  const itemId = pathname.split('/Items/')[1];
  if (itemId) return DETAILS[itemId] ?? { Id: itemId, Name: 'Unknown', Type: 'Movie' };
  return searchParams.get('ParentId') === 'lib-shows' ? SHOWS_LISTING : LISTING;
}

const server = {
  async request({ url }) {
    return {
      status: url.endsWith('/MediaSegments/ep2') ? 404 : url.includes('/Items/ep2/PlaybackInfo') ? 500 : 200,
      headers: { 'content-type': 'application/json' },
      setCookie: [],
      bodyBase64: Buffer.from(JSON.stringify(bodyFor(url))).toString('base64'),
    };
  },
};

async function main() {
  const manifest = loadManifest(dir);
  const storeDir = mkdtempSync(join(tmpdir(), 'yonto-jellyfin-fixtures-'));
  const host = createHost({
    pluginDir: dir,
    // No allowlist editing: the manifest's serverUrl is a `url` field, so the configured
    // host is contributed by the same rule both hosts apply.
    manifest,
    config: CONFIG,
    transport: createRecordTransport({ inner: server, dir: join(dir, 'fixtures') }),
    storeDir,
  });
  const engine = createEngine({ dir, host });

  // Every call `doctor` makes, in its order.
  await engine.call('getCategories', []);
  await engine.call('getFilters', ['lib-movies']);
  await engine.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);
  await engine.call('getMediaDetail', [MOVIE_ID]);
  await engine.call('search', [manifest.probeQuery]);
  await engine.call('getRecommendations', []);
  await engine.call('getContinueWatching', []);
  // Neither is on doctor's path: it stops at the first item of the first category, so it
  // never reaches an episode list or a second library.
  await engine.call('getMediaDetail', [SERIES_ID]);
  await engine.call('getMediaList', ['lib-shows', { page: 1, filters: {} }]);
  await engine.call('getStream', ['ep1']);
  await engine.call('getStream', ['ep2']);
  await engine.call('getStream', ['ep3']);
  await engine.call('getStream', [MOVIE_ID]);
  await engine.call('getStream', [MOVIE_ID, { device: DEVICE }]);
  await engine.call('getStream', ['ep1', { device: DEVICE }]);
  await engine.call('getStream', ['ep2', { device: DEVICE }]);
  const transcoded = await engine.call('getStream', [MOVIE_ID, { device: DEVICE }]);
  await engine.call('reportPlayback', [{ mediaId: MOVIE_ID, event: 'stop', paused: true, position: 30, session: transcoded.session }]);

  rmSync(storeDir, { recursive: true, force: true });
  console.log(`wrote fixtures to ${join(dir, 'fixtures')}`);
}

// Only when run, never when imported: the test imports this file for CONFIG and the ids,
// and a regeneration on import would rewrite the very fixtures it is checking against.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
