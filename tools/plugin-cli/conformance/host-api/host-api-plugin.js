/* yonto-plugin
{
  "kind": "content-source",
  "id": "conformance",
  "name": "Conformance",
  "version": "1.2.0",
  "contractVersion": 21,
  "provides": "source-type",
  "allowedHosts": [
    "conformance.test"
  ],
  "configSchema": [
    {
      "id": "serverUrl",
      "label": "Server",
      "type": "url"
    }
  ]
}
*/
// Not a content source: a probe. Each key is one host-API behaviour, and its value is
// what a correct implementation returns. Any host claiming to run Yonto plugins must
// produce conformance/host-api/expected.json exactly.

// AES-128-CBC of the plaintext "lantern conformance" under the key/iv below, generated
// with node:crypto rather than hand-written — a wrong ciphertext throws on bad padding
// and looks like a host bug rather than a conformance failure.
const AES_VECTOR = 'j2NgbhsT93Q/b6Ips+gWYZFgI/Islkaa0uf3t7l2cB4=';

// The same key/iv, but of the 16-byte (one exact AES block, no PKCS7 tail) plaintext
// "lantern padding!" with the encrypting side's own padding turned off to match — this
// is what a `{ padding: false }` decrypt is for: a stream whose framing already strips
// padding before handing the plugin its ciphertext. Generated with node:crypto's
// `setAutoPadding(false)` on the encrypting cipher, never hand-written.
const AES_NO_PADDING_VECTOR = 'wfkxDuRsY6EEfy7UW4BKdA==';

// `\0raw:{"not":"json"}` in base64 — the device's own in-band marker, followed by
// something that parses. A host that signals "this value is already JSON" with a prefix
// on the value itself cannot tell one of its own markers from a string that merely
// begins with the same bytes, and hands back an object where the plugin asked for text.
// A leading NUL makes that unlikely rather than impossible: `yonto.text.decode` over a
// binary payload is one honest way to produce one.
const RAW_LOOKALIKE = 'AHJhdzp7Im5vdCI6Impzb24ifQ==';

/**
 * What a host must say about `yonto.installId()`, rather than what it answers.
 *
 * The value cannot be pinned the way a hash can: it identifies one source on one
 * television, so every host and every install answers differently on purpose. What both
 * hosts owe is the shape and the stability — a non-empty string, and the same one twice.
 */
function installIdShape() {
  const once = yonto.installId();
  const again = yonto.installId();
  if (typeof once !== 'string') return `not a string: ${typeof once}`;
  if (once.length === 0) return 'empty';
  return once === again ? 'stable' : 'changed between calls';
}

/**
 * What a host hands through as the viewer's chosen catalog — see the contract's "A source
 * that is several".
 *
 * Unlike `installId` this one *can* be pinned: it is the host repeating back what it was
 * configured with, so both hosts owe the same string, and a host that dropped it or turned
 * a missing pick into an empty one reads as a different answer here.
 */
function subSourceHandedIn() {
  const once = yonto.subSource();
  const again = yonto.subSource();
  if (once !== again) return 'changed between calls';
  return once === null ? 'null' : `${typeof once}:${once}`;
}

export default {
  async getCategories() {
    const gbk = 'x+zT4MTq'; // 庆余年 in GBK, base64
    const key = 'MDEyMzQ1Njc4OWFiY2RlZg==';   // "0123456789abcdef"
    const iv = 'ZmVkY2JhOTg3NjU0MzIxMA==';    // "fedcba9876543210"
    // A refusal is part of the contract here, so it has to be comparable rather than
    // thrown: the message is what both hosts must agree on.
    const refusal = (call) => {
      try {
        call();
        return 'no refusal';
      } catch (error) {
        return `refused: ${error.message}`;
      }
    };
    const ciphertext = AES_VECTOR;            // see Step 1b — generated, never guessed
    return [
      { id: 'config', name: JSON.stringify(yonto.config) },
      { id: 'md5', name: yonto.crypto.md5('abc') },
      // A string that starts with U+FEFF reaches the host whole (kangzj/lantern-tv#590).
      { id: 'md5LeadingBom', name: yonto.crypto.md5('\ufeffabc') },
      // An unpaired surrogate is one U+FFFD in the bytes, as TextEncoder writes it, never
      // the `?` Kotlin's encoder writes (kangzj/lantern-tv#600). A pair stays a pair.
      { id: 'md5LoneSurrogate', name: yonto.crypto.md5('a\ud800b') },
      { id: 'hmacSha256LoneSurrogate', name: yonto.crypto.hmacSha256(key, 'a\ud800b') },
      { id: 'base64EncodeLoneSurrogate', name: yonto.encoding.base64Encode('a\ud800b') },
      { id: 'base64EncodeTrailingHighSurrogate', name: yonto.encoding.base64Encode('a\ud83d') },
      { id: 'base64EncodeLoneLowSurrogate', name: yonto.encoding.base64Encode('\udc00b') },
      { id: 'base64EncodeReversedPair', name: yonto.encoding.base64Encode('\udc00\ud800') },
      { id: 'base64EncodeSurrogatePair', name: yonto.encoding.base64Encode('a\ud83d\ude00b') },
      { id: 'sha1', name: yonto.crypto.sha1('abc') },
      { id: 'sha256', name: yonto.crypto.sha256('abc') },
      { id: 'hmacSha256', name: yonto.crypto.hmacSha256(key, 'abc') },
      { id: 'base64', name: yonto.encoding.base64Encode('庆余年') },
      { id: 'base64Decode', name: yonto.encoding.base64Decode('5bqG5L2Z5bm0') },
      { id: 'hexToBase64', name: yonto.encoding.hexToBase64('4f4b') },
      { id: 'base64ToHex', name: yonto.encoding.base64ToHex('T0s=') },
      // Each lenient call site needs its own noncanonical case, or reverting that one call
      // to the strict decoder leaves the suite green off its siblings' coverage.
      { id: 'base64ToHexUrlSafe', name: yonto.encoding.base64ToHex('SGVsbG8-d29ybGQ_') },
      { id: 'base64ToHexWrapped', name: yonto.encoding.base64ToHex('T0\ns=') },
      // The spellings the two hosts used to disagree about. A JWT is URL-safe and unpadded
      // by definition, so a plugin decoding one passed `doctor` and threw on a television
      // (kangzj/lantern-tv#329). Pinned here because prose could not hold it.
      { id: 'base64UrlSafe', name: yonto.encoding.base64Decode('SGVsbG8-d29ybGQ_') },
      // Over-padded, not unpadded: `Base64.getDecoder()` always accepted a missing `=`,
      // so the unpadded case pinned nothing and the issue's table was wrong about it.
      { id: 'base64OverPadded', name: yonto.encoding.base64Decode('5bqG5L2Z5bm0====') },
      // The siblings. `yonto.text.decode` takes base64 too, and so do the crypto
      // arguments — all four were still on the strict decoder after the first pass, so
      // `text.decode('SGVsbG8-d29ybGQ_')` worked in the CLI and threw on a television,
      // which is kangzj/lantern-tv#329 verbatim on the function beside the one it fixed.
      { id: 'textDecodeUrlSafe', name: yonto.text.decode('SGVsbG8-d29ybGQ_', 'utf-8') },
      { id: 'hmacWrappedKey', name: yonto.crypto.hmacSha256('a2V5\nMTIz', 'abc') },
      { id: 'base64Wrapped', name: yonto.encoding.base64Decode('5bqG\n5L2Z\t5bm0') },
      // And the one where agreeing means both refusing: Node truncated, the device threw a
      // JVM class name, and a hex string that is not hex is a bug either way.
      { id: 'hexNotHex', name: refusal(() => yonto.encoding.hexToBase64('zz')) },
      { id: 'hexOddLength', name: refusal(() => yonto.encoding.hexToBase64('abc')) },
      // Hex is the strict half of this pair, so the edges are pinned rather than reasoned
      // about: a trailing newline is refused (JavaScript's `$` does not match before one,
      // which is worth holding still because a reader may assume it does), uppercase is
      // accepted, and empty is empty on both sides rather than an error on one.
      { id: 'hexTrailingNewline', name: refusal(() => yonto.encoding.hexToBase64('4f4b\n')) },
      { id: 'hexUppercase', name: yonto.encoding.hexToBase64('4F4B') },
      { id: 'hexEmpty', name: JSON.stringify(yonto.encoding.hexToBase64('')) },
      { id: 'gbk', name: yonto.text.decode(gbk, 'gbk') },
      { id: 'rawLookalike', name: yonto.encoding.base64Decode(RAW_LOOKALIKE) },
      { id: 'aes', name: yonto.crypto.aesCbcDecrypt(key, iv, ciphertext) },
      { id: 'aesNoPadding', name: yonto.crypto.aesCbcDecrypt(key, iv, AES_NO_PADDING_VECTOR, { padding: false }) },
      // The key, the IV and the ciphertext each go through the decoder separately, so each
      // is spelled in a way the strict decoder actually refuses — otherwise the case pins
      // nothing. Unpadded is not such a spelling: `Base64.getDecoder()` accepts it, so a
      // merely-unpadded key left that call site revertible with this suite still green.
      // These two carry no `+` or `/` to fold, so whitespace is what makes them refusable;
      // the ciphertext is url-safe as well.
      {
        id: 'aesNoncanonicalInputs',
        name: yonto.crypto.aesCbcDecrypt(
          'MDEyMzQ1Njc4 OWFiY2RlZg==',
          'ZmVkY2JhOTg3\tNjU0MzIxMA==',
          'j2NgbhsT93Q_b6Ips-gWYZFgI_Islkaa0uf3t7l2cB4'
        ),
      },
      { id: 'fetch', name: (await yonto.fetch('https://conformance.test/hello')).body },
      { id: 'setCookie', name: await cookies() },
      { id: 'headerNames', name: await headerNames() },
      { id: 'unknownEncoding', name: await unknownEncoding() },
      { id: 'allowlist', name: await allowlist() },
      { id: 'emptyUrl', name: await emptyUrl() },
      { id: 'redirect', name: await redirects() },
      { id: 'redirectPost', name: await redirectedPost() },
      { id: 'redirectRefused', name: await refusedRedirects() },
      { id: 'fetchBodyLoneSurrogate', name: await loneSurrogateBody() },
      { id: 'fetchUrlLoneSurrogate', name: await loneSurrogateUrl() },
      { id: 'html', name: parsesMarkup() },
      { id: 'htmlPseudos', name: jQueryPseudos() },
      { id: 'xml', name: parsesXml() },
      { id: 'cryptoJs', name: cryptoJsSurface() },
      { id: 'cryptoJsOnce', name: cryptoJsIsCompiledOnce() },
      { id: 'cryptoJsRandom', name: cryptoJsRandom() },
      { id: 'jsEncrypt', name: jsEncryptSurface() },
      { id: 'jsEncryptOnce', name: jsEncryptIsCompiledOnce() },
      { id: 'eval', name: directEval() },
      { id: 'indirectEval', name: indirectEval() },
      { id: 'newFunction', name: newFunction() },
      { id: 'compiledModule', name: compiledModule() },
      { id: 'installId', name: installIdShape() },
      { id: 'subSource', name: subSourceHandedIn() },
      { id: 'store', name: await storeRoundTrip() },
      { id: 'storeClear', name: await storeClearRoundTrip() },
      { id: 'storeLimits', name: await storeLimitsProbe() },
      { id: 'storeLoneSurrogate', name: await storeLoneSurrogate() },
      { id: 'storeTtl', name: await storeTtl() },
      { id: 'concurrency', name: await concurrent() },
      { id: 'sleep', name: await sleepResolves() },
      { id: 'log', name: logAccepts() },
      { id: 'partialAccepts', name: partialAccepts() },
      { id: 'now', name: clockIsTheHosts() },
      { id: 'errorNotFound', name: describeError(yonto.error.notFound('missing-id')) },
      { id: 'errorUnauthenticated', name: describeError(yonto.error.unauthenticated('session expired')) },
      { id: 'errorUnavailable', name: describeError(yonto.error.unavailable('site is down')) },
      { id: 'errorMisconfigured', name: describeError(yonto.error.misconfigured('the user id is blank')) },
      { id: 'errorUnreachable', name: describeError(yonto.error.unreachable('the site did not answer')) },
      { id: 'errorChallenged', name: describeError(yonto.error.challenged('https://site.test/list')) },
    ];
  },

  // Not one of the seven contract methods — `runConformance` calls this separately and
  // catches what comes out, to pin that a host honours a thrown value's `code` by
  // duck-typing rather than by checking it was built with `yonto.error.*`. See
  // contracts/content-source-http.md's Yonto plugin errors section.
  async raiseHandBuiltNotFound() {
    throw { code: 'NOT_FOUND', message: 'hand-built, not yonto.error.notFound()' };
  },
};

// The four compile shapes a loader reaches for, which no host may be assumed to have:
// QuickJS leaves `eval` and `Function` bound on the global while throwing
// `eval is not supported` unless the eval intrinsic was compiled in, so their presence in
// globals.json proves nothing. The XPTV loader (kangzj/lantern-tv#369) fetches somebody
// else's plugin over HTTP and has to turn that text into functions it can call, so a host
// missing any of these cannot run one.
function directEval() {
  return String(eval('20 + 21'));
}

// The indirect form is carried separately from the direct one because it evaluates in
// global scope rather than the caller's, which is how an XPTV plugin installs its globals.
// The `var` rather than an assignment to globalThis, which would land there under either
// form: a `var` declared by indirect eval becomes a property of the global object, and the
// same one under direct eval is local to this function and never read back.
function indirectEval() {
  (0, eval)('var __indirectEval = 7');
  return String(globalThis.__indirectEval);
}

function newFunction() {
  return String(new Function('a', 'b', 'return a + b;')(20, 22));
}

// The shape the loader actually uses, rather than the three constructs in isolation: wrap
// fetched text in a function of `module`, call it, and keep what it left behind. A host
// that compiles an expression but not a function body passes the three above and fails the
// only one that matters.
function compiledModule() {
  const fetched = "const NAME = 'fetched';\nmodule.exports = { title(id) { return NAME + ':' + id; } };";
  const module = { exports: {} };
  new Function('module', 'exports', fetched)(module, module.exports);
  return module.exports.title(7);
}

// The parser, over markup shaped like the listing pages the ecosystem actually scrapes.
// One string rather than a case per method, because these are one behaviour — a host
// either has cheerio in the realm or it does not — and a `|`-joined value names which
// part drifted as precisely as separate keys would.
//
// The methods pinned here are the ones the XPTV survey found in use across their plugins:
// load, find, attr, text, each, first, eq, html, map, length, toArray. The four jQuery
// pseudos are the case below, because a parser can have every method here and none of
// them.
const MARKUP = [
  '<div class="list">',
  '<article class="card" data-id="a1"><h2><a href="/one">One &amp; Only</a></h2><span class="tag">新</span></article>',
  '<article class="card" data-id="a2"><h2><a href="/two">Two</a></h2><span class="tag">热</span></article>',
  '<article class="card" data-id="a3"><h2><a href="/three">Three</a></h2></article>',
  '</div>',
  '<div class="notice">not a card</div>',
].join('');

function parsesMarkup() {
  const $ = yonto.html.load(MARKUP);
  const cards = $('article.card');
  const ids = [];
  cards.each((index, node) => ids.push(`${index}:${$(node).attr('data-id')}`));
  const titles = cards.map((_, node) => $(node).find('h2 a').text()).toArray();
  return [
    cards.length,
    ids.join(','),
    titles.join('/'),
    cards.first().find('a').attr('href'),
    cards.eq(1).find('.tag').text(),
    $('.notice').html(),
  ].join('|');
}

// `:first`, `:last`, `:eq(n)` and `:contains(text)` are jQuery's, not CSS's — cheerio
// implements them and a hand-rolled selector engine typically does not, which is the
// difference this case exists to catch.
function jQueryPseudos() {
  const $ = yonto.html.load(MARKUP);
  return [
    $('article:first').attr('data-id'),
    $('article:last').attr('data-id'),
    $('article:eq(1)').attr('data-id'),
    $('article:contains("Two")').attr('data-id'),
  ].join('|');
}

// XML mode (version 15), over the shapes that tell it from HTML mode: CDATA as text, a
// self-closing element that closes, a `>` inside a quoted attribute, an element nested in
// one of its own name, and `&nbsp;` left as written because XML does not define it.
const XML = [
  '<rss><list><video><name><![CDATA[甲 <b>乙</b>]]></name><pic/><type>剧</type>',
  '<dd flag="a>b">x?a=1&amp;b=2 &#x4e2d;&nbsp;</dd><video><name>内</name></video></video></list></rss>',
].join('');

function parsesXml() {
  const $ = yonto.xml.load(XML);
  const outer = $('video').first();
  return [
    outer.children('name').text(),
    outer.children('type').text(),
    $('dd').attr('flag'),
    $('dd').text(),
    $('video video').length,
  ].join('|');
}

// Real CryptoJS in the realm (version 9, kangzj/lantern-tv#410), pinned over the members a
// survey of 120 XPTV plugins actually reaches for rather than over the library's whole
// surface. The ones that matter here are the ones `yonto.crypto`'s five string
// primitives cannot express at all: `AES.encrypt`, ECB, and the `WordArray` and
// `CipherParams` objects — a facade would have had to fake those, and this case is what
// says the two hosts hand over the same library instead.
function cryptoJsSurface() {
  const C = yonto.cryptoJs();
  const key = C.enc.Utf8.parse('PBfAUnTdMjNDe6pL');
  const iv = C.enc.Utf8.parse('sENS6bVbwSfvnXrj');
  const cbc = C.AES.encrypt('the quick brown fox', key, { iv, mode: C.mode.CBC, padding: C.pad.Pkcs7 }).toString();
  const ecb = C.AES.encrypt('the quick brown fox', key, { mode: C.mode.ECB, padding: C.pad.Pkcs7 }).toString();
  const params = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(cbc) });
  return [
    C.MD5('hello').toString(),
    C.SHA1('hello').toString(),
    C.SHA256('hello').toString(),
    C.HmacSHA256('m', 'k').toString(),
    C.enc.Utf8.parse('abc').toString(),
    C.enc.Base64.stringify(C.enc.Utf8.parse('abc')),
    C.enc.Base64.parse('YWJj').toString(C.enc.Utf8),
    C.enc.Hex.parse('616263').toString(C.enc.Utf8),
    C.lib.WordArray.create([0x61626364]).toString(),
    cbc,
    C.AES.decrypt(cbc, key, { iv, mode: C.mode.CBC, padding: C.pad.Pkcs7 }).toString(C.enc.Utf8),
    ecb,
    C.AES.decrypt(ecb, key, { mode: C.mode.ECB, padding: C.pad.Pkcs7 }).toString(C.enc.Utf8),
    C.AES.decrypt(params, key, { iv, mode: C.mode.CBC, padding: C.pad.Pkcs7 }).toString(C.enc.Utf8),
  ].join('|');
}

// The library is one object per runtime, compiled on the first call and not again — the
// same laziness `yonto.html.load` has. Asserted because a host that rebuilt it per call
// would pass every case above and cost 18 ms each time.
function cryptoJsIsCompiledOnce() {
  return String(yonto.cryptoJs() === yonto.cryptoJs());
}

// JSEncrypt in the realm (version 20), pinned on what RSA can be held to on two hosts: a
// fixed private key decrypting a fixed ciphertext, the raw `getKey()` modular arithmetic a
// site that signs with its private key makes a plugin reach for, and a fresh key's encrypt
// and decrypt round trip, whose padding is random so only its outcome can be compared.
const RSA_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIICWgIBAAKBgEYWKo+T2dJBMiQ5lpG0/ops3IqZz/Ki3HVRxL785LHg28OC/slW\nto/hIwmhwi9BWjDeHdjx2D0Is9Jw04yF9GbGMG20xolHsN08ZVzVSmUj/sZ/YJ67\nXvRgmlfX4Z8DrMLg7sUrScVbpN87+CMoapTokKFV84S/6nb8Zz2fy7gXAgMBAAEC\ngYAb2zOPXXR13PPQ8hKmVwnUevAtJnVAOvrkpltMjbdX+8ddLfOWkqB9Dz6d1W0Y\n2yC9y4qRb45Cs/LE8ZMjhxpcVGwAL0TP1gyNCTCFcXZac6yCzIdLgAiQ73YBVfAE\nk719+7ieMnzMwyoNCWaILQOTFV4WiblirEhw97x329BWAQJBAIfsxCqlhoeGhY0f\nXbGlaEAcUuAyc4JuJytE3Yvu5sjNCn0Ui2HTOimyOKRtVEz/HkN/j63Rq9n/MTvc\n2fP49aUCQQCEAChT/Im4Vqf7Z9GEjPgS/ZeK9BC7kuo4aSA7vP6j5TT/TlWrAY74\nK7rX0lcoCpj+h4RfAzgigfF3IYJA0GILAkBYP1L48TCPirnobqXQ8Tfm77yqzHaM\nBuItSG+iKz/wvJaDsLPxlkbbzVbTAhxKRRQr9ISe8FLnnLQlTnS+3jL1AkAFZmA/\n90/G+7yJe1jF3GJ1nGwrogphMgRk5GAOMZAVMlY1r4WvpjOsEVXmaFNqbuyNVQvk\nOyR7vOcc4YELl7q7AkAgMxSr96S8r2dHWADPl39/RcHzSz5UqFa9MzwRxPrbHNuW\nEiNSEIfFE247elcyrx3kzYuzyChNqr5ed+FKyQh3\n-----END RSA PRIVATE KEY-----";
const RSA_CIPHERTEXT = "DWwz+j08HVmQTecWO0UmRldo5I0FeiweDhXG6QZkuQIzk1/XfnpcdpC88N3qaIkX71jVk53HEVJy1ZD8i/bpCzEFTFmkvLHBfXWa64rviWUHx81ccRbxHgyfh6lr4aHgxxVCUz5XDINKdwH7YZ3XY0k3I6ndRBeSbccaR4pnvSA=";

function jsEncryptSurface() {
  const J = yonto.jsEncrypt();
  const held = new J();
  held.setPrivateKey(RSA_PRIVATE_KEY);
  const key = held.getKey();
  const BigInteger = key.n.constructor;
  const signed = key.doPrivate(new BigInteger('2a', 16));
  const fresh = new J({ default_key_size: '512' });
  return [
    held.decrypt(RSA_CIPHERTEXT),
    key.doPublic(signed).toString(16),
    fresh.decrypt(fresh.encrypt('round trip')),
    typeof key.n.toString(16),
  ].join('|');
}

// One class per runtime, compiled on the first call, like cryptoJs above.
function jsEncryptIsCompiledOnce() {
  return String(yonto.jsEncrypt() === yonto.jsEncrypt());
}

// `WordArray.random` has no secure source in the realm and is backed by `Math.random`
// through the bundle's own banner (Jasper, 2026-09-22) — see vendor/crypto-banner.js for
// what that does and does not promise. Pinned on shape rather than on a value, which is
// the only thing randomness can be held to: the right length, and two draws that differ.
// The passphrase form is here because it is the one that reaches it internally, for a
// salt, and it threw on both hosts before the banner existed.
function cryptoJsRandom() {
  const C = yonto.cryptoJs();
  const first = C.lib.WordArray.random(16).toString();
  const second = C.lib.WordArray.random(16).toString();
  const encrypted = C.AES.encrypt('secret text', 'a passphrase').toString();
  return [
    first.length,
    String(first !== second),
    C.AES.decrypt(encrypted, 'a passphrase').toString(C.enc.Utf8),
  ].join('|');
}

// A host that fails to map its own `code` and `message` onto this shape has nowhere to
// hide: the engine (src/engines/quickjs.js) uses exactly these two fields to decide whether
// a thrown value is one of the four honoured codes or an ordinary METHOD_THREW.
function describeError(error) {
  return `${error.code}: ${error.message}`;
}

// One case, three facts: every Set-Cookie comes back whole and in order, the folded
// header a host that knew no better would offer is gone, and no other header was
// disturbed on the way past.
async function cookies() {
  const res = await yonto.fetch('https://conformance.test/cookies');
  return `${JSON.stringify(res.setCookie)}|${String(res.headers['set-cookie'])}|${res.headers['content-type']}`;
}

// A response's header names are lowercase whatever the server sent, so a plugin reads
// `headers['content-type']` rather than scanning for it — on both hosts, and through any
// transport (kangzj/lantern-tv#431).
async function headerNames() {
  const res = await yonto.fetch('https://conformance.test/mixed-case');
  return `${Object.keys(res.headers).sort().join(',')}|${res.headers['content-type']}`;
}

// A charset the host cannot decode with is refused before anything is sent, the same way
// on both hosts. The URL has no fixture, so a host that sent the request anyway would fail
// with something else (kangzj/lantern-tv#502).
async function unknownEncoding() {
  const said = (url) => yonto.fetch(url, { encoding: 'not-a-charset' })
    .then(() => 'fetched', (error) => `${error.code}: ${error.message}`);
  // And before the allowlist, so the two hosts cannot answer one request with two verdicts.
  return `${await said('https://conformance.test/never-asked')}|${await said('https://not-configured.test/ping')}`;
}

// A `url` field a viewer filled in widens the allowlist to that host and to no other.
// This is the only way a plugin can reach a server nobody could have named when it was
// written, and it must not become a way for a plugin to name one itself.
async function allowlist() {
  const configured = await yonto.fetch('https://configured.test/ping')
    .then((response) => response.body, (error) => `threw ${error.code}`);
  const neighbour = await yonto.fetch('https://not-configured.test/ping')
    .then(() => 'allowed', (error) => error.code);
  // A host is its name: the port is not part of it, and neither is the case it was
  // written in. A self-hosted server on :8096 is the whole point of a `url` field, so the
  // two hosts must not disagree about one.
  const ported = await yonto.fetch('https://CONFIGURED.test:8443/ping')
    .then((response) => response.body, (error) => `threw ${error.code}`);
  return `${configured}|${neighbour}|${ported}`;
}

// What a plugin builds out of a required config field nobody filled in. Both hosts have
// to say the same thing about it, and what they used to say was `not a URL: ` with
// nothing after the colon — a sentence that names neither the field nor the emptiness,
// printed once per step by `doctor` and read by an author as a broken plugin.
async function emptyUrl() {
  const said = (url) => yonto.fetch(url).then(() => 'allowed', (error) => `${error.code}: ${error.message}`);
  // Three spellings of the same mistake, because a blank config field is *absent* rather
  // than empty — so what a plugin interpolates is `undefined`, which is the spelling a
  // host is most likely to get wrong and the one neither host used to agree on.
  return `${await said('')}|${await said(undefined)}|${await said(123)}`;
}

// A 3xx is the host's to follow, not the transport's, so both ends agree on what comes
// back: the body from the last hop, the URL it came from, and a refusal when the chain
// leaves the hosts this plugin is allowed to reach.
async function redirects() {
  const followed = await yonto.fetch('https://conformance.test/moved');
  const manual = await yonto.fetch('https://conformance.test/moved', { redirect: 'manual' });
  const offAllowlist = await yonto.fetch('https://conformance.test/leaving')
    .then(() => 'allowed', (error) => error.code);
  return `${followed.body}|${followed.url}|${manual.status}|${manual.headers.location}|${offAllowlist}`;
}

// A POST redirected 302 continues as a GET with no body — and a fixture is identified by
// its URL and its body, so a host that carried either one over would find no fixture here.
// That is what makes this assert the method change rather than merely the final body.
async function redirectedPost() {
  const posted = await yonto.fetch('https://conformance.test/submit', { method: 'POST', body: 'q=1' })
    .then((response) => response.body, (error) => `threw ${error.code}`);
  const kept = await yonto.fetch('https://conformance.test/keep', { method: 'POST', body: 'q=1' })
    .then((response) => response.body, (error) => `threw ${error.code}`);
  return `${posted}|${kept}`;
}

// A redirect chain the host gives up on is its own code, never REQUEST_FAILED, which from
// yonto.fetch means only that a server did not answer: a loop, and a redirect to a scheme
// the host does not follow, and one to a URL that names no host. A chain that runs out of
// time is the same code and is not here, because nothing in expected.json may depend on a
// clock.
async function refusedRedirects() {
  const refused = (url) => yonto.fetch(url).then(() => 'followed', (error) => `${error.code}: ${error.message}`);
  return [
    await refused('https://conformance.test/loop'),
    await refused('https://conformance.test/to-ftp'),
    await refused('https://conformance.test/to-no-host'),
  ].join('|');
}

// A fixture is found by its URL and body as UTF-8, so each of these is found only when the
// host sent U+FFFD for the lone surrogate: `a\ufffdb` and `lone\ufffd` are what was recorded.
async function loneSurrogateBody() {
  return yonto.fetch('https://conformance.test/echo', { method: 'POST', body: 'a\ud800b' })
    .then((response) => response.body, (error) => `threw ${error.code}`);
}

// Through a relative redirect as well, which the host resolves against the URL it sent.
async function loneSurrogateUrl() {
  return yonto.fetch('https://conformance.test/lone\ud800/moved')
    .then((response) => `${response.body}|${response.url}`, (error) => `threw ${error.code}`);
}

async function storeRoundTrip() {
  await yonto.store.set('k', { n: 1 });
  const got = await yonto.store.get('k');
  await yonto.store.remove('k');
  return `${JSON.stringify(got)}|${JSON.stringify(await yonto.store.get('k'))}`;
}

// `clear` drops every key, not just the one named — a separate case from storeRoundTrip
// because a host that implemented `remove` and forgot `clear` would otherwise pass.
async function storeClearRoundTrip() {
  await yonto.store.set('sc-a', 1);
  await yonto.store.set('sc-b', 2);
  await yonto.store.clear();
  return `${JSON.stringify(await yonto.store.get('sc-a'))}|${JSON.stringify(await yonto.store.get('sc-b'))}`;
}

// The store's size, the same on both hosts (kangzj/lantern-tv#341): a value's JSON text up to
// 1 MiB and 256 keys per source, and a write past either refused as STORE_REFUSED. The numbers
// are written here rather than imported, because agreeing on them is the point. Cleared on the
// way out so no other case reads what this one wrote.
async function storeLimitsProbe() {
  const outcome = (write) => write.then(() => 'ok', (error) => error.code);
  const atCap = await outcome(yonto.store.set('sl-value', 'x'.repeat(1024 * 1024 - 2)));
  const overCap = await outcome(yonto.store.set('sl-value', 'x'.repeat(1024 * 1024 - 1)));
  await yonto.store.clear();
  for (let i = 0; i < 256; i += 1) await yonto.store.set(`sl-${i}`, i);
  const pastCount = await outcome(yonto.store.set('sl-one-more', 1));
  await yonto.store.clear();
  return `${atCap}|${overCap}|${pastCount}`;
}

// A key with a lone surrogate is refused, high or low half, on both hosts (kangzj/lantern-tv#611):
// the device's DataStore writes one as `?`, so `x\ud800` came back after a restart as `x?`, and
// answered a get for that other key. A pair is one character and is kept.
async function storeLoneSurrogate() {
  const outcome = (write) => write.then(() => 'ok', (error) => `${error.code}: ${error.message}`);
  const high = await outcome(yonto.store.set('ls\ud800', 1));
  const low = await outcome(yonto.store.set('ls\udc00', 1));
  const pair = await outcome(yonto.store.set('ls\ud83d\ude00', 2));
  const read = JSON.stringify(await yonto.store.get('ls\ud83d\ude00'));
  await yonto.store.clear();
  return `${high}|${low}|${pair}|${read}`;
}

// A ttl is seconds and may be fractional, measured against the frozen clock both hosts run this
// suite at: half a second is still live, a tenth of a millisecond is truncated to none (the
// device's expiry is a whole millisecond), the largest number is a long ttl rather than an
// overflow into the past, and the most negative one has already expired.
async function storeTtl() {
  const after = async (ttlSeconds) => {
    await yonto.store.set('st', 1, { ttlSeconds });
    return JSON.stringify(await yonto.store.get('st'));
  };
  const answers = [await after(0.5), await after(0.0001), await after(Number.MAX_VALUE), await after(-Number.MAX_VALUE)];
  await yonto.store.clear();
  return answers.join('|');
}

// Promise.all must resolve all three and preserve their order — ddys fetches every
// search result's poster this way and a 仓 fans out across its sites. Note there is
// deliberately no timing assertion here: expected.json has to be byte-identical on a
// Mac and on a television, so no case may derive its value from a clock.
async function concurrent() {
  const bodies = await Promise.all([
    yonto.fetch('https://conformance.test/a'),
    yonto.fetch('https://conformance.test/b'),
    yonto.fetch('https://conformance.test/c'),
  ]);
  return bodies.map((r) => r.body).join('');
}

// Only that the call is awaitable and resolves — expected.json has to be byte-identical
// everywhere, so this cannot assert how long it took, only that it is a real Promise
// rather than a host stub that returns a bare value `await` would also accept.
async function sleepResolves() {
  return String(await yonto.sleep(1));
}

// The clock belongs to the host, not to the engine: both suites run with one wound to a
// fixed instant, so a host answering from its own wall clock — or from QuickJS's Date.now(),
// which is what this exists to replace — reads as a different number here. `typeof` pins
// the other half, which is each bootstrap's own `Number(...)`: the value crosses the bridge
// as a string, and a host that stopped converting it would hand plugins something that
// compares wrong everywhere and looks right in a log.
function clockIsTheHosts() {
  const now = yonto.now();
  return `${typeof now}|${now}`;
}

// Only that the call is accepted with a (level, message) pair and returns nothing — what
// a host does with the line (tag it with the plugin id, write it to logcat) has no return
// value to pin, so it is asserted separately by test/host.test.js instead.
function logAccepts() {
  return String(yonto.log('info', 'conformance probe'));
}

// Only that the call takes a sentence, a blank one or something that is not one, and returns
// nothing. What a host keeps after a sequence of them is conformance/partial/calls.json's.
function partialAccepts() {
  return [yonto.partial('一号站没有回应。'), yonto.partial(''), yonto.partial(42), yonto.partial()]
    .map(String).join('|');
}
