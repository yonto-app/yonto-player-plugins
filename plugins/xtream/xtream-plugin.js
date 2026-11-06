/* yonto-plugin
{
  "kind": "content-source",
  "id": "xtream",
  "name": "Xtream Codes",
  "version": "1.0.0",
  "contractVersion": 21,
  "description": "Plays the live channels, films and series of an Xtream Codes panel, grouped the way the panel groups them. You supply the server and your login; Yonto Player includes no subscription.",
  "probeQuery": "news",
  "provides": "source-type",
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "server",
      "label": "Server URL",
      "type": "url",
      "required": true,
      "placeholder": "http://example.com:8080"
    },
    {
      "id": "username",
      "label": "Username",
      "type": "text",
      "required": true
    },
    {
      "id": "password",
      "label": "Password",
      "type": "secret",
      "required": true
    }
  ],
  "capabilities": []
}
*/
// An Xtream Codes panel, through its `player_api.php`. `plugins/xtream/AGENTS.md` has the API.
//
// **It reaches the panel's host and nothing else.** The server is a `url` field, so the host
// widens the allowlist to exactly that host. The streams it hands out are the player's to open.
//
// The login rides in every query and stream address, as the API has it, so no address is ever
// logged: only a request's code or status.

const PAGE_SIZE = 60;
const SEARCH_LIMIT = 100;
/** A listing is re-read at most this often: a listing, a title and a search are three calls. */
const CACHE_SECONDS = 300;
/** How long search keeps a library's titles before reading them again: a panel adds titles daily, not hourly. */
const INDEX_SECONDS = 12 * 60 * 60;
/**
 * How long one search goes on starting requests; the next search carries on from there. Well
 * inside the 20 s after which the host refuses any request a call starts, since the last one
 * started may still take a while to answer.
 */
const INDEX_READ_MS = 12000;
/** How many searches a category that keeps failing is asked in before it is given up on. */
const CATEGORY_TRIES = 3;

/** The three libraries a panel has, each its own categories and its own stream path. */
const KINDS = {
  live: { name: 'Live TV', categories: 'get_live_categories', streams: 'get_live_streams', idKey: 'stream_id' },
  movie: { name: 'Films', categories: 'get_vod_categories', streams: 'get_vod_streams', idKey: 'stream_id' },
  series: { name: 'Series', categories: 'get_series_categories', streams: 'get_series', idKey: 'series_id' },
};
const CATEGORY_FILTER = 'category';
const CATEGORY_FILTER_NAME = 'Category';

const MISCONFIGURED_MESSAGE = 'The server URL must start with http:// or https://.';
const UNUSABLE_ADDRESS_MESSAGE = "The server URL can't be used. Check it.";
const SERVER_DOWN_MESSAGE = "Can't reach this panel right now. Try again later.";
const REFUSED_LOGIN_MESSAGE = "The panel didn't accept this username and password.";
const NO_PANEL_MESSAGE = "There's no Xtream Codes panel at this address, or it didn't accept this username and password.";
const EXPIRED_MESSAGE = 'This subscription has expired. Renew it with your provider.';
const INACTIVE_MESSAGE = "The panel says this account isn't active. Check with your provider.";
const OFF_LIMITS_MESSAGE = "This panel points at an address Yonto Player won't connect to. Check the server URL.";
const REDIRECTS_REFUSED_MESSAGE = "This panel's redirects lead nowhere. Check the server URL.";
const UNREADABLE_MESSAGE = "This address answered with something that isn't an Xtream Codes panel. Check the server URL.";
const TOO_LARGE_MESSAGE = 'This category is too large to read.';
const PARTIAL_SEARCH_MESSAGE = "Not every category has been searched yet. Search again to search the rest.";
const UNSEARCHABLE_MESSAGE = "Some of this panel's categories couldn't be searched.";

const HTTP_URL = /^https?:\/\/\S+$/;
// What a provider's own links end in, which a viewer may paste whole as the server.
const API_FILE = /\/(?:player_api|get)\.php(?:[?#].*)?$/i;
const EPISODE_PREFIX = /^S\d+\s*E\d+\s*-\s*/i;
const YEAR = /^\d{4}$/;
const YEAR_IN_DATE = /^(\d{4})-\d{2}-\d{2}/;

// The host reads a stream with no `mimeType` as HLS, so every stream says what it is. A file or a
// TS channel is left to the player's own sniffing as a progressive one, as the m3u plugin does.
const HLS_MIME = 'application/x-mpegURL';
const PROGRESSIVE_MIME = 'video/mp4';

// ---------------------------------------------------------------------------- requests

/** Read on each use, because a module that reaches for `yonto` while being evaluated can only be imported after the host exists. */
function panel() {
  const server = (yonto.config.server || '').replace(API_FILE, '').replace(/\/+$/, '');
  if (!HTTP_URL.test(server)) throw yonto.error.misconfigured(MISCONFIGURED_MESSAGE);
  return { server, username: yonto.config.username || '', password: yonto.config.password || '' };
}

function apiUrl({ server, username, password }, params) {
  const query = { username, password, ...params };
  const pairs = Object.keys(query).map((key) => `${key}=${encodeURIComponent(query[key])}`);
  return `${server}/player_api.php?${pairs.join('&')}`;
}

/**
 * One API call's JSON. [what] names it in the log, never the address, which carries the login.
 * [tooLarge] is answered for a body over the host's limit, by a caller that has another way to read it.
 */
async function api(site, params, what, { tooLarge = undefined } = {}) {
  let response;
  try {
    response = await yonto.fetch(apiUrl(site, params));
  } catch (error) {
    yonto.log('warn', `${what} failed: ${error?.code ?? 'no code'}`);
    if (error?.code === 'RESPONSE_TOO_LARGE' && tooLarge !== undefined) return tooLarge;
    switch (error?.code) {
      case 'REQUEST_FAILED': throw yonto.error.unreachable(SERVER_DOWN_MESSAGE);
      case 'HOST_NOT_ALLOWED': throw yonto.error.unavailable(OFF_LIMITS_MESSAGE);
      case 'REDIRECT_REFUSED': throw yonto.error.unavailable(REDIRECTS_REFUSED_MESSAGE);
      case 'REQUEST_INVALID': throw yonto.error.misconfigured(UNUSABLE_ADDRESS_MESSAGE);
      case 'RESPONSE_TOO_LARGE': throw yonto.error.unavailable(TOO_LARGE_MESSAGE);
      // Its code alone: a host's message can name the address, and so the password.
      default: throw Object.assign(new Error(`${what} failed: ${error?.code ?? 'no code'}`), { code: error?.code });
    }
  }
  yonto.log('info', `${what} answered HTTP ${response.status}`);
  // A panel answers a refused login with 401 or 403, or (XUI) with a 404 for the whole API.
  if (response.status === 401 || response.status === 403) {
    throw yonto.error.unauthenticated(REFUSED_LOGIN_MESSAGE, { signIn: false });
  }
  if (response.status === 404) throw yonto.error.unavailable(NO_PANEL_MESSAGE);
  if (response.status < 200 || response.status >= 300) throw yonto.error.unreachable(SERVER_DOWN_MESSAGE);
  try {
    return JSON.parse(response.body);
  } catch {
    yonto.log('warn', `${what} answered something that is not JSON`);
    throw yonto.error.unavailable(UNREADABLE_MESSAGE);
  }
}

// ---------------------------------------------------------------------------- the cache

// Module state, so it lives as long as the runtime does; keyed by the panel and login, so a
// source edited to another account never reads the old one's.
let cache = { key: '', entries: new Map() };

function cached(site, name, read) {
  const key = `${site.server}\n${site.username}\n${site.password}`;
  if (cache.key !== key) cache = { key, entries: new Map() };
  const now = yonto.now();
  const hit = cache.entries.get(name);
  if (hit !== undefined && now - hit.at < CACHE_SECONDS * 1000) return hit.value;
  // The promise is kept, so the calls a search fans out share one request per listing; a
  // failed one is dropped, so the next call asks again.
  const value = read().catch((error) => {
    cache.entries.delete(name);
    throw error;
  });
  cache.entries.set(name, { at: now, value });
  return value;
}

/** The account, which says whether the login works and which stream formats it may use. */
function account(site) {
  return cached(site, 'account', async () => {
    const answer = await api(site, {}, 'the account');
    const user = answer?.user_info;
    if (user === null || typeof user !== 'object') throw yonto.error.unavailable(UNREADABLE_MESSAGE);
    if (String(user.auth) !== '1') throw yonto.error.unauthenticated(REFUSED_LOGIN_MESSAGE, { signIn: false });
    const status = String(user.status ?? 'Active');
    if (status === 'Expired') throw yonto.error.unavailable(EXPIRED_MESSAGE);
    if (status !== 'Active') throw yonto.error.unavailable(INACTIVE_MESSAGE);
    const formats = Array.isArray(user.allowed_output_formats) ? user.allowed_output_formats.map(String) : [];
    // TS is what the panel's own playlist hands out; HLS only for an account that may not have TS.
    return { liveFormat: formats.length === 0 || formats.includes('ts') ? 'ts' : 'm3u8' };
  });
}

function categoriesOf(site, kind) {
  return cached(site, `categories:${kind}`, async () => {
    const answer = await api(site, { action: KINDS[kind].categories }, `the ${kind} categories`);
    return (Array.isArray(answer) ? answer : [])
      .filter((category) => category && category.category_id !== undefined && category.category_name)
      .map((category) => ({ id: String(category.category_id), name: String(category.category_name).trim() }));
  });
}

/**
 * One category's titles, as summaries with what the stream needs: one category at a time, since
 * a panel's whole film list can be larger than a plugin may read.
 */
function listingOf(site, kind, categoryId) {
  return cached(site, `listing:${kind}:${categoryId}`, async () => {
    const answer = await api(site, { action: KINDS[kind].streams, category_id: categoryId }, `a ${kind} listing`);
    const items = (Array.isArray(answer) ? answer : []).map((item) => itemOf(kind, item)).filter((item) => item !== null);
    return newestFirst(kind, items);
  });
}

function itemOf(kind, raw) {
  const id = raw?.[KINDS[kind].idKey];
  const title = String(raw?.title || raw?.name || '').trim();
  if (id === undefined || id === null || title === '') return null;
  const item = { id: `${kind}:${id}`, streamId: String(id), title, order: Number(raw.num) || 0 };
  const poster = raw.stream_icon || raw.cover;
  if (typeof poster === 'string' && HTTP_URL.test(poster)) item.poster = poster;
  const year = yearOf(raw.year, raw.releaseDate ?? raw.release_date);
  if (year !== undefined) item.year = year;
  if (raw.container_extension) item.extension = String(raw.container_extension);
  item.added = Number(kind === 'series' ? raw.last_modified : raw.added) || 0;
  return item;
}

// A channel list is in the panel's own order; films and series are the latest first, as a shelf is.
function newestFirst(kind, items) {
  const sorted = [...items];
  if (kind === 'live') sorted.sort((a, b) => a.order - b.order);
  else sorted.sort((a, b) => b.added - a.added);
  return sorted;
}

function yearOf(year, date) {
  const stated = String(year ?? '').trim();
  if (YEAR.test(stated)) return stated;
  return String(date ?? '').match(YEAR_IN_DATE)?.[1];
}

// ---------------------------------------------------------------------------- titles

function kindOf(categoryId) {
  const kind = String(categoryId ?? '');
  if (!isKind(kind)) throw yonto.error.notFound(kind);
  return kind;
}

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

function parseId(mediaId) {
  const id = String(mediaId ?? '');
  const colon = id.indexOf(':');
  const kind = id.slice(0, colon);
  const streamId = id.slice(colon + 1);
  if (colon < 0 || !isKind(kind) || streamId === '') throw yonto.error.notFound(id);
  return { kind, streamId };
}

function summaryOf(item, kind) {
  const summary = { id: item.id, title: item.title, type: kind === 'series' ? 'SERIES' : 'MOVIE' };
  if (item.poster !== undefined) summary.posterUrl = item.poster;
  if (item.year !== undefined) summary.year = item.year;
  return summary;
}

function streamUrl({ server, username, password }, path, file) {
  return [server, path, encodeURIComponent(username), encodeURIComponent(password), file].join('/');
}

function fileStream(site, path, id, extension) {
  const file = extension ? `${encodeURIComponent(id)}.${encodeURIComponent(extension)}` : encodeURIComponent(id);
  return { url: streamUrl(site, path, file), mimeType: PROGRESSIVE_MIME };
}

/** A channel is found in a listing already read, or else in the panel's whole channel list, which is small. */
async function channelDetail(site, streamId) {
  const { liveFormat } = await account(site);
  const id = `live:${streamId}`;
  let channel = await findInListings(site, 'live', id);
  if (channel === undefined) {
    const all = await cached(site, 'listing:live:*', async () => {
      const answer = await api(site, { action: KINDS.live.streams }, 'the channel list');
      return (Array.isArray(answer) ? answer : []).map((item) => itemOf('live', item)).filter((item) => item !== null);
    });
    channel = all.find((item) => item.id === id);
  }
  if (channel === undefined) throw yonto.error.notFound(id);
  const stream = {
    url: streamUrl(site, 'live', `${encodeURIComponent(streamId)}.${liveFormat}`),
    mimeType: liveFormat === 'm3u8' ? HLS_MIME : PROGRESSIVE_MIME,
    live: true,
  };
  return { ...summaryOf(channel, 'live'), genres: [], playbackOptions: [{ label: channel.title, stream }] };
}

async function findInListings(site, kind, id) {
  for (const [name, entry] of cache.entries) {
    if (!name.startsWith(`listing:${kind}:`)) continue;
    const found = (await entry.value.catch(() => [])).find((item) => item.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function filmDetail(site, streamId) {
  const answer = await api(site, { action: 'get_vod_info', vod_id: streamId }, 'a film');
  const info = objectOr(answer?.info);
  const data = objectOr(answer?.movie_data);
  const title = String(data.title || info.name || data.name || '').trim();
  if (title === '') throw yonto.error.notFound(`movie:${streamId}`);
  return {
    id: `movie:${streamId}`,
    title,
    type: 'MOVIE',
    ...artworkOf(info.cover_big || info.movie_image, info.backdrop_path),
    ...optional('year', yearOf(data.year, info.releasedate ?? info.release_date)),
    genres: genresOf(info.genre),
    synopsis: String(info.plot || info.description || '').trim(),
    playbackOptions: [{ label: title, stream: fileStream(site, 'movie', streamId, data.container_extension) }],
  };
}

async function seriesDetail(site, seriesId) {
  const answer = await api(site, { action: 'get_series_info', series_id: seriesId }, 'a series');
  const info = objectOr(answer?.info);
  const title = String(info.title || info.name || '').trim();
  if (title === '') throw yonto.error.notFound(`series:${seriesId}`);
  return {
    id: `series:${seriesId}`,
    title,
    type: 'SERIES',
    ...artworkOf(info.cover, info.backdrop_path),
    ...optional('year', yearOf(info.year, info.releaseDate ?? info.release_date)),
    genres: genresOf(info.genre),
    synopsis: String(info.plot || '').trim(),
    playbackOptions: episodesOf(site, answer?.episodes, title),
  };
}

/** Every season's episodes in order. The panel keys them by season, as an object or an array. */
function episodesOf(site, episodes, seriesTitle) {
  const all = Object.values(objectOr(episodes)).flatMap((season) => (Array.isArray(season) ? season : []));
  return all
    .filter((episode) => episode && episode.id !== undefined && episode.id !== null)
    .map((episode) => ({
      season: Math.trunc(Number(episode.season ?? episode.info?.season)) || 1,
      episode: Math.trunc(Number(episode.episode_num)),
      raw: episode,
    }))
    .sort((a, b) => a.season - b.season || (a.episode || 0) - (b.episode || 0))
    .map(({ season, episode, raw }) => {
      const number = Number.isInteger(episode) && episode >= 0 ? episode : undefined;
      const name = episodeName(String(raw.title ?? ''), seriesTitle);
      const code = `S${season}E${String(number ?? 0).padStart(2, '0')}`;
      return {
        label: name === '' ? code : `${code} · ${name}`,
        season,
        ...optional('episode', number),
        stream: fileStream(site, 'series', String(raw.id), raw.container_extension),
      };
    });
}

/** `Show - S01E01 - Pilot` is `Pilot`: the label already says the show's season and number. */
function episodeName(title, seriesTitle) {
  let name = title.trim();
  if (seriesTitle !== '' && name.toLowerCase().startsWith(`${seriesTitle.toLowerCase()} - `)) {
    name = name.slice(seriesTitle.length + 3);
  }
  return name.replace(EPISODE_PREFIX, '').trim();
}

function artworkOf(poster, backdrops) {
  const artwork = {};
  if (typeof poster === 'string' && HTTP_URL.test(poster)) artwork.posterUrl = poster;
  const backdrop = (Array.isArray(backdrops) ? backdrops : [backdrops]).find((url) => typeof url === 'string' && HTTP_URL.test(url));
  if (backdrop !== undefined) artwork.backdropUrl = backdrop;
  return artwork;
}

function genresOf(genre) {
  return String(genre ?? '').split(/\s*[,/]\s*/).map((name) => name.trim()).filter((name) => name !== '');
}

function objectOr(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

function optional(key, value) {
  return value === undefined ? {} : { [key]: value };
}

// ---------------------------------------------------------------------------- the search index

// A library's titles as `[id, title, poster, year]`, kept in memory for this runtime, so only the
// first search in a while asks the panel. Read from the library's whole list, one request; a list
// over the host's limit (a big panel's films) is read one category at a time instead, never two
// requests at once, which a panel takes for a flood. Not in `yonto.store`, which is one file for
// every source and far too small a place for a panel's library.
const indexes = new Map();

async function searchIndex(site, kind, deadline) {
  const owner = `${site.server}\n${site.username}`;
  const now = yonto.now();
  let index = indexes.get(kind);
  if (index?.owner !== owner || now - index.at >= INDEX_SECONDS * 1000) index = null;
  if (index?.complete) return index;
  if (index === null && now >= deadline) return { complete: false, items: [] };
  if (index === null) {
    const all = await api(site, { action: KINDS[kind].streams }, `the whole ${kind} list`, { tooLarge: null });
    // Some panels answer the whole list with nothing at all, and only a category with its titles.
    index = Array.isArray(all) && all.length > 0
      ? { owner, at: now, complete: true, read: new Set(), failures: new Map(), tooLarge: 0, items: compact(kind, all) }
      : { owner, at: now, complete: false, read: new Set(), failures: new Map(), tooLarge: 0, items: [] };
  }
  if (!index.complete) await readByCategory(site, kind, index, deadline);
  indexes.set(kind, index);
  return index;
}

/**
 * The categories not read yet until [deadline]; the rest wait for the next search. One that failed
 * goes behind every one not tried yet, so a category that times out cannot hold up the others, and
 * after [CATEGORY_TRIES] failures it is given up on like one over the limit, which is passed over
 * at once.
 */
async function readByCategory(site, kind, index, deadline) {
  if (yonto.now() >= deadline) return;
  const ids = new Set(index.items.map(([id]) => id));
  const waiting = (await categoriesOf(site, kind))
    .filter((category) => !index.read.has(category.id))
    .sort((a, b) => (index.failures.get(a.id) ?? 0) - (index.failures.get(b.id) ?? 0));
  for (const category of waiting) {
    if (yonto.now() >= deadline) return;
    let answer;
    try {
      answer = await api(site, { action: KINDS[kind].streams, category_id: category.id }, `a ${kind} listing`, { tooLarge: null });
    } catch {
      const failures = (index.failures.get(category.id) ?? 0) + 1;
      index.failures.set(category.id, failures);
      if (failures < CATEGORY_TRIES) continue;
      answer = null;
    }
    if (answer === null) index.tooLarge += 1;
    for (const item of compact(kind, Array.isArray(answer) ? answer : [])) {
      if (!ids.has(item[0])) index.items.push(item);
      ids.add(item[0]);
    }
    index.read.add(category.id);
  }
  index.complete = waiting.every((category) => index.read.has(category.id));
}

/** A title the panel lists in two categories is one result. */
function compact(kind, raw) {
  const seen = new Set();
  return raw.map((item) => itemOf(kind, item))
    .filter((item) => item !== null && !seen.has(item.id) && seen.add(item.id))
    .map((item) => [item.id, item.title, item.poster ?? '', item.year ?? '']);
}

// ---------------------------------------------------------------------------- the contract

export default {
  /** Live TV, Films and Series, each only where the panel has a category of it. */
  async getCategories() {
    const site = panel();
    await account(site);
    const libraries = [];
    for (const kind of Object.keys(KINDS)) {
      if ((await categoriesOf(site, kind)).length > 0) libraries.push({ id: kind, name: KINDS[kind].name });
    }
    return libraries;
  },

  /** The panel's own categories of that library. There is no "all": a panel's whole film list can be too large to read. */
  async getFilters(categoryId) {
    const site = panel();
    const categories = await categoriesOf(site, kindOf(categoryId));
    if (categories.length === 0) return [];
    return [{ id: CATEGORY_FILTER, name: CATEGORY_FILTER_NAME, init: categories[0].id, options: categories }];
  },

  /** One page of a category; Home's shelf, which names none, is the panel's first. */
  async getMediaList(categoryId, options) {
    const site = panel();
    const kind = kindOf(categoryId);
    await account(site);
    const chosen = String(options?.filters?.[CATEGORY_FILTER] ?? '') || (await categoriesOf(site, kind))[0]?.id;
    if (chosen === undefined) return [];
    const page = Math.max(1, Math.trunc(options?.page ?? 1));
    const listing = await listingOf(site, kind, chosen);
    return listing.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((item) => summaryOf(item, kind));
  },

  async getMediaDetail(mediaId) {
    const site = panel();
    const { kind, streamId } = parseId(mediaId);
    await account(site);
    if (kind === 'live') return channelDetail(site, streamId);
    if (kind === 'movie') return filmDetail(site, streamId);
    return seriesDetail(site, streamId);
  },

  /**
   * A title containing the words, case-insensitively, across the panel, which has no search of
   * its own: read from each library's index, so a search after the first asks the panel nothing.
   */
  async search(query) {
    const site = panel();
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle === '') return [];
    await account(site);
    const deadline = yonto.now() + INDEX_READ_MS;
    const found = [];
    let complete = true;
    let tooLarge = false;
    let failure = null;
    let answered = 0;
    for (const kind of Object.keys(KINDS)) {
      let index;
      try {
        index = await searchIndex(site, kind, deadline);
      } catch (error) {
        // One library the panel cannot answer leaves the others searched; it is asked again next time.
        failure = failure ?? error;
        complete = false;
        continue;
      }
      answered += 1;
      complete = complete && index.complete;
      tooLarge = tooLarge || index.tooLarge > 0;
      for (const [id, title, poster, year] of index.items) {
        if (!title.toLowerCase().includes(needle)) continue;
        found.push(summaryOf({ id, title, poster: poster || undefined, year: year || undefined }, kind));
        if (found.length === SEARCH_LIMIT) return found;
      }
    }
    // A panel that answered no library at all is down, which is not the same as finding nothing.
    if (failure !== null && answered === 0) throw failure;
    if (!complete) yonto.partial(PARTIAL_SEARCH_MESSAGE);
    else if (tooLarge) yonto.partial(UNSEARCHABLE_MESSAGE);
    return found;
  },
};
