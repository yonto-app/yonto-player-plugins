/* yonto-plugin
{
  "kind": "content-source",
  "id": "m3u",
  "name": "M3U playlist",
  "version": "1.1.0",
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

const HTTP_URL = /^https?:\/\/\S+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const CHARSET = /charset=\s*"?([\w-]+)/i;
const ATTRIBUTE = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)')/g;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
// What an HLS stream's own manifest has and a playlist of channels does not.
const HLS_TAG = /^#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/m;
// A playlist of videos often says `-1` too; a file with one of these endings is a video.
const VIDEO_FILE = /\.(?:mp4|m4v|mkv|avi|mov|wmv|webm)(?:[?#]|$)/i;
const LINE_BREAK = /\r\n|\r|\n/;
const BYTE_ORDER_MARK = '﻿';

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
      default: throw error;
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
function parsePlaylist(text, address) {
  const lines = text.replace(BYTE_ORDER_MARK, '').split(LINE_BREAK).map((line) => line.trim());
  const isPlaylist = lines.some((line) => /^#EXTM3U/i.test(line) || /^#EXTINF:/i.test(line));
  // An HLS media or master playlist opens with #EXTM3U too, but it is one stream's manifest.
  if (HLS_TAG.test(text)) throw yonto.error.unavailable(STREAM_ADDRESS_MESSAGE);
  if (!isPlaylist) throw yonto.error.unavailable(UNREADABLE_MESSAGE);
  const entries = [];
  let pending = freshEntry();
  for (const line of lines) {
    if (line === '') continue;
    if (/^#EXTINF:/i.test(line)) {
      const { attributes, seconds, title } = readExtinf(line.slice('#EXTINF:'.length));
      pending.attributes = attributes;
      pending.live = !(seconds > 0);
      pending.title = title;
    } else if (/^#EXTGRP:/i.test(line)) {
      pending.extGroup = line.slice('#EXTGRP:'.length).trim();
    } else if (/^#EXTVLCOPT:/i.test(line)) {
      const [name, ...value] = line.slice('#EXTVLCOPT:'.length).split('=');
      const header = VLC_HEADERS[name.trim().toLowerCase()];
      if (header !== undefined) pending.headers[header] = value.join('=').trim();
    } else if (!line.startsWith('#')) {
      const entry = entryOf(pending, line, address);
      if (entry !== null) entries.push(entry);
      pending = freshEntry();
    }
  }
  return entries;
}

function freshEntry() {
  return { attributes: {}, title: '', extGroup: '', headers: {}, live: true };
}

/**
 * `-1 tvg-id="x" group-title="A, B",Title`: the title follows the first comma outside a quote,
 * and a group name may hold commas.
 */
function readExtinf(rest) {
  let quote = '';
  let comma = -1;
  for (let i = 0; i < rest.length && comma < 0; i += 1) {
    const char = rest[i];
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ',') {
      comma = i;
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
  const [target, ...suffix] = line.split('|');
  const url = absolute(target.trim(), address);
  if (url === '') return null;
  const headers = withHeaders(pending.headers, kodiHeaders(suffix.join('|')));
  const attributes = pending.attributes;
  const title = pending.title || attributes['tvg-name'] || fileName(url);
  const group = attributes['group-title'] || pending.extGroup || UNGROUPED_NAME;
  const entry = {
    id: yonto.crypto.md5(`${url}\n${title}`),
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

/** The first of every id, in order: the app keys its lists on it, and a playlist repeats entries. */
function indexOf(entries) {
  const byId = new Map();
  const groups = new Map();
  for (const entry of entries) {
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  return { entries: [...byId.values()], byId, groups };
}

function summaryOf(entry) {
  const summary = { id: entry.id, title: entry.title, type: 'MOVIE' };
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
    const { byId } = await readPlaylist();
    const entry = byId.get(String(mediaId));
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
