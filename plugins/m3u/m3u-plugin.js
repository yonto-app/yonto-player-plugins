/* yonto-plugin
{
  "kind": "content-source",
  "id": "m3u",
  "name": "M3U playlist",
  "version": "1.2.0",
  "contractVersion": 21,
  "description": "Plays the channels and videos of an M3U or M3U8 playlist, grouped the way the playlist groups them. You supply the address; Yonto Player includes no playlist.",
  "probeQuery": "news",
  "provides": "source-type",
  "allowedHosts": [],
  "configSchema": [
    {
      "id": "playlist",
      "label": "Playlist address",
      "type": "url",
      "required": true,
      "placeholder": "https://example.com/playlist.m3u"
    }
  ],
  "capabilities": []
}
*/
// One M3U playlist, which is one source: each entry is a title with one thing to play, and each
// `group-title` is a category. `plugins/m3u/AGENTS.md` has the format knowledge.
//
// **It reaches the playlist's host and nothing else.** The address is a `url` field, so the host
// widens the allowlist to exactly that host and checks every redirect hop against it. What the
// entries point at is the player's to open, never this plugin's to fetch.

const PAGE_SIZE = 60;
const SEARCH_LIMIT = 100;
/** A playlist is re-read at most this often: a listing, a title and a search are three calls. */
const CACHE_SECONDS = 300;

const ALL_CATEGORY_ID = 'all';
const ALL_CATEGORY_NAME = 'All';
/** Entries with no `group-title`. The `g:` prefix on every group keeps its id off `all`. */
const UNGROUPED_NAME = 'Other';
const GROUP_PREFIX = 'g:';

const MISCONFIGURED_MESSAGE = 'The playlist address must start with http:// or https://.';
const UNUSABLE_ADDRESS_MESSAGE = "The playlist address can't be used. Check it.";
const SERVER_DOWN_MESSAGE = "Can't reach this playlist right now. Try again later.";
const SERVER_REFUSED_MESSAGE = 'This playlist refused access. Check its address.';
const NO_PLAYLIST_MESSAGE = "There's no playlist at this address. Check the playlist address.";
const OFF_LIMITS_MESSAGE = "This playlist points at an address Yonto Player won't connect to. Check its address.";
const REDIRECTS_REFUSED_MESSAGE = "This playlist's redirects lead nowhere. Check its address.";
const UNREADABLE_MESSAGE = "This address answered with something that isn't a playlist. Check the playlist address.";
const STREAM_ADDRESS_MESSAGE = 'This address is a single stream, not a playlist of them.';
const EMPTY_MESSAGE = 'This playlist has nothing in it.';
const TOO_LARGE_MESSAGE = 'This playlist is too large to read.';
const PANEL_TOO_LARGE_MESSAGE = 'This playlist is too large to read. Add it as an Xtream Codes source, with its server, username and password.';

const HTTP_URL = /^https?:\/\/\S+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const CHARSET = /charset=\s*"?([\w-]+)/i;
const ATTRIBUTE = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)')/g;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
// What an HLS stream's own manifest has and a playlist of channels does not.
const HLS_TAGS = ['EXT-X-TARGETDURATION', 'EXT-X-STREAM-INF', 'EXT-X-MEDIA-SEQUENCE'];
const HLS = 'HLS';
// An Xtream Codes panel's playlist link, whose export of a whole library is often too large to read.
const XTREAM_PLAYLIST = /\/get\.php\?(?=.*\busername=)(?=.*\bpassword=)/i;
// A playlist of videos often says `-1` too; a file with one of these endings is a video.
const VIDEO_FILE = /\.(?:mp4|m4v|mkv|avi|mov|wmv|webm)(?:[?#]|$)/i;
const HASH = 0x23;
const COMMA = 0x2c;
const COLON = 0x3a;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

// What `#EXTVLCOPT:` calls the headers a stream wants.
const VLC_HEADERS = {
  'http-user-agent': 'User-Agent',
  'http-referrer': 'Referer',
  'http-referer': 'Referer',
  'http-origin': 'Origin',
};

// ---------------------------------------------------------------------------- the playlist

/** Read on each use, because a module that reaches for `yonto` while being evaluated can only be imported after the host exists. */
function playlistAddress() {
  const address = yonto.config.playlist || '';
  if (!HTTP_URL.test(address)) throw yonto.error.misconfigured(MISCONFIGURED_MESSAGE);
  return address;
}

let cached = null;

/** The parsed playlist, at most [CACHE_SECONDS] old. Module state, so it lives as long as the runtime does. */
async function readPlaylist() {
  const address = playlistAddress();
  const now = yonto.now();
  if (cached !== null && cached.address === address && now - cached.at < CACHE_SECONDS * 1000) return cached.playlist;
  const entries = parsePlaylist(await download(address), address);
  if (entries.length === 0) throw yonto.error.unavailable(EMPTY_MESSAGE);
  const playlist = indexOf(entries);
  cached = { address, at: now, playlist };
  return playlist;
}

async function download(address) {
  let response;
  try {
    response = await yonto.fetch(address);
  } catch (error) {
    // Its code and never its message, which names the URL, and a playlist address can carry a key.
    yonto.log('warn', `the request failed: ${error?.code ?? 'no code'}`);
    switch (error?.code) {
      case 'REQUEST_FAILED': throw yonto.error.unreachable(SERVER_DOWN_MESSAGE);
      case 'HOST_NOT_ALLOWED': throw yonto.error.unavailable(OFF_LIMITS_MESSAGE);
      case 'REDIRECT_REFUSED': throw yonto.error.unavailable(REDIRECTS_REFUSED_MESSAGE);
      case 'REQUEST_INVALID': throw yonto.error.misconfigured(UNUSABLE_ADDRESS_MESSAGE);
      case 'RESPONSE_TOO_LARGE':
        throw yonto.error.unavailable(XTREAM_PLAYLIST.test(address) ? PANEL_TOO_LARGE_MESSAGE : TOO_LARGE_MESSAGE);
      // Its code alone: a host's message can name the address, and an address can carry a key.
      default: throw Object.assign(new Error(`the playlist request failed: ${error?.code ?? 'no code'}`), { code: error?.code });
    }
  }
  yonto.log('info', `the playlist answered HTTP ${response.status}`);
  if (response.status === 404) throw yonto.error.unavailable(NO_PLAYLIST_MESSAGE);
  if (response.status === 401 || response.status === 403) throw yonto.error.unavailable(SERVER_REFUSED_MESSAGE);
  if (response.status < 200 || response.status >= 300) throw yonto.error.unreachable(SERVER_DOWN_MESSAGE);
  return bodyText(response);
}

/** Playlists are often GBK or Latin-1, and a host decodes as UTF-8 unless told otherwise. */
function bodyText(response) {
  const charset = String(response.headers?.['content-type'] ?? '').match(CHARSET)?.[1];
  if (!charset || /^utf-?8$/i.test(charset)) return response.body;
  return yonto.text.decode(response.bodyBase64, charset);
}

// ---------------------------------------------------------------------------- parsing

/**
 * The entries of a playlist, in its order. A line starting `#EXTINF` describes the next address;
 * `#EXTGRP` and `#EXTVLCOPT` lines between them add to it. Everything else starting `#` is a
 * comment or a tag this has no use for.
 */
// A panel's export runs to 30 MB and 90,000 entries, so this loop is written for a television's
// memory and call budget: the body is walked line by line rather than split into a second copy,
// and a tag is recognised by its first characters rather than a regex per line.
function parsePlaylist(text, address) {
  let isPlaylist = false;
  const entries = [];
  let pending = freshEntry();
  forEachLine(text, (line) => {
    const tag = tagOf(line);
    if (tag === 'EXTM3U') {
      isPlaylist = true;
    } else if (tag === HLS) {
      // An HLS media or master playlist opens with #EXTM3U too, but it is one stream's manifest.
      throw yonto.error.unavailable(STREAM_ADDRESS_MESSAGE);
    } else if (tag === 'EXTINF') {
      isPlaylist = true;
      const { attributes, seconds, title } = readExtinf(line.slice('#EXTINF:'.length));
      pending.attributes = attributes;
      pending.live = !(seconds > 0);
      pending.title = title;
    } else if (tag === 'EXTGRP') {
      pending.extGroup = line.slice('#EXTGRP:'.length).trim();
    } else if (tag === 'EXTVLCOPT') {
      const [name, ...value] = line.slice('#EXTVLCOPT:'.length).split('=');
      const header = VLC_HEADERS[name.trim().toLowerCase()];
      if (header !== undefined) pending.headers[header] = value.join('=').trim();
    } else if (tag === null) {
      const entry = entryOf(pending, line, address);
      if (entry !== null) entries.push(entry);
      pending = freshEntry();
    }
  });
  if (!isPlaylist) throw yonto.error.unavailable(UNREADABLE_MESSAGE);
  return entries;
}

/** Each non-empty line of [text], trimmed (a byte order mark with it), whether it ends in CR, LF or both. */
function forEachLine(text, visit) {
  let lf = text.indexOf('\n');
  let cr = text.indexOf('\r');
  for (let from = 0; from < text.length;) {
    // Each is looked for again only once passed, and never again once there is none left.
    if (lf >= 0 && lf < from) lf = text.indexOf('\n', from);
    if (cr >= 0 && cr < from) cr = text.indexOf('\r', from);
    const end = Math.min(lf < 0 ? text.length : lf, cr < 0 ? text.length : cr);
    const line = text.slice(from, end).trim();
    from = end + 1;
    if (line !== '') visit(line);
  }
}

/**
 * A `#` line's tag in capitals, as the old prefix regexes read it: `EXTM3U` however it goes on,
 * [HLS] for a tag only an HLS manifest has, a tag that takes a value (`EXTINF`) only before its
 * colon, `''` for any other comment, and null for an address.
 */
function tagOf(line) {
  if (line.charCodeAt(0) !== HASH) return null;
  let end = 1;
  while (end < line.length && isTagChar(line.charCodeAt(end))) end += 1;
  const written = line.slice(1, end);
  // HLS tags are upper case by spec, and were matched as written.
  if (HLS_TAGS.some((hls) => written.startsWith(hls))) return HLS;
  const name = written.toUpperCase();
  if (name.startsWith('EXTM3U')) return 'EXTM3U';
  return line.charCodeAt(end) === COLON ? name : '';
}

/** A letter, a digit or `-`. */
function isTagChar(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2d;
}

// Shared by every entry that asks for no header, which in a panel's export is all of them.
const NO_HEADERS = Object.freeze({});

function isEmpty(object) {
  for (const _ in object) return false;
  return true;
}

function freshEntry() {
  return { attributes: {}, title: '', extGroup: '', headers: {}, live: true };
}

/**
 * `-1 tvg-id="x" group-title="A, B",Title`: the title follows the first comma outside a quote,
 * and a group name may hold commas.
 */
function readExtinf(rest) {
  let comma = -1;
  for (let i = 0; i < rest.length;) {
    const char = rest.charCodeAt(i);
    if (char === DOUBLE_QUOTE || char === SINGLE_QUOTE) {
      // An unclosed quote runs to the end of the line, so there is no title.
      const close = rest.indexOf(rest[i], i + 1);
      if (close < 0) break;
      i = close + 1;
    } else if (char === COMMA) {
      comma = i;
      break;
    } else {
      i += 1;
    }
  }
  const head = comma < 0 ? rest : rest.slice(0, comma);
  const seconds = Number.parseFloat(head);
  const attributes = {};
  for (const match of head.matchAll(ATTRIBUTE)) attributes[match[1].toLowerCase()] = (match[2] ?? match[3]).trim();
  return { attributes, seconds, title: comma < 0 ? '' : rest.slice(comma + 1).trim() };
}

/** Null for an entry with nothing to play. */
function entryOf(pending, line, address) {
  const bar = line.indexOf('|');
  const url = absolute((bar < 0 ? line : line.slice(0, bar)).trim(), address);
  if (url === '') return null;
  const suffix = bar < 0 ? {} : kodiHeaders(line.slice(bar + 1));
  const headers = isEmpty(pending.headers) && isEmpty(suffix) ? NO_HEADERS : withHeaders(pending.headers, suffix);
  const attributes = pending.attributes;
  const title = pending.title || attributes['tvg-name'] || fileName(url);
  const group = attributes['group-title'] || pending.extGroup || UNGROUPED_NAME;
  const entry = {
    title,
    group,
    url,
    headers,
    live: pending.live && !VIDEO_FILE.test(url),
  };
  const logo = attributes['tvg-logo'];
  if (logo !== undefined && HTTP_URL.test(logo)) entry.poster = logo;
  return entry;
}

/** `Name=value&Name2=value2` after a `|`, which is how Kodi playlists carry headers. */
function kodiHeaders(suffix) {
  const headers = {};
  for (const pair of suffix.split('&')) {
    const [name, ...rest] = pair.split('=');
    let value = rest.join('=');
    try {
      value = decodeURIComponent(value);
    } catch {
      // Kept as written: a lone percent sign is a value, not an escape.
    }
    if (HEADER_NAME.test(name) && HEADER_VALUE.test(value) && value !== '') headers[name] = value;
  }
  return headers;
}

/** [more] over [headers], a name counting once however it is cased: `Referer` and `referer` are one header. */
function withHeaders(headers, more) {
  const merged = { ...headers };
  for (const [name, value] of Object.entries(more)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

/** A relative entry is read against the playlist's own address, as a player would. */
function absolute(target, address) {
  if (target === '') return '';
  if (SCHEME.test(target)) return target;
  if (target.startsWith('//')) return address.slice(0, address.indexOf('//')) + target;
  const origin = address.match(/^[a-z]+:\/\/[^/?#]+/i)[0];
  if (target.startsWith('/')) return origin + target;
  const path = address.slice(origin.length).split(/[?#]/)[0];
  return origin + path.slice(0, path.lastIndexOf('/') + 1) + target;
}

function fileName(url) {
  const path = url.split(/[?#]/)[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last || url;
}

// ---------------------------------------------------------------------------- the index

/** The first of every address and title, in order: the app keys its lists on the id, and a playlist repeats entries. */
function indexOf(entries) {
  const byKey = new Map();
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (byKey.has(key)) continue;
    byKey.set(key, entry);
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  return { entries: [...byKey.values()], byId: null, groups };
}

/** What an entry's id is the md5 of. */
function keyOf(entry) {
  return `${entry.url}\n${entry.title}`;
}

function idOf(entry) {
  // Made only for an entry that is shown or looked up: a host call each for 90,000 entries is a
  // second of a television's budget.
  if (entry.id === undefined) entry.id = yonto.crypto.md5(keyOf(entry));
  return entry.id;
}

/** Every entry by its id, made on the first title page asked for rather than on every listing. */
function entryById(playlist, id) {
  if (playlist.byId === null) playlist.byId = new Map(playlist.entries.map((entry) => [idOf(entry), entry]));
  return playlist.byId.get(id);
}

function summaryOf(entry) {
  const summary = { id: idOf(entry), title: entry.title, type: 'MOVIE' };
  if (entry.poster !== undefined) summary.posterUrl = entry.poster;
  return summary;
}

// The host reads a stream with no `mimeType` as HLS, so every entry says what it is: a playlist
// address is HLS, and anything else is left to the player's own sniffing as a progressive file
// (MP4, FLV and TS entries are common, and none of them has an HLS manifest to parse).
const HLS_ADDRESS = /\.m3u8?(?:[?#&/]|$)/i;
const HLS_MIME = 'application/x-mpegURL';
const PROGRESSIVE_MIME = 'video/mp4';

// `#EXTINF:-1` is how a playlist says a stream has no end, and a looped channel is a short file
// that ends every minute, which a player cannot tell from a title: so the entry says it is live.
// An entry that states a length is a video, and keeps its place like any other.
function streamOf(entry) {
  const stream = { url: entry.url, mimeType: HLS_ADDRESS.test(entry.url) ? HLS_MIME : PROGRESSIVE_MIME };
  if (entry.live) stream.live = true;
  if (Object.keys(entry.headers).length > 0) stream.headers = entry.headers;
  return stream;
}

// ---------------------------------------------------------------------------- the contract

export default {
  /** The playlist's own groups in the order they first appear, under All. */
  async getCategories() {
    const { groups } = await readPlaylist();
    return [
      { id: ALL_CATEGORY_ID, name: ALL_CATEGORY_NAME },
      ...[...groups.keys()].map((name) => ({ id: GROUP_PREFIX + name, name })),
    ];
  },

  /** One page of a group, or of the whole playlist for All. */
  async getMediaList(categoryId, options) {
    const { entries, groups } = await readPlaylist();
    const id = String(categoryId ?? ALL_CATEGORY_ID);
    const source = id === ALL_CATEGORY_ID ? entries : groups.get(id.slice(GROUP_PREFIX.length));
    if (source === undefined) throw yonto.error.notFound(id);
    const page = Math.max(1, Math.trunc(options?.page ?? 1));
    return source.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(summaryOf);
  },

  /** One entry, which has the one thing to play. */
  async getMediaDetail(mediaId) {
    const entry = entryById(await readPlaylist(), String(mediaId));
    if (entry === undefined) throw yonto.error.notFound(mediaId);
    return {
      ...summaryOf(entry),
      genres: entry.group === UNGROUPED_NAME ? [] : [entry.group],
      playbackOptions: [{ label: entry.title, stream: streamOf(entry) }],
    };
  },

  /** A title or group containing the words, case-insensitively: a playlist has no search of its own. */
  async search(query) {
    const { entries } = await readPlaylist();
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle === '') return [];
    return entries
      .filter((entry) => entry.title.toLowerCase().includes(needle) || entry.group.toLowerCase().includes(needle))
      .slice(0, SEARCH_LIMIT)
      .map(summaryOf);
  },
};
