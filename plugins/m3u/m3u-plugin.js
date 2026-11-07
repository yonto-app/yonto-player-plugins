/* yonto-plugin
{
  "kind": "content-source",
  "id": "m3u",
  "name": "M3U playlist",
  "version": "1.3.0",
  "contractVersion": 29,
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

/**
 * The playlist, read at most [CACHE_SECONDS] ago: the cache's, or [held]'s, or else downloaded,
 * parsed and kept. [again] reads it again whatever is kept, for a chunk the cache lost.
 */
async function readPlaylist({ again = false } = {}) {
  const address = playlistAddress();
  const now = yonto.now();
  const fresh = (state) => state.address === address && now - state.at < CACHE_SECONDS * 1000;
  if (held !== null && !fresh(held.state)) held = null;
  if (!again) {
    if (held !== null) return held;
    const state = await keptState();
    if (state !== null && fresh(state)) return { state, chunks: null, ids: null, search: null };
  }
  const entries = parsePlaylist(await download(address), address);
  if (entries.length === 0) throw yonto.error.unavailable(EMPTY_MESSAGE);
  const playlist = compactOf(entries, address, now);
  held = (await kept(playlist)) ? null : playlist;
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

// ---------------------------------------------------------------------------- the kept playlist

// A big playlist's entries are ~110 MB of a realm, so none of them stays in memory between calls:
// they are lines in `yonto.cache`, and a call reads only the chunks it needs. `playlist` is the
// state, `playlist:<n>` the chunks (`plugins/m3u/AGENTS.md`, *The kept playlist*).
const STATE_KEY = 'playlist';
const CHUNK_KEY = 'playlist:';
/** Every line's id in line order, so a title page reads one ids piece and one chunk rather than scanning. */
const IDS_KEY = 'playlist:ids:';
/** Each line's title and group, lowercased as they were written, so a search lowercases nothing and reads no address. */
const SEARCH_KEY = 'playlist:search:';
const ID_CHARS = 32;
/** 4 Mi characters a piece, so a 90,000 entry playlist's ids are one piece. */
const IDS_PER_PIECE = 128 * 1024;
/** Well under the 16 Mi characters a cache value may be, so a call holds one small chunk at a time. */
const CHUNK_CHARS = 512 * 1024;
/** What the playlist may come to on disk, under the 64 MiB a source's cache keeps, so the host never drops our own chunks to make room. */
const CACHE_BYTES = 60 * 1024 * 1024;
const [ID, TITLE, GROUP, POSTER, URL, LIVE, HEADERS] = [0, 1, 2, 3, 4, 5, 6];
const TAB = /\t/g;
// Bounded: an unbounded run over a piece of millions of characters runs the device's regexp out of memory.
const NON_ASCII_RUN = /[^\x00-\x7f]{1,4096}/g;
const LOST = Symbol('lost');

/** The playlist the cache did not keep (a source nobody saved, a disk that refuses, one too large), for this runtime. */
let held = null;

/** What an entry's id is the md5 of. */
function keyOf(entry) {
  return `${entry.url}\n${entry.title}`;
}

/**
 * The first of every address and title, in order, as lines: the app keys its lists on the id, and
 * a playlist repeats entries. Each entry is let go once it is a line, so the two never fill a realm side by side.
 */
function compactOf(entries, address, at) {
  const build = `${at.toString(36)}-${Math.random().toString(36).slice(2)}`;
  const seen = new Set();
  const groups = new Map();
  const chunks = chunker(build);
  const search = chunker(build);
  const ids = [];
  let idParts = null;
  let lines = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    entries[i] = undefined;
    const id = yonto.crypto.md5(keyOf(entry));
    if (seen.has(id)) continue;
    seen.add(id);
    if (lines % IDS_PER_PIECE === 0) {
      if (idParts !== null) ids.push(idParts.join(''));
      idParts = [`${build}\n`];
    }
    idParts.push(id);
    chunks.add(lineOf(id, entry), lines);
    let group = groups.get(entry.group);
    if (group === undefined) groups.set(entry.group, (group = [entry.group, [], fieldOf(entry.group).toLowerCase()]));
    search.add(`${fieldOf(entry.title).toLowerCase()}\t${group[2]}\n`, lines);
    const runs = group[1];
    const run = runs[runs.length - 1];
    if (run !== undefined && run[0] + run[1] === lines) run[1] += 1;
    else runs.push([lines, 1]);
    lines += 1;
  }
  if (idParts !== null) ids.push(idParts.join(''));
  chunks.done();
  search.done();
  const state = {
    address, at, build, lines, starts: chunks.starts, searchStarts: search.starts,
    groups: [...groups.values()].map(([name, runs]) => [name, runs]),
  };
  return { state, chunks: chunks.pieces, ids, search: search.pieces };
}

/** Lines cut into pieces of at most [CHUNK_CHARS], each opening with [build], a line never split; [starts] is each piece's first line. */
function chunker(build) {
  const pieces = [];
  const starts = [];
  let parts = null;
  let size = 0;
  const done = () => {
    if (parts !== null) pieces.push(parts.join(''));
    parts = null;
  };
  return {
    pieces,
    starts,
    done,
    add(line, at) {
      if (parts !== null && size + line.length > CHUNK_CHARS) done();
      if (parts === null) {
        parts = [`${build}\n`];
        size = parts[0].length;
        starts.push(at);
      }
      parts.push(line);
      size += line.length;
    },
  };
}

// A tab in a field would split the line; a line break cannot be in one, since the playlist's lines were split on them.
function lineOf(id, entry) {
  const headers = isEmpty(entry.headers) ? '' : JSON.stringify(entry.headers);
  return `${id}\t${fieldOf(entry.title)}\t${fieldOf(entry.group)}\t${fieldOf(entry.poster ?? '')}\t${fieldOf(entry.url)}\t${entry.live ? '1' : ''}\t${headers}\n`;
}

function fieldOf(text) {
  return text.includes('\t') ? text.replace(TAB, ' ') : text;
}

/**
 * The chunks, then the state that names them; false when any was not kept or the whole would pass
 * what the cache holds. A lone surrogate, which a decoded body cannot hold, would be refused and so held.
 */
async function kept(playlist) {
  const stateText = JSON.stringify(playlist.state);
  if (bytesOf([stateText, ...playlist.chunks, ...playlist.ids, ...playlist.search]) > CACHE_BYTES) {
    yonto.log('info', 'the playlist is too large to keep, so it is held for this runtime');
    return false;
  }
  for (let n = 0; n < playlist.chunks.length; n += 1) {
    if (!(await cacheSet(CHUNK_KEY + n, playlist.chunks[n]))) return false;
  }
  for (let n = 0; n < playlist.ids.length; n += 1) {
    if (!(await cacheSet(IDS_KEY + n, playlist.ids[n]))) return false;
  }
  for (let n = 0; n < playlist.search.length; n += 1) {
    if (!(await cacheSet(SEARCH_KEY + n, playlist.search[n]))) return false;
  }
  return cacheSet(STATE_KEY, stateText);
}

/** At most the UTF-8 bytes of [texts]: a character past ASCII counted as three. */
function bytesOf(texts) {
  let bytes = 0;
  for (const text of texts) {
    bytes += text.length;
    NON_ASCII_RUN.lastIndex = 0;
    for (let run = NON_ASCII_RUN.exec(text); run !== null; run = NON_ASCII_RUN.exec(text)) bytes += 2 * run[0].length;
  }
  return bytes;
}

async function keptState() {
  const text = await cacheGet(STATE_KEY);
  if (text === null) return null;
  try {
    const state = JSON.parse(text);
    const shaped = Array.isArray(state?.starts) && Array.isArray(state.searchStarts) && Array.isArray(state.groups) && typeof state.build === 'string' && Number.isInteger(state.lines);
    return shaped ? state : null;
  } catch {
    return null;
  }
}

/** A cache that cannot be read is no playlist kept, and one that cannot be written is a playlist held. */
async function cacheGet(key) {
  try {
    const text = await yonto.cache.get(key);
    return typeof text === 'string' ? text : null;
  } catch (error) {
    yonto.log('warn', `the playlist could not be read back: ${error?.code ?? 'no code'}`);
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    return (await yonto.cache.set(key, value, { ttlSeconds: CACHE_SECONDS })) === true;
  } catch (error) {
    yonto.log('warn', `the playlist was not kept: ${error?.code ?? 'no code'}`);
    return false;
  }
}

/** Chunk [n], its build id on the first line; null when the cache lost it or holds another build's. */
async function chunkOf(playlist, n) {
  return playlist.chunks !== null ? playlist.chunks[n] : pieceOf(playlist, CHUNK_KEY + n);
}

/** Ids piece [n], as [chunkOf] reads a chunk. */
async function idsOf(playlist, n) {
  return playlist.ids !== null ? playlist.ids[n] : pieceOf(playlist, IDS_KEY + n);
}

/** Search piece [n], as [chunkOf] reads a chunk. */
async function searchOf(playlist, n) {
  return playlist.search !== null ? playlist.search[n] : pieceOf(playlist, SEARCH_KEY + n);
}

async function pieceOf(playlist, key) {
  const text = await cacheGet(key);
  const newline = text?.indexOf('\n') ?? -1;
  if (newline !== playlist.state.build.length || !text.startsWith(playlist.state.build)) return null;
  return text;
}

/** What [read] answers of the playlist, read again first when a chunk it needed is lost: never a partial answer. */
async function answered(read) {
  const answer = await read(await readPlaylist());
  return answer === LOST ? read(await readPlaylist({ again: true })) : answer;
}

/** The fields of each line in [lines], ascending, a chunk read once for all the lines in it. */
async function linesAt(playlist, lines) {
  const { starts } = playlist.state;
  const found = [];
  let n = -1;
  let text = '';
  let at = 0;
  let line = 0;
  for (const wanted of lines) {
    if (n + 1 < starts.length && wanted >= starts[n + 1]) {
      n += 1;
      while (n + 1 < starts.length && wanted >= starts[n + 1]) n += 1;
      text = await chunkOf(playlist, n);
      if (text === null) return LOST;
      at = text.indexOf('\n') + 1;
      line = starts[n];
    }
    for (; line < wanted && at > 0; line += 1) at = text.indexOf('\n', at) + 1;
    const end = text.indexOf('\n', at);
    if (at === 0 || end < 0) return LOST;
    found.push(text.slice(at, end).split('\t'));
  }
  return found;
}

/** The lines of a group's entries [from] to [to] in its own order, from its runs. */
function groupLines(runs, from, to) {
  const lines = [];
  let before = 0;
  for (const [start, length] of runs) {
    for (let i = Math.max(0, from - before); i < length && before + i < to; i += 1) lines.push(start + i);
    before += length;
    if (before >= to) break;
  }
  return lines;
}

/** The fields of the line whose id is [id], null when there is none: its place in the ids, then its one chunk. */
async function lineWithId(playlist, id) {
  if (id.length !== ID_CHARS) return null;
  const pieces = Math.ceil(playlist.state.lines / IDS_PER_PIECE);
  const first = playlist.state.build.length + 1;
  for (let n = 0; n < pieces; n += 1) {
    const text = await idsOf(playlist, n);
    if (text === null) return LOST;
    let at = text.indexOf(id, first);
    while (at >= 0 && (at - first) % ID_CHARS !== 0) at = text.indexOf(id, at + 1);
    if (at < 0) continue;
    const lines = await linesAt(playlist, [n * IDS_PER_PIECE + (at - first) / ID_CHARS]);
    if (lines === LOST || lines[0][ID] !== id) return LOST;
    return lines[0];
  }
  return null;
}

/**
 * The entries whose title or group holds [needle], in playlist order: found in the search pieces,
 * which hold nothing else and are lowercased already, then read from the chunks holding them.
 */
async function matching(playlist, needle) {
  if (needle.includes('\t') || needle.includes('\n')) return [];
  const { searchStarts } = playlist.state;
  const hits = [];
  for (let n = 0; n < searchStarts.length && hits.length < SEARCH_LIMIT; n += 1) {
    const text = await searchOf(playlist, n);
    if (text === null) return LOST;
    // The line the cursor is at, the build id's being 0.
    let line = 0;
    let at = 0;
    for (let hit = text.indexOf(needle, text.indexOf('\n') + 1); hit >= 0 && hits.length < SEARCH_LIMIT;) {
      const start = text.lastIndexOf('\n', hit) + 1;
      for (; at < start; line += 1) at = text.indexOf('\n', at) + 1;
      hits.push(searchStarts[n] + line - 1);
      hit = text.indexOf(needle, text.indexOf('\n', hit) + 1);
    }
  }
  const lines = await linesAt(playlist, hits);
  return lines === LOST ? LOST : lines.map(summaryOf);
}

function summaryOf(fields) {
  const summary = { id: fields[ID], title: fields[TITLE], type: 'MOVIE' };
  if (fields[POSTER] !== '') summary.posterUrl = fields[POSTER];
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
function streamOf(fields) {
  const url = fields[URL];
  const stream = { url, mimeType: HLS_ADDRESS.test(url) ? HLS_MIME : PROGRESSIVE_MIME };
  if (fields[LIVE] === '1') stream.live = true;
  if (fields[HEADERS] !== '') stream.headers = JSON.parse(fields[HEADERS]);
  return stream;
}

// ---------------------------------------------------------------------------- the contract

export default {
  /** The playlist's own groups in the order they first appear, under All. */
  async getCategories() {
    const { state } = await readPlaylist();
    return [
      { id: ALL_CATEGORY_ID, name: ALL_CATEGORY_NAME },
      ...state.groups.map(([name]) => ({ id: GROUP_PREFIX + name, name })),
    ];
  },

  /** One page of a group, or of the whole playlist for All. */
  async getMediaList(categoryId, options) {
    const id = String(categoryId ?? ALL_CATEGORY_ID);
    const page = Math.max(1, Math.trunc(options?.page ?? 1));
    const [from, to] = [(page - 1) * PAGE_SIZE, page * PAGE_SIZE];
    const lines = await answered(async (playlist) => {
      const { state } = playlist;
      let wanted;
      if (id === ALL_CATEGORY_ID) {
        wanted = [];
        for (let line = from; line < Math.min(to, state.lines); line += 1) wanted.push(line);
      } else {
        const group = state.groups.find(([name]) => GROUP_PREFIX + name === id);
        if (group === undefined) throw yonto.error.notFound(id);
        wanted = groupLines(group[1], from, to);
      }
      return linesAt(playlist, wanted);
    });
    return lines.map(summaryOf);
  },

  /** One entry, which has the one thing to play. */
  async getMediaDetail(mediaId) {
    const fields = await answered((playlist) => lineWithId(playlist, String(mediaId)));
    if (fields === null) throw yonto.error.notFound(mediaId);
    const group = fields[GROUP];
    return {
      ...summaryOf(fields),
      genres: group === UNGROUPED_NAME ? [] : [group],
      playbackOptions: [{ label: fields[TITLE], stream: streamOf(fields) }],
    };
  },

  /** A title or group containing the words, case-insensitively: a playlist has no search of its own. */
  async search(query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle === '') {
      await readPlaylist();
      return [];
    }
    return answered((playlist) => matching(playlist, needle));
  },
};
