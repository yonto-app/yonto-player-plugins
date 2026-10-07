import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code, PluginError } from '../src/errors.js';
import { challengeAware } from '../src/browser-check.js';
import { scratchDir } from '../src/scratch-dir.js';

/**
 * `plugins/xptv-js` compiling a catalog and handing it the twelve names XPTV injects.
 *
 * The catalogs here are written for this suite rather than taken from their repos, because
 * `fangkuia/XPTV` carries no licence; the three pinned ones are in `xptv-js-real-catalogs.test.js`.
 * These exercise the shim surface, which a real plugin cannot pin: a forged host verdict is
 * not something any working plugin demonstrates.
 */
const dir = fileURLToPath(new URL('../../../plugins/xptv-js/', import.meta.url));

const EXT = 'https://catalogs.test/one.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * One catalog, whose JavaScript at [ext] is [source] and whose class name is [className].
 * [program], when given, answers the request for [ext] in its place, and may throw.
 */
function engineOver(source, {
  className = null, status = 200, storeDir = null, answer = null, ext = EXT, program = null,
} = {}) {
  const transport = {
    calls: [],
    // Whole requests, where `calls` is their URLs — a test about what a catalog *sent* needs
    // the headers, and every test written before this one reads `calls`.
    requests: [],
    async request(req) {
      this.calls.push(req.url);
      this.requests.push(req);
      if (req.url === ext) return program?.(req) ?? { status, headers: {}, bodyBase64: b64(source) };
      return answer?.(req) ?? { status: 200, headers: {}, bodyBase64: b64('{"ok":true}') };
    },
  };
  const store = storeDir ?? scratchDir('lp-xptv-cat-');
  const host = createHost({
    manifest: loadManifest(dir),
    config: className === null ? { ext } : { ext, className },
    transport,
    storeDir: store,
    pluginDir: dir,
  });
  return { host, transport, storeDir: store, engine: createEngine({ dir, host }) };
}

/** A catalog in their shape: top-level `async function`s, no `export` anywhere. */
const tabs = (body = '', inConfig = '') => `
${body}
async function getConfig() {
  ${inConfig}
  return jsonify({ ver: 1, title: 'T', site: 'https://s.test', tabs: [{ name: '电影', ext: { id: 1 } }] })
}
`;

test('a catalog compiles and its getConfig tabs become the categories', async () => {
  const { engine } = engineOver(tabs());

  const categories = await engine.call('getCategories', []);

  assert.equal(categories.length, 1);
  assert.equal(categories[0].name, '电影');
  // The tab's whole `ext` and nothing else, because that object is what its own `getCards` is
  // asked with, and a migrated source puts its old prefix in front (the design's *The ids, exactly*).
  assert.equal(categories[0].id, '{"id":1}');
});

test("a tab's ext survives the category id whatever shape it is", async () => {
  // `ddys.js`'s tabs carry `{ url }` and some carry `{ url, hasMore: false }`; nothing says
  // a tab's ext has an `id` at all, and most real ones do not.
  const { engine } = engineOver(`
    async function getConfig() {
      return jsonify({ tabs: [
        { name: '所有电影', ext: { url: '/category/movie/' } },
        { name: '连载剧集', ext: { url: '/category/airing/', hasMore: false } },
      ] })
    }
  `);

  const categories = await engine.call('getCategories', []);

  assert.deepEqual(
    categories.map((c) => JSON.parse(c.id)),
    [{ url: '/category/movie/' }, { url: '/category/airing/', hasMore: false }],
  );
});

test('createCheerio hands over the real parser, pseudos and all', async () => {
  // `:contains` is the pseudo one of their plugins uses on a script tag, and the reason the
  // parser had to be cheerio rather than a subset of it.
  const { engine } = engineOver(tabs(`
    const cheerio = createCheerio()
    const $ = cheerio.load('<div><p class="a">x</p><p>window.wp_nonce=1</p></div>')
    if ($('p:contains(wp_nonce)').length !== 1) throw new Error('no :contains')
    if ($('p.a').text() !== 'x') throw new Error('no class selector')
  `));

  assert.equal((await engine.call('getCategories', [])).length, 1);
});

test('createCryptoJS hands over the library, not the five primitives', async () => {
  // A facade over `yonto.crypto` answers a hex string where these want an object with
  // methods, so every one of these lines is one it would fail.
  const { engine } = engineOver(tabs(`
    const CryptoJS = createCryptoJS()
    const key = CryptoJS.enc.Utf8.parse('PBfAUnTdMjNDe6pL')
    const iv = CryptoJS.enc.Utf8.parse('sENS6bVbwSfvnXrj')
    const out = CryptoJS.AES.encrypt('hello', key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 })
    if (typeof out.toString() !== 'string') throw new Error('no ciphertext')
    if (CryptoJS.MD5('x').toString().length !== 32) throw new Error('no MD5')
  `));

  assert.equal((await engine.call('getCategories', [])).length, 1);
});

test('$fetch answers { data } and goes through the host', async () => {
  const { engine, transport } = engineOver(tabs('', `
    const { data } = await $fetch.get('https://api.test/x', { headers: { 'X-A': '1' } })
    if (argsify(data).ok !== true) throw new Error('no data')
  `));

  await engine.call('getCategories', []);

  assert.ok(transport.calls.includes('https://api.test/x'), transport.calls.join(' '));
});

/**
 * `bdys.js`'s own shape, and the reason kangzj/lantern-tv#426 is not a rename.
 *
 * It reads `Set-Cookie` off one response and puts it on its own next request. That is a jar in
 * their closure and none in this loader, which is two claims and needs both requests below:
 * the one the catalog set a `Cookie` on carries it, and the one it did not carries nothing.
 * An assertion on the first alone passes whether or not this loader holds a jar of its own.
 */
test('a catalog reads a cookie off respHeaders and carries it to its own next request', async () => {
  const { engine, transport } = engineOver(tabs('', `
    const first = await $fetch.get('https://s.test/gate')
    const jar = first.respHeaders['set-cookie'][0].split(';')[0]
    await $fetch.get('https://s.test/listing', { headers: { Cookie: jar } })
    await $fetch.get('https://s.test/elsewhere')
  `), {
    answer: (req) => (req.url === 'https://s.test/gate'
      ? { status: 200, headers: {}, setCookie: ['SESSION=abc; Path=/; HttpOnly'], bodyBase64: b64('') }
      : null),
  });

  await engine.call('getCategories', []);

  const sentTo = (url) => transport.requests.find((req) => req.url === url)?.headers ?? null;
  assert.equal(sentTo('https://s.test/listing')?.Cookie, 'SESSION=abc', JSON.stringify(sentTo('https://s.test/listing')));
  // And nothing put it on the request the catalog did not write it onto.
  assert.deepEqual(sentTo('https://s.test/elsewhere'), {});
});

/**
 * The answer is shaped their way, which is three decisions rather than one.
 *
 * Across their 48 plugins the response is read as `data` and `respHeaders` and under no other
 * name, so `headers` is gone rather than kept beside it: two header objects differing only in
 * the one header anybody is looking for is a bad hour on a television. And `set-cookie` is the
 * array `yonto.fetch` answers with, which is lossless where a fold is not, since an `Expires`
 * date contains the comma the fold joins on; its `split` folds it for the plugin that reads
 * XPTV's string (`anime1.js`). A header name is case-insensitive, so any spelling reads it.
 *
 * **Printed rather than thrown.** A catalog that throws surfaces as one "program won't run" with its
 * message discarded, so four claims in one body would collapse into a single opaque red — the
 * test would name the failure it is called after and not the claim that broke.
 *
 * `content-type` is spelled lowercase here because that is what this transport answers, not
 * because anything normalises it: the Kotlin host lowercases every response header name and
 * the CLI host passes the site's spelling through, which is kangzj/lantern-tv#431 and not
 * settled by this plugin. `set-cookie` below is a literal key this shim writes, so it is the
 * one name in here that does not depend on that.
 */
test('respHeaders is their name for it, any casing reads it, and set-cookie arrives whole and splits like a string', async () => {
  const { host, engine } = engineOver(tabs('', `
    const answer = await $fetch.get('https://s.test/two')
    $print(jsonify({
      names: Object.keys(answer).sort(),
      ordinary: answer.respHeaders['content-type'],
      cased: answer.respHeaders['Content-Type'],
      folded: answer.respHeaders['Set-Cookie'].split(','),
      // Not under a cookie name, which log() would hide.
      whole: answer.respHeaders['set-cookie'],
    }))
  `), {
    answer: (req) => (req.url === 'https://s.test/two'
      ? {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
        // The pair the fold cannot be undone on: the first value's Expires date has a comma.
        setCookie: ['a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/', 'b=2; HttpOnly'],
        bodyBase64: b64(''),
      }
      : null),
  });

  await engine.call('getCategories', []);

  const printed = host.logs.map((e) => e.message).find((m) => m.includes('"names"'));
  const seen = JSON.parse(printed.slice(printed.indexOf('{')));
  assert.deepEqual(seen.names, ['data', 'respHeaders', 'status']);
  assert.equal(seen.ordinary, 'text/html');
  assert.equal(seen.cased, 'text/html');
  assert.deepEqual(seen.folded, ['a=1; Expires=Wed', ' 09 Jun 2027 10:18:14 GMT; Path=/', 'b=2; HttpOnly']);
  assert.deepEqual(seen.whole, ['a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/', 'b=2; HttpOnly']);
});

test('$cache is synchronous, the way a real catalog uses it', async () => {
  // `leijing.js` does `argsify($cache.get('leijing_token'))` with no `await` anywhere, which
  // is how their runtime works. Hand that a promise and `JSON.parse` sees `[object Promise]`.
  const { storeDir, engine } = engineOver(tabs(`
    $cache.set('t', jsonify({ token: 'abc' }))
    const read = argsify($cache.get('t'))
    if (read.token !== 'abc') throw new Error('not synchronous')
  `), { className: 'catA' });

  await engine.call('getCategories', []);

  // Written back at the end of the call rather than fire-and-forget: a promise nobody awaits
  // need never resolve before the call ends, and a token written that way is a login done
  // again next time.
  const store = JSON.parse(readFileSync(join(storeDir, 'store.json'), 'utf8'));
  assert.ok(Object.keys(store).includes(`cache:${EXT}`), Object.keys(store).join(' '));
});

test("a catalog's cache is keyed by its address, never its class name", async () => {
  // `cache:<ext>` is what the migration from `plugins/xptv` copies a catalog's login under, so
  // the key is pinned to the character. A class name is shared by every mirror of one plugin.
  const { storeDir, engine } = engineOver(tabs(`$cache.set('t', '1')`), { className: 'wogg' });

  await engine.call('getCategories', []);

  const keys = Object.keys(JSON.parse(readFileSync(join(storeDir, 'store.json'), 'utf8')));
  assert.ok(keys.includes('cache:https://catalogs.test/one.js'), keys.join(' '));
  assert.ok(!keys.includes('cache:wogg'), keys.join(' '));
});

test('an ext ending in a slash keys its cache exactly as given, slash and all', async () => {
  // The migration copies a login under `cache:<ext>` as the index wrote it, so the handler must
  // not tidy the address it was handed.
  const ext = 'https://catalogs.test/dir/';
  const { storeDir, engine } = engineOver(tabs(`$cache.set('t', '1')`), { ext });

  await engine.call('getCategories', []);

  const keys = Object.keys(JSON.parse(readFileSync(join(storeDir, 'store.json'), 'utf8')));
  assert.ok(keys.includes('cache:https://catalogs.test/dir/'), keys.join(' '));
});

test('a 200 that is not a catalog is never kept, so it cannot poison a week', async () => {
  // A CDN's 504 page served with status 200. Kept, it would refuse this catalog for the whole
  // of its TTL, long after the real one came back, and there is no stale
  // copy to fall through to.
  const storeDir = scratchDir('lp-xptv-poison-');
  const bad = engineOver('<html>504 Gateway Time-out</html>', { storeDir });
  await bad.engine.call('getCategories', []).then(() => null, (e) => e);

  const good = engineOver(tabs(), { storeDir });
  const categories = await good.engine.call('getCategories', []);

  assert.equal(categories.length, 1);
  assert.equal(good.transport.calls.filter((url) => url === EXT).length, 1);
});

test("a catalog's source is keyed by its address too", async () => {
  const storeDir = scratchDir('lp-xptv-addr-');
  const first = engineOver(tabs(), { storeDir, className: 'wogg' });
  await first.engine.call('getCategories', []);

  const keys = Object.keys(JSON.parse(readFileSync(join(storeDir, 'store.json'), 'utf8')));
  assert.ok(keys.includes(`catalog:${EXT}`), keys.join(' '));
  assert.ok(!keys.includes('catalog:wogg'), keys.join(' '));
});

test('a getConfig that answers badly says so, not in the engine\'s words', async () => {
  for (const body of [
    `async function getConfig() { return '<html>nope</html>' }`,
    `async function getConfig() { return { tabs: [] } }`,
    `async function getConfig() { throw new Error('site changed') }`,
  ]) {
    const { engine } = engineOver(body);
    const error = await engine.call('getCategories', []).then(() => null, (e) => e);
    assert.equal(error?.code, Code.UNAVAILABLE, body);
    // `unexpected token: '<'` is the engine's own words about somebody else's program.
    assert.doesNotMatch(error.message, /unexpected token|SyntaxError|site changed/, body);
  }
});

test('a catalog cannot forge a host verdict through the load catch', async () => {
  // `code` was the first sieve and it is wide enough to pass a stranger's own object — a
  // transport error carrying `ENOTFOUND` would do it too. The app words NOT_FOUND as the
  // source no longer having what was asked for, on a screen that asked for nothing.
  const { engine } = engineOver(`
    throw Object.assign(new Error('getaddrinfo ENOTFOUND cdn.example'), { code: 'NOT_FOUND' })
  `);

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.UNAVAILABLE);
  assert.doesNotMatch(error.message, /ENOTFOUND/);
});

test('two tabs that answer to the same ext are one category, not a repeated key', async () => {
  // `BrowseScreen` keys its list on the category id and Compose throws on a repeated key, so
  // a catalog shipping two tabs with no `ext` at all would have taken Browse down.
  const { engine } = engineOver(`
    async function getConfig() { return jsonify({ tabs: [{ name: '电影' }, { name: '剧集' }] }) }
  `);

  const categories = await engine.call('getCategories', []);

  assert.equal(categories.length, 1);
  assert.equal(new Set(categories.map((c) => c.id)).size, categories.length);
});

test('getTabs is asked when the config offers none, since it is a real entry point', async () => {
  const { engine } = engineOver(`
    async function getConfig() { return jsonify({ tabs: [] }) }
    async function getTabs() { return jsonify([{ name: '动画', ext: { url: '/a/' } }]) }
  `);

  const categories = await engine.call('getCategories', []);

  assert.equal(categories.length, 1);
  assert.equal(categories[0].name, '动画');
});

test('a search-only catalog is told it has no categories, not that it is broken', async () => {
  // `tianyiso.js` calls its one tab 只有搜索功能. A catalog can be search-only and correct.
  const { engine } = engineOver(`async function getConfig() { return jsonify({ tabs: [] }) }`);

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.UNAVAILABLE);
  assert.match(error.message, /Use search instead/);
  assert.doesNotMatch(error.message, /won't run/);
});

test('checkHealth loads the program and calls a working one usable, even with no tabs', async () => {
  const { engine, transport } = engineOver(`async function getConfig() { return jsonify({ tabs: [] }) }`);

  const health = await engine.call('checkHealth', []);

  assert.equal(health.usable, true);
  assert.deepEqual(transport.calls, [EXT]);
});

test('checkHealth keeps the program, so opening the source afterwards downloads nothing', async () => {
  const first = engineOver(tabs());
  await first.engine.call('checkHealth', []);
  const second = engineOver(tabs(), { storeDir: first.storeDir });

  await second.engine.call('getCategories', []);

  assert.deepEqual(second.transport.calls, []);
});

test('checkHealth writes back what getConfig put in $cache, like every other path', async () => {
  const { engine, storeDir } = engineOver(tabs('', `$cache.set('t', '1')`));

  await engine.call('checkHealth', []);

  const store = JSON.parse(readFileSync(join(storeDir, 'store.json'), 'utf8'));
  assert.ok(Object.keys(store).includes(`cache:${EXT}`), Object.keys(store).join(' '));
});

test('checkHealth says the site is down when getConfig swallowed the failure itself', async () => {
  // A catalog that catches its own request failing and carries on with empty tabs still has a
  // site that did not answer.
  const { engine } = engineOver(tabs('', `try { await $fetch.get('https://s.test/') } catch (e) {}`), {
    answer: () => { throw new Error('offline'); },
  });

  const error = await engine.call('checkHealth', []).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE, JSON.stringify(error));
  assert.match(error.message, /website isn't available/);
});

test('checkHealth refuses a program that cannot be downloaded', async () => {
  const { engine } = engineOver(tabs(), { status: 404 });

  const error = await engine.call('checkHealth', []).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE, JSON.stringify(error));
  assert.match(error.message, /Can't download this source's program/);
});

test('checkHealth refuses a program that will not run', async () => {
  const { engine } = engineOver('this is not javascript {');

  const error = await engine.call('checkHealth', []).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE, JSON.stringify(error));
  assert.match(error.message, /won't run/);
});

test('checkHealth says the site is down when its getConfig could not reach it', async () => {
  const { engine } = engineOver(tabs('', `await $fetch.get('https://s.test/')`), {
    answer: () => { throw new Error('offline'); },
  });

  const error = await engine.call('checkHealth', []).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE, JSON.stringify(error));
  assert.match(error.message, /website isn't available/);
});

test('an ext that is not an http(s) address is the form\'s problem, and nothing is fetched', async () => {
  const { engine, transport } = engineOver(tabs(), { ext: 'https://' });

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error?.code, Code.MISCONFIGURED, JSON.stringify(error));
  assert.equal(error.message, "The program address isn't a full http(s) address. Check it.");
  assert.deepEqual(transport.calls, []);
});

test('loadJSEncrypt hands over the RSA class, decrypting what its key encrypted', async () => {
  const { engine } = engineOver(tabs('', `
    const JSEncrypt = loadJSEncrypt()
    const rsa = new JSEncrypt({ default_key_size: '512' })
    const back = rsa.decrypt(rsa.encrypt('hello'))
    if (back !== 'hello') throw new Error('round trip ' + back)
    if (loadJSEncrypt() !== JSEncrypt) throw new Error('compiled twice')
  `));

  assert.equal((await engine.call('getCategories', [])).length, 1);
});

// kangzj/lantern-tv#830: XPTV's openSafari is how a catalog asks the viewer to pass a check.
test('openSafari asks for a browser check at the page it was handed, whatever agent it names', async () => {
  const { engine } = engineOver(tabs(`
    $utils.openSafari('https://s.test/captcha', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  `));

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.CHALLENGED);
  assert.equal(error.message, 'https://s.test/captcha');
});

// Their getConfig is where a catalog meets its site first, and a failure there is kept so a
// search can still answer without it; a check it asks for is the one thing that must not be.
test('a check asked for from getConfig is raised, not carried past, even by a search', async () => {
  const { engine } = engineOver(`
    async function getConfig() {
      await $fetch.get('https://s.test/captcha')
      $utils.openSafari('https://s.test/captcha')
    }
    async function search(ext) {
      return jsonify({ list: [{ vod_id: '/p/1', vod_name: '庆余年', vod_pic: '', ext: { url: '/p/1' } }] })
    }
  `);

  const error = await engine.call('search', ['庆余年']).then(() => null, (e) => e);

  assert.equal(error?.code, Code.CHALLENGED);
});

test('a television offers the check at a site the catalog fetched in the call, and not at one it did not', async () => {
  const asked = (inConfig) => {
    const { host, engine } = engineOver(tabs('', inConfig));
    return challengeAware(engine, loadManifest(dir), host.requests).call('getCategories', []).then(() => null, (e) => e);
  };

  const fetched = await asked(`
    await $fetch.get('https://s.test/captcha')
    $utils.openSafari('https://s.test/captcha')
  `);
  const unfetched = await asked(`$utils.openSafari('https://elsewhere.test/captcha')`);

  assert.match(fetched.message, /a television offers the viewer a browser check here/);
  assert.match(unfetched.message, /a television reports it as unavailable/);
});

test('a toast logs and the catalog carries on, because the call already succeeded', async () => {
  const { host, engine } = engineOver(tabs(`
    $utils.toastInfo('hello')
    $utils.toastError('oh no')
    $print('printed')
  `));

  // Eighteen of their plugins call one of these. Failing a catalog that works, over a
  // message it wanted to show, is the wrong trade — kangzj/lantern-tv#357 is the home.
  assert.equal((await engine.call('getCategories', [])).length, 1);
  assert.ok(host.logs.some((e) => e.message.includes('toast: hello')), JSON.stringify(host.logs));
  assert.ok(host.logs.some((e) => e.message.includes('printed')), JSON.stringify(host.logs));
});

test('a catalog with no class name is logged as xptv-js, and what it prints keeps its words and not its addresses', async () => {
  // Never by its address, which can carry a token, since a line goes to logcat (kangzj/lantern-tv#566).
  const ext = 'https://catalogs.test/one.js?token=s3cr3t';
  const { host, engine } = engineOver(tabs(`
    $print('asking https://site.test/api?key=s3cr3t for tabs')
    $utils.toastError('could not reach http://site.test:8080/login')
  `), { ext });

  await engine.call('getCategories', []);

  const lines = host.logs.map((e) => e.message);
  assert.ok(lines.some((line) => line === '[xptv-js] asking <a URL> for tabs'), JSON.stringify(lines));
  assert.ok(lines.some((line) => line === '[xptv-js] toast: could not reach <a URL>'), JSON.stringify(lines));
  for (const secret of ['catalogs.test', 'site.test', 's3cr3t']) {
    assert.ok(lines.every((line) => !line.includes(secret)), `${secret} in ${JSON.stringify(lines)}`);
  }
});

test('a URL is blanked in every shape a catalog writes one, and the words around it survive', async () => {
  const printed = [
    'key_https://site.test/a?key=s3cr3t，然后失败了',
    '搜索 https://x.test/search?wd=画皮&token=s3cr3t 失败',
    '{"url":"https:\\/\\/site.test\\/api.php?token=s3cr3t"}',
    '<img src="//site.test/p.jpg?sign=s3cr3t">',
    'HTTPS://SITE.TEST/?KEY=s3cr3t',
    '// a comment, a/b/c',
  ];
  const { host, engine } = engineOver(tabs(printed.map((line) => `$print(${JSON.stringify(line)})`).join('\n')));

  await engine.call('getCategories', []);

  const lines = host.logs.map((e) => e.message.replace('[xptv-js] ', ''));
  for (const expected of [
    'key_<a URL>，然后失败了',
    '搜索 <a URL> 失败',
    '{"url":"<a URL>"}',
    '<img src="<a URL>">',
    '<a URL>',
    '// a comment, a/b/c',
  ]) {
    assert.ok(lines.includes(expected), `${expected} in ${JSON.stringify(lines)}`);
  }
});

test('a secret-named parameter loses its value wherever it sits, URL or not', async () => {
  // A URL's end can't be found once its query holds a space (kangzj/lantern-tv#597), and a bare
  // `sid=…` isn't URL-shaped at all, so the value goes by its name instead.
  const printed = [
    '?wd=权力的游戏 第一季&token=S3CR3T',
    'https://x.test/s?wd=权力的游戏 第一季&access_token=S3CR3T&page=2',
    'sid=abc123',
    'Cookie: PHPSESSID=abc123; path=/',
    '{"token":"S3CR3T","name":"画皮"}',
    'missing key: S3CR3T here',
    '年份: 2024, 地区: 大陆',
  ];
  const { host, engine } = engineOver(tabs(printed.map((line) => `$print(${JSON.stringify(line)})`).join('\n')));

  await engine.call('getCategories', []);

  const lines = host.logs.map((e) => e.message.replace('[xptv-js] ', ''));
  for (const expected of [
    '?wd=权力的游戏 第一季&token=<hidden>',
    '<a URL> 第一季&access_token=<hidden>&page=2',
    'sid=<hidden>',
    'Cookie: <hidden>',
    '{"token":<hidden>,"name":"画皮"}',
    'missing key: <hidden> here',
    '年份: 2024, 地区: 大陆',
  ]) {
    assert.ok(lines.includes(expected), `${expected} in ${JSON.stringify(lines)}`);
  }
  assert.ok(lines.every((line) => !line.includes('S3CR3T') && !line.includes('abc123')), JSON.stringify(lines));
});

test('a secret keeps nothing of its value, whatever shape the value takes', async () => {
  // The shapes a review of kangzj/lantern-tv#612 found leaking, each as it was found.
  const cases = [
    ['Authorization: Bearer eyJ…SECRET', 'Authorization: <hidden>'],
    ['Proxy-Authorization: Basic dXNlcjpTRUNSRVQ=', 'Proxy-Authorization: <hidden>'],
    ['Cookie: uid=123; BDUSS=SECRETBD; STOKEN=X', 'Cookie: <hidden>'],
    ['Set-Cookie: BDUSS=SECRETBD; path=/', 'Set-Cookie: <hidden>'],
    ['Cookie: uid=123; BDUSS=SECRETBD\nUser-Agent: okhttp', 'Cookie: <hidden>\nUser-Agent: okhttp'],
    ['{"headers":"Cookie: uid=123; BDUSS=SECRETBD","ua":"okhttp"}', '{"headers":"Cookie: <hidden>","ua":"okhttp"}'],
    ['{"token":"ab\\"SECRET\\"cd","name":"画皮"}', '{"token":<hidden>,"name":"画皮"}'],
    ['{"cookie":{"BDUSS":"SECRET"},"name":"画皮"}', '{"cookie":<hidden>,"name":"画皮"}'],
    ['{"tokens":["SECRET1",["SECRET2"]],"name":"画皮"}', '{"tokens":<hidden>,"name":"画皮"}'],
    ['{"tokens":["SECRET1",{"a":"]"}', '{"tokens":<hidden>'],
    ['{"token":"SECRET, and on', '{"token":<hidden>'],
    ['token=ab\tSECRET', 'token=<hidden>'],
    ['token=ab,SECRET', 'token=<hidden>'],
    ['token：SECRET', 'token：<hidden>'],
    ['BDUSS=SECRETBD', 'BDUSS=<hidden>'],
    ['sig=SECRET', 'sig=<hidden>'],
    ['__pus=SECRET', '__pus=<hidden>'],
    ['__puus=SECRET', '__puus=<hidden>'],
  ];
  const { host, engine } = engineOver(tabs(cases.map(([line]) => `$print(${JSON.stringify(line)})`).join('\n')));

  await engine.call('getCategories', []);

  const lines = host.logs.map((e) => e.message.replace('[xptv-js] ', ''));
  for (const [, expected] of cases) {
    assert.ok(lines.includes(expected), `${JSON.stringify(expected)} in ${JSON.stringify(lines)}`);
  }
  assert.ok(lines.every((line) => !line.includes('SECRET')), JSON.stringify(lines));
});

test('a secret goes under the names and shapes the second review found, and a word that only looks like one stays', async () => {
  const cases = [
    // JSON printed as a JSON string.
    ['"{\\"token\\":\\"SECRET\\"}"', '"{\\"token\\":<hidden>}"'],
    [JSON.stringify(JSON.stringify({ token: 'a"SECRET', name: '画皮' })), '"{\\"token\\":<hidden>,\\"name\\":\\"画皮\\"}"'],
    [
      JSON.stringify({ headers: JSON.stringify({ Cookie: 'lang=zh; yp=SECRET', 'User-Agent': 'okhttp' }) }),
      '{"headers":"{\\"Cookie\\":<hidden>,\\"User-Agent\\":\\"okhttp\\"}"}',
    ],
    // A cookie or an auth token under another name is one credential too.
    ['X-Cookie: lang=zh; yp=SECRET', 'X-Cookie: <hidden>'],
    ['cookies: lang=zh; yp=SECRET', 'cookies: <hidden>'],
    ['cookie_str=lang=zh; yp=SECRET', 'cookie_str=<hidden>'],
    ['Cookie2: lang=zh; yp=SECRET', 'Cookie2: <hidden>'],
    ['X-Auth-Token: Bearer SECRET', 'X-Auth-Token: <hidden>'],
    // The smaller gaps.
    ['jwt=SECRET', 'jwt=<hidden>'],
    ['ck=SECRET', 'ck=<hidden>'],
    ['csrf=SECRET', 'csrf=<hidden>'],
    ['track=1', 'track=1'],
    ['token＝SECRET', 'token＝<hidden>'],
    ['token%3DSECRET%26page%3D2', 'token%3D<hidden>%26page%3D2'],
    ['sent Bearer SECRET to it', 'sent Bearer <hidden> to it'],
    ['data[token]=SECRET&page=2', 'data[token]=<hidden>&page=2'],
    ['token:\n  SECRET', 'token:\n  <hidden>'],
  ];
  const { host, engine } = engineOver(tabs(cases.map(([line]) => `$print(${JSON.stringify(line)})`).join('\n')));

  await engine.call('getCategories', []);

  const lines = host.logs.map((e) => e.message.replace('[xptv-js] ', ''));
  for (const [, expected] of cases) {
    assert.ok(lines.includes(expected), `${JSON.stringify(expected)} in ${JSON.stringify(lines)}`);
  }
  assert.ok(lines.every((line) => !line.includes('SECRET')), JSON.stringify(lines));
});

/**
 * The steps QuickJS runs for a `getCategories` that `$print`s [bytes] bytes of hex and three
 * quarters of that of base64url, counted by `engine.polls()` rather than timed: a busy machine
 * takes longer over the same steps (kangzj/lantern-tv#746).
 */
async function printingWork(bytes) {
  const blob = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 151 + 7) % 256));
  const hex = blob(bytes).toString('hex');
  const base64url = blob((bytes * 3) / 4).toString('base64url');
  const { host, engine } = engineOver(tabs('', `$print(${JSON.stringify(hex)}); $print(${JSON.stringify(base64url)})`));
  await engine.call('getCategories', []);
  const lines = host.logs.map((e) => e.message);
  assert.ok(lines.some((line) => line.endsWith(hex)) && lines.some((line) => line.endsWith(base64url)));
  return engine.polls();
}

test('a long blob a catalog prints goes through log() in linear time', async () => {
  // A catalog `$print`ing an encrypted response. A pattern tried from every character of a run is
  // quadratic: in QuickJS the name one took 3.5 s over 8k of hex and 17 s over 16k of base64url,
  // and the URL one a second over 16k of hex. Counted in steps, 4k and 8k of hex are enough to
  // tell them apart: linear work doubles with the blob, and quadratic work quadruples. Below about
  // 1.5k the count has not turned linear yet, so these must not shrink. Steps inside a C builtin
  // are not counted, so this guards growth in the plugin's own code and its regexes, not in `slice`.
  const small = await printingWork(2048);
  const large = await printingWork(4096);

  assert.ok(large < 3 * small, `${small} steps for 4k of hex, then ${large} for 8k`);
});

test('a catalog whose class name sounds secret keeps the words after its name', async () => {
  const { host, engine } = engineOver(tabs('$print("apikey: SECRET")'), { className: 'apikey' });

  const [category] = await engine.call('getCategories', []);
  await engine.call('getMediaDetail', [category.id]).catch(() => null);

  const lines = host.logs.map((e) => e.message);
  assert.ok(lines.includes('catalog apikey: not a media id'), JSON.stringify(lines));
  assert.ok(lines.includes('[apikey] apikey: <hidden>'), JSON.stringify(lines));
});

test('the lines about an id or a failed load name the catalog, and nothing the id or the error carried', async () => {
  const ext = 'https://catalogs.test/one.js?token=s3cr3t';
  const logName = 'csp_test';

  const { host, engine } = engineOver(tabs('async function getCards() { return jsonify({ list: [] }) }'), { ext, className: logName });
  const [category] = await engine.call('getCategories', []);
  await engine.call('getMediaDetail', [category.id]).catch(() => null);
  await engine.call('getMediaList', ['{"e":{}}', { page: 1, filters: {} }]).catch(() => null);
  const lines = host.logs.map((e) => e.message);
  assert.ok(lines.includes(`catalog ${logName}: not a media id`), JSON.stringify(lines));
  assert.ok(lines.includes(`catalog ${logName}: not a category id`), JSON.stringify(lines));

  const broken = engineOver(tabs(`throw new Error('could not reach https://site.test/?key=s3cr3t for the tabs')`), { ext, className: logName });
  await broken.engine.call('getCategories', []).catch(() => null);
  const loading = broken.host.logs.map((e) => e.message).find((line) => line.includes('threw while loading'));
  assert.equal(loading, `catalog ${logName} threw while loading: could not reach <a URL> for the tabs`);
});

test('a catalog that wraps a failed $fetch in its own words hands the log no address or search text', async () => {
  // czzy.js catches a failure and rethrows `'请求失败: ' + e.message`, and the host's message
  // names the URL asked — here with the search text unencoded, where no URL pattern reaches.
  const { host, engine } = engineOver(`
async function getConfig() { return jsonify({ ver: 1, title: 'T', site: 'https://s.test', tabs: [] }) }
async function getTabs() {
  try {
    await $fetch.get('https://s.test/search?key=s3cr3t-key&wd=私人搜索词')
  } catch (e) {
    throw new Error('请求失败: ' + e.message + ' (' + e.code + ')')
  }
}
`, { answer: () => { throw new Error('connect refused'); } });

  await engine.call('getCategories', []).catch(() => null);

  const line = host.logs.map((e) => e.message).find((message) => message.includes('answered badly'));
  assert.match(line, /answered badly: 请求失败: (REQUEST_FAILED|HOST_NOT_ALLOWED) \(\1\)$/);
});

// One way to logcat, so a line added later cannot forget to go through it.
test('the plugin calls yonto.log in one place', () => {
  const source = readFileSync(join(dir, 'xptv-js-plugin.js'), 'utf8');
  assert.equal(source.match(/yonto\.log\(/g).length, 1);
});

test('the host is not reachable by the names a catalog would try first', async () => {
  const { engine } = engineOver(tabs(`
    if (typeof yonto !== 'undefined') throw new Error('yonto reachable')
    if (typeof globalThis !== 'undefined') throw new Error('globalThis reachable')
    if (typeof __host_fetch !== 'undefined') throw new Error('__host_fetch reachable')
    if (this !== undefined && typeof this.yonto !== 'undefined') throw new Error('this.yonto reachable')
  `));

  // Hygiene, not containment: `new Function('return this')()` still recovers the real
  // global and always will. `plugins/xptv-js/AGENTS.md` is the whole list.
  assert.equal((await engine.call('getCategories', [])).length, 1);
});

test('a catalog that will not compile says so, rather than throwing a SyntaxError at a viewer', async () => {
  const { engine } = engineOver('this is not javascript {{{');

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.UNAVAILABLE);
  // The part that failed, not the source: the app's headline already names that.
  assert.equal(error.message, "This source's program won't run. It may be out of date.");
});

test('a catalog that throws while loading says so, and the cause reaches the log', async () => {
  const { host, engine } = engineOver(`throw new Error('boom from the catalog')`);

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.UNAVAILABLE);
  // kangzj/lantern-tv#395 loses this cause on the device, so the log is the only place it
  // survives — and evaluating fetched source is this plugin's whole job.
  assert.ok(host.logs.some((e) => e.message.includes('boom from the catalog')), JSON.stringify(host.logs));
});

test('a catalog whose source will not download says so, and not that it is broken', async () => {
  const { engine } = engineOver(tabs(), { status: 500 });

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.UNAVAILABLE);
  assert.equal(error.message, "Can't download this source's program right now. Try again later.");
});

test('a catalog is compiled once per runtime, not once per call', async () => {
  // Counted by a side effect in the module body rather than by the download, because the
  // store would hide a recompile: the two mechanisms mask each other, and one test asserting
  // both held neither on its own.
  const { host, engine } = engineOver(tabs(`$print('loaded')`));

  await engine.call('getCategories', []);
  await engine.call('getCategories', []);

  // #390's bound: one compiled catalog kept between calls, and a call wanting a different
  // one replaces it.
  const loads = host.logs.filter((entry) => entry.message.includes('loaded')).length;
  assert.equal(loads, 1);
});

test("a catalog's source is kept, so a second runtime does not download it again", async () => {
  const storeDir = scratchDir('lp-xptv-shared-');
  const first = engineOver(tabs(), { storeDir });
  await first.engine.call('getCategories', []);

  const second = engineOver(tabs(), { storeDir });
  await second.engine.call('getCategories', []);

  // Opening a media id from a catalog that is not the active one pays a compile inside that
  // call — this is what stops it also paying a download.
  assert.equal(first.transport.calls.filter((url) => url === EXT).length, 1);
  assert.equal(second.transport.calls.filter((url) => url === EXT).length, 0);
});

/**
 * `bdys.js`'s own shape, which is the whole of kangzj/lantern-tv#433.
 *
 * Its `getConfig` fetches a throwaway path for a `Set-Cookie`, keeps it in a module-scope
 * object, and every request it makes afterwards reuses that object. Their runtime calls
 * `getConfig` when it loads a plugin, so the cookie is there by the time `getCards` runs —
 * this loader reached it from the categories path only, so the listing, the search, the
 * detail and the stream all went out bare. 7 of their 48 do work in there rather than returning the object.
 */
const gated = `
let headers = {}
async function getConfig() {
  if (!headers.Cookie) {
    const { respHeaders } = await $fetch.get('https://s.test/gate', { headers })
    headers.Cookie = respHeaders['set-cookie'][0].split(';')[0]
  }
  return jsonify({ tabs: [{ name: '电影', ext: { id: 1 } }] })
}
async function getCards(ext) {
  await $fetch.get('https://s.test/listing', { headers })
  return jsonify({ list: [] })
}
async function search(ext) {
  await $fetch.get('https://s.test/search', { headers })
  return jsonify({ list: [] })
}
async function getTracks(ext) {
  await $fetch.get('https://s.test/tracks', { headers })
  return jsonify({ list: [] })
}
async function getPlayinfo(ext) {
  await $fetch.get('https://s.test/playinfo', { headers })
  return jsonify({ urls: ['https://v.test/1.mp4'] })
}
`;

const GATE = 'https://s.test/gate';

const gate = (req) => (req.url === GATE
  ? { status: 200, headers: {}, setCookie: ['SESSION=abc; Path=/; HttpOnly'], bodyBase64: b64('') }
  : null);

test('their getConfig runs before every entry point, not only the one that reads the tabs', async () => {
  const storeDir = scratchDir('lp-xptv-gated-');
  const categoryId = '{"id":1}';
  const mediaId = JSON.stringify({ e: { url: '/p/1' }, n: '庆余年' });
  const token = JSON.stringify({ t: { url: '/p/1/1' } });
  // Six realms, because each of our calls is one — nothing the categories call sets up
  // survives into the listing call, which is why "it ran once on the first screen" was not an
  // answer. The store is shared between them, as it is on a television. The categories path
  // makes no request of its own: its tabs come out of the config, so the gate is all it does.
  const paths = [
    ['getCategories', [], null],
    ['getFilters', [categoryId], 'https://s.test/listing'],
    ['getMediaList', [categoryId, { page: 1 }], 'https://s.test/listing'],
    ['search', ['庆余年'], 'https://s.test/search'],
    ['getMediaDetail', [mediaId], 'https://s.test/tracks'],
    ['getStream', [token], 'https://s.test/playinfo'],
  ];

  const ran = {};
  const carried = {};
  for (const [method, args, url] of paths) {
    const { engine, transport } = engineOver(gated, { storeDir, answer: gate });
    // `getMediaDetail` reads the tracks and then refuses, which is #392 and not this test's
    // business — what it sent on the way is.
    await engine.call(method, args).catch(() => {});
    ran[method] = transport.calls.includes(GATE);
    if (url !== null) carried[method] = transport.requests.find((req) => req.url === url)?.headers?.Cookie ?? null;
  }

  // One object rather than an assertion per path: five of these six were the defect, and a
  // per-path assertion would stop at the first and say nothing about the other two.
  assert.deepEqual(ran, {
    getCategories: true,
    getFilters: true,
    getMediaList: true,
    search: true,
    getMediaDetail: true,
    getStream: true,
  });
  // And the cookie that ran collected is on the request each path then makes, which is the
  // half that says the setup reached the catalog rather than merely happening.
  assert.deepEqual(carried, {
    getFilters: 'SESSION=abc',
    getMediaList: 'SESSION=abc',
    search: 'SESSION=abc',
    getMediaDetail: 'SESSION=abc',
    getStream: 'SESSION=abc',
  });
});

test('their getConfig is asked once per compiled catalog, not once per entry point', async () => {
  // The bound on the line above, and its price. `czzy.js` builds its tabs inside `getConfig`
  // with a fetch and no guard of its own, so a second ask is a second request — and their
  // runtime makes one ask per load, which is what a compiled catalog is here.
  const { host, engine } = engineOver(tabs('', `$print('config')`));
  const asks = () => host.logs.filter((entry) => entry.message.includes('config')).length;

  await engine.call('getCategories', []);
  // The categories path reads the tabs out of that same answer rather than asking again.
  assert.equal(asks(), 1);

  await engine.call('getCategories', []);
  // And a second call in one runtime reuses the compiled catalog, so it reuses its config.
  assert.equal(asks(), 1);
});

test('a getConfig that fails stops the categories, and not the search that never read it', async () => {
  // Asking `getConfig` everywhere must not cost the paths that only wanted its side effects.
  // Measured on the pinned `czzy.js`, whose `getConfig` fetches its homepage *only* to build
  // tabs: with that homepage down its search answered before #433, and refusing it now would
  // be this change taking away a screen that worked.
  const source = `
    async function getConfig() { throw new Error('the homepage is down') }
    async function search(ext) {
      return jsonify({ list: [{ vod_id: '/p/1', vod_name: '庆余年', vod_pic: '', ext: { url: '/p/1' } }] })
    }
  `;

  const found = await engineOver(source).engine.call('search', ['庆余年']);
  assert.equal(found.length, 1);

  const error = await engineOver(source).engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error.code, Code.UNAVAILABLE);
  // And the categories path keeps the sentence for a catalog that will not run. Answering it
  // an empty config instead would reach `noCategoriesMessage` — a broken catalog described as
  // a working search-only one, which is the one wrong answer this shape has to avoid.
  assert.match(error.message, /won't run/, error.message);
  assert.doesNotMatch(error.message, /Use search instead/, error.message);
  assert.doesNotMatch(error.message, /the homepage is down/, error.message);
});

test('a getConfig that failed is asked again on the next call, not kept for the runtime', async () => {
  // A television keeps its runtime between screens, so a homepage that was down for one call
  // would otherwise refuse the categories until the catalog is compiled again.
  const { engine } = engineOver(`
    let asked = 0
    async function getConfig() {
      asked += 1
      if (asked === 1) throw new Error('the homepage is down')
      return jsonify({ tabs: [{ name: '电影', ext: { id: 1 } }] })
    }
  `);

  const first = await engine.call('getCategories', []).then(() => null, (e) => e);
  assert.equal(first?.code, Code.UNAVAILABLE);

  const categories = await engine.call('getCategories', []);
  assert.deepEqual(categories.map((category) => category.name), ['电影']);
});

test('a catalog with no getConfig is still searched, rather than refused for the want of one', async () => {
  // Their runtime has nothing to call either, and only the categories path needs an answer
  // from it — so an absent `getConfig` is no config, not a catalog that will not run.
  const { engine } = engineOver(`
    async function search(ext) {
      return jsonify({ list: [{ vod_id: '/p/1', vod_name: '庆余年', vod_pic: '', ext: { url: '/p/1' } }] })
    }
  `);

  const items = await engine.call('search', ['庆余年']);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, '庆余年');
});

// kangzj/lantern-tv#655's two codes, whose messages name the URL, forged here because the CLI
// host passes a transport's `PluginError` through with its code. Both are logged by the code
// alone. A refused redirect chain is the site's doing, so it gets the site's sentence as
// `REQUEST_FAILED` does; a request their code built wrong is the program's.
const SEARCH_THAT_FETCHES = tabs(`
async function search(ext) {
  ext = argsify(ext)
  await $fetch.get('https://s.test/search?key=s3cr3t-key&wd=' + encodeURIComponent(ext.text))
  return jsonify({ list: [] })
}`);

for (const [code, sentence] of [
  ['REQUEST_INVALID', "This source's program won't run. It may be out of date."],
  ['REDIRECT_REFUSED', "This source's website isn't available right now. Try again later."],
  // #716's cap on a body: the site answered, so it is the program's sentence and not the site's.
  ['RESPONSE_TOO_LARGE', "This source's program won't run. It may be out of date."],
]) {
  test(`a ${code} is logged by its code, never its URL, and says ${sentence}`, async () => {
    const { host, engine } = engineOver(SEARCH_THAT_FETCHES, {
      className: 'one',
      answer: (req) => {
        throw new PluginError(code, `${req.url} was refused`, { url: req.url });
      },
    });

    const error = await engine.call('search', ['私人搜索词']).then(() => null, (e) => e);

    assert.equal(error?.message, sentence);
    const line = host.logs.find((entry) => entry.message.includes('answered badly'));
    assert.equal(line?.message, `catalog one answered badly: ${code}`, JSON.stringify(host.logs));
    for (const secret of ['s.test', 's3cr3t-key', '私人搜索词']) {
      assert.ok(host.logs.every((entry) => !entry.message.includes(secret)), `${secret} in ${JSON.stringify(host.logs)}`);
    }
  });
}

test('a refused redirect says why the site is called down, in a line of its own', async () => {
  const { host, engine } = engineOver(SEARCH_THAT_FETCHES, {
    className: 'one',
    answer: (req) => {
      throw new PluginError('REDIRECT_REFUSED', `${req.url} was refused`, { url: req.url });
    },
  });

  await engine.call('search', ['私人搜索词']).catch(() => null);

  assert.ok(
    host.logs.some((entry) => entry.message === 'catalog one: a request was redirected in a way the host refused (REDIRECT_REFUSED)'),
    JSON.stringify(host.logs),
  );
});

// The download of the program itself: its server not answering, a redirect chain on `ext`, and
// the call running out of time on the way. The host's message names `ext`, which can carry a
// token, so neither the log nor the viewer's sentence may hold it.
const SIGNED_EXT = 'https://catalogs.test/one.js?token=s3cr3t';

for (const [code, failure, sentence] of [
  ['REQUEST_FAILED', (req) => { throw new Error(`connect refused to ${req.url}`); }, "Can't download this source's program right now. Try again later."],
  ['REDIRECT_REFUSED', (req) => { throw new PluginError('REDIRECT_REFUSED', `more than 5 redirects, ending at ${req.url}`, { url: req.url }); }, "Can't download this source's program right now. Try again later."],
  ['TIMEOUT', (req) => { throw new PluginError('TIMEOUT', `${req.url} ran out of time`, { url: req.url }); }, "Can't download this source's program right now. Try again later."],
  ['REQUEST_INVALID', (req) => { throw new PluginError('REQUEST_INVALID', `not a URL: ${req.url}`, { url: req.url }); }, "Can't download this source's program right now. Try again later."],
  ['HOST_NOT_ALLOWED', (req) => { throw new PluginError('HOST_NOT_ALLOWED', `${req.url} is not allowed`, { url: req.url }); }, "Can't download this source's program right now. Try again later."],
  // Past the host's cap (kangzj/lantern-tv#716): not a download to try again later.
  ['RESPONSE_TOO_LARGE', (req) => { throw new PluginError('RESPONSE_TOO_LARGE', `the response from ${req.url} was larger than the 16 MB a plugin may read`, { url: req.url }); }, "This source's program is too large to load."],
]) {
  test(`a program whose download fails with ${code} says ${sentence}, and its address stays out of it`, async () => {
    const { host, engine } = engineOver(tabs(), { className: 'one', ext: SIGNED_EXT, program: failure });

    const error = await engine.call('getCategories', []).then(() => null, (e) => e);

    assert.equal(error?.code, Code.UNAVAILABLE);
    assert.equal(error.message, sentence);
    assert.ok(
      host.logs.some((entry) => entry.message === `catalog one: its program could not be fetched (${code})`),
      JSON.stringify(host.logs),
    );
    for (const secret of ['catalogs.test', 's3cr3t']) {
      assert.ok(!error.message.includes(secret), error.message);
      assert.ok(host.logs.every((entry) => !entry.message.includes(secret)), `${secret} in ${JSON.stringify(host.logs)}`);
    }
  });
}

// Only the host's own codes are the download failing. Anything else is not ours to reword, so it
// goes out as it was: here a replay with no recording, which says so in its own words.
test('a program download that fails with something other than a host code is not called undownloadable', async () => {
  const { engine } = engineOver(tabs(), { className: 'one', ext: SIGNED_EXT, program: (req) => {
    throw new PluginError('NO_FIXTURE', `no recorded fixture for GET ${req.url}`, { url: req.url });
  } });

  const error = await engine.call('getCategories', []).then(() => null, (e) => e);

  assert.equal(error?.code, Code.NO_FIXTURE);
  assert.notEqual(error.message, "Can't download this source's program right now. Try again later.");
});

test('a catalog whose own request failed is logged by the host\'s code, not the URL it asked', async () => {
  // A failed fetch's message can name the URL, and a search's URL carries what the viewer
  // typed. The log reaches logcat in release builds (kangzj/lantern-tv#561).
  const { host, engine } = engineOver(tabs(`
async function search(ext) {
  ext = argsify(ext)
  await $fetch.get('https://s.test/search?key=s3cr3t-key&wd=' + encodeURIComponent(ext.text))
  return jsonify({ list: [] })
}`), { className: 'one', answer: () => { throw new Error('connect refused'); } });

  const error = await engine.call('search', ['私人搜索词']).then(() => null, (e) => e);

  assert.equal(error?.code, Code.UNAVAILABLE);
  const line = host.logs.find((entry) => entry.message.includes('answered badly'));
  assert.ok(line, JSON.stringify(host.logs));
  assert.match(line.message, /REQUEST_FAILED/);
  for (const secret of ['s.test', 's3cr3t-key', '私人搜索词', encodeURIComponent('私人搜索词')]) {
    assert.ok(!line.message.includes(secret), `${secret} in ${line.message}`);
  }
});

test('a catalog\'s own error keeps its message in the log', async () => {
  const { host, engine } = engineOver(tabs(`
async function search(ext) {
  throw new Error('their own words')
}`));

  await engine.call('search', ['画皮']).catch(() => {});

  assert.ok(
    host.logs.some((entry) => entry.message.includes('answered badly: their own words')),
    JSON.stringify(host.logs),
  );
});

test('a store that will not keep a catalog logs which catalog, not its address', async () => {
  // Past the store's key limit, so the write is refused. The key is the catalog's address,
  // which may be signed.
  const long = `https://catalogs.test/${'a'.repeat(1100)}.js?sig=s3cr3t-key`;
  const { host, engine } = engineOver(tabs(), { className: 'long', ext: long });

  assert.equal((await engine.call('getCategories', [])).length, 1);

  const line = host.logs.find((entry) => entry.message.startsWith('could not keep'));
  assert.ok(line, JSON.stringify(host.logs));
  assert.match(line.message, /catalog long/);
  assert.ok(!line.message.includes('catalogs.test'), line.message);
  assert.ok(!line.message.includes('s3cr3t-key'), line.message);
});

// ------------------------------------------------------------ what this handler may reach

test('a catalog reaches any public host, because hostsFromConfig is the feature', async () => {
  // The servers a catalog scrapes are named inside its own program, which no manifest can list.
  const { engine, transport } = engineOver(tabs('', `await $fetch.get('https://anywhere.test/page')`));

  await engine.call('getCategories', []);

  assert.ok(transport.calls.includes('https://anywhere.test/page'), transport.calls.join(' '));
});

test("the private floor still holds: a catalog does not reach the television's network", async () => {
  // Only a host the viewer typed passes, and here that is the public one `ext` is on.
  const { host, engine, transport } = engineOver(tabs('', `
    try { await $fetch.get('http://192.168.1.1/admin') } catch (e) { $print('refused ' + e.code) }
  `));

  await engine.call('getCategories', []);

  assert.ok(!transport.calls.includes('http://192.168.1.1/admin'), transport.calls.join(' '));
  assert.ok(host.logs.some((entry) => entry.message.endsWith('refused HOST_NOT_ALLOWED')), JSON.stringify(host.logs));
});

test('the manifest says what the install dialog and the lint rules read', () => {
  const manifest = loadManifest(dir);

  assert.deepEqual(manifest.handles, ['xptv-js']);
  assert.equal(manifest.provides, 'source-type');
  assert.deepEqual(manifest.allowedHosts, []);
  assert.equal(manifest.hostsFromConfig, true);
  assert.equal(manifest.runsFetchedCode, true);
  assert.equal(manifest.playbackTokens, true);
  // One entry is one source, so there is no second level to offer or fetch.
  assert.equal(manifest.catalogsAreRemote, undefined);
});

test('console reaches the log, and a catalog that logs through it still loads', async () => {
  const { host, engine } = engineOver(tabs(`
    console.log('a', 1)
    console.error('b', new Error('boom'))
  `, ''), { className: 'csp_c' });

  assert.equal((await engine.call('getCategories', [])).length, 1);
  const messages = host.logs.map((entry) => `${entry.level} ${entry.message}`);
  assert.ok(messages.some((m) => m === 'info [csp_c] a 1'), messages.join('\n'));
  assert.ok(messages.some((m) => m === 'warn [csp_c] b Error: boom'), messages.join('\n'));
});

test("a catalog may declare the names that are XPTV's globals, as its own", async () => {
  // `jpyy.js` opens with `let $config = argsify($config_str)`, legal at XPTV's global scope.
  const { engine } = engineOver(tabs(`
    let $config = argsify($config_str)
    const console = { log() {} }
    var createCheerio = 1
  `));

  assert.equal((await engine.call('getCategories', [])).length, 1);
});

test('$html reads a page, and an element is read again with a selector under it', async () => {
  const { engine } = engineOver(tabs(`
    const page = '<ul><li><a href="/a">A <b>1</b></a><img src="a.jpg"></li><li><a href="/b">B</a></li></ul>'
    const items = $html.elements(page, 'li')
    if (items.length !== 2) throw new Error('elements ' + items.length)
    if ($html.attr(items[0], 'a', 'href') !== '/a') throw new Error('attr')
    if ($html.text(items[0], 'a') !== 'A 1') throw new Error('text ' + $html.text(items[0], 'a'))
    if ($html.attr(items[1], 'img', 'src') !== '') throw new Error('missing attr')
    if ($html.text(page, 'li:last-child') !== 'B') throw new Error('text of a page')
    if ($html.text(page, 'table') !== '') throw new Error('no match')
  `));

  assert.equal((await engine.call('getCategories', [])).length, 1);
});

test('a header the host owns costs that header, not the request', async () => {
  const { engine, transport } = engineOver(tabs('', `
    await $fetch.get('https://s.test/a', { headers: {
      'Accept-Encoding': 'gzip', 'Sec-Fetch-Dest': 'video', 'User-Agent': 'ua', Referer: 'https://s.test/',
    } })
    await $fetch.post('https://s.test/b', { x: 1 }, { headers: { 'accept-encoding': 'gzip', 'Content-Type': 'application/json' } })
    await $fetch.get('https://s.test/c', { headers: { 'X-HTTP-Method-Override': 'TRACE', 'X-Method-Override': 'PUT' } })
  `));

  await engine.call('getCategories', []);

  const sent = (url) => transport.requests.find((req) => req.url === url).headers;
  assert.deepEqual(Object.keys(sent('https://s.test/a')).sort(), ['Referer', 'User-Agent']);
  assert.ok(!Object.keys(sent('https://s.test/b')).some((name) => name.toLowerCase() === 'accept-encoding'));
  // A method override is refused by its value, so one naming PUT goes out and one naming TRACE does not.
  assert.deepEqual(sent('https://s.test/c'), { 'X-Method-Override': 'PUT' });
});

test("the headers dropped are the host's forbidden ones, none more and none fewer", () => {
  const source = readFileSync(new URL('xptv-js-plugin.js', `file://${dir}`), 'utf8');
  const rules = JSON.parse(readFileSync(new URL('../conformance/request-rules.json', import.meta.url), 'utf8'));
  const listed = [...source.match(/const FORBIDDEN_HEADERS = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
  const prefixes = [...source.match(/FORBIDDEN_HEADER_PREFIXES = \[(.*?)\]/)[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);

  assert.deepEqual([...listed].sort(), [...rules.forbiddenHeaders].sort());
  assert.deepEqual(prefixes, rules.forbiddenHeaderPrefixes);
  const listOf = (name) => [...source.match(new RegExp(`const ${name} = \\[(.*?)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listOf('METHOD_OVERRIDE_HEADERS'), rules.methodOverrideHeaders);
  assert.deepEqual(listOf('FORBIDDEN_METHODS'), rules.forbiddenMethods);
});

test('an object body is a form when the catalog says so, and JSON otherwise', async () => {
  const { engine, transport } = engineOver(tabs('', `
    await $fetch.post('https://s.test/form', { device: 'a b&c', n: 1 }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    await $fetch.post('https://s.test/json', { device: 'a b' })
    await $fetch.post('https://s.test/text', 'd=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  `));

  await engine.call('getCategories', []);

  const bodyOf = (url) => transport.requests.find((req) => req.url === url).body;
  assert.equal(bodyOf('https://s.test/form'), 'device=a%20b%26c&n=1');
  assert.equal(bodyOf('https://s.test/json'), '{"device":"a b"}');
  assert.equal(bodyOf('https://s.test/text'), 'd=1');
});

test('respHeaders still has the members an object has', async () => {
  const { engine } = engineOver(tabs('', `
    const answer = await $fetch.get('https://s.test/members')
    if (!answer.respHeaders.hasOwnProperty('set-cookie')) throw new Error('hasOwnProperty')
    if (typeof String(answer.respHeaders) !== 'string') throw new Error('toString')
  `));

  assert.equal((await engine.call('getCategories', [])).length, 1);
});
