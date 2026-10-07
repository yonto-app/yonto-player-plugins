import { Code, PluginError } from './errors.js';

/**
 * The manifest a plugin file carries in its own opening comment.
 *
 * A plugin is one `.js` file (kangzj/lantern-tv#100). The manifest is the same object
 * `contracts/manifest.schema.json` has always validated — only where it is written moved.
 *
 * **Read as text, never by evaluating the module.** That is the whole reason it is a
 * comment and not an `export`: `allowedHosts`, `hostsFromConfig`, `configSchema` and
 * `contractVersion` decide where a plugin may go, and learning them by running the plugin
 * inverts the order those exist in. It also keeps the editor's picker cheap — listing what
 * a box can run reads names without ever starting a runtime.
 *
 * `app/…/content/plugin/PluginHeader.kt` is the same file in the other language, and
 * `conformance/headers.json` holds both to it.
 */

/** What opens the comment. Leading whitespace and a BOM are allowed before it, nothing else. */
const OPENING = '/* yonto-plugin';

/** What closes it. Written as a pair so this file does not close its own comment. */
const CLOSING = `*${'/'}`;

/**
 * How far in the terminator is looked for.
 *
 * A hostile file must not be able to make either host scan a megabyte for a terminator that
 * is not there, so the search runs over this much and stops. The largest manifest in this
 * repository is under 2 KB.
 *
 * Characters, not bytes: both hosts index the same way, so this bounds the same work on
 * each, and counting bytes would mean encoding the file before deciding whether to read it.
 * These manifests carry Chinese labels, so the two numbers differ by a factor of three.
 */
export const MAX_HEADER_CHARS = 64 * 1024;

/**
 * A BOM and any leading whitespace, which an editor may add and a viewer cannot see.
 *
 * Spelled out rather than `\s`, and matched character for character by the Kotlin host:
 * JS counts U+FEFF as whitespace and Kotlin's `isWhitespace` does not, while Kotlin counts
 * the C0 separators U+001C-U+001F and JS does not. Left to each language's idea of blank,
 * the two hosts accept different files — which is the one thing this format cannot afford,
 * since the file a viewer installs is the file an author linted.
 */
const LEAD_IN = /^[\uFEFF \t\n\r\f\v]+/;

function withoutLeadIn(source) {
  return source.replace(LEAD_IN, '');
}

/**
 * The manifest JSON text at the top of `source`, or a refusal saying which rule it broke.
 *
 * Kept as text rather than parsed here, so both hosts share one set of rules about the
 * comment and each uses its own JSON parser and schema validator on what comes out.
 */
export function headerJson(source) {
  const text = withoutLeadIn(String(source ?? ''));
  if (!text.startsWith(OPENING)) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `a plugin file opens with "${OPENING}" and its manifest, and this one does not`);
  }

  // Bounded before the search, not after it: `indexOf` over the whole body would read the
  // megabyte this exists to refuse and only then decide it was too far in.
  const end = text.slice(0, MAX_HEADER_CHARS + CLOSING.length).indexOf(CLOSING, OPENING.length);
  if (end === -1) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `the yonto-plugin header is not closed within ${MAX_HEADER_CHARS} characters`);
  }
  return text.slice(OPENING.length, end);
}

/**
 * Whether a manifest can be written into a header at all.
 *
 * A comment terminator is the one sequence that could cut a header short into something
 * that still parses as JSON — a manifest ending early, with the rest of itself read as
 * code. `bundle` refuses rather than escaping, because an escape a reader cannot see is
 * worse than a refusal.
 */
export function headerSafe(manifestJson) {
  return !manifestJson.includes(CLOSING);
}

/**
 * The header text a file opens with, delimiters and all — what `bundle` re-prepends.
 *
 * The author's own bytes rather than a re-serialisation of what they parse to: an author
 * who laid their manifest out a particular way gets that file back, and the published
 * artifact differs from the entry file only where esbuild touched it.
 */
export function headerTextOf(source) {
  const text = withoutLeadIn(String(source ?? ''));
  const json = headerJson(text);
  return text.slice(0, OPENING.length + json.length + CLOSING.length);
}

/** A manifest as the header a plugin file opens with, terminator and all. */
export function headerFor(manifest) {
  const json = JSON.stringify(manifest, null, 2);
  if (!headerSafe(json)) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `a manifest cannot contain "${CLOSING}": it would close its own header early`);
  }
  return `${OPENING}\n${json}\n${CLOSING}\n`;
}
