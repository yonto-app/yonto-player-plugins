#!/usr/bin/env node
// Builds the markup parser the realm hands plugins as `yonto.html.load` and `yonto.xml.load`.
//
// Not committed, because a committed bundle is an artefact whose input nobody in this
// repository edits and whose staleness nothing reports — the same rule that keeps
// plugins/<id>/dist out of git. Run by `npm install`'s prepare hook so a clone of the CLI
// works, and by Gradle's BundleParserAsset so the APK's copy is an output of this script
// rather than of somebody's laptop.
//
// Idempotent and quick (about 10 ms): re-running it rewrites identical bytes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = dirname(dirname(fileURLToPath(import.meta.url)));

export const PARSER_FILE = join(cli, 'build', 'parser', 'cheerio-slim.js');

// `cheerio/slim`, not the `cheerio` entry: the default one cannot bundle for a
// non-Node platform, pulling node:stream, undici, whatwg-mimetype and — through
// whatwg-encoding -> iconv-lite -> safer-buffer — buffer.
export const PARSER_ENTRY = "export { load } from 'cheerio/slim';\n";

export function buildParser() {
  const entry = join(cli, 'build', 'parser', 'entry.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, PARSER_ENTRY);

  // The banner is committed source (vendor/banner.js) and the reason is written down
  // there: cheerio/slim's entity table is base64 and its decoder reaches for `atob`, then
  // for `Buffer`, and the realm has neither. It goes in the bundle's own scope, never on
  // the realm — conformance/globals.json is unchanged by any of this, and a plugin gains
  // no name it did not declare.
  const banner = readFileSync(join(cli, 'vendor', 'banner.js'), 'utf8');

  execFileSync(
    join(cli, 'node_modules', '.bin', 'esbuild'),
    [
      entry,
      '--bundle',
      '--format=iife',
      // The realm never sees this name: JsHostApi and the CLI's engine each evaluate the
      // bundle inside a function, so `cheerio` is a local of that function and
      // `yonto.html.load` and `yonto.xml.load` are the only ways to it.
      '--global-name=cheerio',
      '--target=es2020',
      '--minify',
      `--banner:js=${banner}`,
      `--outfile=${PARSER_FILE}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return PARSER_FILE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(buildParser());
}
