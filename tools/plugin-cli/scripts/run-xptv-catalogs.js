#!/usr/bin/env node
// Runs real XPTV plugins through plugins/xptv-js, to see whether their code still works here.
//
// Opt-in and not part of `npm test`, because it goes to the network and `npm test` must pass
// with wifi off. Nothing it downloads is written to disk.
//
// **Their plugins are deliberately not committed.** `fangkuia/XPTV` carries no licence and
// no LICENSE file, so its files are all-rights-reserved and a public repository is not where
// they belong. `tools/plugin-cli/test/xptv-js-catalogs.test.js` holds the suite, with catalogs
// written for it — which also reach what no working plugin demonstrates, like `loadJSEncrypt`
// refusing. This script is the other half: proof that real, unmodified plugins run, kept as
// something anybody can re-run in one command rather than a paragraph in AGENTS.md.
//
// NOT under test/: node --test's default patterns include **/test/**/*.js.
//
//   node tools/plugin-cli/scripts/run-xptv-catalogs.js [name ...]

import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { scratchDir } from '../src/scratch-dir.js';

const dir = fileURLToPath(new URL('../../../plugins/xptv-js/', import.meta.url));
const RAW = 'https://raw.githubusercontent.com/fangkuia/XPTV/main/js';

// One scraper, one that reaches for CryptoJS and a jQuery pseudo, one that is search-only.
// All three call `createCheerio()` or `createCryptoJS()` at module scope, so loading them
// exercises those shims before an entry point is called.
const DEFAULT = ['ddys.js', 'czzy.js', 'tianyiso.js'];

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function run(name) {
  const ext = `${RAW}/${name}`;
  const source = await fetch(ext).then((r) => {
    if (!r.ok) throw new Error(`${ext} answered HTTP ${r.status}`);
    return r.text();
  });
  const transport = {
    async request(req) {
      if (req.url === ext) return { status: 200, headers: {}, bodyBase64: b64(source) };
      // Anything else the catalog asks for during load. It is not served the real site:
      // what this checks is that their code runs, not that their site is up.
      //
      // A cookie comes back because `bdys.js` opens by reading one off its first response and
      // putting it on the next, and `[][0].split(...)` is a throw rather than an empty
      // listing — a scripted transport that answered none would report their code as broken
      // for a reason that is this file's (kangzj/lantern-tv#426).
      return { status: 200, headers: {}, setCookie: ['SESSION=stub; Path=/'], bodyBase64: b64('') };
    },
  };
  const host = createHost({
    manifest: loadManifest(dir),
    config: { ext, className: 'csp_x' },
    transport,
    storeDir: scratchDir('xptv-catalogs-'),
    pluginDir: dir,
  });
  const categories = await createEngine({ dir, host }).call('getCategories', []);
  return categories.map((category) => category.name);
}

const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT;
let failed = 0;
for (const name of names) {
  try {
    const categories = await run(name);
    console.log(`✓ ${name.padEnd(16)} ${categories.length} categories — ${categories.slice(0, 6).join(' / ')}`);
  } catch (error) {
    failed = 1;
    console.log(`✗ ${name.padEnd(16)} ${error?.message ?? error}`);
  }
}
process.exit(failed);
