import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blankStrings, contractVersionOf, OLDEST, RECORD } from '../src/contract-version.js';
import { HOST_FUNCTIONS } from '../src/host/surface.js';
import { MANIFEST_FACTS, METHODS, RESULT_FIELDS } from '../src/contract.js';

const pluginsDir = fileURLToPath(new URL('../../../plugins/', import.meta.url));
// A plugin is a directory holding its source, not any directory: a removed plugin's
// git-ignored dist/ stays behind on disk.
const shipped = readdirSync(pluginsDir).filter((id) => existsSync(`${pluginsDir}${id}/${id}-plugin.js`));

const sourceOf = (id) => ({ [`${id}-plugin.js`]: readFileSync(`${pluginsDir}${id}/${id}-plugin.js`, 'utf8') });
const only = (surface) => [...new Set(surface.reasons.map((r) => r.name))];

// Written against what each plugin *does* rather than against a number it happens to need
// today: the day ddys reaches for yonto.now, a test about the detector should not be the
// thing that fails.
test('a host function that arrived later raises what any plugin needs', async () => {
  for (const id of shipped) {
    const asShipped = await contractVersionOf(sourceOf(id));
    const withClock = await contractVersionOf({
      'probe-plugin.js': `${sourceOf(id)[`${id}-plugin.js`]}\nconst t = yonto.now();\n`,
    });

    assert.ok(withClock.required >= 2, `${id} did not notice yonto.now`);
    assert.ok(withClock.reasons.some((r) => r.name === 'yonto.now'), id);
    assert.ok(withClock.required >= asShipped.required, id);
  }
});

test('what each shipped plugin needs is what its own surface says, not what it declares', async () => {
  // Jellyfin reaches version 3 twice over: it can be told its artwork signature was refused
  // (#133), and it asks the host what to call itself to a server, because a plugin has
  // nowhere of its own to keep that (#134). The scrapers' half is `private/scrapers.test.js`.
  assert.deepEqual(
    only(await contractVersionOf(sourceOf('jellyfin'))).sort(),
    ['getImageHeaders', 'onImageHeadersRefused', 'yonto.error.misconfigured', 'yonto.installId'],
  );
});

// The XPTV loader's shims are named calls, so the scan reads the whole host surface it has
// rather than a floor (see cli.test.js's XPTV lint test for why that is worth holding).
test('the XPTV loader\'s host surface is read by name, nothing left unclassified', async () => {
  const surface = await contractVersionOf(sourceOf('xptv-js'));

  for (const name of ['yonto.html.load', 'yonto.cryptoJs', 'yonto.jsEncrypt']) assert.ok(surface.calls.includes(name), name);
  assert.deepEqual(surface.unclassified, []);
  assert.deepEqual(surface.oldName, []);
});

test('the old host name is found where it reaches the host, and not in a plugin\'s own value', async () => {
  const named = async (code) => (await contractVersionOf({ 'probe-plugin.js': code })).oldName.length > 0;

  assert.equal(await named('export default { async getCategories() { return lantern.fetch("https://h.tv"); } };'), true);
  assert.equal(await named('export default { async getCategories() { return globalThis.lantern ? [] : []; } };'), true);
  assert.equal(await named('const lantern = "light";\nexport default { async getCategories() { return [{ id: lantern, name: lantern }]; } };'), false);
  assert.equal(await named('export default { async getCategories() { return [{ id: "a", name: "a" }].map(({ lantern }) => lantern); } };'), false);
});

test('a call through yonto is dated by its own leaf', async () => {
  const fetching = await contractVersionOf({ 'probe-plugin.js': 'export default { async getMediaList() { return yonto.fetch("https://h.tv"); } };' });

  assert.equal(fetching.required, 1);
  assert.deepEqual(fetching.calls, ['yonto.fetch']);

  const clock = await contractVersionOf({ 'probe-plugin.js': 'export default { async getMediaList() { return yonto.now(); } };' });
  assert.ok(clock.reasons.some((r) => r.name === 'yonto.now' && r.version === 2));
});

test('a yonto that is taken apart is unplaceable', async () => {
  const surface = await contractVersionOf({ 'probe-plugin.js': 'const { now } = yonto;\nexport default {};' });

  assert.equal(surface.unclassified.length, 1);
});

// `calls` exists so `lint` can ask whether a plugin reads a host function without knowing
// which version that function arrived in — the same reason `exports` exists beside it. The
// pairing rule that reads it (a picker whose answer nothing reads) is in `cli.js`.
test('the host functions a plugin calls are reported beside the methods it exports', async () => {
  const surface = await contractVersionOf({
    'probe-plugin.js': `
      export default {
        async getSubSources() { return { items: [], activeId: yonto.subSource() }; },
        async getCategories() { return []; },
      };
    `,
  });

  assert.deepEqual(surface.calls, ['yonto.subSource']);
  assert.ok(surface.exports.includes('getSubSources'));
  assert.equal(surface.required, 4);
});

test('a name in a comment is prose, not a call or an export', async () => {
  const needed = await contractVersionOf({
    'probe-plugin.js': `
      // getImageHeaders() is what a source with protected artwork exports.
      /* and yonto.now() is the clock it would read */
      export default { async getCategories() { return []; } };
    `,
  });

  assert.equal(needed.required, 1);
});

test('a name inside a string is prose too, however it was quoted', async () => {
  for (const source of [
    `export default { async getCategories() { yonto.log('info', "falling back from yonto.now"); return []; } };`,
    'export default { async getCategories() { await yonto.fetch(`https://yonto.now.example/x`); return []; } };',
    `export default { async getCategories() { return ['it\\'s not yonto.now']; } };`,
  ]) {
    const needed = await contractVersionOf({ 'probe-plugin.js': source });
    assert.equal(needed.required, 1, source);
  }
});

test('a quote inside a regex is skipped, so the rest of the file is still read', async () => {
  // The silent direction, and the one that bit: a lone quote in `replace(/'/g, '')` opened
  // a string that ran to the end of the source, so everything after it went unread —
  // including, in plugins/ddys, the whole second half of the file.
  const needed = await contractVersionOf({
    'probe-plugin.js': String.raw`export default { async getCategories() { const s = 'x'.replace(/'/g, ''); return [s, yonto.now()]; } };`,
  });
  const afterClass = await contractVersionOf({
    'probe-plugin.js': String.raw`export default { async getCategories() { const s = 'a'.split(/[/']/); return [s, yonto.now()]; } };`,
  });
  const afterReturn = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { return /\\{/.test("a") ? [yonto.now()] : []; } };',
  });
  const divided = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { const n = 6 / 2 / 1; return [n, yonto.now()]; } };',
  });

  assert.equal(needed.required, 2);
  assert.equal(afterClass.required, 2, 'a slash inside a character class is not the end of the regex');
  assert.equal(afterReturn.required, 2, 'a regex can follow a keyword, not only punctuation');
  assert.equal(divided.required, 2, 'division is not a regex');
  for (const surface of [needed, afterClass, afterReturn, divided]) assert.deepEqual(surface.unscannable, []);

  // A keyword after a dot is a property name, so this is division — reading it as a regex
  // swallowed the call between the slashes and reported version 1 for a plugin that needs 2.
  const divided_property = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { const o = { in: 6 }; return [o.in/ (yonto.now()) /3]; } };',
  });
  assert.equal(divided_property.required, 2);
  assert.deepEqual(divided_property.unscannable, []);
});

// The two halves are separate mechanisms and a regex with a lone quote is rescued by either,
// so each is held on its own: otherwise one can be deleted with every test still green.
test('blanking gives up on a quote it cannot close, rather than blanking the rest', () => {
  assert.equal(blankStrings('const s = "never closed;'), null);
  assert.equal(blankStrings('const s = `${ unbalanced'), null);
  assert.notEqual(blankStrings(String.raw`const s='x'.replace(/'/g,'');`), null, 'a regex is not an open quote');
});

test('a call inside a template substitution is code, not a string body', async () => {
  // `?_=${yonto.now()}` is an ordinary cache-buster, and blanking the whole backtick hid
  // the call completely — a plugin needing the newer contract reading as needing the older.
  const needed = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { return [await yonto.fetch(`https://h.tv/x?_=${yonto.now()}`)]; } };',
  });
  const nested = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { return [`a${`b${yonto.now()}`}c`]; } };',
  });
  const text = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { return [`nothing about yonto.now here`]; } };',
  });

  assert.equal(needed.required, 2);
  assert.equal(nested.required, 2, 'a template inside a substitution is still code');
  assert.equal(text.required, 1, 'and its text is still text');
});

test('an export written as a name is followed, and one that cannot be is read noisily', async () => {
  const named = await contractVersionOf({
    'probe-plugin.js': 'const api = { getImageHeaders() { return {}; }, async getCategories() { return []; } }; export default api;',
  });
  const unfollowable = await contractVersionOf({
    'probe-plugin.js': 'const base = { getImageHeaders() { return {}; } }; export default { ...base, async getCategories() { return []; } };',
  });

  assert.equal(named.required, 2, 'a named default export is the plugin’s export too');
  // The whole-file fallback would also find it, so what following the name actually buys is
  // the quiet: no warning, and no keys counted that the app never calls.
  assert.deepEqual(named.unscannable, []);
  assert.equal(unfollowable.required, 2, 'what cannot be followed is read whole rather than missed');
  assert.deepEqual(unfollowable.unscannable.map((u) => u.path), ['probe-plugin.js']);
  assert.match(unfollowable.unscannable[0].why, /export/);
});

test('only the entry file exports: a helper with its own default export is not the plugin', async () => {
  const needed = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { return []; } };',
    'src/lib/helper.js': 'export default { getImageHeaders() { return {}; } };',
  });

  assert.equal(needed.required, 1);
});

test('a key named like a method counts only on the object the app actually calls', async () => {
  const internal = await contractVersionOf({
    'probe-plugin.js': 'const builders = { getImageHeaders: (x) => x }; export default { async getCategories() { return [builders]; } };',
    'src/lib/unused.js': 'export function getImageHeaders() { return {}; }',
  });
  const nested = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { const o = { getImageHeaders: 1 }; return [o]; } };',
  });

  assert.equal(internal.required, 1, 'an internal table, and a file nothing imports, are not exports');
  assert.equal(nested.required, 1, 'a key inside a method is that method’s business');
});

// Minifying is what folds these two into the shapes the scan looks for. Pinned because the
// dependency is invisible: swap minify for a comment stripper and both stop being seen.
test('a computed call and a shorthand export are still found', async () => {
  const computed = await contractVersionOf({
    'probe-plugin.js': "export default { async getCategories() { return yonto['now'](); } };",
  });
  const shorthand = await contractVersionOf({
    'probe-plugin.js': 'function getImageHeaders() { return {}; } export default { getImageHeaders, async getCategories() { return []; } };',
  });

  assert.equal(computed.required, 2);
  assert.equal(shorthand.required, 2);
});

test('a host function nobody added is reported once, by the name that was called', async () => {
  const needed = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { yonto.teleport(); yonto.teleport(); return yonto.store.getAll(); } };',
  });

  assert.equal(needed.required, 1);
  assert.deepEqual(needed.unknown.map((u) => u.name).sort(), ['yonto.store.getAll', 'yonto.teleport']);
});

// A false positive on correct code, which is the worse half of #86: `yonto.store` has no
// leaf to place and is not a call nobody added either — it is the namespace, held as a
// value, on its way to a leaf this cannot see.
test('a namespace held as a value is a host reference, not a call nobody added', async () => {
  const aliased = await contractVersionOf({
    'probe-plugin.js':
      'const store = yonto.store;\n' +
      'export default { async getCategories() { return [await store.get("c")]; } };',
  });

  assert.deepEqual(aliased.unknown, []);
  assert.deepEqual(aliased.unclassified.map((u) => u.path), ['probe-plugin.js']);
});

test('yonto.config is a value, so reading it says nothing about which contract is needed', async () => {
  const needed = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() { return [yonto.config.siteUrl]; } };',
  });

  assert.equal(needed.required, 1);
  assert.deepEqual(needed.unknown, []);
});

// The hole this closes: `HOST_CALL` matches a literal `yonto.<name>`, and a plugin that
// takes the function out of the namespace first was read as needing version 1 — silently,
// which is the one direction this file is not allowed to be wrong in. It declares 1, passes
// lint on the author's machine, installs on an older app and dies at the first call.
test('a yonto taken apart rather than read through is reported, not counted as version 1', async () => {
  for (const source of [
    'export default { async getCategories() { const { now } = yonto; return [now()]; } };',
    'export default { async getCategories() { const { ...rest } = yonto; return [rest.now()]; } };',
    'export default { async getCategories() { const k = Math.random() > 1 ? "now" : "log"; return [yonto[k]()]; } };',
  ]) {
    const needed = await contractVersionOf({ 'probe-plugin.js': source });

    assert.deepEqual(needed.unclassified.map((u) => u.path), ['probe-plugin.js'], source);
  }
});

// Over-reporting is the safe direction and under-reporting is not, but a warning on every
// ordinary plugin is a warning nobody reads — so the shapes that *can* be placed must not
// draw one. Every plugin in the tree is in here for that reason.
test('a plugin that reads the host the ordinary way is told nothing it cannot act on', async () => {
  for (const id of shipped) {
    const needed = await contractVersionOf(sourceOf(id));

    assert.deepEqual(needed.unclassified, [], id);
  }

  const direct = await contractVersionOf({
    'probe-plugin.js':
      'export default { async getCategories() { const now = yonto.now; return [now(), await yonto.store.get("c")]; } };',
  });

  assert.deepEqual(direct.unclassified, [], 'an alias keeps the dotted text, so it places');
  assert.deepEqual(direct.reasons.map((r) => r.name), ['yonto.now']);
});

// Minifying mangles local names, which is the only thing standing between a local helper
// and the export table. Invisible dependency, pinned here: swap minify for a comment
// stripper and this plugin starts claiming a version it does not need.
test('a local named like an export is not one', async () => {
  const needed = await contractVersionOf({
    'probe-plugin.js':
      'function getImageHeaders() { return {}; }\n' +
      'export default { async getCategories() { return [getImageHeaders()]; } };',
  });

  assert.equal(needed.required, 1);
});

// The surface that was there from the beginning. Written out rather than derived, because
// deriving it from the record is the circularity this exists to break: `since()` resolves
// an unrecorded name to 1, so "nobody recorded this" and "this has been here since the
// start" are the same answer, and the wrong one is silent.
//
// The list is the ledger that makes the difference visible. A new leaf now fails until
// somebody decides which it is — recorded with a version, or added here as pre-existing —
// which is the decision that was skipped when `yonto.html.load` shipped unrecorded and
// `lint` certified a plugin calling it as contract 1 (found in review, twice: the first
// fix recorded the one leaf, this one closes the class).
const ARRIVED_AT_VERSION_1 = [
  'config',
  'crypto.aesCbcDecrypt', 'crypto.hmacSha256', 'crypto.md5', 'crypto.sha1', 'crypto.sha256',
  'encoding.base64Decode', 'encoding.base64Encode', 'encoding.base64ToHex', 'encoding.hexToBase64',
  'error.notFound', 'error.unauthenticated', 'error.unavailable',
  'fetch', 'log', 'sleep',
  'store.clear', 'store.get', 'store.remove', 'store.set',
  'text.decode',
];

test('every host function the record does not date is one known to predate it', () => {
  const dated = new Set(
    Object.keys(RECORD.since)
      .filter((name) => name.startsWith('yonto.'))
      .map((name) => name.slice('yonto.'.length)),
  );
  const undated = HOST_FUNCTIONS.filter((name) => !dated.has(name));

  assert.deepEqual(
    undated.filter((name) => !ARRIVED_AT_VERSION_1.includes(name)),
    [],
    'this leaf is on the surface, is not in contract-versions.json, and is not on the ' +
      'version-1 ledger — so `since()` is calling it version 1 by default rather than by ' +
      'anybody deciding, and `lint` will tell a plugin author it may declare 1',
  );
  assert.deepEqual(
    ARRIVED_AT_VERSION_1.filter((name) => !HOST_FUNCTIONS.includes(name) && name !== 'config'),
    [],
    'a name on the version-1 ledger that is no longer on the surface: a dead entry rather ' +
      'than a silent one',
  );
});

// The manifest-fact half of the detector: nothing in the source says a plugin declared it,
// so the declaration is the only evidence there is — the same shape as a host-held
// cookieLogin, one field along (kangzj/lantern-tv#377).
test('a declared remote library list raises what a plugin needs, though its source says nothing', async () => {
  const source = {
    'demo-plugin.js':
      'export default { async getCategories() { return []; }, async getSubSources() { return { items: [] }; } };',
  };

  const undeclared = await contractVersionOf(source, { catalogsAreRemote: false });
  const declared = await contractVersionOf(source, { catalogsAreRemote: true });

  assert.equal(declared.required, RECORD.since[MANIFEST_FACTS.CATALOGS_ARE_REMOTE]);
  assert.ok(declared.reasons.some((r) => r.name === MANIFEST_FACTS.CATALOGS_ARE_REMOTE));
  assert.ok(declared.required > undeclared.required, 'the declaration is what moved it');
});

// The third, and the one where "the source says nothing" is not a limitation of the scan
// but the permanent condition: the code this declares is downloaded while the plugin runs,
// so it is never in anything this could read (kangzj/lantern-tv#375).
test('a plugin that declares it runs fetched code raises what it needs, and nothing scans for it', async () => {
  // A source that gives the scan every reason to think otherwise: it compiles a string the
  // way the XPTV loader does, and the scan still has nothing to place — that call is a
  // language builtin, not a name the contract records.
  const source = {
    'demo-plugin.js':
      'export default { async getCategories() { const f = new Function("return []"); return f(); } };',
  };

  const undeclared = await contractVersionOf(source, { runsFetchedCode: false });
  const declared = await contractVersionOf(source, { runsFetchedCode: true });

  assert.equal(declared.required, RECORD.since[MANIFEST_FACTS.RUNS_FETCHED_CODE]);
  assert.ok(declared.reasons.some((r) => r.name === MANIFEST_FACTS.RUNS_FETCHED_CODE));
  assert.ok(declared.required > undeclared.required, 'the declaration is what moved it');
  assert.ok(
    !undeclared.reasons.some((r) => r.name === MANIFEST_FACTS.RUNS_FETCHED_CODE),
    'the undeclared plugin compiles a string too: silence here is silence, not a finding',
  );
});

// The same shape a fourth time, and the one whose absence costs a title rather than a line:
// an app too old to know what a `pan` is decodes the option with `stream` required and fails
// the whole detail, taking the thirty-nine ordinary episodes beside the one share with it.
test('a plugin that declares it may answer a token raises what it needs, and nothing scans for it', async () => {
  // A source that returns an option with a `pan` in it, so the scan has every chance to
  // notice — and cannot, because a returned shape is not a call and not an export.
  const source = {
    'demo-plugin.js':
      'export default { async getMediaDetail() { return { id: "m", title: "M", ' +
      'playbackOptions: [{ label: "合集", pan: { share: "https://pan.quark.cn/s/1" } }] }; } };',
  };

  const undeclared = await contractVersionOf(source, { playbackTokens: false });
  const declared = await contractVersionOf(source, { playbackTokens: true });

  assert.equal(declared.required, RECORD.since[MANIFEST_FACTS.PLAYBACK_TOKENS]);
  assert.ok(declared.reasons.some((r) => r.name === MANIFEST_FACTS.PLAYBACK_TOKENS));
  assert.ok(declared.required > undeclared.required, 'the declaration is what moved it');
  assert.ok(
    !undeclared.reasons.some((r) => r.name === MANIFEST_FACTS.PLAYBACK_TOKENS),
    'the undeclared plugin returns a pan option too: silence here is silence, not a finding',
  );
});

// An export places its own floor, unlike the fact above — and it has to, or a plugin whose
// getStream a host cannot call declares the version before it and dies at the redemption.
test('exporting getStream places the plugin at the version that added it', async () => {
  const source = {
    'demo-plugin.js':
      'export default { async getStream(token) { return { url: "https://v/" + token }; } };',
  };

  const scanned = await contractVersionOf(source, {});

  assert.equal(scanned.required, RECORD.since.getStream);
  assert.ok(scanned.exports.includes('getStream'));
});

// An older app delivers UNREACHABLE as METHOD_THREW, an ordinary outage, so a plugin raising
// it has to declare the version an older app refuses to install (kangzj/lantern-tv#615).
test('raising unreachable places the plugin at the version that added it', async () => {
  const scanned = await contractVersionOf({
    'demo-plugin.js':
      'export default { async getCategories() { throw yonto.error.unreachable("一号站没有应答。"); } };',
  });

  assert.equal(scanned.required, RECORD.since['yonto.error.unreachable']);
  assert.deepEqual(scanned.calls, ['yonto.error.unreachable']);
});

// A hand-built `{ code: 'UNREACHABLE' }` is honoured like the constructor's, so it needs what
// the constructor needs, though the source calls nothing (#650's review). A code reaches a
// thrown value through many shapes, and each one missed lets the plugin declare too low.
test('a code written out places the plugin where its constructor arrived, however it is raised', async () => {
  const placed = (body) => contractVersionOf({ 'demo-plugin.js': body }).then((surface) => surface.required);
  const unreachable = RECORD.since['yonto.error.unreachable'];
  const shapes = {
    literal: "export default { async getCategories() { throw { code: 'UNREACHABLE', message: 'x' }; } };",
    assigned: "export default { async getCategories() { const e = new Error('x'); e.code = 'UNREACHABLE'; throw e; } };",
    helper: `function fail(code) { const e = new Error('x'); e.code = code; throw e; }
      export default { async getCategories() { fail('UNREACHABLE'); } };`,
    classField: `class Down extends Error { constructor(c) { super('x'); this.code = c; } }
      export default { async getCategories() { throw new Down('UNREACHABLE'); } };`,
    ternary: "export default { async getCategories(q) { throw { code: q ? 'UNREACHABLE' : 'UNAVAILABLE' }; } };",
    constant: `const DOWN = 'UNREACHABLE';
      export default { async getCategories() { throw { code: DOWN, message: 'x' }; } };`,
  };
  for (const [shape, body] of Object.entries(shapes)) assert.equal(await placed(body), unreachable, shape);

  assert.equal(
    await placed('export default { async getCategories() { throw { code: "MISCONFIGURED" }; } };'),
    RECORD.since['yonto.error.misconfigured'],
  );
  assert.equal(await placed("export default { async getCategories() { throw { code: 'NOT_FOUND' }; } };"), 1,
    'a code from version 1 places nothing');
  assert.equal(await placed("export default { async getCategories() { throw new Error('SITE UNREACHABLE'); } };"), 1,
    'the word inside a sentence is prose');
});

// This check refuses, so a code the plugin only reads must not raise the version it demands.
test('a code compared, matched in a case or written in a comment places nothing', async () => {
  const placed = (body) => contractVersionOf({ 'demo-plugin.js': body }).then((surface) => surface.required);
  const shapes = {
    strictEqual: "export default { async getCategories() { try { return []; } catch (e) { if (e.code === 'UNREACHABLE') return []; throw e; } } };",
    notEqual: "export default { async getCategories() { try { return []; } catch (e) { if ('UNREACHABLE' !== e.code) throw e; return []; } } };",
    looseEqual: "export default { async getCategories() { try { return []; } catch (e) { return e.code == 'UNREACHABLE' ? [] : [1]; } } };",
    // Three cases, because minifying turns a switch of one into an `if`.
    caseLabel: `export default { async getCategories() {
      try { return []; } catch (e) {
        switch (e.code) { case 'UNREACHABLE': return []; case 'UNAVAILABLE': return [2]; case 'NOT_FOUND': return [3]; default: throw e; }
      }
    } };`,
    legalComment: "/*! throw { code: 'UNREACHABLE' } */\nexport default { async getCategories() { return []; } };",
  };
  for (const [shape, body] of Object.entries(shapes)) assert.equal(await placed(body), 1, shape);
});

// The rule reads every shipped plugin's own source, so it must not move what any of them needs.
test('every shipped plugin still declares a version lint accepts', async () => {
  for (const id of shipped) {
    const manifest = JSON.parse(sourceOf(id)[`${id}-plugin.js`].match(/\/\* yonto-plugin\s*([\s\S]*?)\*\//)[1]);
    const surface = await contractVersionOf(sourceOf(id), manifest);
    // What `lint` holds a declaration to: what it needs, or the version of a result field it
    // may answer with, never less than what it needs.
    const required = Math.max(OLDEST, surface.required);
    const justified = [required, ...surface.mayAnswerWith.map((field) => field.version)]
      .filter((version) => version >= required);
    assert.ok(justified.includes(manifest.contractVersion), `${id} declares ${manifest.contractVersion}, needs ${required}`);
  }
});

test('the record names only what changed, by the name the lookup uses', () => {
  // A host function keyed without its `yonto.` prefix would be a dead entry: `since()`
  // never finds it, and the plugin it was meant to catch passes. The names themselves are
  // held to both hosts elsewhere — this file says when, not what.
  for (const [name, version] of Object.entries(RECORD.since)) {
    const isHostFunction = name.startsWith('yonto.') && HOST_FUNCTIONS.includes(name.slice('yonto.'.length));
    const isMethod = METHODS.includes(name);
    // The third kind: something a manifest declares and a host answers, which appears in
    // neither list because a plugin neither calls nor exports it — see `MANIFEST_FACTS`.
    const isManifestFact = Object.values(MANIFEST_FACTS).includes(name);
    // The fourth: a field inside a method's answer, which only a host seeing it can place.
    const isResultField = Object.values(RESULT_FIELDS).includes(name);
    assert.ok(isHostFunction || isMethod || isManifestFact || isResultField,
      `${name} is neither a host function, a contract method, a manifest fact nor a result field`);
    assert.ok(version >= 2, `${name} is recorded as version ${version}; version 1 is what absence means`);
  }
});

test('the exports a plugin declares are reported as themselves', async () => {
  // `reasons` names getImageHeaders today only because its version is 2, which is an
  // accident of the record. A caller asking what a plugin exports must not have to know
  // which version each method arrived in.
  const surface = await contractVersionOf({
    'probe-plugin.js': 'export default { async getCategories() {}, async getImageHeaders() { return {}; } };',
  });

  assert.deepEqual(surface.exports.sort(), ['getCategories', 'getImageHeaders']);
});

test('a method a plugin does not export is not reported as one', async () => {
  const surface = await contractVersionOf({ 'probe-plugin.js': 'export default { async getCategories() {} };' });

  assert.equal(surface.exports.includes('getImageHeaders'), false);
});

// A result field nothing in the source can show: a plugin exporting getFilters may answer
// with `init` (kangzj/lantern-tv#358), so declaring exactly its version is justified, and
// nothing is required of one that exports no getFilters.
test('a plugin that may answer with a result field is justified in declaring its version', async () => {
  const withFilters = await contractVersionOf({
    'demo-plugin.js': 'export default { async getCategories() { return []; }, async getFilters() { return []; } };',
  });
  const without = await contractVersionOf({
    'demo-plugin.js': 'export default { async getCategories() { return []; } };',
  });

  assert.deepEqual(withFilters.mayAnswerWith, [{ name: RESULT_FIELDS.FILTER_INIT, version: RECORD.since[RESULT_FIELDS.FILTER_INIT] }]);
  assert.equal(withFilters.required, 1, 'may is not must: an older app still runs it');
  assert.deepEqual(without.mayAnswerWith, []);
});
