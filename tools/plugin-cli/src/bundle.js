import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { entryFile, loadManifest } from './manifest.js';
import { headerTextOf } from './header.js';
import { buildPlugin } from './build.js';

export async function bundlePlugin({ dir, outDir }) {
  const manifest = loadManifest(dir);
  // Lifted off the entry file and re-prepended verbatim, because esbuild drops a leading
  // comment and because a plugin that imports still has one self-describing entry file.
  // Verbatim and not rebuilt from the parsed manifest: an author who laid theirs out a
  // particular way gets that file back, and for the plugins here — none of which
  // imports anything — the published artifact is then the entry file, which is the point
  // of #100. `loadManifest` above has already validated what it says.
  const header = headerTextOf(readFileSync(entryFile(dir), 'utf8'));
  const built = await buildPlugin(dir, { format: 'esm' });

  // JSZip stamps the current time into each entry by default, so two bundles of the same
  // input would otherwise hash differently — pinning it is what makes the published sha256
  // something a downloader can reproduce, not just a value recorded once. The zip format's
  // own DOS timestamp cannot represent anything before 1980 (JSZip packs
  // getUTCFullYear() - 1980 into an unsigned field), so the Unix epoch underflows and wraps
  // to a bogus date around 2098 instead of erroring — DOS_EPOCH is the earliest date the
  // format can actually hold.
  const DOS_EPOCH = new Date(Date.UTC(1980, 0, 1));
  const file = `${header}${built.outputFiles[0].text}`;

  const zip = new JSZip();
  // One entry, the same headered file: a zip is an inbound shim for whoever would rather
  // send one thing than paste one, and nothing past the door ever sees it. Two entries
  // would put the manifest in two places that can disagree about where a plugin may
  // reach, which is what the header was chosen to avoid.
  zip.file('source.js', file, { date: DOS_EPOCH });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  mkdirSync(outDir, { recursive: true });
  const jsPath = join(outDir, `${manifest.id}-${manifest.version}.js`);
  writeFileSync(jsPath, file);
  const zipPath = join(outDir, `${manifest.id}-${manifest.version}.zip`);
  writeFileSync(zipPath, bytes);

  return {
    jsPath,
    zipPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}
