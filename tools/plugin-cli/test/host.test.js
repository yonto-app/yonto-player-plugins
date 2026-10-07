import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHost } from '../src/host/index.js';
import { HOST_FUNCTIONS, REALM_FUNCTIONS } from '../src/host/surface.js';
import { MAX_KEY_CHARS, MAX_KEYS, MAX_VALUE_CHARS } from '../src/host/store.js';
import { scratchDir } from '../src/scratch-dir.js';

const manifest = { id: 'demo', allowedHosts: ['h.tv'] };
const LINK_LOGIN = { type: 'linkLogin', service: 'plex.tv' };
const transport = { async request() { return { status: 200, headers: {}, bodyBase64: '' }; } };

/**
 * A host with a call already announced, which is the only state an engine ever puts one
 * in — `startCall` is what gives a call its sleep budget and its deadline, and a host
 * outside a call starts nothing at all (kangzj/lantern-tv#178). A generous budget, because
 * what these tests are about is what the functions do rather than when they are refused;
 * `deadline.test.js` is where the refusing is asserted.
 */
function host(extra = {}) {
  const built = createHost({ manifest, config: { token: 'abc' }, transport, storeDir: scratchDir('lp-'), pluginDir: '/probe/plugin', ...extra });
  built.startCall(60_000);
  return built;
}

test('exposes the profile config the app would have collected', () => {
  assert.equal(host().yonto.config.token, 'abc');
});

test('store round-trips a value', async () => {
  const { yonto } = host();
  await yonto.store.set('sites', { a: 1 });
  assert.deepEqual(await yonto.store.get('sites'), { a: 1 });
  await yonto.store.remove('sites');
  assert.equal(await yonto.store.get('sites'), null);
});

// kangzj/lantern-tv#341: every read loads the whole store, so it has a size. `PluginStoreLimitsTest`
// holds the device to the same numbers and words.
test('store keeps a value exactly at the cap and refuses one character more, naming the limit', async () => {
  const { yonto } = host();
  // JSON text of a string is the string plus its two quotes.
  await yonto.store.set('at', 'x'.repeat(MAX_VALUE_CHARS - 2));
  await assert.rejects(yonto.store.set('over', 'x'.repeat(MAX_VALUE_CHARS - 1)), (error) => {
    assert.equal(error.code, 'STORE_REFUSED');
    assert.equal(error.message,
      `yonto.store.set refused: the value is ${MAX_VALUE_CHARS + 1} characters of JSON, over the ${MAX_VALUE_CHARS} a store keeps`);
    return true;
  });
  assert.equal(await yonto.store.get('over'), null);
});

test('store refuses a key longer than the cap', async () => {
  const { yonto } = host();
  await yonto.store.set('k'.repeat(MAX_KEY_CHARS), 1);
  await assert.rejects(yonto.store.set('k'.repeat(MAX_KEY_CHARS + 1), 1),
    { code: 'STORE_REFUSED', message: `yonto.store.set refused: the key is ${MAX_KEY_CHARS + 1} characters, over the ${MAX_KEY_CHARS} a store keeps` });
});

test('store refuses a key past the count, and still overwrites one it holds', async () => {
  const { yonto } = host();
  for (let i = 0; i < MAX_KEYS; i += 1) await yonto.store.set(`k${i}`, i);

  await assert.rejects(yonto.store.set('one-more', 1),
    { code: 'STORE_REFUSED', message: `yonto.store.set refused: this source's store already holds the ${MAX_KEYS} keys it keeps` });
  await yonto.store.set(`k${MAX_KEYS - 1}`, 'again');
  assert.equal(await yonto.store.get(`k${MAX_KEYS - 1}`), 'again');
});

test('a key whose ttl has passed does not count against the store', async () => {
  let clock = 1000;
  const { yonto, startCall } = host({ now: () => clock });
  for (let i = 0; i < MAX_KEYS; i += 1) await yonto.store.set(`k${i}`, i, { ttlSeconds: i === 0 ? 1 : 3600 });
  clock += 2000;
  startCall(60_000);

  await yonto.store.set('one-more', 1);
  assert.equal(await yonto.store.get('one-more'), 1);
});

test('store forgets a value once its ttl has passed', async () => {
  let clock = 1000;
  // A ttl outliving a call is the whole point of one, so the reads are announced as later
  // calls rather than made from a call that has been running for a minute — which is a
  // call a deadline refuses, and rightly (kangzj/lantern-tv#178).
  const { yonto, startCall } = host({ now: () => clock });
  await yonto.store.set('config', 'body', { ttlSeconds: 60 });
  clock = 1000 + 59_000;
  startCall(60_000);
  assert.equal(await yonto.store.get('config'), 'body');
  clock = 1000 + 61_000;
  startCall(60_000);
  assert.equal(await yonto.store.get('config'), null);
});

test('now is the clock the host was given, so a caller can wind it', () => {
  let clock = 1_700_000_000_000;
  const { yonto } = host({ now: () => clock });

  assert.equal(yonto.now(), 1_700_000_000_000);
  clock += 30 * 60 * 1000;
  assert.equal(yonto.now(), 1_700_000_000_000 + 30 * 60 * 1000);
});

// The same clock drives both, which is what lets one wound clock move a plugin's own
// timing and the store's ttl together — a 仓's config ttl and its site cooldowns are
// measured against the two halves and have to agree.
test('now and the store read the same clock', async () => {
  let clock = 1000;
  const { yonto, startCall } = host({ now: () => clock });
  await yonto.store.set('config', 'body', { ttlSeconds: 60 });

  clock = yonto.now() + 61_000;
  // The read is a later call, because a minute has passed — see the ttl test above.
  startCall(60_000);

  assert.equal(await yonto.store.get('config'), null);
});

test('base64 and hex round-trip', () => {
  const { yonto } = host();
  assert.equal(yonto.encoding.base64Decode(yonto.encoding.base64Encode('庆余年')), '庆余年');
  assert.equal(yonto.encoding.hexToBase64('4f4b'), 'T0s=');
});

test('sha256 and md5 match known digests', () => {
  const { yonto } = host();
  assert.equal(yonto.crypto.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(yonto.crypto.sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('aesCbcDecrypt unwraps what aes-128-cbc encrypted, which is what a 仓 config needs', async () => {
  const { createCipheriv } = await import('node:crypto');
  const key = Buffer.from('0123456789abcdef');
  const iv = Buffer.from('fedcba9876543210');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update('{"sites":[]}', 'utf8'), cipher.final()]);

  const { yonto } = host();
  const plain = yonto.crypto.aesCbcDecrypt(
    key.toString('base64'), iv.toString('base64'), encrypted.toString('base64'));

  assert.equal(plain, '{"sites":[]}');
});

test('text.decode turns GBK bytes into a string', () => {
  const { yonto } = host();
  const gbk = Buffer.from([0xc7, 0xec, 0xd3, 0xe0, 0xc4, 0xea]).toString('base64');
  assert.equal(yonto.text.decode(gbk, 'gbk'), '庆余年');
});

test('log collects what the plugin said, tagged with its id', () => {
  const h = host();
  h.yonto.log('warn', 'markup looks off');
  assert.deepEqual(h.logs[0], { level: 'warn', pluginId: 'demo', message: 'markup looks off' });
});

// Whether this build can run a given plugin is answered before a host exists, so the
// surface is recorded rather than enumerated. conformance/ is where the two hosts are held
// to one answer — this is the same idea as globals.json, one level up from the language.
// A REALM_FUNCTIONS name that fell out of host-functions.json would go on excusing a
// member nothing has, silently. `contract-version.test.js` holds RECORD.since to the same
// rule — a dead entry rather than a silent one.
test('every realm function is a name the record still knows', () => {
  assert.deepEqual(REALM_FUNCTIONS.filter((name) => !HOST_FUNCTIONS.includes(name)), []);
});

test('the recorded surface is the one a host actually has', () => {
  // Leaves only — a namespace is not something a plugin can call. Recursive rather than one
  // level deep: the surface is two deep today, and a `yonto.a.b.c` added later would
  // otherwise be invisible here, absent from the record, and green on every side.
  const walk = (value, prefix) => Object.entries(value).flatMap(([key, member]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof member === 'function') return [path];
    if (member && typeof member === 'object' && path !== 'config') return walk(member, path);
    return [];
  });

  // `yonto.session` is a linkLogin plugin's alone, so the surface is walked on one.
  const { yonto } = host({ manifest: { ...manifest, capabilities: [LINK_LOGIN] } });
  const found = walk(yonto, '');

  // Minus what the realm implements for itself: the parser is handed over as source and
  // compiled inside QuickJS, so `html.load` is on the surface a plugin sees and not on
  // this object. See REALM_FUNCTIONS.
  const implementedHere = HOST_FUNCTIONS.filter((name) => !REALM_FUNCTIONS.includes(name));

  assert.deepEqual(found.sort(), implementedHere.sort());
});

test('a plugin with no linkLogin has no yonto.session', () => {
  assert.equal(host().yonto.session, undefined);
});

// The gap that let an unstable id ship: `installIdShape()` in the conformance suite compares
// two calls inside one session, so it reads 'stable' whether or not the answer survives the
// run — and `cli.js` builds a fresh store on every invocation. Deriving from
// that store meant a new identity per run, which for the one plugin that spends this as a
// device id is kangzj/lantern-tv#134's own symptom reproduced in the tool meant to catch it.
//
// So this builds hosts the way `cli.js` does — new store each time — and asks across them.
test('installId survives the run, because cli.js makes a new store on every one', () => {
  const manifest = { id: 'probe', allowedHosts: [] };
  const asCliDoes = (pluginDir) => createHost({
    manifest,
    transport: null,
    storeDir: scratchDir('lp-run-'),
    pluginDir,
  }).yonto.installId();

  assert.equal(asCliDoes('/plugins/probe'), asCliDoes('/plugins/probe'));
  assert.notEqual(asCliDoes('/plugins/probe'), asCliDoes('/plugins/other'));
});

test('a host built without a plugin directory refuses rather than inventing an identity', () => {
  assert.throws(
    () => createHost({ manifest: { id: 'probe', allowedHosts: [] }, transport: null, storeDir: scratchDir('lp-run-') }),
    /pluginDir/,
  );
});

// What a host is configured with, repeated back. Unlike `installId` there is nothing to
// derive: a viewer picked a library on a television and `YONTO_PLUGIN_SUBSOURCE` is where
// that pick comes from here, so the only way to get this wrong is to lose it.
test('subSource is the library the host was configured with, and null when there is none', () => {
  assert.equal(host().yonto.subSource(), null);
  assert.equal(host({ subSource: 'suoni' }).yonto.subSource(), 'suoni');
});

// One plugin reached three ways is one plugin. `doctor plugins/jellyfin` from the root,
// `doctor .` from inside it and the absolute path are three different strings, and hashing
// them as typed gave three identities — so an author doing the same thing three ways left
// three rows in a real server's device list, which is kangzj/lantern-tv#134 landing on the
// author rather than the viewer.
test('how a plugin directory was spelled does not change what the plugin is called', () => {
  const manifest = { id: 'probe', allowedHosts: [] };
  const idFor = (pluginDir) => createHost({
    manifest,
    transport: null,
    storeDir: scratchDir('lp-spelling-'),
    pluginDir,
  }).yonto.installId();

  const here = process.cwd();
  assert.equal(idFor(here), idFor('.'));
  assert.equal(idFor(here), idFor(join(here, 'src', '..')));
});

// kangzj/lantern-tv#357. Per call, as `YontoHostApi` keeps it on the device.
// What a viewer sees of it is `partialShown`'s, walked with this host in test/partial.test.js.
test('yonto.partial keeps the last sentence of a call, handed out once', () => {
  const { yonto, takePartial } = host();

  yonto.partial('一号站没有回应。');
  yonto.partial('四个站点中有一个没有回应。');
  assert.equal(takePartial(), '四个站点中有一个没有回应。');
  // Handed out once: whatever reads it next gets nothing unless the plugin said it again.
  assert.equal(takePartial(), null);
});

test('a new call starts with no partial sentence, whatever the last one said', () => {
  const { yonto, startCall, takePartial } = host();

  yonto.partial('四个站点中有一个没有回应。');
  startCall(60_000);

  assert.equal(takePartial(), null);
});
