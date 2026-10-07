#!/usr/bin/env node
// Builds the RSA library the realm hands plugins as `yonto.jsEncrypt`.
//
// The sibling of scripts/build-crypto.mjs, for the same reasons: not committed, because a
// committed bundle is an artefact whose input nobody here edits and whose staleness nothing
// reports. Run by `npm install`'s prepare hook so a clone of the CLI works, and by Gradle's
// BundleJsEncryptAsset so the apps' copy is an output of this script.
//
// Idempotent and quick: re-running it rewrites identical bytes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = dirname(dirname(fileURLToPath(import.meta.url)));

export const JSENCRYPT_FILE = join(cli, 'build', 'jsencrypt', 'jsencrypt.js');

export const JSENCRYPT_ENTRY = "export { JSEncrypt as library } from 'jsencrypt';\n";

export function buildJsEncrypt() {
  const entry = join(cli, 'build', 'jsencrypt', 'entry.js');
  mkdirSync(dirname(entry), { recursive: true });
  // Re-exported under a name, for the reason build-crypto.mjs gives: `--global-name` hands
  // over the module namespace, and neither host should have to reach through `.default`.
  writeFileSync(entry, JSENCRYPT_ENTRY);

  execFileSync(
    join(cli, 'node_modules', '.bin', 'esbuild'),
    [
      entry,
      '--bundle',
      '--format=iife',
      // A local of the function each host evaluates the bundle in, so `yonto.jsEncrypt` is
      // the only way to it.
      '--global-name=jsEncrypt',
      '--target=es2020',
      '--minify',
      `--outfile=${JSENCRYPT_FILE}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return JSENCRYPT_FILE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(buildJsEncrypt());
}
