import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Code, PluginError } from '../errors.js';

/** How much one source's store holds; `PluginStoreLimits` on the device, same numbers and
 *  words. The value is measured as the JSON text it crosses as there. */
export const MAX_KEY_CHARS = 1024;
export const MAX_VALUE_CHARS = 1024 * 1024;
export const MAX_KEYS = 256;

function check(key, valueJson, othersLive) {
  let refused = null;
  if (key.length > MAX_KEY_CHARS) refused = `the key is ${key.length} characters, over the ${MAX_KEY_CHARS} a store keeps`;
  // The device's DataStore writes one as `?`, so after a restart it would answer for another key.
  else if (!key.isWellFormed()) refused = 'the key has a lone surrogate, which a store cannot keep';
  else if (valueJson.length > MAX_VALUE_CHARS) {
    refused = `the value is ${valueJson.length} characters of JSON, over the ${MAX_VALUE_CHARS} a store keeps`;
  } else if (othersLive >= MAX_KEYS) refused = `this source's store already holds the ${MAX_KEYS} keys it keeps`;
  if (refused) throw new PluginError(Code.STORE_REFUSED, `yonto.store.set refused: ${refused}`, { key });
}

export function createStore({ dir, now = Date.now }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'store.json');
  // Truncated to the millisecond and held finite, as the device's Long is: JSON writes an
  // infinite expiry as null, which would read back as never expiring.
  const expiryAfter = (ttlSeconds) =>
    Math.trunc(Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, now() + ttlSeconds * 1000)));
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const write = (data) => writeFileSync(file, JSON.stringify(data));

  return {
    async get(key) {
      const entry = read()[key];
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= now()) return null;
      return entry.value;
    },
    async set(key, value, { ttlSeconds = null } = {}) {
      const data = read();
      // Expired keys go first, so a store is full of what is live rather than of what was.
      for (const [name, entry] of Object.entries(data)) {
        if (name !== key && entry.expiresAt !== null && entry.expiresAt <= now()) delete data[name];
      }
      check(key, String(JSON.stringify(value)), Object.keys(data).filter((name) => name !== key).length);
      data[key] = { value, expiresAt: ttlSeconds === null ? null : expiryAfter(ttlSeconds) };
      write(data);
    },
    async remove(key) {
      const data = read();
      delete data[key];
      write(data);
    },
    async clear() {
      rmSync(file, { force: true });
    },
  };
}
