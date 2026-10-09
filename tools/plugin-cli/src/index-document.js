import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import JSZip from 'jszip';
import { bundlePlugin } from './bundle.js';
import { headerJson } from './header.js';
import { LATEST, OLDEST } from './contract-version.js';
import { readIndex, text } from './index-reader.js';
import { entryFile, loadManifest, typeNameSchema } from './manifest.js';


/** The same ceiling the app puts on a download, for the index and for each plugin. */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024;

const contract = (path) => JSON.parse(readFileSync(new URL(`../../../contracts/${path}`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(typeNameSchema);
const validate = ajv.compile(contract('index.schema.json'));

const SHA256_FRAGMENT = /#sha256=([0-9a-f]{64})$/i;

/** The address `publish-plugins.sh` gives a version: `<base>/<id>/<id>-<version>.zip`. */
export function versionedUrl(baseUrl, id, version) {
  return `${baseUrl.replace(/\/+$/, '')}/${id}/${id}-${version}.zip`;
}

/** The entry an index lists a built plugin under, in its `plugins` list. */
export function pluginEntry(manifest, url, sha256) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    provides: manifest.provides,
    ...(manifest.description ? { description: manifest.description } : {}),
    // So a repo can offer a type's handler without downloading every zip it lists.
    ...(manifest.handles?.length ? { handles: manifest.handles } : {}),
    url: `${url}#sha256=${sha256}`,
  };
}

/**
 * Bundles every plugin under [pluginsDir], or just the ids in [only], and lists each at its
 * versioned address. An id in [only] with no plugin is refused rather than left out, since a
 * publisher naming one it cannot find has the wrong list. Bundled into a directory of its own,
 * never the plugin's `dist/`, which is Gradle's output.
 */
export async function buildIndex({ pluginsDir, baseUrl, only }) {
  const plugins = [];
  const dirs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (only === undefined || only.includes(d.name)))
    .map((d) => join(pluginsDir, d.name))
    .filter((dir) => existsSync(entryFile(dir)))
    .sort();
  const missing = (only ?? []).filter((id) => !dirs.includes(join(pluginsDir, id)));
  if (missing.length > 0) throw new Error(`no plugin under ${pluginsDir} for ${missing.join(', ')}`);
  const outDir = mkdtempSync(join(tmpdir(), 'yonto-index-'));
  try {
    for (const dir of dirs) {
      const manifest = loadManifest(dir);
      const { sha256 } = await bundlePlugin({ dir, outDir });
      plugins.push(pluginEntry(manifest, versionedUrl(baseUrl, manifest.id, manifest.version), sha256));
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  return { plugins };
}

/**
 * What is wrong with [document] as an author wrote it, without fetching anything: the schema.
 * Somebody else's entries are held to nothing more, and what a reader only skips
 * ([pluginEntries]) is not a problem here.
 */
export function indexProblems(document) {
  const problems = [];
  if (!validate(document)) {
    for (const e of validate.errors) {
      // An `if`/`then` failure only restates the errors under it; an `anyOf` one the two arms'.
      if (e.keyword === 'if' || e.keyword === 'anyOf') continue;
      problems.push(`${e.instancePath || '/'} ${e.message}${e.params?.allowedValue !== undefined ? `: ${e.params.allowedValue}` : ''}`);
    }
  }
  return [...new Set(problems)];
}

/**
 * [document] as the app reads it, through `readIndex` (#648): every catalog entry it keeps,
 * what it skips and why, and each `plugins` entry as written, marked with whether a reader
 * offers it. One a reader passes over is still returned, so a check can fetch it too.
 * A list of repos is answered as `{ list }`, since it names no entries of its own.
 */
export function pluginEntries(document) {
  const read = readIndex(Buffer.from(JSON.stringify(document)));
  if (read.refused) return { refused: read.refused };
  if (read.list) return { list: read.list };
  const unclaimed = [...read.plugins];
  const plugins = (Array.isArray(document.plugins) ? document.plugins : []).map((plugin) => {
    const at = unclaimed.findIndex((offered) => offered.id === text(plugin?.id) && offered.url === text(plugin?.url));
    return { plugin, offered: at >= 0 && unclaimed.splice(at, 1).length === 1 };
  });
  return { entries: read.entries, skipped: read.skipped, plugins };
}

/**
 * Downloads one plugin entry and holds it to what the entry says: the sha256 in its `url`,
 * then the downloaded manifest's id, version and contract, which is the check the app makes
 * before anything reaches the install dialog. Answers the problems found, none when it holds.
 */
export async function entryProblems(plugin, fetchBytes) {
  const config = plugin ?? {};
  const where = config.id ?? '(no id)';
  // Refused before anything is fetched, as the app refuses it: no host runs a contract outside these.
  if (config.contractVersion < OLDEST || config.contractVersion > LATEST) {
    return [`${where}: the index says contractVersion ${config.contractVersion}, and no host runs a plugin outside ${OLDEST}–${LATEST}`];
  }
  const expected = SHA256_FRAGMENT.exec(config.url ?? '')?.[1]?.toLowerCase();
  if (!expected) return [`${where}: its url carries no #sha256=, so nothing could check the download`];
  let bytes;
  try {
    bytes = await fetchBytes(config.url.replace(/#.*$/, ''));
  } catch (error) {
    return [`${where}: couldn't fetch ${config.url.replace(/#.*$/, '')}: ${error.message}`];
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) return [`${where}: the index says sha256 ${expected}, the file is ${actual}`];

  let manifest;
  try {
    manifest = JSON.parse(headerJson(await sourceOf(bytes)));
  } catch (error) {
    return [`${where}: the file is not a plugin: ${error.message}`];
  }
  return ['id', 'version', 'contractVersion']
    .filter((field) => manifest[field] !== config[field])
    .map((field) => `${where}: the index says ${field} ${config[field]}, the plugin says ${manifest[field]}`);
}

async function sourceOf(bytes) {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return Buffer.from(bytes).toString('utf8');
  const file = (await JSZip.loadAsync(bytes)).file('source.js');
  if (!file) throw new Error('the zip holds no source.js');
  return file.async('string');
}

/** Fetches [url] with the app's ceiling on size, and stops reading as soon as it is passed. */
export async function fetchBounded(url, { maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timed out after 30 s')), 30_000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > maxBytes) {
        abort.abort();
        throw new Error(`over ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

/** A `#sha256=` on the index's own address, which pins the whole document. */
export function pinnedSha256(address) {
  return SHA256_FRAGMENT.exec(address)?.[1]?.toLowerCase() ?? null;
}
