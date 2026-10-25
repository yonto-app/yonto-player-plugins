/* yonto-plugin
{
  "kind": "content-source",
  "id": "peertube",
  "name": "PeerTube",
  "version": "1.0.0",
  "contractVersion": 21,
  "description": "Your own PeerTube instance on the TV: what is new, what is trending and each of its channels, with captions. Sign in to watch your private videos too. Not affiliated with PeerTube or Framasoft.",
  "probeQuery": "tomatoes",
  "provides": "source-type",
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "instanceUrl",
      "label": "Instance address",
      "type": "url",
      "required": true,
      "placeholder": "https://videos.example.com"
    },
    {
      "id": "username",
      "label": "Username (only for private videos)",
      "type": "text"
    },
    {
      "id": "password",
      "label": "Password",
      "type": "secret"
    },
    {
      "id": "federated",
      "label": "Include videos from instances it follows",
      "type": "bool",
      "default": "false"
    }
  ],
  "capabilities": []
}
*/
// One PeerTube instance (https://joinpeertube.org), through its REST API. plugins/peertube/AGENTS.md
// has what a real PeerTube 8.3 confirmed.

// PeerTube refuses a `count` above 100.
const PAGE_SIZE = 50;
const SEARCH_COUNT = 50;
const RECOMMENDATION_COUNT = 10;
const CHANNEL_COUNT = 100;

const RECENT = 'recent';
const TRENDING = 'trending';
const MINE = 'mine';
const CHANNEL_PREFIX = 'channel:';
const SORTS = { [RECENT]: '-publishedAt', [TRENDING]: '-trending' };

const HLS_PLAYLIST_TYPE = 1;
const MIME_HLS = 'application/x-mpegURL';
// A hint for a progressive stream, not a claim about the container: the player sniffs the bytes.
const MIME_MP4 = 'video/mp4';
const MIME_VTT = 'text/vtt';
const MAX_SUBTITLES = 32;
const POSTER_MIN_WIDTH = 480;
const SQUARE = '1:1';

const SERVER_ERROR_MESSAGE = 'The instance answered with an error.';
const SERVER_SILENT_MESSAGE = 'The instance did not answer.';
const SERVER_UNREADABLE_MESSAGE = 'The address answered with a page that is not PeerTube: check the instance address.';
const NOT_READY_MESSAGE = 'This video is still being processed on the instance. Try again later.';
const NOT_PUBLIC_MESSAGE = 'This video is not public. Add your username and password to this source to watch it.';
const VIDEO_PASSWORD_MESSAGE = 'This video has a password of its own, which Yonto Player cannot ask for yet.';
const HALF_CREDENTIALS_MESSAGE = 'Fill in both the username and the password, or neither to watch public videos only.';
const LOGIN_REFUSED_MESSAGE = 'Check the username and password by editing the source in Settings.';
const TWO_FACTOR_MESSAGE = 'This account signs in with two-factor authentication, which Yonto Player cannot do yet.';
const BLOCKED_MESSAGE = 'This account is blocked on the instance.';
const TOO_MANY_MESSAGE = 'The instance is refusing sign-ins for a while. Try again in a few minutes.';
const SIGN_IN_FAILED_MESSAGE = 'Signing in failed: the instance answered with an error.';
const ACCOUNT_REFUSED_MESSAGE = "Check this account's permissions on the instance.";

const CLIENT_KEY = 'client';
const SESSION_KEY = 'session';
// The last password the instance refused for each of the latest instances and usernames, so a
// wrong one is sent once rather than on every call.
const REFUSED_KEY = 'refused';
const REFUSALS_KEPT = 10;
// A token this close to its expiry is renewed before it is used.
const EXPIRY_MARGIN_MS = 60000;

function instance() {
  return (yonto.config.instanceUrl || '').replace(/\/+$/, '');
}

function username() {
  return yonto.config.username || '';
}

function password() {
  return yonto.config.password || '';
}

function signsIn() {
  if (!username() && !password()) return false;
  if (!username() || !password()) throw yonto.error.misconfigured(HALF_CREDENTIALS_MESSAGE);
  return true;
}

function federated() {
  return yonto.config.federated === 'true';
}

function url(path, params = {}) {
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  return `${instance()}/api/v1/${path}${query ? `?${query}` : ''}`;
}

function segment(value) {
  return encodeURIComponent(value);
}

/** `yonto.fetch`, with an instance that gave no answer said as `unreachable`. */
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

/** A 2xx that is not a JSON object is something in front of the instance, like a proxy's login page. */
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

/** PeerTube's errors are RFC 9457 problems carrying a `code`; anything else has none. */
function problemCode(response) {
  try {
    const problem = JSON.parse(response.body);
    return typeof problem?.code === 'string' ? problem.code : '';
  } catch {
    return '';
  }
}

// --- Signing in: OAuth 2's password grant, with the instance's own client (docs.joinpeertube.org/api/rest-getting-started).

async function client() {
  const stored = await yonto.store.get(CLIENT_KEY);
  if (stored && stored.instance === instance()) return stored;
  const response = await send(url('oauth-clients/local'), { headers: { Accept: 'application/json' } });
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `the OAuth client got HTTP ${response.status}`);
    throw yonto.error.unavailable(SIGN_IN_FAILED_MESSAGE);
  }
  const payload = parsed(response, 'the OAuth client');
  if (typeof payload.client_id !== 'string' || typeof payload.client_secret !== 'string') {
    throw yonto.error.unavailable(SERVER_UNREADABLE_MESSAGE);
  }
  const won = { instance: instance(), id: payload.client_id, secret: payload.client_secret };
  await yonto.store.set(CLIENT_KEY, won);
  return won;
}

function form(fields) {
  return Object.keys(fields).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(fields[key])}`).join('&');
}

/** The token endpoint's answer: the session it grants, or null when the grant itself was refused. */
async function grant(fields) {
  const { id, secret } = await client();
  const response = await send(url('users/token'), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: id, client_secret: secret, ...fields }),
  });
  const code = problemCode(response);
  if (response.status === 400 && code === 'invalid_client') {
    // The instance's client changed (a reinstall); the next attempt fetches it again.
    await yonto.store.remove(CLIENT_KEY);
    throw yonto.error.unavailable(SIGN_IN_FAILED_MESSAGE);
  }
  if (response.status === 400 && code === 'invalid_grant') return null;
  // Neither is remembered as a refused password: either can be lifted on the instance without the password changing.
  if (code === 'account_blocked') throw yonto.error.unauthenticated(BLOCKED_MESSAGE);
  if (code === 'missing_two_factor') throw yonto.error.unauthenticated(TWO_FACTOR_MESSAGE);
  if (response.status === 429) throw yonto.error.unavailable(TOO_MANY_MESSAGE);
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `signing in got HTTP ${response.status}`);
    throw yonto.error.unavailable(SIGN_IN_FAILED_MESSAGE);
  }
  const payload = parsed(response, 'signing in');
  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw yonto.error.unavailable(SIGN_IN_FAILED_MESSAGE);
  }
  return {
    instance: instance(),
    username: username(),
    access: payload.access_token,
    refresh: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
    expiresAt: yonto.now() + (Number(payload.expires_in) || 0) * 1000,
  };
}

async function fingerprint() {
  return { instance: instance(), username: username(), password: await yonto.crypto.sha256(password()) };
}

function sameAccount(a, b) {
  return a.instance === b.instance && a.username === b.username;
}

async function refusals() {
  const stored = await yonto.store.get(REFUSED_KEY);
  return Array.isArray(stored) ? stored : [];
}

async function signIn(stale) {
  if (stale && stale.refresh) {
    const renewed = await grant({ grant_type: 'refresh_token', refresh_token: stale.refresh });
    if (renewed) return renewed;
  }
  const credential = await fingerprint();
  if ((await refusals()).some((r) => sameAccount(r, credential) && r.password === credential.password)) {
    yonto.log('warn', 'the same password was refused before; not spending another attempt');
    throw yonto.error.unauthenticated(LOGIN_REFUSED_MESSAGE);
  }
  const won = await grant({ grant_type: 'password', username: username(), password: password() });
  const others = (await refusals()).filter((r) => !sameAccount(r, credential));
  if (!won) {
    await yonto.store.set(REFUSED_KEY, [...others, credential].slice(-REFUSALS_KEPT));
    throw yonto.error.unauthenticated(LOGIN_REFUSED_MESSAGE);
  }
  await yonto.store.set(REFUSED_KEY, others);
  return won;
}

/** The access token to send, or null for an anonymous source. A source runs one call at a time, and a call asks
 *  for this one request at a time, so two sign-ins never race. */
async function accessToken() {
  if (!signsIn()) return null;
  const stored = await yonto.store.get(SESSION_KEY);
  const current = stored && stored.instance === instance() && stored.username === username() ? stored : null;
  if (current && current.expiresAt - EXPIRY_MARGIN_MS > yonto.now()) return current.access;
  const won = await signIn(current);
  await yonto.store.set(SESSION_KEY, won);
  return won.access;
}

async function get(path, what, params, retried) {
  const token = await accessToken();
  const response = await send(url(path, params), {
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (response.status === 401 || response.status === 403) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    if (problemCode(response) === 'video_requires_password') throw yonto.error.unavailable(VIDEO_PASSWORD_MESSAGE);
    if (response.status === 401 && token && !retried) {
      // A token can be revoked on the instance, so the first refusal renews it once; a second is the account.
      await yonto.store.remove(SESSION_KEY);
      return get(path, what, params, true);
    }
    throw yonto.error.unauthenticated(token ? ACCOUNT_REFUSED_MESSAGE : NOT_PUBLIC_MESSAGE);
  }
  if (response.status === 404) throw yonto.error.notFound(what);
  if (response.status < 200 || response.status >= 300) {
    yonto.log('warn', `${what} got HTTP ${response.status}`);
    throw yonto.error.unavailable(SERVER_ERROR_MESSAGE);
  }
  return parsed(response, what);
}

// --- Mapping PeerTube's videos to the contract.

function videosOf(payload) {
  return Array.isArray(payload.data) ? payload.data.filter((video) => video && video.uuid && video.name) : [];
}

function absolute(path) {
  if (typeof path !== 'string' || path === '') return undefined;
  return /^https?:\/\//i.test(path) ? path : `${instance()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** The widest landscape thumbnails (PeerTube 8.1 lists several sizes), else the two paths older ones had. */
function artworkOf(video) {
  const landscape = (Array.isArray(video.thumbnails) ? video.thumbnails : [])
    .filter((t) => t && t.fileUrl && t.aspectRatio !== SQUARE)
    .sort((a, b) => (a.width || 0) - (b.width || 0));
  if (landscape.length > 0) {
    const poster = landscape.find((t) => (t.width || 0) >= POSTER_MIN_WIDTH) || landscape[landscape.length - 1];
    return { posterUrl: poster.fileUrl, backdropUrl: landscape[landscape.length - 1].fileUrl };
  }
  const preview = absolute(video.previewPath) || absolute(video.thumbnailPath);
  return { posterUrl: preview, backdropUrl: preview };
}

function yearOf(video) {
  const match = /^(\d{4})-/.exec(video.originallyPublishedAt || video.publishedAt || '');
  return match ? match[1] : undefined;
}

function toSummary(video) {
  const summary = { id: video.uuid, title: video.name, type: 'movie', ...artworkOf(video) };
  const year = yearOf(video);
  if (year) summary.year = year;
  for (const key of Object.keys(summary)) if (summary[key] === undefined) delete summary[key];
  return summary;
}

function clock(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** PeerTube's descriptions are Markdown; a television shows text. */
function plainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

/** The contract has no field for who made a video or how long it is, so the synopsis opens with both. */
function synopsisOf(video) {
  const byline = [video.channel?.displayName, video.isLive ? 'Live' : video.duration ? clock(video.duration) : '']
    .filter(Boolean)
    .join(' · ');
  const description = plainText(video.description || video.truncatedDescription || '');
  return [byline, description].filter(Boolean).join('\n\n');
}

/** The highest resolution; an audio-only file is resolution 0, so it plays only when it is all there is. */
function bestFile(files) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && file.fileUrl)
    .sort((a, b) => (b.resolution?.id || 0) - (a.resolution?.id || 0))[0];
}

/** The HLS master when there is one, which carries every resolution and, since PeerTube 7, the captions; else the best file. */
function playableOf(video) {
  const playlists = Array.isArray(video.streamingPlaylists) ? video.streamingPlaylists : [];
  const hls = playlists.find((playlist) => playlist && playlist.type === HLS_PLAYLIST_TYPE && playlist.playlistUrl);
  if (hls) return { url: hls.playlistUrl, mimeType: MIME_HLS, hls: true };
  const file = bestFile(video.files);
  return file ? { url: file.fileUrl, mimeType: MIME_MP4, hls: false } : null;
}

/** A caption the HLS master already names (it has an `m3u8Url`) is the player's already, so it is not offered twice. */
function subtitlesOf(captions, playable) {
  return captions
    .filter((caption) => caption && caption.language && !(playable.hls && caption.m3u8Url))
    .map((caption) => {
      const address = caption.fileUrl || absolute(caption.captionPath);
      const label = caption.language.label || caption.language.id;
      return address && label
        ? {
          url: address,
          label: caption.automaticallyGenerated ? `${label} (auto-generated)` : label,
          ...(caption.language.id ? { language: caption.language.id } : {}),
          mimeType: MIME_VTT,
        }
        : null;
    })
    .filter(Boolean)
    .slice(0, MAX_SUBTITLES);
}

async function captionsOf(id) {
  try {
    const payload = await get(`videos/${segment(id)}/captions`, 'the captions');
    return Array.isArray(payload.data) ? payload.data : [];
  } catch (error) {
    // A video plays without its captions rather than not at all.
    yonto.log('warn', `the captions could not be read: ${error?.code ?? 'no code'}`);
    return [];
  }
}

/** A private or internal video's files are under `/private/` on the instance itself, which wants the session there. */
async function streamOf(video) {
  const playable = playableOf(video);
  if (!playable) return null;
  const stream = { url: playable.url, mimeType: playable.mimeType };
  if (video.isLive === true) stream.live = true;
  const token = video.isLocal && playable.url.includes('/private/') ? await accessToken() : null;
  if (token) stream.headers = { Authorization: `Bearer ${token}` };
  const subtitles = subtitlesOf(await captionsOf(video.uuid), playable);
  if (subtitles.length > 0) stream.subtitles = subtitles;
  return stream;
}

function localOnly() {
  return federated() ? undefined : 'true';
}

function page(number) {
  return { start: (Math.max(1, Number(number) || 1) - 1) * PAGE_SIZE, count: PAGE_SIZE };
}

async function channels() {
  const payload = await get('video-channels', 'the channels', { start: 0, count: CHANNEL_COUNT, sort: 'name' });
  return (Array.isArray(payload.data) ? payload.data : []).filter((channel) => channel && channel.isLocal && channel.name);
}

function avatarOf(channel) {
  const avatars = (Array.isArray(channel.avatars) ? channel.avatars : []).filter((a) => a && (a.fileUrl || a.path));
  const widest = avatars.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return widest ? widest.fileUrl || absolute(widest.path) : undefined;
}

export default {
  async getCategories() {
    const categories = [
      { id: RECENT, name: 'Recently added' },
      { id: TRENDING, name: 'Trending' },
    ];
    if (signsIn()) categories.push({ id: MINE, name: 'My videos' });
    for (const channel of await channels()) {
      const category = { id: `${CHANNEL_PREFIX}${channel.name}`, name: channel.displayName || channel.name };
      const thumbnailUrl = avatarOf(channel);
      if (thumbnailUrl) category.thumbnailUrl = thumbnailUrl;
      categories.push(category);
    }
    return categories;
  },

  async getMediaList(categoryId, options) {
    const paging = page(options?.page);
    if (categoryId === MINE) {
      return videosOf(await get('users/me/videos', 'your videos', { ...paging, sort: '-publishedAt' })).map(toSummary);
    }
    if (categoryId.startsWith(CHANNEL_PREFIX)) {
      const name = categoryId.slice(CHANNEL_PREFIX.length);
      return videosOf(await get(`video-channels/${segment(name)}/videos`, 'the channel', { ...paging, sort: '-publishedAt' }))
        .map(toSummary);
    }
    const sort = SORTS[categoryId];
    if (!sort) throw yonto.error.notFound('the category');
    return videosOf(await get('videos', 'the videos', { ...paging, sort, isLocal: localOnly() })).map(toSummary);
  },

  async getMediaDetail(id) {
    const video = await get(`videos/${segment(id)}`, 'the video');
    const stream = await streamOf(video);
    if (!stream) throw yonto.error.unavailable(NOT_READY_MESSAGE);
    const detail = { ...toSummary(video), synopsis: synopsisOf(video), playbackOptions: [{ label: 'Play', stream }] };
    if (video.category && video.category.id !== null && video.category.label) detail.genres = [video.category.label];
    return detail;
  },

  async search(query) {
    const payload = await get('search/videos', 'the search', {
      search: query, searchTarget: 'local', start: 0, count: SEARCH_COUNT, isLocal: localOnly(),
    });
    return videosOf(payload).map(toSummary);
  },

  async getRecommendations() {
    const payload = await get('videos', 'the trending videos', {
      start: 0, count: RECOMMENDATION_COUNT, sort: '-trending', isLocal: localOnly(),
    });
    return videosOf(payload).map(toSummary);
  },
};
