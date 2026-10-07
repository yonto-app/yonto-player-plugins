/**
 * What a held credential becomes in anything the plugin is handed or says — the design's *What
 * the plugin is handed back* and *Never in a log*. `CredentialMask.kt` on a television;
 * `conformance/link-login/masking.json` holds the two to one answer.
 */

/** What an answer the plugin is handed says in place of a held credential. */
export const MASKED = 'yonto-held-credential';

/** What plugin text says in place of one, once it has crossed into the host. */
export const REDACTED = '‹credential›';

/** The shortest value masked: every credential a dialect accepts is at least this long. */
const MIN_LENGTH = 8;

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * A credential as a service writes it, JSON-escaped (with and without `\/`), percent-encoded and
 * form-encoded as the sign-in's form bodies are (each escape in either case).
 */
export function spellingsOf(credential) {
  const json = credential.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const percent = [...credential].map((char) => (UNRESERVED.test(char)
    ? char : `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  const form = new URLSearchParams([['', credential]]).toString().slice(1);
  const lower = (escaped) => escaped.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase());
  return [...new Set([credential, json, json.replaceAll('/', '\\/'), percent, lower(percent), form, lower(form)])];
}

/** [text] with every spelling of every one of [held] replaced by [placeholder], longest first. */
export function masked(text, held, placeholder = MASKED) {
  const spellings = held.filter((value) => typeof value === 'string' && value.length >= MIN_LENGTH)
    .flatMap(spellingsOf)
    .sort((a, b) => b.length - a.length);
  let out = String(text);
  for (const spelling of spellings) out = out.replaceAll(spelling, placeholder);
  return out;
}

/** [bytes] masked as bytes: every held credential is ASCII, so it is the same bytes in any ASCII-compatible charset. */
export function maskedBytes(bytes, held) {
  return Buffer.from(masked(Buffer.from(bytes).toString('latin1'), held), 'latin1');
}

/** Every string in [value], masked; for a projection handed to the plugin. */
export function maskedLeaves(value, held) {
  if (typeof value === 'string') return masked(value, held);
  if (Array.isArray(value)) return value.map((item) => maskedLeaves(item, held));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskedLeaves(item, held)]));
  }
  return value;
}

/**
 * What `--record` must not write: each value the host holds or made this run, with the
 * placeholder it is recorded as (the design's *The CLI*). One added [hostOwn] appears only in
 * the host's own requests, and only their fixtures look for it: a four-letter code would
 * otherwise be replaced wherever it happened to occur in a plugin's pages.
 */
export function createSecrets() {
  const secrets = new Map();
  return {
    add(value, placeholder, { hostOwn = false } = {}) {
      if (value !== null && value !== undefined && String(value) !== '') secrets.set(String(value), { placeholder, hostOwn });
    },
    list({ hostOwn = false } = {}) {
      return [...secrets].filter(([, secret]) => hostOwn || !secret.hostOwn)
        .map(([value, { placeholder }]) => ({ value, placeholder }));
    },
  };
}

export const PLACEHOLDERS = Object.freeze({
  credential: '<credential>',
  serverCredential: '<server-credential>',
  pin: '<pin>',
  clientId: '<host-client-id>',
});
