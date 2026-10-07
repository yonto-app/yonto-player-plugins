# vendor

Hand-written source for the third-party JavaScript that runs inside a plugin's realm.

Nothing generated lives here. The bundles themselves are outputs, both git-ignored, for the
reason every other artefact in this repository is generated: a committed bundle goes stale
with nothing reporting it.

There are three, and two of them have a banner:

| library | banner | script | built to | reached as |
| --- | --- | --- | --- | --- |
| `cheerio/slim` | `banner.js` | `scripts/build-parser.mjs` | `build/parser/cheerio-slim.js` | `yonto.html.load` (v7), `yonto.xml.load` (v15) |
| `crypto-js` | `crypto-banner.js` | `scripts/build-crypto.mjs` | `build/crypto/crypto-js.js` | `yonto.cryptoJs()` (v9) |
| `jsencrypt` | none | `scripts/build-jsencrypt.mjs` | `build/jsencrypt/jsencrypt.js` | `yonto.jsEncrypt()` (v20) |

## banner.js

The `atob` inlined into the parser bundle.

`cheerio/slim`'s entity decoder holds its table base64-encoded and reaches for `atob`, then
for `Buffer`. The realm has neither — `conformance/globals.json` is the list — so without
this it throws while loading, not on the first entity it meets.

It sits in the **bundle's** scope rather than on the realm: the decoder closes over that
binding, and a plugin never gains a global it did not declare. Putting `atob` on the realm
would work too, and would be a new undeclared name in every plugin's world for one
library's benefit. `globals.json` is unchanged by any of this, and
`QuickJsGlobalSurfaceTest` re-records from a live runtime to prove it.

## crypto-banner.js

The random source inlined into the crypto bundle — **and it is `Math.random`, which is not
secure.** Read that file before relying on anything it makes possible.

`crypto-js` 4.2.0 needs random bytes for `lib.WordArray.random`, which is what generates a
salt when a plugin encrypts with a passphrase. It looks for `window.crypto`, `self.crypto`,
`globalThis.crypto`, `msCrypto` and Node's `randomBytes`, finds none in the realm, and
throws — 4.2.0 deliberately removed the `Math.random` fallback earlier versions had.
Yonto puts it back, which is Jasper's decision (2026-09-22, kangzj/yonto#410) and is
what makes the passphrase form of `AES.encrypt` work at all.

**So: never generate a key, a token, a nonce that must not repeat, or anything a viewer's
privacy rests on with it.** What makes it acceptable here is that nothing in Yonto's
threat model depends on a plugin's randomness — a plugin never sees the viewer's session,
and what a scraper encrypts is a request body for somebody else's API.

Supplied as `self` rather than `globalThis.crypto`, and the difference is the whole point:
`self` is a name the realm does not have and the bundle refers to once, in the probe above,
so shadowing it in the **bundle's** scope leaves `globals.json` untouched. Assigning
`globalThis.crypto` would be a new undeclared global in every plugin's world.
`QuickJsGlobalSurfaceTest` compiles this bundle and draws from
`lib.WordArray.random` before recording the surface, which is what makes that claim
enforced rather than asserted — it did not, for the length of #410's first draft, and a
review pass proved the gap by leaking `globalThis.crypto` past a green suite.

## jsencrypt

`jsencrypt` 3.5.4 (MIT) is the whole RSA class, 58 KB minified, built `--global-name=jsEncrypt` and re-exporting
`JSEncrypt` **under the name** `library`, for the reason `crypto-js` does.
It needs no banner: it guards every `window`, `self` and `navigator` it reads and falls back to `Math.random`, so it loads in the bare realm as it is, and its padding is no more secure than `crypto-js`'s random source.

## What is built from them

```sh
node tools/plugin-cli/scripts/build-parser.mjs
node tools/plugin-cli/scripts/build-crypto.mjs
node tools/plugin-cli/scripts/build-jsencrypt.mjs
```

`npm install` and `npm ci` run all three through the `prepare` hook, and Gradle's
`bundleParserAsset`, `bundleCryptoAsset` and `bundleJsEncryptAsset` run them again to put the results in the APK —
so a clone that has run one has them all, and the APK's copies and the CLI's are the
same bytes by construction rather than by anyone remembering.

Each Gradle task declares **its script, its banner and the lockfile** as inputs, and its
built file as an output. Both halves are load-bearing: without the banner among the inputs,
editing one of these files leaves the task UP-TO-DATE and the APK shipping the old bundle
(which `bundleCryptoAsset` did until review), and without the output declared, deleting the
built file leaves the task UP-TO-DATE with nothing able to restore it.

`cheerio/slim` 1.2.0, not the `cheerio` entry: the default one cannot bundle for a non-Node
platform, pulling `node:stream`, `undici`, `whatwg-mimetype` and — through
`whatwg-encoding` -> `iconv-lite` -> `safer-buffer` — `buffer`. 194 KB minified, 77 KB of
APK once the zip has had it.

`--format=iife --global-name=cheerio` because both hosts evaluate the bundle inside a
function — `new Function` on the first `yonto.html.load` or `yonto.xml.load` — so
`cheerio` is a local of that function and those two are the only ways to reach it.

`crypto-js` 4.2.0 is the whole library rather than a list of the algorithms anyone happens
to use today: 71 KB minified, 18 ms to compile once, and a plugin fetched at run time can
reach for any of it. It is built `--global-name=cryptoJs` for the same reason, and its entry
re-exports the library **under a name** (`export { default as library }`) because
`--global-name` hands the realm the module *namespace*: `export { default }` would make the
global `{ default: CryptoJS }` and both hosts would have to reach through `.default`.
