import { createDecipheriv } from 'node:crypto';
import { YONTO_ENTRY_TYPE, YONTO_TYPES, TVBOX_ENTRY_TYPES, XPTV_ENTRY_TYPES, isTypeName } from './yonto-types.js';

/**
 * Reads an index the way the app's `IndexReader` does: a TVBox 仓, an XPTV index or a Yonto
 * index, unwrapped from its disguise, parsed leniently, its dialect sniffed, and every entry
 * typed or counted as skipped (docs/design/2026-09-23-the-app-reads-every-index.md, *The
 * reader*). `conformance/index-reading/` holds the two readers to one answer per document.
 *
 * A document with no `sites` that is a list of repos, a 多仓's `storeHouse` or a 多线路's `urls`,
 * reads as `{ list }`; the two chain, a 多仓 naming 多线路 lists that name 仓s (#786).
 */

export const DIALECT = Object.freeze({ CANG: 'cang', XPTV: 'xptv', YONTO: 'yonto' });

export const REFUSAL = Object.freeze({ NOT_AN_INDEX: 'not-an-index', TOO_MANY_ENTRIES: 'too-many-entries' });

/** Mirrors `sites.maxItems` in `contracts/index.schema.json` (kangzj/lantern-tv#626). */
const MAX_ENTRIES = 2000;

// Nine is the deepest any document in #572's corpus or XPTV's files nests; the Kotlin parser
// recurses, and this keeps both readers well inside its stack (kangzj/lantern-tv#648).
const MAX_NESTING = 64;

const XPTV_JS = 'xptv-js';
const MACCMS_XML = 'maccms-xml';
const MACCMS_JSON = 'maccms-json';
// `at/xml` or `at/json` after a `/`, `?` or `&`, which is how a MacCMS address names its
// dialect: `…/provide/vod/at/xml/`, `…/provide/vod/from/x/?at/xml/`. A proxy's
// `?url=https://cms/…/at/xml/` names it too, since the wrapped server is the one answering, and
// the first one named wins. Matched in the path and query alone, since neither the host nor a
// fragment is what the server is asked for. No `$`, which Kotlin's regex also matches before a
// final line terminator and JavaScript's does not.
const DIALECT_IN_ADDRESS = /(?:^|[/?&])at\/(xml|json)(?![^/?&])/;
const SCHEME_AND_AUTHORITY = /^https?:\/\/[^/?#]*/;
const SPIDER_TYPE = 3;
// Keys FongMi reads that no XPTV index has been seen to carry (kangzj/lantern-tv#648).
const CANG_ONLY_KEYS = ['lives', 'parses', 'rules'];
const HTTP_ADDRESS = /^https?:\/\/\S+$/;

const BOM = '\uFEFF';
const BASE64_MARKER = /[A-Za-z0-9]{8}\*\*/;
const CIPHER_PREFIX = '2423';
const KEY_END_HEX = '2324';
const IV_LENGTH = 13;
const AES_BLOCK = 16;
// Java's `\s`, which is what FongMi drops from the hex, rather than JavaScript's wider one.
const HEX_WHITESPACE = /[ \t\n\u000B\f\r]+/g;
const OPENS_AS_OBJECT = /^[ \t\n\r]*(?:\{|\/[/*])/;

/**
 * [bytes] read as an index, pinned to [dialect] when the repo already has one, sniffed
 * otherwise. Answers `{ dialect, named, entries, skipped }`, `{ list }` for a list of repos, or
 * `{ refused }` when the document is neither: one entry it can't use is counted, never a refusal.
 */
export function readIndex(bytes, dialect = null) {
  const root = documentOf(bytes);
  if (root === null) return { refused: REFUSAL.NOT_AN_INDEX };
  if (!Array.isArray(root.sites)) {
    const list = listedIn(root);
    return list === null ? { refused: REFUSAL.NOT_AN_INDEX } : { list };
  }
  if (root.sites.length > MAX_ENTRIES) return { refused: REFUSAL.TOO_MANY_ENTRIES };
  const read = dialect ?? sniff(root);
  const skipped = { spider: 0, type: 0, address: 0, duplicate: 0, unknownType: 0 };
  const entries = [];
  const keys = new Set();
  for (const site of root.sites) {
    const { yontoType, skip } = typeOf(site, read);
    if (skip) { skipped[skip] += 1; continue; }
    const address = text(addressOf(site, yontoType));
    if (!HTTP_ADDRESS.test(address)) { skipped.address += 1; continue; }
    const key = text(site.key) || address;
    if (keys.has(key)) { skipped.duplicate += 1; continue; }
    keys.add(key);
    const type = dialectNamedBy(yontoType, site, address);
    entries.push({ key, name: text(site.name) || key, yontoType: type, address, config: configOf(type, site, address) });
  }
  return { dialect: read, named: root.sites.length, entries, skipped };
}

/**
 * A 多仓's `storeHouse` of `sourceName` and `sourceUrl`, or else a 多线路's `urls` of `name` and
 * `url`, as the TVBox players read them. Only the download's own bound limits how many: a list
 * is browsed, never saved, and real ones name thousands.
 */
function listedIn(root) {
  const [items, nameKey, urlKey] = Array.isArray(root.storeHouse)
    ? [root.storeHouse, 'sourceName', 'sourceUrl']
    : Array.isArray(root.urls) ? [root.urls, 'name', 'url'] : [null];
  if (items === null) return null;
  const skipped = { address: 0, duplicate: 0 };
  const repos = [];
  const urls = new Set();
  for (const item of items) {
    const isObject = item !== null && typeof item === 'object' && !Array.isArray(item);
    const url = isObject ? text(item[urlKey]) : '';
    if (!HTTP_ADDRESS.test(url)) { skipped.address += 1; continue; }
    if (urls.has(url)) { skipped.duplicate += 1; continue; }
    urls.add(url);
    repos.push({ name: text(item[nameKey]) || url, url });
  }
  return { named: items.length, repos, skipped };
}

/**
 * A numbered MacCMS entry whose address names its dialect is read in that dialect, whatever its
 * `type` says; `type` decides otherwise. FongMi reads `type` alone, so a server at `…/at/xml/`
 * typed 1 is parsed as JSON there and shows nothing; the address is the more specific statement
 * of what the server speaks (kangzj/lantern-tv#595). A type-50 entry names its type outright.
 */
function dialectNamedBy(yontoType, site, address) {
  if (site.type === YONTO_ENTRY_TYPE || (yontoType !== MACCMS_JSON && yontoType !== MACCMS_XML)) return yontoType;
  const named = DIALECT_IN_ADDRESS.exec(address.replace(SCHEME_AND_AUTHORITY, '').split('#')[0])?.[1];
  if (named === 'xml') return MACCMS_XML;
  if (named === 'json') return MACCMS_JSON;
  return yontoType;
}

/**
 * A 仓 has a `spider` or a `type` 0 entry; a Yonto index names only type-50 entries, whatever
 * else it carries; a document with a key only a 仓 has (`lives`, `parses`, `rules`) is a 仓 too;
 * the rest is XPTV. It only matters for `type` 3, a CatVod spider in a 仓 and a script in XPTV.
 */
function sniff(root) {
  if (Object.hasOwn(root, 'spider') || root.sites.some((site) => numericType(site?.type) === 0)) return DIALECT.CANG;
  if (root.sites.length > 0 && root.sites.every((site) => site?.type === YONTO_ENTRY_TYPE)) return DIALECT.YONTO;
  if (CANG_ONLY_KEYS.some((key) => Object.hasOwn(root, key))) return DIALECT.CANG;
  return DIALECT.XPTV;
}

/**
 * Where the entry's server is: `api`, save an XPTV program, which a numbered entry carries as
 * `ext` and a type-50 entry as its config's `ext`, since there `ext` is the Yonto object.
 */
function addressOf(site, yontoType) {
  if (yontoType !== XPTV_JS) return site.api;
  return site.type === YONTO_ENTRY_TYPE ? site.ext.config?.ext : site.ext;
}

/** The entry's yonto type, or which count it is skipped under. */
function typeOf(site, dialect) {
  if (site === null || typeof site !== 'object' || Array.isArray(site)) return { skip: 'type' };
  // A number, never the string "50", because `contracts/index.schema.json` refuses a Yonto
  // entry typed "50" (kangzj/lantern-tv#626). The others are read as TVBox players read them,
  // a numeric string included.
  if (site.type === YONTO_ENTRY_TYPE) {
    const named = site.ext?.yontoType;
    const known = typeof named === 'string' && (YONTO_TYPES.has(named) || (named.includes('.') && isTypeName(named)));
    return known ? { yontoType: named } : { skip: 'unknownType' };
  }
  const type = numericType(site.type);
  const numbered = dialect === DIALECT.CANG ? TVBOX_ENTRY_TYPES : XPTV_ENTRY_TYPES;
  if (numbered.has(type)) return { yontoType: numbered.get(type) };
  return dialect === DIALECT.CANG && type === SPIDER_TYPE ? { skip: 'spider' } : { skip: 'type' };
}

function numericType(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^(?:0|[1-9][0-9]*)$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * What the entry's handler is handed: a type-50 entry carries its own as `ext.config`, and the
 * reader builds one for a numeric entry out of the fields its type reads.
 */
function configOf(yontoType, site, address) {
  if (site.type === YONTO_ENTRY_TYPE) {
    const carried = site.ext.config;
    // As a handler receives it, written out: a number past a double's range is null there.
    return carried !== null && typeof carried === 'object' && !Array.isArray(carried) ? JSON.parse(JSON.stringify(carried)) : {};
  }
  if (yontoType === XPTV_JS) return { ext: address, ...(text(site.api) ? { className: text(site.api) } : {}) };
  return {
    api: address,
    dialect: yontoType === MACCMS_XML ? 'xml' : 'json',
    ...(text(site.searchable) === '0' ? { searchable: false } : {}),
  };
}

/**
 * Every scalar in a hand-written index may be a number, a null or an object. A number past a
 * double's range is none, as `JSON.stringify` writes it.
 */
export function text(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value.trim() : '';
}

// ------------------------------------------------------------------------- the document

/** The document's root object, unwrapped and parsed, or null. */
function documentOf(bytes) {
  const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const body = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  try {
    // Read as it is when it already parses as an object, before any disguise is looked for,
    // as FongMi's `Decoder` checks `Json.isObj` first: a plain 仓's notice can hold eight
    // letters and `**` (kangzj/lantern-tv#603).
    const root = plainObject(body) ?? parseLenientJson(unwrap(body));
    return root !== null && typeof root === 'object' && !Array.isArray(root) ? root : null;
  } catch {
    return null;
  }
}

function plainObject(body) {
  if (!OPENS_AS_OBJECT.test(body)) return null;
  try {
    const parsed = parseLenientJson(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The two disguises, the way FongMi's `Decoder` takes them off: base64 after an
 * eight-character marker and `**` (usually after an image), then AES-CBC hex behind `2423`.
 */
function unwrap(body) {
  const marker = BASE64_MARKER.exec(body);
  const unwrapped = marker === null ? body : base64Text(body.slice(marker.index + marker[0].length));
  return unwrapped.startsWith(CIPHER_PREFIX) ? decryptCbc(unwrapped) : unwrapped;
}

// The base64 follows binary noise and may carry a MIME encoder's line breaks, so only the
// alphabet and its padding are kept. Padding anywhere but the end, or a length no base64 has,
// is refused, as FongMi's decoder refuses it.
function base64Text(text) {
  const alphabet = text.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  if (alphabet.includes('=') || alphabet.length % 4 === 1) throw new Error('not base64');
  return Buffer.from(alphabet, 'base64').toString('utf8');
}

/**
 * Hex AES-CBC: the key between `$#` and `#$`, the iv the last 13 bytes, both lowercased
 * as FongMi's `cbc()` lowercases them and padded with the character `0` to 16. Done in hex,
 * so a byte stays a byte; only ASCII capitals are lowercased (kangzj/lantern-tv#572).
 */
function decryptCbc(rawHex) {
  const hex = rawHex.replace(HEX_WHITESPACE, '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('not hex');
  const keyEnd = indexOfByte(hex, KEY_END_HEX);
  const ivStart = hex.length - IV_LENGTH * 2;
  if (keyEnd < 0 || ivStart < keyEnd + KEY_END_HEX.length) throw new Error('no key');
  const key = bytesOf(padHex(lowerAsciiHex(hex.slice(CIPHER_PREFIX.length, keyEnd))));
  const iv = bytesOf(padHex(lowerAsciiHex(hex.slice(ivStart))));
  const body = bytesOf(hex.slice(keyEnd + KEY_END_HEX.length, ivStart));
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Pair by pair, as `IndexDisguise` reads them, rather than Node's `'hex'`, which stops at the
 * first bad pair: only the not-hex check refuses a pair like `-f` on either host.
 */
function bytesOf(hex) {
  return Buffer.from(Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) & 0xff));
}

/** Where a byte sequence starts, on a byte boundary: `2324` also sits across two bytes. */
function indexOfByte(hex, needle) {
  for (let at = hex.indexOf(needle); at >= 0; at = hex.indexOf(needle, at + 1)) {
    if (at % 2 === 0) return at;
  }
  return -1;
}

function lowerAsciiHex(hex) {
  return hex.replace(/[0-9a-f]{2}/g, (byte) => {
    const code = parseInt(byte, 16);
    return code >= 0x41 && code <= 0x5a ? (code + 0x20).toString(16) : byte;
  });
}

function padHex(hex) {
  return hex.padEnd(AES_BLOCK * 2, '30');
}

/**
 * JSON as a 仓 is hand-written, and this reads the hand-written forms FongMi's Gson 2.14.0 reads
 * where the grammar says what was meant: `//`, `#` and `/* *\/` comments, a `\'` escape, and raw
 * control characters inside strings. Scanned, not regexed, since a config is full of `https://`.
 *
 * **More lenient than FongMi in two places, on purpose:** a trailing comma is dropped, where Gson
 * refuses one in an object and reads one in an array as an extra `null` (so a lone `[,]` or `{,}`
 * reads as empty); and a comment after the document is skipped, where Gson refuses it.
 * **Stricter everywhere else Gson goes past JSON**, which includes unquoted and single-quoted keys
 * and values, `=`/`=>` and `;` separators, `NaN`, uppercase keywords, an empty array element
 * before another, and the `)]}'` prefix. That is why a key missing its opening quote, or a stray
 * `"` after a value, refuses the document: Gson reads either as an unquoted key or value, with one
 * field quietly wrong, and this does not guess the same wrong field (kangzj/lantern-tv#657, the
 * design's *The reader*).
 */
function parseLenientJson(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char < ' ') {
        // After a backslash Gson reads the pair as the character itself, so that backslash goes.
        if (escaped) out = out.slice(0, -1);
        out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        escaped = false;
        continue;
      }
      if (escaped && char === "'") {
        // `\'` is not a JSON escape and Gson reads it as the quote, so the backslash goes.
        out = `${out.slice(0, -1)}'`;
        escaped = false;
        continue;
      }
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > MAX_NESTING) throw new Error('nested too deep');
      out += char;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      out += char;
    } else if (opensLineComment(text, i)) {
      i = endOfLine(text, i);
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else if (!(char === ',' && closesNext(text, i))) {
      out += char;
    }
  }
  return JSON.parse(out);
}

/** Whether what follows the comma at [at], past whitespace and comments, closes a list or object. */
function closesNext(text, at) {
  for (let i = at + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue;
    if (opensLineComment(text, i)) {
      i = endOfLine(text, i);
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 1;
    } else {
      return char === '}' || char === ']';
    }
  }
  return false;
}

/** `//` or `#`, outside a string: Gson reads both as a comment to the end of the line. */
function opensLineComment(text, at) {
  return text[at] === '#' || (text[at] === '/' && text[at + 1] === '/');
}

/** Where the line [at] is on ends: its `\n`, or a lone `\r`, which Gson ends a comment at too. */
function endOfLine(text, at) {
  let i = at;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
  return i;
}
