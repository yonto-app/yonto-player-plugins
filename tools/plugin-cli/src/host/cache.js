import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Code, PluginError } from '../errors.js';

/** What one write may be and what one source keeps; `PluginCacheLimits` on the device, same numbers and words. */
export const MAX_KEY_CHARS = 1024;
export const MAX_VALUE_CHARS = 16 * 1024 * 1024;
export const MAX_ENTRIES = 256;
export const MAX_BYTES = 64 * 1024 * 1024;

const PART = '.part';
// Room for the header line: a key of 1,024 characters, as UTF-8 and JSON-escaped, and the rest of it.
const HEADER_BYTES = 16 * 1024;

/** The first line of [file] alone, as trim needs it, rather than a value of up to 16 Mi characters. */
function headerLineOf(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const newline = buffer.subarray(0, read).indexOf(0x0a);
    return newline < 0 ? null : buffer.subarray(0, newline).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function check(key, value) {
  let refused = null;
  if (key.length > MAX_KEY_CHARS) refused = `the key is ${key.length} characters, over the ${MAX_KEY_CHARS} a cache keeps`;
  else if (!key.isWellFormed()) refused = 'the key has a lone surrogate, which a cache cannot keep';
  else if (value.length > MAX_VALUE_CHARS) refused = `the value is ${value.length} characters, over the ${MAX_VALUE_CHARS} a cache keeps`;
  // Kept as UTF-8, which has no lone surrogate, so it would come back as another string.
  else if (!value.isWellFormed()) refused = 'the value has a lone surrogate, which a cache cannot keep';
  if (refused) throw new PluginError(Code.STORE_REFUSED, `yonto.cache.set refused: ${refused}`, { key });
}

const digest = (text) => createHash('sha256').update(text).digest('hex');

/**
 * `yonto.cache` for one source: one file per key under [dir], a line of JSON naming its key, its
 * expiry and when it was written, then the value, as the device's `PluginCaches` writes it. A file
 * that cannot be read is absent, and a write the disk refuses is dropped: it is a cache. [dir] null
 * keeps nothing, as `PluginCache.NONE` does for a source nobody saved.
 */
export function createCache({ dir, now = Date.now, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }) {
  if (dir === null) {
    return {
      async get() { return null; },
      async set(key, value) { check(key, value); return false; },
      async remove() {},
    };
  }
  // Truncated to the millisecond and held finite, as the store's expiry is.
  const expiryAfter = (ttlSeconds) =>
    Math.trunc(Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, now() + ttlSeconds * 1000)));
  const live = (header, at) => header.expiresAt === null || header.expiresAt > at;
  const headerOf = (text) => {
    const newline = text.indexOf('\n');
    if (newline < 0) return null;
    const header = JSON.parse(text.slice(0, newline));
    return { header, value: text.slice(newline + 1) };
  };

  /** Expired and unreadable entries first, then the least recently written, never [keeping]. */
  const trim = (keeping) => {
    const at = now();
    const entries = [];
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (name.endsWith(PART)) {
        rmSync(file, { force: true });
        continue;
      }
      let header = null;
      try {
        const line = headerLineOf(file);
        header = line === null ? null : JSON.parse(line);
      } catch {
        header = null;
      }
      if (file !== keeping && (header === null || !live(header, at))) {
        rmSync(file, { force: true });
        continue;
      }
      entries.push({ file, writtenAt: header?.writtenAt ?? at, size: statSync(file).size });
    }
    let count = entries.length;
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.filter((e) => e.file !== keeping).sort((a, b) => a.writtenAt - b.writtenAt)) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      rmSync(entry.file, { force: true });
      count -= 1;
      bytes -= entry.size;
    }
  };

  return {
    async get(key) {
      if (!key.isWellFormed()) return null;
      try {
        const read = headerOf(readFileSync(join(dir, digest(key)), 'utf8'));
        if (read === null || read.header.key !== key || !live(read.header, now())) return null;
        return read.value;
      } catch {
        return null;
      }
    },
    async set(key, value, { ttlSeconds = null } = {}) {
      check(key, value);
      const header = { key, expiresAt: ttlSeconds === null ? null : expiryAfter(ttlSeconds), writtenAt: now() };
      const file = join(dir, digest(key));
      try {
        mkdirSync(dir, { recursive: true });
        const part = `${file}.${process.pid}${PART}`;
        writeFileSync(part, `${JSON.stringify(header)}\n${value}`);
        renameSync(part, file);
      } catch {
        // A disk that refused the write leaves the key absent, which a cache may always be.
        return false;
      }
      try {
        trim(file);
      } catch {
        // A trim that fails leaves the folder over its bounds until the next write, not this value unkept.
      }
      return true;
    },
    async remove(key) {
      try {
        rmSync(join(dir, digest(key)), { force: true });
      } catch {
        // As a write the disk refused: what could not be removed reads as absent once it expires or is dropped.
      }
    },
  };
}
