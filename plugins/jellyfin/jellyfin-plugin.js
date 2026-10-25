/* yonto-plugin
{
  "kind": "content-source",
  "id": "jellyfin",
  "name": "Jellyfin",
  "version": "1.12.0",
  "contractVersion": 23,
  "description": "A Jellyfin media server, reached with an ordinary login or with a server-generated API key.",
  "probeQuery": "bubble",
  "provides": "source-type",
  "allowedHosts": [],
  "playbackTokens": true,
  "deviceProfile": true,
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
const CONTINUE_WATCHING_COUNT = 30;
const TICKS_PER_SECOND = 10000000;

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
const LIST_ITEM_FIELDS = 'ProductionYear,ProviderIds';
const DETAIL_ITEM_FIELDS = 'Genres,Overview,ProductionYear,ProviderIds,MediaStreams';
// An episode's subtitle files are in its own streams, asked for when it is played.
const STREAM_FIELDS = 'MediaStreams';
// An episode's size, which a listing gives cheaply; its range is only in its own streams.
const EPISODE_FIELDS = 'Width,Height';

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
const MIME_HLS = 'application/x-mpegURL';

// The contract's cap on one stream's subtitles.
const MAX_SUBTITLES = 32;
const MAX_SEGMENTS = 32;
// A subtitle file in a format the host plays is fetched as it is; any other text format is
// asked for as SubRip, which the server converts to (SAMI checked on 12.2).
const SUBTITLE_FORMATS = { subrip: 'srt', srt: 'srt', ass: 'ass', ssa: 'ssa', webvtt: 'vtt', vtt: 'vtt' };
const CONVERTED_FORMAT = 'srt';
const SUBTITLE_TYPES = { srt: 'application/x-subrip', ass: 'text/x-ssa', ssa: 'text/x-ssa', vtt: 'text/vtt' };
const UNDETERMINED_LANGUAGE = 'und';

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
const UNKNOWN_EVENT_MESSAGE = 'The playback report names an event this source does not send.';
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

/** The address as the viewer saved it, which is what a session and a refusal are tied to. */
function server() {
  return (yonto.config.serverUrl || '').replace(/\/+$/, '');
}

/** Jellyfin's own port, which its official apps try when an address names none. */
const DEFAULT_PORT = '8096';
/** The address that answered as a Jellyfin, so it is looked for once per address typed. */
const ADDRESS_KEY = 'address';

/** `{ typed, base }`: the saved address and where that server actually answered. */
let reached = null;
let finding = null;

/**
 * The same address on Jellyfin's own port, or null when it was typed in full.
 *
 * A bare `192.168.1.20` is saved as `http://192.168.1.20`, which is port 80, where a Jellyfin
 * seldom is (kangzj/yonto#1871). An address with a port or with `https://` is the viewer's own
 * choice, and an `https://` one is never tried over plain http.
 */
function withDefaultPort(typed) {
  const parts = /^http:\/\/([^/?#]+)(.*)$/i.exec(typed);
  if (!parts || /:\d*$/.test(parts[1])) return null;
  return `http://${parts[1]}:${DEFAULT_PORT}${parts[2]}`;
}

/** Where requests go: the typed address, or its default port once only that answered. */
function base() {
  return reached && reached.typed === server() ? reached.base : server();
}

/** Settles `base()` for an address typed without a port, the typed one tried first. */
async function reach() {
  const typed = server();
  const fallback = withDefaultPort(typed);
  if (!fallback || (reached && reached.typed === typed)) return;
  if (!finding) finding = find(typed, fallback).finally(() => { finding = null; });
  await finding;
}

async function find(typed, fallback) {
  const stored = await yonto.store.get(ADDRESS_KEY);
  if (stored && stored.typed === typed) {
    reached = stored;
    return;
  }
  // Both at once, so a host that drops packets costs one connect timeout, not two.
  const [onTyped, onFallback] = await Promise.allSettled([answersAsJellyfin(typed), answersAsJellyfin(fallback)]);
  for (const [candidate, probe] of [[typed, onTyped], [fallback, onFallback]]) {
    if (probe.status === 'fulfilled' && probe.value) {
      reached = { typed, base: candidate };
      await yonto.store.set(ADDRESS_KEY, reached);
      return;
    }
  }
  yonto.log('warn', 'neither the address as typed nor its default port answered as a Jellyfin');
  // The typed address's own failure, not a third request: a host that drops packets would run the call out of time.
  if (onTyped.status === 'rejected') throw onTyped.reason;
}

/** `/System/Info/Public` needs no sign-in, and only a Jellyfin answers it with its server id. */
async function answersAsJellyfin(candidate) {
  const response = await send(`${candidate}/System/Info/Public`, { headers: { Accept: 'application/json' } });
  if (response.status < 200 || response.status >= 300) return false;
  try {
    const info = JSON.parse(response.body);
    return typeof info?.Id === 'string' && info.Id !== '';
  } catch {
    return false;
  }
}

/** `yonto.fetch`, forgetting the address it found when that stops answering, so the next call looks again. */
async function send(address, init) {
  try {
    return await yonto.fetch(address, init);
  } catch (error) {
    if (error?.code === 'REQUEST_FAILED' && reached) {
      reached = null;
      await yonto.store.remove(ADDRESS_KEY);
    }
    throw error;
  }
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
 * Dashboard > Devices — so they say Yonto Player rather than something anonymous, and the device
 * id is stable so logging in again replaces that session instead of adding another.
 */
const CLIENT = 'Yonto Player';
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

  await reach();
  const response = await send(url(['Users', 'AuthenticateByName'], {}), {
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
  return `${base()}/${path}${query ? `?${query}` : ''}`;
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
async function request(method, segments, what, params, body, retried) {
  const me = await session();
  await reach();
  const response = await send(url(resolve(segments, me), resolve(params || {}, me)), {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...authHeaders(me.token),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    // A login's token can be revoked while a key cannot, so the first 401 is worth one
    // more try: renew the session and repeat the call. Only once — the retry carries a
    // token the server accepted after this refusal, whether this call won it or another
    // call already had, so a second 401 is this account being refused rather than a
    // session that expired, and retrying that forever would log in on every attempt.
    if (!apiKey() && !retried) {
      await forgetSession(me.token);
      return request(method, segments, what, params, body, true);
    }
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unauthenticated(apiKey() ? KEY_REFUSED_MESSAGE : ACCOUNT_REFUSED_MESSAGE);
  }
  if (response.status === 404) throw yonto.error.notFound(what);
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unavailable(SERVER_ERROR_MESSAGE);
  }
  return response;
}

async function get(segments, what, params) {
  return parsed(await request('GET', segments, what, params), what);
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

// A title the server never matched has none, and the server only knows these three.
function idsOf(item) {
  const given = item.ProviderIds || {};
  const ids = {};
  if (given.Tmdb) ids.tmdb = String(given.Tmdb);
  if (given.Imdb) ids.imdb = String(given.Imdb);
  if (given.Tvdb) ids.tvdb = String(given.Tvdb);
  return Object.keys(ids).length === 0 ? undefined : ids;
}

// The server's place for this viewer. `EnableUserData=true` asks for it by name, since
// `Fields` does not carry it. A title it says nothing about has no `UserData`, and says
// nothing here either; a position is only sent when there is one, because zero is what an
// unwatched or finished title holds and "not watched" is `played: false` on its own.
function playStateOf(item) {
  const data = item.UserData;
  if (data === null || typeof data !== 'object') return {};
  const state = {};
  if (typeof data.Played === 'boolean') state.played = data.Played;
  if (typeof data.PlaybackPositionTicks === 'number' && data.PlaybackPositionTicks > 0) {
    state.position = data.PlaybackPositionTicks / TICKS_PER_SECOND;
  }
  if (typeof data.LastPlayedDate === 'string' && data.LastPlayedDate) state.playedAt = data.LastPlayedDate;
  return state;
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
    ids: idsOf(item),
    ...playStateOf(item),
  };
}

// The subtitle files beside the item's video. An embedded track is in the stream already, unless the
// server converts the stream, whose HLS carries none, so then the server extracts it as a file too.
// A picture format (PGS, VobSub) is not text the player can be handed.
function subtitlesOf(item, embeddedToo = false) {
  return (Array.isArray(item.MediaStreams) ? item.MediaStreams : [])
    .filter((stream) => stream && stream.Type === 'Subtitle' && (embeddedToo || stream.IsExternal === true)
      && stream.IsTextSubtitleStream === true && Number.isInteger(stream.Index))
    .slice(0, MAX_SUBTITLES)
    .map((stream) => {
      const format = SUBTITLE_FORMATS[String(stream.Codec).toLowerCase()] || CONVERTED_FORMAT;
      const language = stream.Language && stream.Language !== UNDETERMINED_LANGUAGE ? stream.Language : undefined;
      return {
        url: url(['Videos', item.Id, item.Id, 'Subtitles', String(stream.Index), `Stream.${format}`], {}),
        label: stream.Title || stream.LocalizedLanguage || language || stream.DisplayTitle || 'Subtitles',
        language,
        mimeType: SUBTITLE_TYPES[format],
        forced: stream.IsForced === true,
        default: stream.IsDefault === true,
      };
    });
}

// Jellyfin 10.10's Media Segments, in ticks. A server before that answers 404, and any failure
// here is a stream without segments, never a stream that does not play.
const SEGMENT_TYPES = { Intro: 'intro', Recap: 'recap', Outro: 'credits', Preview: 'preview', Commercial: 'commercial' };

async function segmentsOf(itemId) {
  let payload;
  try {
    payload = await get(['MediaSegments', itemId], 'media segments');
  } catch {
    return [];
  }
  return items(payload)
    .filter((segment) => segment && SEGMENT_TYPES[segment.Type] && segment.StartTicks >= 0)
    .slice(0, MAX_SEGMENTS)
    .map((segment) => {
      const found = { type: SEGMENT_TYPES[segment.Type], start: segment.StartTicks / TICKS_PER_SECOND };
      const ends = segment.EndTicks > segment.StartTicks;
      if (ends) found.end = segment.EndTicks / TICKS_PER_SECOND;
      // Only credits may run to the end: for an intro that would be a button to skip the film.
      return found.type === 'credits' || ends ? found : null;
    })
    .filter(Boolean);
}

// Segments first, then the token: a 401 on this endpoint alone renews the session and revokes the
// token a stream built before it would carry.
async function streamWithSegments(item) {
  const segments = await segmentsOf(item.Id);
  const stream = streamOf(item, (await session()).token);
  return segments.length > 0 ? { ...stream, segments } : stream;
}

// Jellyfin's static direct-play endpoint. Reusing the item id as the media source id is
// correct for the common single-file-per-item case — verified against a live server — and
// skips a PlaybackInfo negotiation round trip that direct play does not need, which is one
// fewer network hop before playback can start.
function streamOf(item, token) {
  const stream = {
    url: url(['Videos', item.Id, 'stream'], {
      static: 'true',
      mediaSourceId: item.Id,
    }),
    mimeType: MIME_MP4,
    // The token is passed in rather than read here: with a login there is no credential in
    // the config to read, and the one that exists belongs to the session that fetched this
    // item. The player speaks neither `yonto.fetch` nor this plugin, so a stream carries
    // what it needs with it.
    headers: authHeaders(token),
  };
  const subtitles = subtitlesOf(item);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  return stream;
}

// What the device plays, in the names a DeviceProfile uses.
const CONTAINER_NAMES = { mp4: 'mp4,m4v,mov', mkv: 'mkv', webm: 'webm', ts: 'ts,mpegts,m2ts' };
const AUDIO_NAMES = { dts: 'dts,dca' };
// A layer the device plays without the format on top counts too: HDR10+ and Dolby Vision play as
// their HDR10 or HLG layer, and as their SDR one on any screen.
const SDR_RANGES = ['SDR', 'DOVIWithSDR'];
const HDR_RANGES = {
  hdr10: ['HDR10', 'HDR10Plus', 'DOVIWithHDR10'],
  hdr10plus: ['HDR10Plus'],
  hlg: ['HLG', 'DOVIWithHLG'],
  dolbyVision: ['DOVI', 'DOVIWithHDR10', 'DOVIWithHLG', 'DOVIWithSDR'],
};
const TRANSCODE_AUDIO = ['aac', 'ac3', 'eac3'];
const SUBTITLE_PROFILE_FORMATS = ['srt', 'subrip', 'ass', 'ssa', 'vtt'];
// No limit a home network would meet, so a file is never converted for its size alone.
const MAX_STREAMING_BITRATE = 200000000;

function listOf(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

// The device as Jellyfin's own clients describe it. A video beyond a decoder's size, bit depth or
// the screen's dynamic range fails its codec profile, so the server converts it to H.264 SDR,
// tone-mapping HDR as its own settings say.
function deviceProfileOf(device) {
  const video = (Array.isArray(device.video) ? device.video : []).filter((v) => v && typeof v.codec === 'string');
  const audio = listOf(device.audio);
  const containers = listOf(device.containers).map((name) => CONTAINER_NAMES[name]).filter(Boolean);
  const ranges = [...new Set([...SDR_RANGES, ...listOf(device.hdr).flatMap((format) => HDR_RANGES[format] || [])])];
  const transcodeAudio = TRANSCODE_AUDIO.filter((codec) => audio.includes(codec));
  const channels = Number.isInteger(device.maxAudioChannels) && device.maxAudioChannels > 0 ? device.maxAudioChannels : 2;
  // H.264 is what a conversion encodes to. HEVC the device plays is copied rather than encoded
  // again, as a file in a container the device can't open is, and HEVC goes in fMP4, the one
  // HLS container AVPlayer takes it in.
  const copiesHevc = video.some((v) => v.codec === 'hevc');
  return {
    Name: CLIENT,
    MaxStreamingBitrate: MAX_STREAMING_BITRATE,
    DirectPlayProfiles: [{
      Type: 'Video',
      Container: containers.join(','),
      VideoCodec: video.map((v) => v.codec).join(','),
      AudioCodec: audio.map((codec) => AUDIO_NAMES[codec] || codec).join(','),
    }],
    TranscodingProfiles: [{
      Type: 'Video',
      Container: copiesHevc ? 'mp4' : 'ts',
      Protocol: 'hls',
      Context: 'Streaming',
      VideoCodec: copiesHevc ? 'h264,hevc' : 'h264',
      AudioCodec: (transcodeAudio.length > 0 ? transcodeAudio : ['aac']).join(','),
      MaxAudioChannels: String(channels),
      MinSegments: 1,
      BreakOnNonKeyFrames: true,
    }],
    CodecProfiles: video.map((v) => ({
      Type: 'Video',
      Codec: v.codec,
      Conditions: [
        { Condition: 'LessThanEqual', Property: 'Width', Value: String(v.maxWidth), IsRequired: false },
        { Condition: 'LessThanEqual', Property: 'Height', Value: String(v.maxHeight), IsRequired: false },
        { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: String(v.maxBitDepth), IsRequired: false },
        { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: ranges.join('|'), IsRequired: false },
      ],
    })),
    SubtitleProfiles: SUBTITLE_PROFILE_FORMATS.flatMap((format) => [
      { Format: format, Method: 'Embed' },
      { Format: format, Method: 'External' },
    ]),
  };
}

// The credential rides in the Authorization header on every hop, so a key the server writes into
// the address is taken out rather than left in logs and caches.
function withoutKey(path) {
  const [route, query = ''] = path.split('?');
  const kept = query.split('&').filter((pair) => pair && !/^(api_key|ApiKey)=/i.test(pair));
  return kept.length > 0 ? `${route}?${kept.join('&')}` : route;
}

// What the server decided for this device: the file as stored where it plays, or the server's own
// HLS conversion. Anything the decision cannot answer plays the file as stored, as it always did.
async function decidedStream(item, device) {
  let source;
  let playSession;
  try {
    const info = parsed(await request('POST', ['Items', item.Id, 'PlaybackInfo'], 'playback info', { UserId: ME }, {
      DeviceProfile: deviceProfileOf(device),
      MaxStreamingBitrate: MAX_STREAMING_BITRATE,
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      SubtitleStreamIndex: -1,
      AutoOpenLiveStream: true,
    }), 'playback info');
    source = (Array.isArray(info.MediaSources) ? info.MediaSources : [])[0];
    playSession = info.PlaySessionId;
  } catch (error) {
    yonto.log('warn', `playback info failed, playing the file as stored: ${error && error.message}`);
  }
  if (!source || source.SupportsDirectPlay || typeof source.TranscodingUrl !== 'string') {
    const stream = await streamWithSegments(item);
    return source ? { ...stream, session: sessionOf(playSession, source.Id, 'DirectPlay') } : stream;
  }
  const segments = await segmentsOf(item.Id);
  const stream = {
    url: `${base()}${withoutKey(source.TranscodingUrl)}`,
    mimeType: MIME_HLS,
    headers: authHeaders((await session()).token),
    session: sessionOf(playSession, source.Id, 'Transcode'),
  };
  const subtitles = subtitlesOf(item, true);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  return segments.length > 0 ? { ...stream, segments } : stream;
}

// Handed back on every report about this play, so the server keeps its own session and the stop
// ends its conversion.
function sessionOf(playSessionId, mediaSourceId, playMethod) {
  return JSON.stringify({ playSessionId, mediaSourceId, playMethod });
}

function playSessionOf(session) {
  try {
    const decoded = JSON.parse(session);
    return decoded && typeof decoded === 'object' ? decoded : {};
  } catch {
    return {};
  }
}

// An episode is a `track` that `getStream` redeems with its own streams, so a show's listing
// does not carry every episode's streams on every open.
function episodeOptions(episodes) {
  return episodes.map((episode) => {
    const season = episode.ParentIndexNumber ?? 1;
    const number = episode.IndexNumber ?? 0;
    return {
      label: `S${season}E${String(number).padStart(2, '0')} · ${episode.Name}`,
      id: episode.Id,
      track: episode.Id,
      season,
      ...episodeNumberOf(episode),
      ...playStateOf(episode),
      ...videoOf(episode),
    };
  });
}

// Only the server's own numbers, never the label's defaults: the host asks a skip-times
// database by them, and a guessed season would ask about another episode.
function episodeNumberOf(episode) {
  return Number.isInteger(episode.ParentIndexNumber) && Number.isInteger(episode.IndexNumber)
    ? { episode: episode.IndexNumber }
    : {};
}

// Jellyfin's range types, a Dolby Vision file with another layer counted as Dolby Vision.
const VIDEO_RANGES = {
  SDR: 'sdr', HDR10: 'hdr10', HDR10Plus: 'hdr10plus', HLG: 'hlg',
  DOVI: 'dolbyVision', DOVIWithHDR10: 'dolbyVision', DOVIWithHLG: 'dolbyVision', DOVIWithSDR: 'dolbyVision',
};

// What the copy is: a film's own streams say its size and range, an episode's listing its size alone.
function videoOf(item) {
  const stream = (Array.isArray(item.MediaStreams) ? item.MediaStreams : []).find((s) => s && s.Type === 'Video') || {};
  const width = positive(stream.Width ?? item.Width);
  const height = positive(stream.Height ?? item.Height);
  const range = VIDEO_RANGES[stream.VideoRangeType];
  const video = { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(range ? { range } : {}) };
  return Object.keys(video).length > 0 ? { video } : {};
}

function positive(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// Only each episode's size is asked for: its label is built from its name and index, and nothing here reads a
// synopsis, a genre or a year per episode.
async function episodesOf(seriesId) {
  return items(await get(['Users', ME, 'Items'], seriesId, {
    ParentId: seriesId,
    IncludeItemTypes: 'Episode',
    Recursive: 'true',
    Fields: EPISODE_FIELDS,
    EnableUserData: 'true',
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

const PLAYING_PATHS = {
  start: ['Sessions', 'Playing'],
  progress: ['Sessions', 'Playing', 'Progress'],
  stop: ['Sessions', 'Playing', 'Stopped'],
};

// An episode on its own has no title worth a card, so it stands for its series, resuming at it.
function episodeResume(episode) {
  const poster = imageUrl(episode.SeriesId, episode.SeriesPrimaryImageTag, 'Primary', POSTER_MAX_WIDTH);
  return {
    id: episode.SeriesId,
    title: episode.SeriesName,
    type: 'SERIES',
    posterUrl: poster,
    backdropUrl: backdropUrl(episode),
    optionId: episode.Id,
    ...playStateOf(episode),
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
      EnableUserData: 'true',
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
      EnableUserData: 'true',
    });
    if (item.Type !== SERIES_TYPE) {
      // A track like an episode's, redeemed on Play: what the server decides to send is for one
      // play on one device, and this answer is cached and kept.
      return toDetail(item, [{ label: 'Play', id: item.Id, track: item.Id, ...videoOf(item) }]);
    }
    return toDetail(item, episodeOptions(await episodesOf(item.Id)));
  },

  // A `track` is its item id. The stream carries the credential this call was answered with.
  // With what the device plays, the server decides; without it (a download, an older app) the
  // file is sent as stored.
  async getStream(track, asked) {
    const item = await get(['Users', ME, 'Items', track], track, { Fields: STREAM_FIELDS });
    const device = asked && asked.device;
    return device && typeof device === 'object' ? decidedStream(item, device) : streamWithSegments(item);
  },

  // Written to the server as Jellyfin's own clients do, `Sessions/Playing` and its two
  // siblings. The server's own play session and method come back in `session` where it decided
  // the stream, and the stop that carries them ends its conversion; otherwise a `PlaySessionId`
  // derived from the item keeps the three of one play together without state here. `finished`
  // is ignored on purpose: the server decides "played" from the position on stop.
  async reportPlayback({ mediaId, optionId, event, paused, position, session }) {
    const itemId = optionId || mediaId;
    const path = PLAYING_PATHS[event];
    if (!path) throw yonto.error.unavailable(UNKNOWN_EVENT_MESSAGE);
    const decided = playSessionOf(session);
    await request('POST', path, 'playback report', {}, {
      ItemId: itemId,
      MediaSourceId: decided.mediaSourceId || itemId,
      PlaySessionId: decided.playSessionId || `${deviceId()}-${itemId}`,
      PositionTicks: Math.round(position * TICKS_PER_SECOND),
      IsPaused: paused === true,
      PlayMethod: decided.playMethod || 'DirectPlay',
      CanSeek: true,
    });
  },

  async setPlayed({ mediaId, optionId, played }) {
    await request(played ? 'POST' : 'DELETE', ['Users', ME, 'PlayedItems', optionId || mediaId], 'played mark');
  },

  // What the server would resume: an episode is its series with `optionId` naming the episode.
  async getContinueWatching() {
    const resumable = items(await get(['Users', ME, 'Items', 'Resume'], 'continue watching', {
      Limit: String(CONTINUE_WATCHING_COUNT),
      MediaTypes: 'Video',
      EnableUserData: 'true',
    }));
    return {
      items: resumable.map((item) => (item.Type === 'Episode' ? episodeResume(item) : toSummary(item))),
    };
  },

  async search(query) {
    return items(await get(['Users', ME, 'Items'], 'search', {
      searchTerm: query,
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: LIST_ITEM_FIELDS,
      EnableUserData: 'true',
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
      EnableUserData: 'true',
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
      Limit: String(RECOMMENDATION_COUNT),
    }))
      .filter((item) => item.CommunityRating !== undefined && item.CommunityRating !== null)
      .map(toSummary);
  },
};
