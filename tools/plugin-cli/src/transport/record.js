import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spellingsOf } from '../host/mask.js';

// `body ?? ''`, not a default parameter: the bootstrap sends a bodyless request as null,
// the way the device's does, and `ReplayPluginTransport` reads it as `request.body ?: ""`.
// A default only catches undefined, so null hashed as the string "null" and no fixture
// recorded before today could be found again.
export function fixtureName({ method, url, body }) {
  const hash = createHash('sha256').update(`${url}\n${body ?? ''}`).digest('hex').slice(0, 16);
  return `${method.toLowerCase()}-${hash}.json`;
}

/**
 * [secrets] is what the host holds or made this run (`createSecrets`), each written as its
 * placeholder; a fixture in which one survives anyway is not written, and [refused] is told
 * which (the design's *The CLI*). [hostOwn] is the host's own requests, whose fixtures also
 * redact what only they carry: a sign-in's id and code, which [learn] is shown each answer to
 * find before it is written.
 */
export function createRecordTransport({
  inner, dir, secrets = null, hostOwn = false, learn = () => {}, refused = (file, why) => { throw new Error(`${file}: ${why}`); },
}) {
  mkdirSync(dir, { recursive: true });
  return {
    async request(req) {
      const response = await inner.request(req);
      learn(req, response);
      const held = secrets?.list({ hostOwn }) ?? [];
      const name = fixtureName(req);
      const fixture = withSecretsReplaced({
        request: { method: req.method, url: req.url, body: req.body ?? null },
        response: redacted(response),
      }, held);
      const survivor = held.find(({ value }) => spellingsOf(value).some((spelling) => survives(fixture, spelling)));
      if (survivor === undefined) {
        writeFileSync(join(dir, name), `${JSON.stringify(fixture, null, 2)}\n`);
      } else {
        refused(join(dir, name), `a value the host holds survived redaction as ${survivor.placeholder}, so the fixture was not written`);
      }
      return response;
    },
  };
}

// A fixture is committed, and a plugin recorded while signed in would commit its session. The
// value goes and the cookie stays: a catalog like XPTV's bdys.js carries a `Set-Cookie` onto
// its next request, and replay would be a different run if it found none. The folded header
// goes entirely — the host never hands it to a plugin. The request's headers were never
// written, so a `Cookie` sent has nowhere to land.
function redacted({ setCookie, ...response }) {
  return {
    ...response,
    headers: Object.fromEntries(Object.entries(response.headers)
      .filter(([name]) => name.toLowerCase() !== 'set-cookie')),
    ...(setCookie === undefined ? {} : { setCookie: setCookie.map(withoutValue) }),
  };
}

function withoutValue(cookie) {
  const [pair, ...attributes] = cookie.split(';');
  const equals = pair.indexOf('=');
  return [`${pair.slice(0, equals + 1)}redacted`, ...attributes].join(';');
}

/** Every spelling `yonto.fetch` masks of each held value, with its placeholder, longest first. */
function spelled(held) {
  return held.flatMap(({ value, placeholder }) => spellingsOf(value).map((spelling) => ({ spelling, placeholder })))
    .sort((a, b) => b.spelling.length - a.spelling.length);
}

/** Each held value as its placeholder in every string of [fixture], its body read as bytes; a JSON body's numbers too. */
function withSecretsReplaced(fixture, held) {
  if (held.length === 0) return fixture;
  const spellings = spelled(held);
  const text = (value) => spellings.reduce((out, { spelling, placeholder }) => out.replaceAll(spelling, placeholder), value);
  const { response } = fixture;
  const body = Buffer.from(response.bodyBase64 ?? '', 'base64').toString('latin1');
  return {
    request: { ...fixture.request, url: text(fixture.request.url), body: fixture.request.body === null ? null : text(fixture.request.body) },
    response: {
      ...response,
      headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, text(String(value))])),
      ...(response.setCookie === undefined ? {} : { setCookie: response.setCookie.map(text) }),
      bodyBase64: Buffer.from(jsonReplaced(body, held, text) ?? text(body), 'latin1').toString('base64'),
    },
  };
}

/** A JSON body with each held value replaced where it is a whole number or inside a string, or null for a body that is not JSON. */
function jsonReplaced(body, held, text) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number') return held.find(({ value: secret }) => secret === String(value))?.placeholder ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [walk(k), walk(v)]));
    return value;
  };
  const replaced = walk(parsed);
  return JSON.stringify(replaced) === JSON.stringify(parsed) ? body : JSON.stringify(replaced);
}

function survives({ request, response }, value) {
  return [
    request.url, request.body ?? '', ...Object.values(response.headers).map(String), ...(response.setCookie ?? []),
    Buffer.from(response.bodyBase64 ?? '', 'base64').toString('latin1'),
  ].some((text) => text.includes(value));
}
