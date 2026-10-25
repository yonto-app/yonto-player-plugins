/* yonto-plugin
{
  "kind": "content-source",
  "id": "emby",
  "name": "Emby",
  "version": "1.6.0",
  "contractVersion": 23,
  "description": "An Emby media server, reached with an ordinary login or with a server-generated API key. Not affiliated with Emby.",
  "probeQuery": "pattern",
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
// An Emby media server (https://emby.media), through its own REST API. plugins/emby/AGENTS.md
// has what a real 4.10 server confirmed and how it differs from Jellyfin.

// Home only ever asks for page 1, so this caps what a shelf can show (see jellyfin's AGENTS.md).
const PAGE_SIZE = 500;
const RECOMMENDATION_COUNT = 10;
const CONTINUE_WATCHING_COUNT = 30;
const TICKS_PER_SECOND = 10000000;

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
const LIST_ITEM_FIELDS = 'ProductionYear,OfficialRating,ProviderIds';
const RANKED_ITEM_FIELDS = `${LIST_ITEM_FIELDS},CommunityRating`;
const DETAIL_ITEM_FIELDS = 'Genres,Overview,ProductionYear,OfficialRating,ProviderIds,MediaSources,Chapters';
// The media source carries the subtitle files and the id their address needs.
const STREAM_FIELDS = 'MediaSources,Chapters';
// An episode's size, which a listing gives cheaply; its range is only in its own media source.
const EPISODE_FIELDS = 'Width,Height';

const POSTER_MAX_WIDTH = 480;
const BACKDROP_MAX_WIDTH = 1920;
const IMAGE_QUALITY = 90;

// A hint for a progressive stream, not a claim about the container: the player sniffs the bytes.
const MIME_MP4 = 'video/mp4';
const MIME_HLS = 'application/x-mpegURL';

// jellyfin-plugin.js has the why of these; Emby converts SAMI to SubRip too (checked on 4.9.3).
const MAX_SUBTITLES = 32;
const MAX_SEGMENTS = 32;
const SUBTITLE_FORMATS = { subrip: 'srt', srt: 'srt', ass: 'ass', ssa: 'ssa', webvtt: 'vtt', vtt: 'vtt' };
const CONVERTED_FORMAT = 'srt';
const SUBTITLE_TYPES = { srt: 'application/x-subrip', ass: 'text/x-ssa', ssa: 'text/x-ssa', vtt: 'text/vtt' };
const UNDETERMINED_LANGUAGE = 'und';

const SERVER_ERROR_MESSAGE = 'The server answered with an error.';
const SERVER_SILENT_MESSAGE = 'The server did not answer.';
const SERVER_UNREADABLE_MESSAGE = 'The server answered with a page that is not the media server: check the server URL.';
const UNKNOWN_EVENT_MESSAGE = 'The playback report names an event this source does not send.';
const SIGN_IN_FAILED_MESSAGE = 'Signing in failed: the server answered with an error.';
const NO_TOKEN_MESSAGE = 'Signing in failed: the server accepted the sign-in but sent back no session.';
const NO_CREDENTIALS_MESSAGE =
  'This source has no credentials: fill in a username and password, or an API key and user ID.';
const NO_USER_ID_MESSAGE =
  'This source has an API key but no user ID: fill that in, or use a username and password instead.';
const KEY_REFUSED_MESSAGE = 'Check the API key and user ID by editing the source in Settings.';
const LOGIN_REFUSED_MESSAGE = 'Check the username and password by editing the source in Settings.';
const ACCOUNT_REFUSED_MESSAGE = "Check this account's permissions on the server.";

const CLIENT = 'Yonto Player';
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

// Emby's own port, tried when a typed address names none; jellyfin-plugin.js has the why.
const DEFAULT_PORT = '8096';
const ADDRESS_KEY = 'address';

/** `{ typed, base }`: the saved address and where that server actually answered. */
let reached = null;
let finding = null;

/** The same address on Emby's own port, or null when it has a port or `https://`. */
function withDefaultPort(typed) {
  const parts = /^http:\/\/([^/?#]+)(.*)$/i.exec(typed);
  if (!parts || /:\d*$/.test(parts[1])) return null;
  return `http://${parts[1]}:${DEFAULT_PORT}${parts[2]}`;
}

function base() {
  return reached && reached.typed === server() ? reached.base : server();
}

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
  const [onTyped, onFallback] = await Promise.allSettled([answersAsEmby(typed), answersAsEmby(fallback)]);
  for (const [candidate, probe] of [[typed, onTyped], [fallback, onFallback]]) {
    if (probe.status === 'fulfilled' && probe.value) {
      reached = { typed, base: candidate };
      await yonto.store.set(ADDRESS_KEY, reached);
      return;
    }
  }
  yonto.log('warn', 'neither the address as typed nor its default port answered as an Emby');
  // The typed address's own failure, not a third request: a host that drops packets would run the call out of time.
  if (onTyped.status === 'rejected') throw onTyped.reason;
}

/** `/System/Info/Public` needs no sign-in, and only a media server answers it with its id. */
async function answersAsEmby(candidate) {
  const response = await send(`${candidate}/emby/System/Info/Public`, { headers: { Accept: 'application/json' } });
  if (response.status < 200 || response.status >= 300) return false;
  try {
    const info = JSON.parse(response.body);
    return typeof info?.Id === 'string' && info.Id !== '';
  } catch {
    return false;
  }
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

  await reach();
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
  return `${base()}/emby/${path}${query ? `?${query}` : ''}`;
}

/** `yonto.fetch`, with a server that gave no answer said as `unreachable`, and the address it
 *  found forgotten so the next call looks again. */
async function send(address, init) {
  try {
    return await yonto.fetch(address, init);
  } catch (error) {
    // The code, never the message, which can name the URL.
    yonto.log('warn', `the request failed: ${error?.code ?? 'no code'}`);
    if (error?.code === 'REQUEST_FAILED') {
      if (reached) {
        reached = null;
        await yonto.store.remove(ADDRESS_KEY);
      }
      throw yonto.error.unreachable(SERVER_SILENT_MESSAGE);
    }
    throw error;
  }
}

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
    // A login's token can be revoked, so the first refusal renews it once; a second is the account.
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

// A title the server never matched has none, and the server only knows these three.
function idsOf(item) {
  const given = item.ProviderIds || {};
  const ids = {};
  if (given.Tmdb) ids.tmdb = String(given.Tmdb);
  if (given.Imdb) ids.imdb = String(given.Imdb);
  if (given.Tvdb) ids.tvdb = String(given.Tvdb);
  return Object.keys(ids).length === 0 ? undefined : ids;
}

// The server's place for this viewer, asked for with `EnableUserData=true`. A title it sends
// no `UserData` for says nothing here either, and a zero position is not sent: it is what an
// unwatched or finished title holds.
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

function defaultSource(item) {
  return (Array.isArray(item.MediaSources) ? item.MediaSources : [])[0];
}

// The subtitle files beside the default source's video, the one the stream plays. Their
// address names that source's own id, which on Emby is not the item id. An embedded track is in
// the stream already, unless the server converts it, whose HLS carries none, so then the server
// extracts it as a file too.
function subtitlesOf(item, embeddedToo = false) {
  const source = defaultSource(item);
  if (!source || typeof source.Id !== 'string' || !source.Id) return [];
  return (Array.isArray(source.MediaStreams) ? source.MediaStreams : [])
    .filter((stream) => stream && stream.Type === 'Subtitle' && (embeddedToo || stream.IsExternal === true)
      && stream.IsTextSubtitleStream === true && Number.isInteger(stream.Index))
    .slice(0, MAX_SUBTITLES)
    .map((stream) => {
      const format = SUBTITLE_FORMATS[String(stream.Codec).toLowerCase()] || CONVERTED_FORMAT;
      const language = stream.Language && stream.Language !== UNDETERMINED_LANGUAGE ? stream.Language : undefined;
      return {
        url: url(['Videos', item.Id, source.Id, 'Subtitles', String(stream.Index), `Stream.${format}`], {}),
        label: stream.Title || stream.DisplayLanguage || language || stream.DisplayTitle || 'Subtitles',
        language,
        mimeType: SUBTITLE_TYPES[format],
        forced: stream.IsForced === true,
        default: stream.IsDefault === true,
      };
    });
}

// Emby keeps its intro and credits marks as chapters whose `MarkerType` says so, in ticks: an intro is
// an `IntroStart` and the next `IntroEnd`, and credits are a `CreditsStart` that runs to the end.
function segmentsOf(item) {
  const marks = (Array.isArray(item.Chapters) ? item.Chapters : [])
    .filter((chapter) => chapter && chapter.StartPositionTicks >= 0
      && ['IntroStart', 'IntroEnd', 'CreditsStart'].includes(chapter.MarkerType))
    .sort((a, b) => a.StartPositionTicks - b.StartPositionTicks);
  const segments = marks.filter((mark) => mark.MarkerType === 'CreditsStart')
    .map((mark) => ({ type: 'credits', start: mark.StartPositionTicks / TICKS_PER_SECOND }));
  // An IntroStart counts only when the very next intro mark is its IntroEnd.
  const intro = marks.filter((mark) => mark.MarkerType !== 'CreditsStart');
  intro.forEach((mark, index) => {
    const end = intro[index + 1];
    if (mark.MarkerType === 'IntroStart' && end && end.MarkerType === 'IntroEnd' && end.StartPositionTicks > mark.StartPositionTicks) {
      segments.push({ type: 'intro', start: mark.StartPositionTicks / TICKS_PER_SECOND, end: end.StartPositionTicks / TICKS_PER_SECOND });
    }
  });
  return segments.sort((a, b) => a.start - b.start).slice(0, MAX_SEGMENTS);
}

// No MediaSourceId: Emby's is not the item id (it answers 400 to that), and without one it
// serves the item's default source.
function streamOf(item, token) {
  const stream = {
    url: url(['Videos', item.Id, 'stream'], { Static: 'true' }),
    mimeType: MIME_MP4,
    headers: authHeaders(token),
  };
  const subtitles = subtitlesOf(item);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  const segments = segmentsOf(item);
  if (segments.length > 0) stream.segments = segments;
  return stream;
}

// What the device plays, in the names an Emby DeviceProfile uses. Emby compares a video's range by
// its `VideoRange` alone (4.10 ignores the extended types as conditions), and Dolby Vision is one
// name whatever its profile, so the profiles whose base layer the screen shows are let in per item.
const CONTAINER_NAMES = { mp4: 'mp4,m4v,mov', mkv: 'mkv', webm: 'webm', ts: 'ts,mpegts,m2ts' };
const AUDIO_NAMES = { dts: 'dts,dca' };
const SDR_RANGE = 'SDR';
const HDR_RANGES = {
  hdr10: ['HDR 10', 'HDR 10+'],
  hdr10plus: ['HDR 10+'],
  hlg: ['HLG'],
  dolbyVision: ['DolbyVision'],
};
const DOLBY_VISION_RANGE = 'DolbyVision';
const DOLBY_VISION_BASE_LAYERS = {
  DoviProfile02: 'sdr', DoviProfile22: 'sdr', DoviProfile42: 'sdr', DoviProfile82: 'sdr', DoviProfile92: 'sdr',
  DoviProfile61: 'hdr10', DoviProfile76: 'hdr10', DoviProfile81: 'hdr10',
  DoviProfile84: 'hlg',
};
const TRANSCODE_AUDIO = ['aac', 'ac3', 'eac3'];
const SUBTITLE_PROFILE_FORMATS = ['srt', 'subrip', 'ass', 'ssa', 'vtt'];
// No limit a home network would meet, so a file is never converted for its size alone.
const MAX_STREAMING_BITRATE = 200000000;

function listOf(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function videoStreamOf(item) {
  const source = defaultSource(item);
  return (source && Array.isArray(source.MediaStreams) ? source.MediaStreams : [])
    .find((stream) => stream && stream.Type === 'Video');
}

// The ranges this item may play as stored on this screen.
function rangesFor(device, item) {
  const shown = listOf(device.hdr);
  const ranges = [SDR_RANGE, ...shown.flatMap((format) => HDR_RANGES[format] || [])];
  const layer = DOLBY_VISION_BASE_LAYERS[(videoStreamOf(item) || {}).ExtendedVideoSubType];
  if (layer === 'sdr' || shown.includes(layer)) ranges.push(DOLBY_VISION_RANGE);
  return [...new Set(ranges)];
}

// The device as Emby's own clients describe it. A video beyond a decoder's size or bit depth fails
// its codec profile, so the server converts it to H.264. The range is a condition only on a server
// that tone-maps, which takes Emby Premiere: without it a conversion is no truer to the colours
// than the file, so a range alone is not worth converting for.
function deviceProfileOf(device, item, toneMaps) {
  const video = (Array.isArray(device.video) ? device.video : []).filter((v) => v && typeof v.codec === 'string');
  const audio = listOf(device.audio);
  const containers = listOf(device.containers).map((name) => CONTAINER_NAMES[name]).filter(Boolean);
  const ranges = rangesFor(device, item);
  const transcodeAudio = TRANSCODE_AUDIO.filter((codec) => audio.includes(codec));
  const channels = Number.isInteger(device.maxAudioChannels) && device.maxAudioChannels > 0 ? device.maxAudioChannels : 2;
  // HEVC the device plays is copied rather than encoded again, in fMP4, the one HLS container
  // AVPlayer takes it in.
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
        ...(toneMaps ? [{ Condition: 'EqualsAny', Property: 'VideoRange', Value: ranges.join('|'), IsRequired: false }] : []),
      ],
    })),
    SubtitleProfiles: SUBTITLE_PROFILE_FORMATS.flatMap((format) => [
      { Format: format, Method: 'Embed' },
      { Format: format, Method: 'External' },
    ]),
  };
}

// A viewer may read whether the server has Premiere, though not whether its tone mapping is on.
// Not through `request`: a refusal here says nothing about the login, which must not be renewed for it.
async function hasPremiere() {
  try {
    const me = await session();
    const response = await send(url(['Registrations', 'premiere'], {}), {
      headers: { Accept: 'application/json', ...authHeaders(me.token) },
    });
    return response.status >= 200 && response.status < 300 && JSON.parse(response.body).IsRegistered === true;
  } catch {
    return false;
  }
}

// The credential rides in a header on every hop, so a key the server writes into the address is
// taken out rather than left in logs and caches.
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
    const profile = deviceProfileOf(device, item, await hasPremiere());
    const info = parsed(await request('POST', ['Items', item.Id, 'PlaybackInfo'], 'playback info', { UserId: ME }, {
      DeviceProfile: profile,
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
  const token = (await session()).token;
  if (!source || source.SupportsDirectPlay || typeof source.TranscodingUrl !== 'string') {
    const stream = streamOf(item, token);
    return source ? { ...stream, session: sessionOf(playSession, source.Id, 'DirectPlay') } : stream;
  }
  // Under `/emby` like every other call, which a reverse proxy may be the only path it forwards.
  const stream = {
    url: `${base()}/emby${withoutKey(source.TranscodingUrl)}`,
    mimeType: MIME_HLS,
    headers: authHeaders(token),
    session: sessionOf(playSession, source.Id, 'Transcode'),
  };
  const subtitles = subtitlesOf(item, true);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  const segments = segmentsOf(item);
  if (segments.length > 0) stream.segments = segments;
  return stream;
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

// An episode is a `track` that `getStream` redeems with its own media source, as Jellyfin's is.
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

// Emby's `VideoRange` names, as `HDR_RANGES` above sends them to its decision.
const RANGE_OF = { SDR: 'sdr', 'HDR 10': 'hdr10', 'HDR 10+': 'hdr10plus', HLG: 'hlg', DolbyVision: 'dolbyVision' };

// What the copy is: a film's default source says its size and range, an episode's listing its size alone.
function videoOf(item) {
  const stream = videoStreamOf(item) || {};
  const width = positive(stream.Width ?? item.Width);
  const height = positive(stream.Height ?? item.Height);
  const range = RANGE_OF[stream.VideoRange];
  const video = { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(range ? { range } : {}) };
  return Object.keys(video).length > 0 ? { video } : {};
}

function positive(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

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

function names(payload) {
  return items(payload).map((item) => item.Name).filter((name) => typeof name === 'string' && name);
}

const PLAYING_PATHS = {
  start: ['Sessions', 'Playing'],
  progress: ['Sessions', 'Playing', 'Progress'],
  stop: ['Sessions', 'Playing', 'Stopped'],
};

// An episode on its own has no title worth a card, so it stands for its series, resuming at it.
function episodeResume(episode) {
  return {
    id: episode.SeriesId,
    title: episode.SeriesName,
    type: 'SERIES',
    posterUrl: imageUrl(episode.SeriesId, episode.SeriesPrimaryImageTag, 'Primary', POSTER_MAX_WIDTH),
    backdropUrl: backdropUrl(episode),
    optionId: episode.Id,
    ...playStateOf(episode),
  };
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

  // A `track` is its item id. The stream carries the token this call was answered with. With what
  // the device plays, the server decides; without it (a download, an older app) the file is sent
  // as stored.
  async getStream(track, asked) {
    const item = await get(['Users', ME, 'Items', track], track, { Fields: STREAM_FIELDS });
    const device = asked && asked.device;
    return device && typeof device === 'object' ? decidedStream(item, device) : streamOf(item, (await session()).token);
  },

  // A report without a `PlaySessionId` is a 400 on Emby ("Parameter 'key'"), and one for a play it
  // never saw start is dropped. The server's own play session, media source and method come back
  // in `session` where it decided the stream, and the stop that carries them ends its conversion;
  // otherwise all three carry an id derived from the item and kept nowhere, and no
  // `MediaSourceId`, since the item id is not one (see `streamOf`).
  // `finished` is ignored: the server decides "played" from the position on stop.
  async reportPlayback({ mediaId, optionId, event, paused, position, session }) {
    const itemId = optionId || mediaId;
    const path = PLAYING_PATHS[event];
    if (!path) throw yonto.error.unavailable(UNKNOWN_EVENT_MESSAGE);
    const decided = playSessionOf(session);
    await request('POST', path, 'playback report', {}, {
      ItemId: itemId,
      ...(decided.mediaSourceId ? { MediaSourceId: decided.mediaSourceId } : {}),
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
  // Emby's list also holds titles it has nothing to resume (a position of 0, or one already
  // played), so only an unfinished place is kept. Its listings carry no `LastPlayedDate`, so
  // an item here has no `playedAt`; the server's order is the recency order.
  async getContinueWatching() {
    const resumable = items(await get(['Users', ME, 'Items', 'Resume'], 'continue watching', {
      Limit: String(CONTINUE_WATCHING_COUNT),
      MediaTypes: 'Video',
      EnableUserData: 'true',
    })).filter((item) => {
      const { played, position } = playStateOf(item);
      return played !== true && position > 0;
    });
    return {
      items: resumable.map((item) => (item.Type === 'Episode' ? episodeResume(item) : toSummary(item))),
    };
  },

  async search(query) {
    return items(await get(['Users', ME, 'Items'], 'search', {
      SearchTerm: query,
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: LIST_ITEM_FIELDS,
      EnableUserData: 'true',
      Limit: String(PAGE_SIZE),
    })).map(toSummary);
  },

  // The best-rated titles, with unrated ones dropped rather than shown as picks.
  async getRecommendations() {
    return items(await get(['Users', ME, 'Items'], 'recommendations', {
      Recursive: 'true',
      IncludeItemTypes: ALL_ITEM_TYPES,
      Fields: RANKED_ITEM_FIELDS,
      EnableUserData: 'true',
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
      Limit: String(RECOMMENDATION_COUNT),
    }))
      .filter((item) => item.CommunityRating !== undefined && item.CommunityRating !== null)
      .map(toSummary);
  },
};
