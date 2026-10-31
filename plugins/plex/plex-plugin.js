/* yonto-plugin
{
  "kind": "content-source",
  "id": "plex",
  "name": "Plex",
  "version": "1.10.0",
  "contractVersion": 23,
  "description": "The Plex servers shared with you, once you log in with a code, or your own server at an address you type.",
  "probeQuery": "bunny",
  "provides": "source-type",
  "allowedHosts": ["*.plex.direct"],
  "catalogsAreRemote": true,
  "playbackTokens": true,
  "deviceProfile": true,
  "configSchema": [
    {
      "id": "serverUrl",
      "label": "Your own server's URL (leave empty to log in instead)",
      "type": "url"
    },
    {
      "id": "token",
      "label": "Plex token, only if your server asks (usually your whole Plex account's token)",
      "type": "secret"
    }
  ],
  "capabilities": [{ "type": "linkLogin", "service": "plex.tv" }]
}
*/
// Plex Media Servers (https://developer.plex.tv/pms/), read through their documented API, each
// one library. A server the viewer typed is read exactly as before the sign-in existed, with the
// token typed beside it. The host's plex.tv login lists the servers shared with the account, and
// the host attaches each one's own token: this plugin sends none to them, and never reaches
// plex.tv (plugins/plex/AGENTS.md).

// Browse pages, so this is a page and not a cap.
const PAGE_SIZE = 60;
const SEARCH_LIMIT = 50;

const MOVIE = 'movie';
const SHOW = 'show';
const LIBRARY_TYPES = [MOVIE, SHOW];

const SORT_FILTER = 'sort';
// A listing with no sort is a Home shelf, so it is the latest first. `episode.addedAt` is a show's
// newest episode, and in a film section Plex reads it as the film's own `addedAt`.
const ADDED_SORT = 'added';
const SORTS = {
  [ADDED_SORT]: { name: 'Recently added', by: 'episode.addedAt:desc' },
  title: { name: 'Title', by: 'titleSort' },
  year: { name: 'Year', by: 'year:desc' },
  rating: { name: 'Rating', by: 'audienceRating:desc' },
};
const SORT_OPTIONS = Object.keys(SORTS).map((id) => ({ id, name: SORTS[id].name }));

// Plex serves the stored artwork unless asked to resize it; these are the sizes a poster card
// and a full-bleed backdrop are drawn at on a 1080p screen.
const POSTER_SIZE = { width: 480, height: 720 };
const BACKDROP_SIZE = { width: 1920, height: 1080 };

const PRODUCT = 'Yonto Player';

// A shared server's media id is `<server id>|<ratingKey>` and the typed server's the bare
// ratingKey, so History finds a title on its own server whichever library is picked.
const ID_SEPARATOR = '|';
const TYPED_SERVER_ID = 'typed';

// The only connections the manifest can reach, and the only ones the host binds a token to.
const PLEX_DIRECT = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.plex\.direct(:\d{1,5})?$/i;
const CONNECTION_KEY = 'connection:';
// What a server answers with no token, so a 2xx there says the connection works.
const PROBE_PATH = '/identity';
// How long a direct connection may take to answer after a relay has: a relay is bandwidth-capped.
const RELAY_GRACE_MS = 1000;
// How long a relay is kept before the direct connections are probed again. Not every call: a
// television's call waits for all its requests, so each probe of a dead one costs a connect timeout.
const RELAY_KEPT_SECONDS = 10 * 60;

const SERVER_ERROR_MESSAGE = 'The server answered with an error.';
const SERVER_DOWN_MESSAGE = 'The server did not answer. Check it is running and on this network.';
const SHARED_DOWN_MESSAGE = 'None of the server\'s addresses answered.';
const SERVER_OFF_LIMITS_MESSAGE = 'The server sent this request somewhere it may not go.';
const UNUSABLE_ADDRESS_MESSAGE = 'The server URL cannot be used. Check it by editing the source in Settings.';
const REDIRECTS_REFUSED_MESSAGE = 'The server redirected too far. Check the server URL by editing the source in Settings.';
const UNREADABLE_MESSAGE = 'The server answered with something that is not a Plex library.';
const QUERY_UNUSABLE_MESSAGE = 'This search cannot be sent. Try different words.';
const TOKEN_REFUSED_MESSAGE = 'The server refused the token. Check it by editing the source in Settings.';
const TOKEN_WANTED_MESSAGE = 'The server asks for a Plex token. Add one by editing the source in Settings.';
const SHARED_REFUSED_MESSAGE = 'The server refused this login. Try again in a minute.';
const LOG_IN_MESSAGE = 'Log in to Plex, or type your own server\'s address, by editing the source in Settings.';
const ACCOUNT_DOWN_MESSAGE = 'The list of your Plex servers could not be read.';
const NO_SHARED_SERVERS_MESSAGE =
  'No Plex server is shared with this account. For your own server, add its address and token by editing the source in Settings.';
const WRITE_REFUSED_MESSAGE = 'The server did not take the update.';
const NOTHING_TO_PLAY_MESSAGE = 'The server has no playable file for this title.';

function typedServer() {
  return (yonto.config.serverUrl || '').replace(/\/+$/, '');
}

function token() {
  return yonto.config.token || '';
}

// The typed token belongs to the typed server alone: a shared server is signed by the host.
function tokenHeaders(target) {
  return target.typed && token() ? { 'X-Plex-Token': token() } : {};
}

function apiHeaders(target) {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': `lantern-${yonto.installId()}`,
    ...tokenHeaders(target),
  };
}

function queryOf(params) {
  const query = Object.keys(params || {})
    .filter((key) => params[key] !== undefined)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  return query ? `?${query}` : '';
}

function rankOf(connection) {
  if (connection.relay) return 2;
  return connection.local ? 0 : 1;
}

// Local, then remote, then relay: the order Plex's own clients prefer.
function connectionsOf(server) {
  return server.connections
    .map((connection) => ({ connection, base: String(connection.uri).replace(/\/+$/, '') }))
    .filter(({ base }) => PLEX_DIRECT.test(base))
    .sort((a, b) => rankOf(a.connection) - rankOf(b.connection))
    .map(({ connection, base }) => ({ base, relay: connection.relay === true }));
}

// The servers shared with the login, each with the connections this plugin can reach.
async function sharedServers() {
  let servers;
  try {
    servers = await yonto.session.servers();
  } catch (error) {
    yonto.log('warn', `the account's servers could not be read: ${error?.code ?? 'no code'}`);
    if (error?.code === 'REQUEST_FAILED') throw yonto.error.unreachable(ACCOUNT_DOWN_MESSAGE);
    throw error;
  }
  // Signed out, or the account refused the host's own request: the list is empty either way.
  if (!yonto.session.linked()) throw yonto.error.unauthenticated(LOG_IN_MESSAGE);
  return servers
    .filter((server) => !server.owned)
    .map((server) => ({ id: server.id, name: server.name || server.id, connections: connectionsOf(server) }))
    .filter((server) => server.connections.length > 0);
}

// Beside a typed server a login is extra: its absence or failure leaves the typed library alone,
// unless a shared server is the pick, which must not be read as the typed one without a word.
async function sharedBesideTyped() {
  if (!yonto.session.linked()) return [];
  const pick = yonto.subSource();
  if (pick !== null && pick !== TYPED_SERVER_ID) return sharedServers();
  try {
    return await sharedServers();
  } catch (error) {
    yonto.log('warn', `the shared servers were left out: ${error?.code ?? 'no code'}`);
    return [];
  }
}

// With no typed server, a login sharing nothing leaves the viewer's own server to be typed.
async function sharedOnly() {
  const servers = await sharedServers();
  if (servers.length === 0) throw yonto.error.misconfigured(NO_SHARED_SERVERS_MESSAGE);
  return servers;
}

function typedLibrary() {
  return { id: TYPED_SERVER_ID, name: typedServer().replace(/^[a-z]+:\/\//i, '') };
}

function sharedLibrary(server) {
  return { id: server.id, name: server.name };
}

async function rememberedBase(server) {
  const base = await yonto.store.get(CONNECTION_KEY + server.id);
  return server.connections.some((connection) => connection.base === base) ? base : null;
}

function typedTarget() {
  return { typed: true, base: typedServer(), prefix: '' };
}

async function sharedTarget(server) {
  const remembered = await rememberedBase(server);
  return { typed: false, server, remembered, base: null, probed: false, prefix: `${server.id}${ID_SEPARATOR}` };
}

// The picked library, falling back to the typed one and then to the first shared server.
async function pickedTarget() {
  const pick = yonto.subSource();
  if (typedServer()) {
    if (pick === null || pick === TYPED_SERVER_ID) return typedTarget();
    const server = (await sharedBesideTyped()).find((s) => s.id === pick);
    return server ? sharedTarget(server) : typedTarget();
  }
  const servers = await sharedOnly();
  return sharedTarget(servers.find((s) => s.id === pick) || servers[0]);
}

// A bare id is the typed server's ratingKey as it always was; a shared server's names its server.
async function targetOf(mediaId) {
  const at = mediaId.indexOf(ID_SEPARATOR);
  if (at === -1) return { target: typedServer() ? typedTarget() : null, key: mediaId };
  const server = (await sharedServers()).find((s) => s.id === mediaId.slice(0, at));
  return { target: server ? await sharedTarget(server) : null, key: mediaId.slice(at + 1) };
}

function refusal(error, target) {
  switch (error?.code) {
    case 'REQUEST_FAILED': return yonto.error.unreachable(target.typed ? SERVER_DOWN_MESSAGE : SHARED_DOWN_MESSAGE);
    case 'HOST_NOT_ALLOWED': return yonto.error.unavailable(SERVER_OFF_LIMITS_MESSAGE);
    case 'REDIRECT_REFUSED': return yonto.error.unavailable(REDIRECTS_REFUSED_MESSAGE);
    case 'REQUEST_INVALID':
      return target.typed ? yonto.error.misconfigured(UNUSABLE_ADDRESS_MESSAGE) : yonto.error.unavailable(UNREADABLE_MESSAGE);
    default: return error;
  }
}

async function fetchTyped(target, pathAndQuery, what) {
  try {
    return await yonto.fetch(`${target.base}${pathAndQuery}`, { headers: apiHeaders(target) });
  } catch (error) {
    // The code, never the message: a failed fetch can name the URL.
    yonto.log('warn', `${what} failed: ${error?.code ?? 'no code'}`);
    throw refusal(error, target);
  }
}

// Every connection at once, as Plex's own clients do: one after another, two that drop packets
// spend the call's budget on connect timeouts before a relay is ever asked. The first direct one
// to answer wins, and a relay only when no direct one answers within the grace.
function probe(target, what) {
  return new Promise((resolve, reject) => {
    const { connections } = target.server;
    let waiting = connections.length;
    let relay = null;
    let settled = false;
    const settle = (base) => {
      if (settled) return;
      settled = true;
      resolve(base);
    };
    const answered = () => {
      waiting -= 1;
      if (waiting > 0 || settled) return;
      if (relay !== null) settle(relay);
      else {
        settled = true;
        reject(refusal({ code: 'REQUEST_FAILED' }, target));
      }
    };
    for (const { base, relay: isRelay } of connections) {
      yonto.fetch(`${base}${PROBE_PATH}`, { headers: apiHeaders(target) }).then((response) => {
        if (!isSuccess(response.status)) {
          yonto.log('warn', `${what}: a connection answered HTTP ${response.status}`);
        } else if (!isRelay) settle(base);
        else if (relay === null) {
          relay = base;
          yonto.sleep(RELAY_GRACE_MS).then(() => settle(base), () => settle(base));
        }
        answered();
      }, (error) => {
        yonto.log('warn', `${what}: a connection did not answer: ${error?.code ?? 'no code'}`);
        answered();
      });
    }
  });
}

// The remembered connection, or the probe's winner, remembered; a relay only for a while.
async function connect(target, what) {
  if (target.remembered !== null) return target.remembered;
  target.probed = true;
  const base = await probe(target, what);
  target.remembered = base;
  const key = CONNECTION_KEY + target.server.id;
  const kept = target.server.connections.some((c) => c.base === base && c.relay)
    ? yonto.store.set(key, base, { ttlSeconds: RELAY_KEPT_SECONDS })
    : yonto.store.set(key, base);
  await kept.catch(() => {});
  return base;
}

function isSuccess(status) {
  return status >= 200 && status < 300;
}

// A remembered connection that stops answering, or answers with an error, is let go and the
// connections probed once more.
async function fetchShared(target, pathAndQuery, what, anyAnswerStands = false) {
  let response;
  try {
    if (target.base === null) target.base = await connect(target, what);
    response = await yonto.fetch(`${target.base}${pathAndQuery}`, { headers: apiHeaders(target) });
  } catch (error) {
    yonto.log('warn', `${what} failed: ${error?.code ?? 'no code'}`);
    if (error?.code !== 'REQUEST_FAILED' && error?.code !== 'UNREACHABLE') throw refusal(error, target);
    await yonto.store.remove(CONNECTION_KEY + target.server.id).catch(() => {});
    if (target.probed) throw refusal({ code: 'REQUEST_FAILED' }, target);
    return probedAgain(target, pathAndQuery, what, anyAnswerStands);
  }
  if (target.probed || anyAnswerStands || isSuccess(response.status)) return response;
  yonto.log('warn', `${what} got HTTP ${response.status} from the connection it kept`);
  await yonto.store.remove(CONNECTION_KEY + target.server.id).catch(() => {});
  return probedAgain(target, pathAndQuery, what, anyAnswerStands);
}

function probedAgain(target, pathAndQuery, what, anyAnswerStands) {
  target.remembered = null;
  target.base = null;
  return fetchShared(target, pathAndQuery, what, anyAnswerStands);
}

async function get(target, path, what, params) {
  // Outside the fetch's try: a lone surrogate in a search makes `encodeURIComponent` throw,
  // and that is not the server's failure (kangzj/lantern-tv#293).
  let query;
  try {
    query = queryOf(params);
  } catch {
    yonto.log('warn', `could not build the ${what} request from what was typed`);
    throw yonto.error.unavailable(QUERY_UNUSABLE_MESSAGE);
  }
  const response = target.typed
    ? await fetchTyped(target, `${path}${query}`, what)
    : await fetchShared(target, `${path}${query}`, what);
  if (response.status === 401 || response.status === 403) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    if (!target.typed) {
      // The token the host attached was refused: it asks plex.tv again on the next call.
      yonto.session.refused();
      throw yonto.error.unavailable(SHARED_REFUSED_MESSAGE);
    }
    const message = token() ? TOKEN_REFUSED_MESSAGE : TOKEN_WANTED_MESSAGE;
    // Signed out, nothing is bound to a typed server, so no sign-in answers this. Signed in, the
    // host may have bound a shared server's credential over the typed token (an IP literal that
    // matches one), so the refusal may be plex.tv's: ask again and leave the sign-in offered.
    if (!yonto.session.linked()) throw yonto.error.unauthenticated(message, { signIn: false });
    yonto.session.refused();
    throw yonto.error.unauthenticated(message);
  }
  if (response.status === 404) throw yonto.error.notFound(what);
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unreachable(SERVER_ERROR_MESSAGE);
  }
  return containerOf(response, what);
}

// A read whose refusal says nothing about the login: like a write, it never asks plex.tv again or
// probes past the kept connection.
async function ask(target, path, what, params) {
  const pathAndQuery = `${path}${queryOf(params)}`;
  const response = target.typed
    ? await fetchTyped(target, pathAndQuery, what)
    : await fetchShared(target, pathAndQuery, what, true);
  if (!isSuccess(response.status)) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unavailable(SERVER_ERROR_MESSAGE);
  }
  return containerOf(response, what);
}

function containerOf(response, what) {
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    payload = undefined;
  }
  if (!payload || typeof payload.MediaContainer !== 'object' || payload.MediaContainer === null) {
    yonto.log('warn', `${what} answered 200 with no MediaContainer`);
    throw yonto.error.unavailable(UNREADABLE_MESSAGE);
  }
  return payload.MediaContainer;
}

// A write the server did not take is only logged and thrown: unlike a read, a refusal here must
// not ask plex.tv again, sign the viewer out or make the kept connection be probed past, since a
// friend's library may not take writes.
async function write(target, path, params, what) {
  const query = queryOf({ identifier: LIBRARY_IDENTIFIER, ...params });
  const response = target.typed
    ? await fetchTyped(target, `${path}${query}`, what)
    : await fetchShared(target, `${path}${query}`, what, true);
  if (!isSuccess(response.status)) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unavailable(WRITE_REFUSED_MESSAGE);
  }
}

// The ratingKey a report or a mark is for: the episode's, or the title's own for a film.
async function writeTargetOf({ mediaId, optionId }) {
  const { target, key } = await targetOf(mediaId);
  if (!target) throw yonto.error.notFound(mediaId);
  return { target, ratingKey: optionId || key };
}

const TIMELINE_STATES = { start: 'playing', progress: 'playing', stop: 'stopped' };

function milliseconds(seconds) {
  return String(Math.max(Math.round(seconds * 1000), 0));
}

function list(container, key) {
  return Array.isArray(container[key]) ? container[key] : [];
}

// No token in the URL: the app signs the typed host's artwork with `getImageHeaders()`, and a
// shared server's with the host's own token.
function imageUrl(target, path, size) {
  if (!path) return undefined;
  return `${target.base}/photo/:/transcode${queryOf({
    url: path,
    width: String(size.width),
    height: String(size.height),
    minSize: '1',
    upscale: '1',
  })}`;
}

function mediaType(item) {
  return item.type === SHOW ? 'SERIES' : 'MOVIE';
}

function yearOf(item) {
  return item.year === null || item.year === undefined ? undefined : String(item.year);
}

// Plex lists a title's database ids as `Guid` entries like `tmdb://603`. A listing and a search leave them out
// unless asked; a detail already has them.
const WITH_GUIDS = { includeGuids: '1' };
const DATABASE_GUID = /^(tmdb|imdb|tvdb):\/\/(.+)$/;

function idsOf(item) {
  const ids = {};
  for (const guid of list(item, 'Guid')) {
    const match = DATABASE_GUID.exec(guid.id || '');
    if (match) ids[match[1]] = match[2];
  }
  return Object.keys(ids).length === 0 ? undefined : ids;
}

const LIBRARY_IDENTIFIER = 'com.plexapp.plugins.library';

// What the server says of the viewer's place, from `viewCount`, `viewOffset` (ms) and
// `lastViewedAt` (epoch seconds). Plex leaves `viewCount` out of an unwatched title, so a movie or
// an episode without one is unwatched; a show is watched when every leaf is, and says nothing when
// it does not count them. A title being watched again has both a count and an offset, and the
// offset wins, as in Plex Web.
function playStateOf(item) {
  const state = {};
  const offset = Number(item.viewOffset);
  const resuming = Number.isFinite(offset) && offset > 0;
  if (item.type === SHOW) {
    if (Number(item.leafCount) > 0 && Number.isFinite(Number(item.viewedLeafCount))) {
      state.played = Number(item.viewedLeafCount) >= Number(item.leafCount);
    }
  } else {
    state.played = Number(item.viewCount) > 0 && !resuming;
  }
  if (resuming) state.position = offset / 1000;
  const viewedAt = Number(item.lastViewedAt);
  if (Number.isFinite(viewedAt) && viewedAt > 0) state.playedAt = new Date(viewedAt * 1000).toISOString();
  return state;
}

function toSummary(target, item) {
  return {
    ...playStateOf(item),
    id: `${target.prefix}${item.ratingKey}`,
    title: item.title,
    type: mediaType(item),
    posterUrl: imageUrl(target, item.thumb, POSTER_SIZE),
    backdropUrl: imageUrl(target, item.art, BACKDROP_SIZE),
    year: yearOf(item),
    rating: item.contentRating || undefined,
    ids: idsOf(item),
  };
}

// The part key is the one string the server puts straight after our host, so it has to be a
// path on that host: `@evil.example/x` or `//evil.example/x` would move the stream, and the
// token in its headers, somewhere else.
const PATH_ON_THIS_HOST = /^\/(?![/\\])/;

function firstPartKey(media) {
  const part = (media.Part || [])[0];
  const key = part && part.key;
  return typeof key === 'string' && PATH_ON_THIS_HOST.test(key) ? key : undefined;
}

// The contract reads a stream with no mimeType as HLS, so a file has to say it is not one.
// Past that the player sniffs the container itself; these only name it where Plex did.
const CONTAINER_TYPES = { mkv: 'video/x-matroska', webm: 'video/webm', ts: 'video/mp2t', mpegts: 'video/mp2t' };
const DEFAULT_FILE_TYPE = 'video/mp4';

// The contract's cap on one stream's subtitles.
const MAX_SUBTITLES = 32;
const SUBTITLE_STREAM_TYPE = 3;
// Plex serves a subtitle file as it is stored, so only the formats the host plays are offered.
const SUBTITLE_TYPES = {
  srt: 'application/x-subrip',
  subrip: 'application/x-subrip',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
};

// A part's subtitle files: an embedded track has no `key` of its own and is in the file already.
// A detail carries a part's streams; a listing such as `allLeaves` does not.
function subtitlesOf(target, media) {
  const part = (media.Part || [])[0] || {};
  return list(part, 'Stream')
    .filter((stream) => stream.streamType === SUBTITLE_STREAM_TYPE && typeof stream.key === 'string'
      && PATH_ON_THIS_HOST.test(stream.key) && SUBTITLE_TYPES[String(stream.codec).toLowerCase()])
    .slice(0, MAX_SUBTITLES)
    .map((stream) => ({
      url: `${target.base}${stream.key}`,
      label: stream.displayTitle || stream.language || 'Subtitles',
      language: stream.languageTag || undefined,
      mimeType: SUBTITLE_TYPES[String(stream.codec).toLowerCase()],
      forced: stream.forced === true,
      default: stream.default === true,
    }));
}

// The contract's cap on one stream's segments, and the marker types Plex names that the contract does too.
const MAX_SEGMENTS = 32;
const MARKER_TYPES = { intro: 'intro', credits: 'credits' };

// Plex marks in milliseconds. A final credits marker runs to the end of the file, which the
// contract says by leaving `end` out.
function segmentsOf(item) {
  return list(item, 'Marker')
    .filter((marker) => MARKER_TYPES[marker.type] && Number.isFinite(marker.startTimeOffset) && marker.startTimeOffset >= 0)
    .slice(0, MAX_SEGMENTS)
    .map((marker) => {
      const segment = { type: MARKER_TYPES[marker.type], start: marker.startTimeOffset / 1000 };
      const ends = marker.endTimeOffset > marker.startTimeOffset;
      if (ends && marker.final !== true) segment.end = marker.endTimeOffset / 1000;
      // Only credits may run to the end: for an intro that would be a button to skip the film.
      return segment.type === 'credits' || ends ? segment : null;
    })
    .filter(Boolean);
}

// The part's own path is Plex's direct play: the file as stored, with the typed token as a
// header so it is never in a URL the player might log.
function streamOf(target, media, item) {
  const stream = {
    url: `${target.base}${firstPartKey(media)}`,
    mimeType: CONTAINER_TYPES[media.container] || DEFAULT_FILE_TYPE,
  };
  const headers = tokenHeaders(target);
  if (headers['X-Plex-Token']) stream.headers = headers;
  const subtitles = subtitlesOf(target, media);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  const segments = segmentsOf(item);
  if (segments.length > 0) stream.segments = segments;
  return stream;
}

// What the device plays, in the names a Plex client profile uses.
const CONTAINER_NAMES = { mp4: 'mp4,mov', mkv: 'mkv', webm: 'webm', ts: 'mpegts' };
const AUDIO_NAMES = { dts: 'dca' };
const TRANSCODE_AUDIO = ['aac', 'ac3', 'eac3'];
// The transfer each HDR format the screen shows is carried in.
const SHOWN_TRANSFERS = { hdr10: 'smpte2084', hdr10plus: 'smpte2084', dolbyVision: 'smpte2084', hlg: 'arib-std-b67' };
const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67'];
// Profile 5's base layer, which shows right only where the screen decodes Dolby Vision itself.
const DOLBY_VISION_ONLY_LAYER = '0';
const HLS_MIME = 'application/x-mpegURL';
const TRANSCODE = '/video/:/transcode/universal';

function listOf(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function limitation(codec, type, name, value) {
  return `add-limitation(scope=videoCodec&scopeName=${codec}&type=${type}&name=${name}&${value}&isRequired=false)`;
}

// The device as `X-Plex-Client-Profile-Extra` says it to the `Generic` profile, which has nothing of
// its own: a video beyond a decoder's size or bit depth is converted to H.264, and HEVC the device
// plays is copied, in fMP4, the one HLS container AVPlayer takes it in. The screen's range is a
// limitation only on a server that tone-maps, which takes Plex Pass: without it a conversion is no
// truer to the colours than the file.
function profileExtraOf(device, toneMaps, media) {
  const video = (Array.isArray(device.video) ? device.video : []).filter((v) => v && typeof v.codec === 'string');
  const audio = listOf(device.audio);
  const shown = listOf(device.hdr);
  const containers = listOf(device.containers).map((name) => CONTAINER_NAMES[name]).filter(Boolean);
  const transcodeAudio = TRANSCODE_AUDIO.filter((codec) => audio.includes(codec));
  const copiesHevc = video.some((v) => v.codec === 'hevc');
  const unshown = HDR_TRANSFERS.filter((transfer) => !shown.some((format) => SHOWN_TRANSFERS[format] === transfer));
  const parts = [
    `add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=${copiesHevc ? 'mp4' : 'mpegts'}`
      + `&videoCodec=h264&audioCodec=${(transcodeAudio.length > 0 ? transcodeAudio : ['aac']).join(',')})`,
    ...(copiesHevc ? ['append-transcode-target-codec(type=videoProfile&context=streaming&protocol=hls&videoCodec=hevc)'] : []),
    `add-direct-play-profile(type=videoProfile&protocol=http&container=${containers.join(',')}`
      + `&videoCodec=${video.map((v) => v.codec).join(',')}&audioCodec=${audio.map((codec) => AUDIO_NAMES[codec] || codec).join(',')})`,
    ...softwareProfileOf(device, video, media),
  ];
  for (const v of video) {
    parts.push(limitation(v.codec, 'upperBound', 'video.width', `value=${v.maxWidth}`));
    parts.push(limitation(v.codec, 'upperBound', 'video.height', `value=${v.maxHeight}`));
    parts.push(limitation(v.codec, 'upperBound', 'video.bitDepth', `value=${v.maxBitDepth}`));
    if (toneMaps && unshown.length > 0) parts.push(limitation(v.codec, 'notMatch', 'video.colorTrc', `list=${unshown.join('|')}`));
    if (toneMaps && !shown.includes('dolbyVision')) {
      parts.push(limitation(v.codec, 'notMatch', 'video.DOVIBLCompatID', `list=${DOLBY_VISION_ONLY_LAYER}`));
    }
  }
  return parts.join('+');
}

// What the device's software player also plays as stored: its containers, with the video it decodes in the device's own
// hardware and a picture it shows, SDR or a range it names, never Dolby Vision.
function softwareProfileOf(device, video, media) {
  const player = device.softwarePlayer;
  if (!player || typeof player !== 'object' || !showsRange(player, (videoOf(media).video || {}).range)) return [];
  const codecs = listOf(player.video).filter((codec) => video.some((v) => v.codec === codec));
  const containers = listOf(player.containers).map((name) => CONTAINER_NAMES[name]).filter(Boolean);
  if (codecs.length === 0 || containers.length === 0) return [];
  return [`add-direct-play-profile(type=videoProfile&protocol=http&container=${containers.join(',')}`
    + `&videoCodec=${codecs.join(',')}&audioCodec=${listOf(player.audio).map((codec) => AUDIO_NAMES[codec] || codec).join(',')})`];
}

// An unread range is taken as SDR, as a player takes a file that says nothing of its colour.
function showsRange(player, range = 'sdr') {
  return range !== 'dolbyVision' && (range === 'sdr' || listOf(player.hdr).includes(range));
}

// The largest picture any decoder plays, which caps what a conversion encodes.
function resolutionOf(device) {
  const video = (Array.isArray(device.video) ? device.video : []).filter((v) => v && v.maxWidth > 0 && v.maxHeight > 0);
  if (video.length === 0) return '1920x1080';
  const largest = video.reduce((best, v) => (v.maxWidth * v.maxHeight > best.maxWidth * best.maxHeight ? v : best));
  return `${largest.maxWidth}x${largest.maxHeight}`;
}

/** Each server's answer, by `passKeyOf`, kept while the plugin runs. */
const plexPasses = new Map();

function passKeyOf(target) {
  return target.typed ? `typed ${target.base} ${token()}` : `shared ${target.server.id}`;
}

// The server root names its owner's Plex Pass, which its tone mapping needs. A read that failed is
// not kept, so the next play asks again.
async function hasPlexPass(target) {
  const key = passKeyOf(target);
  if (plexPasses.has(key)) return plexPasses.get(key);
  try {
    const pass = (await ask(target, '/', 'server')).myPlexSubscription === true;
    plexPasses.set(key, pass);
    return pass;
  } catch {
    return false;
  }
}

// Fresh for each play: Plex keys its conversion by it, and a stop that names it ends that one.
function newPlaySession() {
  return `${yonto.installId()}-${yonto.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// What the server decided for this device: the file as stored where it plays, or its own HLS
// conversion. The conversion's address carries everything Plex needs in its query, so the player
// sends nothing but the token a file would get, and no bitrate cap is sent: one makes Plex convert a
// file it has not deeply analysed, whose bitrate it then counts as unbounded. Anything the decision
// cannot answer plays the file as stored, as it always did.
async function decidedStream(target, item, media, device, start) {
  const playSession = newPlaySession();
  let params;
  let decided;
  try {
    params = {
      path: `/library/metadata/${item.ratingKey}`,
      mediaIndex: String((item.Media || []).indexOf(media)),
      partIndex: '0',
      protocol: 'hls',
      directPlay: '1',
      directStream: '1',
      directStreamAudio: '1',
      fastSeek: '1',
      subtitles: 'none',
      videoResolution: resolutionOf(device),
      session: playSession,
      'X-Plex-Session-Identifier': playSession,
      'X-Plex-Product': PRODUCT,
      'X-Plex-Client-Identifier': `lantern-${yonto.installId()}`,
      'X-Plex-Platform': 'Generic',
      'X-Plex-Client-Profile-Extra': profileExtraOf(device, await hasPlexPass(target), media),
      // Where the play starts, so a conversion starts there rather than at 0 and again at the seek.
      ...(start > 0 ? { offset: String(Math.floor(start)) } : {}),
    };
    const answer = await ask(target, `${TRANSCODE}/decision`, 'playback decision', params);
    const part = ((list(answer, 'Metadata')[0] || {}).Media || [])[0];
    decided = part && ((part.Part || [])[0] || {}).decision;
  } catch (error) {
    yonto.log('warn', `the playback decision failed, playing the file as stored: ${error?.code ?? 'no code'}`);
  }
  if (decided === 'directplay') return { ...streamOf(target, media, item), session: sessionOf(playSession, 'directplay') };
  if (decided !== 'transcode') return streamOf(target, media, item);
  const stream = {
    url: `${target.base}${TRANSCODE}/start.m3u8${queryOf(params)}`,
    mimeType: HLS_MIME,
    session: sessionOf(playSession, 'transcode'),
  };
  const headers = tokenHeaders(target);
  if (headers['X-Plex-Token']) stream.headers = headers;
  const subtitles = subtitlesOf(target, media);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  const segments = segmentsOf(item);
  if (segments.length > 0) stream.segments = segments;
  return stream;
}

// Handed back on every report about this play: a timeline that names it is Plex's own client's,
// and the stopped one ends the conversion.
function sessionOf(playSession, method) {
  return JSON.stringify({ playSession, method });
}

function playSessionOf(session) {
  try {
    const decoded = JSON.parse(session);
    return decoded && typeof decoded === 'object' && typeof decoded.playSession === 'string' ? decoded.playSession : null;
  } catch {
    return null;
  }
}

const VIDEO_STREAM_TYPE = 1;
const TRANSFER_RANGES = { smpte2084: 'hdr10', 'arib-std-b67': 'hlg' };

// What a version is: its size from the `Media`, and its range from its video stream, which only a
// title's own detail lists (`allLeaves` does not), Dolby Vision whatever layer it carries beside.
function videoOf(media) {
  const width = positive(media.width);
  const height = positive(media.height);
  const stream = list((media.Part || [])[0] || {}, 'Stream').find((s) => s.streamType === VIDEO_STREAM_TYPE);
  let range;
  if (stream) range = stream.DOVIPresent === true ? 'dolbyVision' : TRANSFER_RANGES[stream.colorTrc] || 'sdr';
  const video = { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(range ? { range } : {}) };
  return Object.keys(video).length > 0 ? { video } : {};
}

function positive(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// A film's version rides on its track after this, so the version picked is the one redeemed.
const VERSION_SEPARATOR = '#';

// One option per version of a movie, named by resolution only when there is more than one, each a
// track redeemed on Play: what the server decides to send is for one play on one device, and a
// detail is cached and kept.
function movieOptions(target, item) {
  const playable = (item.Media || []).filter(firstPartKey);
  return playable.map((media) => ({
    label: playable.length > 1 && media.videoResolution ? `Play ${media.videoResolution}` : 'Play',
    id: String(item.ratingKey),
    track: playable.length > 1
      ? `${target.prefix}${item.ratingKey}${VERSION_SEPARATOR}${media.id}`
      : `${target.prefix}${item.ratingKey}`,
    ...videoOf(media),
  }));
}

// An episode is a `track` the player redeems with `getStream`, since `allLeaves` leaves out the
// streams that list its subtitle files: one detail call for the episode played, not one per episode.
function episodeOptions(target, episodes) {
  return episodes
    .filter((episode) => firstPartKey((episode.Media || [])[0] || {}))
    .map((episode) => {
      const season = episode.parentIndex ?? 1;
      const number = episode.index ?? 0;
      return {
        ...playStateOf(episode),
        id: String(episode.ratingKey),
        label: `S${season}E${String(number).padStart(2, '0')} · ${episode.title}`,
        track: `${target.prefix}${episode.ratingKey}`,
        season,
        ...episodeNumberOf(episode),
        ...videoOf((episode.Media || [])[0] || {}),
      };
    });
}

// Only the server's own numbers, never the label's defaults: the host asks a skip-times
// database by them, and a guessed season would ask about another episode.
function episodeNumberOf(episode) {
  return Number.isInteger(episode.parentIndex) && Number.isInteger(episode.index) ? { episode: episode.index } : {};
}

async function metadataOf(mediaId) {
  const { target, key } = await targetOf(mediaId);
  if (!target) throw yonto.error.notFound(mediaId);
  const path = `/library/metadata/${encodeURIComponent(key)}`;
  const item = list(await get(target, path, mediaId, { includeMarkers: '1' }), 'Metadata')[0];
  if (!item) throw yonto.error.notFound(mediaId);
  return { target, path, item };
}

export default {
  // Only the typed host is ever signed with this: the host signs no `*.` entry's hosts.
  async getImageHeaders() {
    return typedServer() ? tokenHeaders(typedTarget()) : {};
  },

  // The token is typed into the form, so only the viewer can replace one the server refused.
  async onImageHeadersRefused() {
    return { renewable: false };
  },

  // One library per server: the typed one first, then each one shared with the login.
  async getSubSources() {
    const items = typedServer()
      ? [typedLibrary(), ...(await sharedBesideTyped()).map(sharedLibrary)]
      : (await sharedOnly()).map(sharedLibrary);
    const pick = yonto.subSource();
    return { items, activeId: (items.find((item) => item.id === pick) || items[0]).id };
  },

  async getCategories() {
    const target = await pickedTarget();
    return list(await get(target, '/library/sections/all', 'libraries'), 'Directory')
      .filter((section) => LIBRARY_TYPES.indexOf(section.type) !== -1)
      .map((section) => ({ id: String(section.key), name: section.title }));
  },

  async getFilters() {
    return [{ id: SORT_FILTER, name: 'Sort', options: SORT_OPTIONS, init: ADDED_SORT }];
  },

  async getMediaList(categoryId, options) {
    const { page = 1, filters = {} } = options || {};
    const target = await pickedTarget();
    const container = await get(target, `/library/sections/${encodeURIComponent(categoryId)}/all`, categoryId, {
      ...WITH_GUIDS,
      sort: SORTS[filters[SORT_FILTER] || ADDED_SORT].by,
      'X-Plex-Container-Start': String(Math.max(page - 1, 0) * PAGE_SIZE),
      'X-Plex-Container-Size': String(PAGE_SIZE),
    });
    return list(container, 'Metadata').map((item) => toSummary(target, item));
  },

  async getMediaDetail(mediaId) {
    const { target, path, item } = await metadataOf(mediaId);
    const options = item.type === SHOW
      ? episodeOptions(target, list(await get(target, `${path}/allLeaves`, mediaId), 'Metadata'))
      : movieOptions(target, item);
    if (options.length === 0) {
      yonto.log('warn', `${item.type} has no media part to play`);
      throw yonto.error.unavailable(NOTHING_TO_PLAY_MESSAGE);
    }
    return {
      ...toSummary(target, item),
      genres: list(item, 'Genre').map((genre) => genre.tag),
      synopsis: item.summary || '',
      playbackOptions: options,
    };
  },

  // A `track` is its media id, after which a film with several versions names the one picked, and
  // its own detail is what lists its subtitle files. With what the device plays, the server decides;
  // without it (a download, an older app) the file is sent as stored.
  async getStream(track, asked) {
    const [mediaId, version] = track.split(VERSION_SEPARATOR);
    const { target, item } = await metadataOf(mediaId);
    const playable = (item.Media || []).filter(firstPartKey);
    const media = version === undefined ? playable[0] : playable.find((m) => String(m.id) === version);
    if (!media) {
      yonto.log('warn', `${item.type} has no media part to play`);
      throw yonto.error.unavailable(NOTHING_TO_PLAY_MESSAGE);
    }
    const device = asked && asked.device;
    const start = asked && Number.isFinite(asked.start) ? asked.start : 0;
    return device && typeof device === 'object' ? decidedStream(target, item, media, device, start) : streamOf(target, media, item);
  },

  // Plex's /:/timeline moves the server's resume point and shows a session; a finished title is
  // scrobbled after it, so the last word on the server is "watched". A play the server decided
  // names its session, so the stopped timeline ends the server's conversion.
  async reportPlayback(report) {
    const { target, ratingKey } = await writeTargetOf(report);
    const state = report.paused && report.event !== 'stop' ? 'paused' : TIMELINE_STATES[report.event];
    const playSession = playSessionOf(report.session);
    const params = {
      ratingKey,
      key: `/library/metadata/${ratingKey}`,
      state,
      time: milliseconds(report.position),
      ...(playSession ? { 'X-Plex-Session-Identifier': playSession } : {}),
    };
    if (report.duration > 0) params.duration = milliseconds(report.duration);
    const finished = report.event === 'stop' && report.finished === true;
    try {
      await write(target, '/:/timeline', params, 'timeline');
    } finally {
      // The scrobble is what marks it watched, so a timeline the server dropped must not skip it.
      if (finished) await write(target, '/:/scrobble', { key: ratingKey }, 'scrobble');
    }
  },

  async setPlayed(change) {
    const { target, ratingKey } = await writeTargetOf(change);
    await write(target, change.played ? '/:/scrobble' : '/:/unscrobble', { key: ratingKey }, 'mark');
  },

  // On Deck: what Plex would resume or play next. An episode is its show's summary with the
  // episode as the option to open.
  async getContinueWatching() {
    const target = await pickedTarget();
    const items = list(await get(target, '/library/onDeck', 'on deck'), 'Metadata').flatMap((item) => {
      if (item.type === 'episode' && item.grandparentRatingKey !== undefined) {
        const show = toSummary(target, {
          type: SHOW,
          ratingKey: item.grandparentRatingKey,
          title: item.grandparentTitle || item.title,
          thumb: item.grandparentThumb,
          art: item.grandparentArt,
        });
        return [{ ...show, ...playStateOf(item), optionId: String(item.ratingKey) }];
      }
      return item.type === MOVIE ? [toSummary(target, item)] : [];
    });
    return { items };
  },

  async search(query) {
    const target = await pickedTarget();
    const hubs = list(await get(target, '/hubs/search', 'search', { ...WITH_GUIDS, query, limit: String(SEARCH_LIMIT) }), 'Hub');
    return hubs
      .filter((hub) => LIBRARY_TYPES.indexOf(hub.type) !== -1)
      .flatMap((hub) => list(hub, 'Metadata'))
      .map((item) => toSummary(target, item));
  },
};
