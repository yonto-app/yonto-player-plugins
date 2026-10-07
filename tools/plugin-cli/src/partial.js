import { asLine } from './display-text.js';

// The methods whose answer a television draws `yonto.partial`'s sentence under. Every other
// call's is dropped, as `JsPluginContentSourceAdapter`'s NOTED_METHODS drops it.
const NOTED_METHODS = new Set(['getMediaList', 'search', 'getMediaDetail']);

// Blank as the device's `isNotBlank()` decides it — Kotlin's `Char.isWhitespace()`, which is
// Java's `isWhitespace` or `isSpaceChar` — rather than as `trim()` does, which also strips
// U+FEFF, a character the device shows.
const BLANK = /^[\p{Zs}\p{Zl}\p{Zp}\t\n\v\f\r\x1c-\x1f]*$/u;

/** The sentence a television shows for what a call to `method` said, or null. */
export function partialShown(method, reason) {
  if (reason === null || !NOTED_METHODS.has(method)) return null;
  const line = asLine(reason);
  return BLANK.test(line) ? null : line;
}
