#!/usr/bin/env node
// Builds the crypto library the realm hands plugins as `yonto.cryptoJs`.
//
// The sibling of scripts/build-parser.mjs, for the same reasons in the same words: not
// committed, because a committed bundle is an artefact whose input nobody in this
// repository edits and whose staleness nothing reports. Run by `npm install`'s prepare
// hook so a clone of the CLI works, and by Gradle's BundleCryptoAsset so the APK's copy is
// an output of this script rather than of somebody's laptop.
//
// Idempotent and quick (about 10 ms): re-running it rewrites identical bytes.
//
// It carries a banner for the same kind of reason the parser does, and vendor/crypto-banner.js
// says what it is and why at length: `crypto-js` bundles for a neutral platform untouched,
// but `lib.WordArray.random` has no source of randomness in the realm and throws. Measured
// on 2026-09-22 for kangzj/lantern-tv#410: 72,789 bytes minified against cheerio's 281,645,
// loading in 15 ms against its 44.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = dirname(dirname(fileURLToPath(import.meta.url)));

export const CRYPTO_FILE = join(cli, 'build', 'crypto', 'crypto-js.js');

export const CRYPTO_ENTRY = "export { default as library } from 'crypto-js';\n";

export function buildCrypto() {
  const entry = join(cli, 'build', 'crypto', 'entry.js');
  mkdirSync(dirname(entry), { recursive: true });
  // The whole library rather than a list of the algorithms their plugins happen to use.
  // The survey on kangzj/lantern-tv#410 is what a conformance case pins, not what the
  // implementation covers — a plugin fetched at run time can reach for any of it, and this
  // costs 72 KB to be wrong about nothing.
  //
  // Re-exported under a name rather than as the default, because `--global-name` gives the
  // realm the module *namespace* and not the module's value: `export { default }` would
  // make the bundle's global `{ default: CryptoJS }`, so both hosts would have to reach
  // through `.default` and one of them would eventually forget. The parser has the same
  // shape and hides it by exporting `load` by name; this says it out loud.
  writeFileSync(entry, CRYPTO_ENTRY);

  // Committed source, and the reason is written down in it: crypto-js needs a random
  // source for `WordArray.random` and the realm has none. It goes in the bundle's own
  // scope, never on the realm, so conformance/globals.json is untouched by any of this.
  const banner = readFileSync(join(cli, 'vendor', 'crypto-banner.js'), 'utf8');

  execFileSync(
    join(cli, 'node_modules', '.bin', 'esbuild'),
    [
      entry,
      '--bundle',
      '--format=iife',
      // The realm never sees this name: JsHostApi and the CLI's engine each evaluate the
      // bundle inside a function, so `cryptoJs` is a local of that function and
      // `yonto.cryptoJs` is the only way to it.
      '--global-name=cryptoJs',
      '--target=es2020',
      '--minify',
      `--banner:js=${banner}`,
      `--outfile=${CRYPTO_FILE}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return CRYPTO_FILE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(buildCrypto());
}
