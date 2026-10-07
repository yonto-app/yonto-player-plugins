/* yonto-plugin
{
  "kind": "content-source",
  "id": "jellyfin",
  "name": "Jellyfin",
  "version": "1.6.7",
  "contractVersion": 21,
  "description": "A Jellyfin media server, reached with an ordinary login or with a server-generated API key.",
  "probeQuery": "bubble",
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
// A Jellyfin media server (https://jellyfin.org), talked to through its own REST API.
// Nothing here is a scraper: the server is documented, versioned and the viewer's own.
//
// The server is wherever its owner put it, so `allowedHosts` in the manifest is empty and
// the only thing this plugin may reach is the host of the `serverUrl` a viewer filled in —
// that is the rule both hosts apply to a `url` config field. Unconfigured, it reaches
// nothing at all, which is the failure worth having.
//
// Read config on each use, never once at module scope: a module that reaches for the host
// while it is being evaluated can only be imported after the host exists, which is a rule
// every importer would then have to know.

// MainViewModel.loadHome() only ever requests page 1 — no shelf pagination or "load more"
// UI exists — so this is the hard cap on how much of a category Home can ever show.
// Anything past it is invisible until the viewer already knows the title and searches for
// it. 500 comfortably covers a typical personal library; the real fix is paging in
// ContentRepository/MainViewModel/MediaShelf, not a bigger number here.
const PAGE_SIZE = 500;
const RECOMMENDATION_COUNT = 10;

/** Jellyfin calls a library a "view"; only these two hold anything this app can play. */
const LIBRARY_COLLECTION_TYPES = ['movies', 'tvshows'];

// Every listing asks for both item types; a mixed library — or a filter on one — is
// narrowed from here rather than by the library's own collection type.
const ALL_ITEM_TYPES = 'Movie,Series';
const SERIES_TYPE = 'Series';

const TYPE_FILTER = 'type';
const GENRE_FILTER = 'genre';
const YEAR_FILTER = 'year';
const TYPE_OPTIONS = [
  { id: 'Movie', name: 'Movies' },
  { id: 'Series', name: 'Series' },
];

// Jellyfin only includes these in a response when they are asked for by name. Omitting one
// is not a request error, it is silently-empty data — which is exactly what a missing
// Fields param on the detail call once caused: synopsis and genres came back blank against
// a real server while the list view looked perfectly correct.
//
// A listing maps to the contract's summary, which carries no genres and no synopsis, so
// asking for them would pull data across the network for up to PAGE_SIZE items per shelf
// (Overview especially, often a full paragraph) only to drop it. Only the detail call, one
// item at a time, needs the full set.
const LIST_ITEM_FIELDS = 'ProductionYear';
const DETAIL_ITEM_FIELDS = 'Genres,Overview,ProductionYear';

// Jellyfin serves the original artwork unless asked to resize, and a library's posters are
// commonly 1000x1500+ JPEGs — a shelf scroll was pulling megabytes per row only for the
// image loader to downsample every one to a 160dp card. The server-side resize (maxWidth
// keeps the aspect ratio) sends a fraction of the bytes and decodes faster, which is what
// a poster row's scroll smoothness on a TV box comes down to. Widths are sized for a 1080p
// UI at 2x density: a focused card (160dp * 1.1 * 2) is ~350px, a full-bleed hero or
// detail backdrop is 1920px.
const POSTER_MAX_WIDTH = 480;
const BACKDROP_MAX_WIDTH = 1920;
const IMAGE_QUALITY = 90;

const MIME_MP4 = 'video/mp4';

/**
 * Every sentence this plugin hands a viewer, and nothing else it hands one.
 *
 * The contract's rules for `reason` (`contracts/content-source-http.md`): never a status
 * code, a URL or anything else meant for a log, and it names the part of the source that
 * failed rather than the source, because the headline above it already said the source's
 * name. The status and the path a bug report wants go to `yonto.log` at the throw site
 * (kangzj/lantern-tv#264).
 */
const SERVER_ERROR_MESSAGE = 'The server answered with an error.';
const SERVER_UNREADABLE_MESSAGE = 'The server answered with a page that is not the media server: check the server URL.';
const SIGN_IN_FAILED_MESSAGE = 'Signing in failed: the server answered with an error.';
const NO_TOKEN_MESSAGE = 'Signing in failed: the server accepted the sign-in but sent back no session.';
const NO_CREDENTIALS_MESSAGE =
  'This source has no credentials: fill in a username and password, or an API key and user ID.';
const NO_USER_ID_MESSAGE =
  'This source has an API key but no user ID: fill that in, or use a username and password instead.';
// Which credential was refused is known by whether an API key is saved: `session()` takes
// that branch before any login, so every other refusal is about a username and password.
// A refusal says what to check and where, because the app's headline above it says only
// that the source refused. `get()` meets a password profile's refusal only after a login
// was accepted, so the password is right there and the account's rights are not.
const KEY_REFUSED_MESSAGE = 'Check the API key and user ID by editing the source in Settings.';
const LOGIN_REFUSED_MESSAGE = 'Check the username and password by editing the source in Settings.';
const ACCOUNT_REFUSED_MESSAGE = "Check this account's permissions on the server.";

function server() {
  return (yonto.config.serverUrl || '').replace(/\/+$/, '');
}

function apiKey() {
  return yonto.config.apiKey || '';
}

function username() {
  return yonto.config.username || '';
}

/** Where a session won from a login is kept, so a viewer logs in once rather than once per
 *  call. Keyed by nothing: `yonto.store` is already namespaced per source, and a profile
 *  pointed at a different server or username invalidates it by comparison below. */
const SESSION_KEY = 'session';

/**
 * Which credential the server has already refused, so it is offered once and not again.
 *
 * Without this a wrong password is retried on every call, and there are five before a viewer
 * has done anything: the status probe builds an adapter and asks for artwork headers and a
 * health check, then Home builds another and does the same plus recommendations. Jellyfin's
 * default maximum failed attempts is 3 for an ordinary account, and reaching it **disables
 * the account** — recoverable only by the administrator this whole feature exists to avoid
 * needing. So the first refusal is remembered and the rest are refused locally.
 *
 * A fingerprint rather than the credential: the password is hashed, so what is stored cannot
 * be replayed, and editing any of the three — server, username, password — is a different
 * credential and worth one more attempt. One is kept for each of the latest few servers and
 * usernames rather than one in all, so a viewer going back to one they tried before is not
 * asked again.
 */
const REFUSED_KEY = 'refused';
const REFUSALS_KEPT = 10;

/** One login per runtime however many callers want one. `loadHome` fans out a listing per
 *  category at once, so a revoked token meant one `AuthenticateByName` per category: a row
 *  each in the viewer's device list, a failed attempt each against the lockout, and — since
 *  the server replaces a session per device id — logins invalidating one another, which
 *  reaches some callers as a hard refusal for a session that was merely renewed. */
let loggingIn = null;

/**
 * How this plugin identifies itself when logging in.
 *
 * Jellyfin records these against the session it hands back, and a viewer sees them in
 * Dashboard > Devices — so they say Yonto rather than something anonymous, and the device
 * id is stable so logging in again replaces that session instead of adding another.
 */
const CLIENT = 'Yonto';
const DEVICE = 'Android TV';
const CLIENT_VERSION = '1.0';

/** This install's own device id, so `Dashboard > Devices` can tell one box from another.
 *
 *  A constant would make every Yonto anywhere the same device to the server: the list the
 *  comment above sends a viewer to could not distinguish them, and removing "the" device
 *  would revoke every one at once.
 *
 *  The host answers this now. This plugin used to mint one and keep it in `yonto.store`,
 *  which is a cache — Clear cache took it, the next login opened a second session, and the
 *  first was left in the server's device list with nothing here able to reach it
 *  (kangzj/lantern-tv#134). `yonto.installId()` is stable for this source on this box and
 *  survives a cache clear, which is the whole of what this needs. */
function deviceId() {
  return `lantern-${yonto.installId()}`;
}

/**
 * The only way a Jellyfin server authenticates anything.
 *
 * `X-Emby-Token` and `?api_key=` are gone: a 12.x server's own OpenAPI document declares
 * exactly one security scheme, an api key in a header named `Authorization`, and answers
 * 401 to every other form — the legacy header, `X-MediaBrowser-Token`, and the query
 * parameter, on JSON and on media alike. Verified against demo.jellyfin.org/stable 12.1.0.
 * Older servers have accepted this header for years, so there is nothing to fall back to.
 *
 * A token from a login and a key from the dashboard go in the same header, because to
 * Jellyfin they are the same kind of credential. That is what makes a login a drop-in
 * replacement for a key an ordinary account cannot mint.
 */
function authHeaders(token) {
  return { Authorization: `MediaBrowser Token="${token}"` };
}

/** What the login itself is authorised by: no token yet, so the client describes itself and
 *  that is the whole of it. */
async function clientHeader() {
  return {
    Authorization:
      `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId()}", Version="${CLIENT_VERSION}"`,
  };
}

/**
 * The credential every call uses, and the user it belongs to.
 *
 * An API key and a user id, when a viewer has them — an administrator's dashboard mints
 * those, and a profile that already holds them keeps working untouched.
 *
 * Otherwise a username and password, exchanged for exactly the same kind of credential by
 * `POST /Users/AuthenticateByName`. That is the path that matters: `Dashboard > API Keys`
 * and `Dashboard > Users` are the server administrator's pages, so a viewer given an account
 * on someone else's Jellyfin — which is most people who use one — could not obtain either
 * and so could not add the source at all.
 *
 * The session is stored, not the exchange repeated: a login per call would be one session
 * per call in the server's own device list.
 */
async function session() {
  if (apiKey()) {
    // Checked here because the editor cannot: `userId` is optional in the manifest, since a
    // viewer logging in does not have one to type. Without this an API key with no user id
    // saved cleanly and every call asked for `/Users//Views` — an empty path segment, which
    // came back as "couldn't find that" rather than as the field nobody filled in.
    if (!yonto.config.userId) {
      // Logged as well as thrown: a viewer reporting "it says my login expired" left no
      // trace of which of the four guards it actually was (kangzj/lantern-tv#281).
      yonto.log('warn', 'an API key is saved with no user id beside it');
      // `misconfigured`, not `unauthenticated`: nothing has expired and there is no login
      // to go back to — the field they left blank is on the form they just left. The app
      // words this one "needs attention / edit the source in Settings", which is where the
      // fix is, and renders the sentence below as the line under it.
      throw yonto.error.misconfigured(NO_USER_ID_MESSAGE);
    }
    return { token: apiKey(), userId: yonto.config.userId };
  }

  const cached = await yonto.store.get(SESSION_KEY);
  // Tied to the server and the account it was won from, or a viewer who edits either keeps
  // reaching the old one with a credential that still happens to work.
  if (cached && cached.server === server() && cached.username === username()) return cached;

  return logIn();
}

/** What identifies this credential without keeping it: the password is hashed, so a stored
 *  refusal cannot be replayed, and changing any of the three is worth another attempt. */
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

function logIn() {
  // Shared rather than awaited in turn: every caller that wants a session gets this one.
  if (!loggingIn) {
    loggingIn = attemptLogIn();
    // Cleared whichever way it goes, so the next call after a failure can try again once
    // the viewer has edited something — the refusal marker is what stops it before then.
    loggingIn = loggingIn.then(
      (won) => { loggingIn = null; return won; },
      (error) => { loggingIn = null; throw error; }
    );
  }
  return loggingIn;
}

async function attemptLogIn() {
  if (!username()) {
    yonto.log('warn', 'no username, no password and no API key are saved for this source');
    // The same shape as the user-id guard above: a profile saved with nothing in it has no
    // session to renew, so this is the form's problem and not a sign-in's.
    throw yonto.error.misconfigured(NO_CREDENTIALS_MESSAGE);
  }

  const credential = await fingerprint();
  if ((await refusals()).some((r) => sameAccount(r, credential) && r.password === credential.password)) {
    yonto.log('warn', 'the same credential was refused before; not spending another attempt');
    throw yonto.error.unauthenticated(LOGIN_REFUSED_MESSAGE);
  }

  const response = await yonto.fetch(url(['Users', 'AuthenticateByName'], {}), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(await clientHeader()) },
    body: JSON.stringify({ Username: username(), Pw: yonto.config.password || '' }),
  });
  if (response.status === 401 || response.status === 403) {
    // Remembered before throwing: the next call must not spend another of the three
    // attempts the server allows before it disables the account.
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
  // A 200 without these is a server this plugin cannot use, and saying so here is better
  // than every later call failing as an unexplained 401.
  if (!token || !id) {
    yonto.log('warn', 'logging in got a 2xx with no AccessToken or user id');
    throw yonto.error.unavailable(NO_TOKEN_MESSAGE);
  }

  const won = { token, userId: id, server: server(), username: username() };
  await yonto.store.set(SESSION_KEY, won);
  // A password that works says this account's refusals are stale, and nothing about another's.
  await yonto.store.set(REFUSED_KEY, (await refusals()).filter((r) => !sameAccount(r, credential)));
  return won;
}

/** Forgets the stored session if it is still `refused`, so the next call logs in again. A
 *  token from a login can be revoked server-side — removing the device in Dashboard >
 *  Devices does it — where a dashboard key cannot, so a 401 is recoverable here rather than
 *  final.
 *
 *  Only if it is still that token: a caller whose 401 arrives after another has already
 *  renewed would otherwise throw the renewed one away and log in again, and since the
 *  server keeps one session per device id that login revokes the token the first caller is
 *  retrying with. */
async function forgetSession(refused) {
  const stored = await yonto.store.get(SESSION_KEY);
  if (stored && stored.token === refused) await yonto.store.remove(SESSION_KEY);
}

/** There is no `URL` and no `URLSearchParams` on a television; this is the whole of it. */
function url(segments, params) {
  const path = segments.map(encodeURIComponent).join('/');
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  return `${server()}/${path}${query ? `?${query}` : ''}`;
}

/**
 * The status rules are HttpJsonClient's, which is where every HTTP-backed source in the
 * app implements them — not this adapter's own former parse wrapper.
 *
 * A non-2xx used to throw a plain Error on the reasoning that METHOD_THREW becomes an
 * Unavailable carrying the status as its *cause*, so the status stayed out of the viewer's
 * way. Every step of that is true and the conclusion was wrong: an Unavailable with no
 * `reason` falls back to `error_unreachable_body`, "Check the TV's network connection,
 * then try again" — so a server answering 503 told the viewer their network was down
 * (kangzj/lantern-tv#264). The status goes to `yonto.log` and the throw carries a
 * sentence instead, which is what `iyingshi`'s `read()` already did.
 */
async function get(segments, what, params, retried) {
  const me = await session();
  const response = await yonto.fetch(url(resolve(segments, me), resolve(params || {}, me)), {
    headers: { Accept: 'application/json', ...authHeaders(me.token) },
  });
  if (response.status === 401 || response.status === 403) {
    // A login's token can be revoked while a key cannot, so the first 401 is worth one
    // more try: renew the session and repeat the call. Only once — the retry carries a
    // token the server accepted after this refusal, whether this call won it or another
    // call already had, so a second 401 is this account being refused rather than a
    // session that expired, and retrying that forever would log in on every attempt.
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

/** A 2xx that is not a JSON object is something in front of the server, like a proxy's sign-in page
 *  or a mistyped address that reached some other site, so the viewer is pointed at the URL. */
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

/**
 * [ME] stands in for the id of whoever this profile is logged in as, because that id is not
 * known until a session exists — and with a login it is the server that decides it rather
 * than a viewer typing it in. Substituted in both the path and the query, which is where
 * Jellyfin wants it.
 */
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

function imageUrl(itemId, tag, type, maxWidth) {
  if (!tag) return undefined;
  // No key in the URL: the app asks for these with `getImageHeaders()` on the request,
  // which is the only place a 12.x server reads one from, and keeps the token out of
  // anything that logs or caches a URL.
  return url(['Items', itemId, 'Images', type], {
    tag,
    maxWidth: String(maxWidth),
    quality: String(IMAGE_QUALITY),
  });
}

function posterUrl(item) {
  return imageUrl(item.Id, item.ImageTags && item.ImageTags.Primary, 'Primary', POSTER_MAX_WIDTH);
}

// An episode carries no artwork of its own in most libraries, so it borrows the series'
// backdrop rather than showing a hero with a hole in it.
function backdropUrl(item) {
  const own = (item.BackdropImageTags || [])[0];
  if (own) return imageUrl(item.Id, own, 'Backdrop', BACKDROP_MAX_WIDTH);
  const parentTag = (item.ParentBackdropImageTags || [])[0];
  if (!item.ParentBackdropItemId || !parentTag) return undefined;
  return imageUrl(item.ParentBackdropItemId, parentTag, 'Backdrop', BACKDROP_MAX_WIDTH);
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

// Jellyfin's static direct-play endpoint. Reusing the item id as the media source id is
// correct for the common single-file-per-item case — verified against a live server — and
// skips a PlaybackInfo negotiation round trip that direct play does not need, which is one
// fewer network hop before playback can start.
function streamOf(itemId, token) {
  return {
    url: url(['Videos', itemId, 'stream'], {
      static: 'true',
      mediaSourceId: itemId,
    }),
    mimeType: MIME_MP4,
    // The token is passed in rather than read here: with a login there is no credential in
    // the config to read, and the one that exists belongs to the session that fetched this
    // item. The player speaks neither `yonto.fetch` nor this plugin, so a stream carries
    // what it needs with it.
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

// Episode labels are built from name and index alone, so no Fields param: nothing here
// reads a synopsis, a genre or a year per episode.
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

export default {
  /**
   * What the app has to send to fetch the artwork this plugin hands back, since a poster
   * URL cannot carry a key any more and the image loader is not this plugin's code.
   *
   * The app applies these only to hosts this profile is allowed to reach, so the token
   * cannot ride along to anywhere else a URL might point.
   */
  async getImageHeaders() {
    // Awaits a session rather than reading a key, so an ordinary login authenticates its
    // artwork too. A source with no credentials at all signs nothing instead of throwing:
    // the host asks for these when the plugin starts, and a profile half-filled-in should
    // draw grey posters rather than fail to start.
    if (!apiKey() && !username()) return {};
    return authHeaders((await session()).token);
  },

  /**
   * The host saying the headers it was given were refused, so the next ask wins a new one.
   *
   * Without this the host could only ask again, and `session()` answers from the store
   * whenever the server and username still match — which a revoked token does, so asking
   * again returns the very token that was just refused. This is the same move `get()`
   * makes for itself on a 401, made available to the one caller that cannot: artwork is
   * fetched by the image loader, outside every request this plugin makes.
   *
   * An api key cannot be renewed by logging in, so there is nothing to forget: saying so
   * is what stops the host from asking a second time for a credential only its owner can
   * replace.
   */
  async onImageHeadersRefused(refused) {
    // Only the server's owner can replace an api key, so there is nothing here to forget
    // and nothing a second ask could win. Saying so is what stops the host asking again.
    if (apiKey() || !username()) return { renewable: false };

    // What is held *now*, which is not necessarily what was refused: an ordinary call that
    // met a 401 has already logged in and stored a live session. Forgetting that would
    // throw away a token the rest of the app is carrying and win another — and the server
    // replaces a session per device id, so a login invalidates the one in flight. The host
    // only needs to be told it may ask again.
    const { token } = await session();
    if (authHeaders(token).Authorization !== (refused || {}).Authorization) return { renewable: true };

    // Genuinely stale: this is the token that was refused, and nothing else has renewed it.
    await forgetSession(token);
    return { renewable: true };
  },

  async getCategories() {
    return items(await get(['Users', ME, 'Views'], 'views'))
      .filter((item) => LIBRARY_COLLECTION_TYPES.indexOf(item.CollectionType) !== -1)
      .map((item) => ({
        id: item.Id,
        name: item.Name,
        thumbnailUrl: posterUrl(item),
      }));
  },

  // Type is static; genres and years are whatever this library's items actually carry, so
  // no option can lead to an empty grid. Years newest first, the order a viewer scans them.
  async getFilters(categoryId) {
    const available = await get(['Items', 'Filters'], categoryId, {
      UserId: ME,
      ParentId: categoryId,
      IncludeItemTypes: ALL_ITEM_TYPES,
    });
    return [
      { id: TYPE_FILTER, name: 'Type', options: TYPE_OPTIONS },
      {
        id: GENRE_FILTER,
        name: 'Genre',
        options: (available.Genres || []).slice().sort()
          .map((genre) => ({ id: genre, name: genre })),
      },
      {
        id: YEAR_FILTER,
        name: 'Year',
        options: (available.Years || []).slice().sort((a, b) => b - a)
          .map((year) => ({ id: String(year), name: String(year) })),
      },
    ];
  },

  // Jellyfin pages by offset, so the manifest says nothing about pagination and the
  // cursor an options object may carry is never read.
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

  async getMediaDetail(mediaId) {
    const item = await get(['Users', ME, 'Items', mediaId], mediaId, {
      Fields: DETAIL_ITEM_FIELDS,
    });
    if (item.Type !== SERIES_TYPE) {
      // After the call, not before: if the session had to be won or re-won, this is the
      // credential the item was actually fetched with, and the stream has to carry the same
      // one or the player gets a 401 for an item that loaded.
      return toDetail(item, [{ label: 'Play', stream: streamOf(item.Id, (await session()).token) }]);
    }
    // And for a series, after the *episode* call rather than before it — which is what the
    // comment above used to claim while doing the opposite. That call can 401 and re-log-in
    // too, and stamping every episode with the token that just proved dead means a detail
    // screen that loads and a Play button that fails on all of them.
    const episodes = await episodesOf(item.Id);
    return toDetail(item, episodeOptions(episodes, (await session()).token));
  },

  async search(query) {
    return items(await get(['Users', ME, 'Items'], 'search', {
      searchTerm: query,
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: LIST_ITEM_FIELDS,
      Limit: String(PAGE_SIZE),
    })).map(toSummary);
  },

  // The library's best-rated titles stand in for a ranking. Jellyfin sorts unrated items in
  // with the rest, so they are dropped here rather than shown as somebody's picks.
  async getRecommendations() {
    return items(await get(['Users', ME, 'Items'], 'recommendations', {
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: LIST_ITEM_FIELDS,
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
      Limit: String(RECOMMENDATION_COUNT),
    }))
      .filter((item) => item.CommunityRating !== undefined && item.CommunityRating !== null)
      .map(toSummary);
  },
};
