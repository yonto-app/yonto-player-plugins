/* yonto-plugin
{
  "kind": "content-source",
  "id": "emby",
  "name": "Emby",
  "version": "1.0.5",
  "contractVersion": 21,
  "description": "An Emby media server, reached with an ordinary login or with a server-generated API key. Not affiliated with Emby.",
  "probeQuery": "pattern",
  "provides": "source-type",
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "serverUrl",
      "label": "Server URL",
      "type": "url",
      "required": true
    },
    {
      "id": "username",
      "label": "Username",
      "type": "text"
    },
    {
      "id": "password",
      "label": "Password",
      "type": "secret"
    },
    {
      "id": "apiKey",
      "label": "API key (only if you have one)",
      "type": "secret"
    },
    {
      "id": "userId",
      "label": "User ID (only with an API key)",
      "type": "text"
    }
  ],
  "capabilities": []
}
*/
// An Emby media server (https://emby.media), through its own REST API. plugins/emby/AGENTS.md
// has what a real 4.10 server confirmed and how it differs from Jellyfin.

// Home only ever asks for page 1, so this caps what a shelf can show (see jellyfin's AGENTS.md).
const PAGE_SIZE = 500;
const RECOMMENDATION_COUNT = 10;

const LIBRARY_COLLECTION_TYPES = ['movies', 'tvshows'];
const ALL_ITEM_TYPES = 'Movie,Series';
const SERIES_TYPE = 'Series';

const TYPE_FILTER = 'type';
const GENRE_FILTER = 'genre';
const YEAR_FILTER = 'year';
const TYPE_OPTIONS = [
  { id: 'Movie', name: 'Movies' },
  { id: 'Series', name: 'Series' },
];

// A listing leaves these out unless they are named, CommunityRating included (unlike Jellyfin).
const LIST_ITEM_FIELDS = 'ProductionYear,OfficialRating';
const RANKED_ITEM_FIELDS = `${LIST_ITEM_FIELDS},CommunityRating`;
const DETAIL_ITEM_FIELDS = 'Genres,Overview,ProductionYear,OfficialRating';

const POSTER_MAX_WIDTH = 480;
const BACKDROP_MAX_WIDTH = 1920;
const IMAGE_QUALITY = 90;

// A hint for a progressive stream, not a claim about the container: the player sniffs the bytes.
const MIME_MP4 = 'video/mp4';

const SERVER_ERROR_MESSAGE = 'The server answered with an error.';
const SERVER_SILENT_MESSAGE = 'The server did not answer.';
const SERVER_UNREADABLE_MESSAGE = 'The server answered with a page that is not the media server: check the server URL.';
const SIGN_IN_FAILED_MESSAGE = 'Signing in failed: the server answered with an error.';
const NO_TOKEN_MESSAGE = 'Signing in failed: the server accepted the sign-in but sent back no session.';
const NO_CREDENTIALS_MESSAGE =
  'This source has no credentials: fill in a username and password, or an API key and user ID.';
const NO_USER_ID_MESSAGE =
  'This source has an API key but no user ID: fill that in, or use a username and password instead.';
const KEY_REFUSED_MESSAGE = 'Check the API key and user ID by editing the source in Settings.';
const LOGIN_REFUSED_MESSAGE = 'Check the username and password by editing the source in Settings.';
const ACCOUNT_REFUSED_MESSAGE = "Check this account's permissions on the server.";

const CLIENT = 'Yonto';
const DEVICE = 'Android TV';
const CLIENT_VERSION = '1.0';

const SESSION_KEY = 'session';
// The last credential the server refused for each of the latest servers and usernames, so a
// wrong password is sent once.
const REFUSED_KEY = 'refused';
const REFUSALS_KEPT = 10;

let loggingIn = null;

/** The typed address without its trailing slashes, and without an `/emby` a viewer pasted. */
function server() {
  return (yonto.config.serverUrl || '').replace(/\/+$/, '').replace(/\/emby$/i, '');
}

function apiKey() {
  return yonto.config.apiKey || '';
}

function username() {
  return yonto.config.username || '';
}

function deviceId() {
  return `lantern-${yonto.installId()}`;
}

function authHeaders(token) {
  return { 'X-Emby-Token': token };
}

function clientHeader() {
  return {
    'X-Emby-Authorization':
      `Emby Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId()}", Version="${CLIENT_VERSION}"`,
  };
}

async function session() {
  if (apiKey()) {
    if (!yonto.config.userId) {
      yonto.log('warn', 'an API key is saved with no user id beside it');
      throw yonto.error.misconfigured(NO_USER_ID_MESSAGE);
    }
    return { token: apiKey(), userId: yonto.config.userId };
  }

  const cached = await yonto.store.get(SESSION_KEY);
  if (cached && cached.server === server() && cached.username === username()) return cached;

  return logIn();
}

async function fingerprint() {
  const hashed = await yonto.crypto.sha256(yonto.config.password || '');
  return { server: server(), username: username(), password: hashed };
}

function sameAccount(a, b) {
  return a.server === b.server && a.username === b.username;
}

async function refusals() {
  const stored = await yonto.store.get(REFUSED_KEY);
  return Array.isArray(stored) ? stored : [];
}

/** One login however many calls want one: a fan-out of logins is a fan-out of failed attempts. */
function logIn() {
  if (!loggingIn) {
    loggingIn = attemptLogIn().then(
      (won) => { loggingIn = null; return won; },
      (error) => { loggingIn = null; throw error; }
    );
  }
  return loggingIn;
}

async function attemptLogIn() {
  if (!username()) {
    yonto.log('warn', 'no username, no password and no API key are saved for this source');
    throw yonto.error.misconfigured(NO_CREDENTIALS_MESSAGE);
  }

  const credential = await fingerprint();
  if ((await refusals()).some((r) => sameAccount(r, credential) && r.password === credential.password)) {
    yonto.log('warn', 'the same credential was refused before; not spending another attempt');
    throw yonto.error.unauthenticated(LOGIN_REFUSED_MESSAGE);
  }

  const response = await send(url(['Users', 'AuthenticateByName'], {}), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...clientHeader() },
    body: JSON.stringify({ Username: username(), Pw: yonto.config.password || '' }),
  });
  if (response.status === 401 || response.status === 403) {
    // One per server and username, so a right password refused for another reason (a lockout)
    // is let go by the next attempt on that account, as it was when there was one slot.
    const others = (await refusals()).filter((r) => !sameAccount(r, credential));
    await yonto.store.set(REFUSED_KEY, [...others, credential].slice(-REFUSALS_KEPT));
    throw yonto.error.unauthenticated(LOGIN_REFUSED_MESSAGE);
  }
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `logging in got HTTP ${response.status}`);
    throw yonto.error.unavailable(SIGN_IN_FAILED_MESSAGE);
  }

  const payload = parsed(response, 'logging in');
  const token = payload.AccessToken;
  const id = payload.User && payload.User.Id;
  if (!token || !id) {
    yonto.log('warn', 'logging in got a 2xx with no AccessToken or user id');
    throw yonto.error.unavailable(NO_TOKEN_MESSAGE);
  }

  const won = { token, userId: id, server: server(), username: username() };
  await yonto.store.set(SESSION_KEY, won);
  await yonto.store.set(REFUSED_KEY, (await refusals()).filter((r) => !sameAccount(r, credential)));
  return won;
}

/** Only if it is still the refused token: a call that already renewed it must keep the new one. */
async function forgetSession(refused) {
  const stored = await yonto.store.get(SESSION_KEY);
  if (stored && stored.token === refused) await yonto.store.remove(SESSION_KEY);
}

function url(segments, params) {
  const path = segments.map(encodeURIComponent).join('/');
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  return `${server()}/emby/${path}${query ? `?${query}` : ''}`;
}

/** `yonto.fetch`, with a server that gave no answer said as `unreachable`. */
async function send(address, init) {
  try {
    return await yonto.fetch(address, init);
  } catch (error) {
    // The code, never the message, which can name the URL.
    yonto.log('warn', `the request failed: ${error?.code ?? 'no code'}`);
    if (error?.code === 'REQUEST_FAILED') throw yonto.error.unreachable(SERVER_SILENT_MESSAGE);
    throw error;
  }
}

async function get(segments, what, params, retried) {
  const me = await session();
  const response = await send(url(resolve(segments, me), resolve(params || {}, me)), {
    headers: { Accept: 'application/json', ...authHeaders(me.token) },
  });
  if (response.status === 401 || response.status === 403) {
    // A login's token can be revoked, so the first refusal renews it once; a second is the account.
    if (!apiKey() && !retried) {
      await forgetSession(me.token);
      return get(segments, what, params, true);
    }
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unauthenticated(apiKey() ? KEY_REFUSED_MESSAGE : ACCOUNT_REFUSED_MESSAGE);
  }
  if (response.status === 404) throw yonto.error.notFound(what);
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unavailable(SERVER_ERROR_MESSAGE);
  }
  return parsed(response, what);
}

/** A 2xx that is not a JSON object is something in front of the server, like a proxy's login page. */
function parsed(response, what) {
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    payload = undefined;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    yonto.log('warn', `${what} got a 2xx that is not a JSON object`);
    throw yonto.error.unavailable(SERVER_UNREADABLE_MESSAGE);
  }
  return payload;
}

// The signed-in user's id, known only once a session exists.
const ME = '{me}';

function resolve(shape, me) {
  if (Array.isArray(shape)) return shape.map((segment) => (segment === ME ? me.userId : segment));
  const resolved = {};
  Object.keys(shape).forEach((key) => {
    resolved[key] = shape[key] === ME ? me.userId : shape[key];
  });
  return resolved;
}

function items(payload) {
  return Array.isArray(payload.Items) ? payload.Items : [];
}

// Unsigned: Emby serves an image by its tag without a token.
function imageUrl(itemId, tag, type, maxWidth) {
  if (!tag) return undefined;
  return url(['Items', itemId, 'Images', type], {
    tag,
    maxWidth: String(maxWidth),
    quality: String(IMAGE_QUALITY),
  });
}

function posterUrl(item) {
  return imageUrl(item.Id, item.ImageTags && item.ImageTags.Primary, 'Primary', POSTER_MAX_WIDTH);
}

function backdropUrl(item) {
  return imageUrl(item.Id, (item.BackdropImageTags || [])[0], 'Backdrop', BACKDROP_MAX_WIDTH);
}

function mediaType(item) {
  return item.Type === SERIES_TYPE ? 'SERIES' : 'MOVIE';
}

function yearOf(item) {
  const year = item.ProductionYear;
  return year === null || year === undefined ? undefined : String(year);
}

function toSummary(item) {
  return {
    id: item.Id,
    title: item.Name,
    type: mediaType(item),
    posterUrl: posterUrl(item),
    backdropUrl: backdropUrl(item),
    year: yearOf(item),
    rating: item.OfficialRating ?? undefined,
  };
}

// No MediaSourceId: Emby's is not the item id (it answers 400 to that), and without one it
// serves the item's default source.
function streamOf(itemId, token) {
  return {
    url: url(['Videos', itemId, 'stream'], { Static: 'true' }),
    mimeType: MIME_MP4,
    headers: authHeaders(token),
  };
}

function episodeOptions(episodes, token) {
  return episodes.map((episode) => {
    const season = episode.ParentIndexNumber ?? 1;
    const number = episode.IndexNumber ?? 0;
    return {
      label: `S${season}E${String(number).padStart(2, '0')} · ${episode.Name}`,
      stream: streamOf(episode.Id, token),
      season,
    };
  });
}

async function episodesOf(seriesId) {
  return items(await get(['Users', ME, 'Items'], seriesId, {
    ParentId: seriesId,
    IncludeItemTypes: 'Episode',
    Recursive: 'true',
    SortBy: 'ParentIndexNumber,IndexNumber',
    SortOrder: 'Ascending',
  }));
}

function toDetail(item, playbackOptions) {
  return {
    ...toSummary(item),
    genres: item.Genres || [],
    synopsis: item.Overview || '',
    playbackOptions,
  };
}

function names(payload) {
  return items(payload).map((item) => item.Name).filter((name) => typeof name === 'string' && name);
}

export default {
  async getCategories() {
    return items(await get(['Users', ME, 'Views'], 'views'))
      .filter((item) => LIBRARY_COLLECTION_TYPES.indexOf(item.CollectionType) !== -1)
      .map((item) => ({
        id: item.Id,
        name: item.Name,
        thumbnailUrl: posterUrl(item),
      }));
  },

  // Emby has no /Items/Filters, so genres and years are a call each.
  async getFilters(categoryId) {
    const scope = { UserId: ME, ParentId: categoryId, IncludeItemTypes: ALL_ITEM_TYPES, Recursive: 'true' };
    const [genres, years] = await Promise.all([
      get(['Genres'], categoryId, scope),
      get(['Years'], categoryId, scope),
    ]);
    return [
      { id: TYPE_FILTER, name: 'Type', options: TYPE_OPTIONS },
      {
        id: GENRE_FILTER,
        name: 'Genre',
        options: names(genres).sort().map((genre) => ({ id: genre, name: genre })),
      },
      {
        id: YEAR_FILTER,
        name: 'Year',
        options: names(years).sort((a, b) => Number(b) - Number(a)).map((year) => ({ id: year, name: year })),
      },
    ];
  },

  async getMediaList(categoryId, options) {
    const { page = 1, filters = {} } = options || {};
    return items(await get(['Users', ME, 'Items'], categoryId, {
      ParentId: categoryId,
      Recursive: 'true',
      IncludeItemTypes: filters[TYPE_FILTER] || ALL_ITEM_TYPES,
      Fields: LIST_ITEM_FIELDS,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      StartIndex: String(Math.max(page - 1, 0) * PAGE_SIZE),
      Limit: String(PAGE_SIZE),
      Genres: filters[GENRE_FILTER] || undefined,
      Years: filters[YEAR_FILTER] || undefined,
    })).map(toSummary);
  },

  // The stream carries the token the last call was answered with, which a renewal may have changed.
  async getMediaDetail(mediaId) {
    const item = await get(['Users', ME, 'Items', mediaId], mediaId, {
      Fields: DETAIL_ITEM_FIELDS,
    });
    if (item.Type !== SERIES_TYPE) {
      return toDetail(item, [{ label: 'Play', stream: streamOf(item.Id, (await session()).token) }]);
    }
    const episodes = await episodesOf(item.Id);
    return toDetail(item, episodeOptions(episodes, (await session()).token));
  },

  async search(query) {
    return items(await get(['Users', ME, 'Items'], 'search', {
      SearchTerm: query,
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: LIST_ITEM_FIELDS,
      Limit: String(PAGE_SIZE),
    })).map(toSummary);
  },

  // The best-rated titles, with unrated ones dropped rather than shown as picks.
  async getRecommendations() {
    return items(await get(['Users', ME, 'Items'], 'recommendations', {
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: RANKED_ITEM_FIELDS,
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
      Limit: String(RECOMMENDATION_COUNT),
    }))
      .filter((item) => item.CommunityRating !== undefined && item.CommunityRating !== null)
      .map(toSummary);
  },
};
