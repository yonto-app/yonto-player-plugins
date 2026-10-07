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
  IsFolder: false,
  ImageTags: { Primary: 'a131fdbdca9ddadcda7d3c86756c6b67' },
  BackdropImageTags: ['408be2dfc34f1ce61108cf049a5aa82e'],
  UserData: { PlayCount: 12, Played: true },
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
    Id: 'ep1', Name: 'Earthfall', Type: 'Episode', IndexNumber: 1, ParentIndexNumber: 1,
    SeriesId: SERIES_ID, SeriesName: 'Pioneer One',
    ParentBackdropItemId: SERIES_ID, ParentBackdropImageTags: ['pioneerBackdropTag'],
  },
  {
    Id: 'ep2', Name: 'Caches', Type: 'Episode', IndexNumber: 2, ParentIndexNumber: 1,
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

const DETAILS = { [MOVIE_ID]: MOVIE, [SERIES_ID]: SERIES };

/** Answers the way a server would, picked by what the request is asking for. */
function bodyFor(url) {
  const { pathname, searchParams } = new URL(url);
  if (pathname.endsWith('/Views')) return VIEWS;
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
      status: 200,
      headers: { 'content-type': 'application/json' },
      setCookie: [],
      bodyBase64: Buffer.from(JSON.stringify(bodyFor(url))).toString('base64'),
    };
  },
};

async function main() {
  const manifest = loadManifest(dir);
  const storeDir = mkdtempSync(join(tmpdir(), 'yonto-jellyfin-fixtures-'));
  const { yonto } = createHost({
    pluginDir: dir,
    // No allowlist editing: the manifest's serverUrl is a `url` field, so the configured
    // host is contributed by the same rule both hosts apply.
    manifest,
    config: CONFIG,
    transport: createRecordTransport({ inner: server, dir: join(dir, 'fixtures') }),
    storeDir,
  });
  const engine = createEngine({ dir, yonto });

  // Every call `doctor` makes, in its order.
  await engine.call('getCategories', []);
  await engine.call('getFilters', ['lib-movies']);
  await engine.call('getMediaList', ['lib-movies', { page: 1, filters: {} }]);
  await engine.call('getMediaDetail', [MOVIE_ID]);
  await engine.call('search', [manifest.probeQuery]);
  await engine.call('getRecommendations', []);
  // Neither is on doctor's path: it stops at the first item of the first category, so it
  // never reaches an episode list or a second library.
  await engine.call('getMediaDetail', [SERIES_ID]);
  await engine.call('getMediaList', ['lib-shows', { page: 1, filters: {} }]);

  rmSync(storeDir, { recursive: true, force: true });
  console.log(`wrote fixtures to ${join(dir, 'fixtures')}`);
}

// Only when run, never when imported: the test imports this file for CONFIG and the ids,
// and a regeneration on import would rewrite the very fixtures it is checking against.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
