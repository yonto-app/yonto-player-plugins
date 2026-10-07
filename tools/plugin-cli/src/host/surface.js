import { readFileSync } from 'node:fs';

/**
 * Every function a host provides, as the dotted path a plugin calls it by.
 *
 * Read from `conformance/host-functions.json` rather than written here, because it is not
 * this host's list — it is the surface both hosts are held to, beside `globals.json` and
 * `host-api/expected.json` for the same reason. A list kept twice can be green on each side
 * while the two disagree. `src/contract-version.js` decides from it: which names exist is
 * what tells a call in a plugin's source apart from a typo, and so which `contractVersion`
 * that plugin may declare. A name missing here is a call nobody can place.
 *
 * `test/host.test.js` holds this host's live `yonto` to the file, and
 * `JsHostApiConformanceTest` holds the Android host's to the same, so a function added to
 * one host and not recorded is a red test rather than a record quietly wrong about a host.
 *
 * Only leaves are listed. `crypto` is a namespace, not something a plugin can call, so it
 * is not declarable — see the contract.
 *
 * `config` is a value rather than a function and is not listed either: a plugin reading it
 * on a host too old to have it gets `undefined`, which is not the failure this is about.
 */
/**
 * The surface members no host implements in its own language.
 *
 * There are four, and they are the same shape: `yonto.html.load` (version 7), its XML
 * twin `yonto.xml.load` (version 15, the same parser), `yonto.cryptoJs` (version 9) and
 * `yonto.jsEncrypt` (version 20).
 * Both hosts supply a third-party library to the realm as
 * *source* — an APK asset on the device, a built file here — and the realm compiles it on
 * first use and implements the member itself, because neither a cheerio object nor a
 * CryptoJS `WordArray` can cross the bridge to be implemented on the other side of it. So
 * the surface a plugin sees has members the host object does not, which is what this
 * names: `test/host.test.js` walks this host's own `yonto` and has to know to expect the
 * difference, while `JsHostApiConformanceTest` walks the realm's and does not.
 *
 * This said "the first of them and may be the only one" until kangzj/lantern-tv#410, which
 * is the entry worth keeping: the test of whether something belongs here is not that it is
 * a parser, it is that its return value is an object with methods rather than data.
 */
export const REALM_FUNCTIONS = Object.freeze(['html.load', 'xml.load', 'cryptoJs', 'jsEncrypt']);

export const HOST_FUNCTIONS = Object.freeze(
  JSON.parse(readFileSync(new URL('../../conformance/host-functions.json', import.meta.url), 'utf8')),
);
