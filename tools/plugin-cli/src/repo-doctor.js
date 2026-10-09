import { lookup as systemLookup } from 'node:dns';
import { Agent, fetch } from 'undici';
import { MAX_HOPS, floorRefuses, isRedirect, resolve } from './host/redirect.js';
import { hostOf } from './hostname.js';
import { typedHostOf } from './manifest.js';
import { DIALECT, REFUSAL, readIndex } from './index-reader.js';

/** The same bound the app puts on a plugin download, and the design on a repo's document. */
export const MAX_INDEX_BYTES = 1024 * 1024;
const INDEX_TIMEOUT_MS = 30_000;

// Three of kangzj/lantern-tv#572's disguised 仓s answer anything but an OkHttp agent with an
// HTML page, and FongMi's build sends this one.
export const INDEX_USER_AGENT = 'okhttp/5.5.0';

const DIALECT_NAMES = { [DIALECT.CANG]: '仓', [DIALECT.XPTV]: 'XPTV index', [DIALECT.YONTO]: 'Yonto index' };
const SKIPPED_NAMES = { spider: 'spider', type: 'unknown type number', address: 'no http(s) address', duplicate: 'duplicate key or plugin id', unknownType: 'unknown yontoType', plugin: 'plugin entry missing what an install needs' };
const LIST_SKIPPED_NAMES = { address: 'no http(s) address', duplicate: 'address named twice' };

/**
 * [url]'s body, following redirects, refused past [MAX_INDEX_BYTES] or [INDEX_TIMEOUT_MS].
 *
 * Every hop is under the private-address floor, as a television's fetch of a repo is: only
 * the host [url] was typed on passes it, so a repo on the open web that redirects into the
 * LAN is refused at that hop (docs/design/2026-09-23-the-app-reads-every-index.md, *Security*).
 * Only the host as written is under it; a name is fetched wherever it resolves. [lookup] is
 * `dns.lookup`'s shape.
 */
async function fetchIndex(url, timeoutMs, lookup) {
  const typedHost = typedHostOf(url);
  const dispatcher = new Agent({ connect: { lookup } });
  const signal = AbortSignal.timeout(timeoutMs);
  let hop = url.replace(/#.*$/, '');
  let response;
  for (let hops = 0; ; hops += 1) {
    const host = hostOf(hop);
    if (host === null) throw new Error(`not a URL: ${hop}`);
    if (floorRefuses(host, [typedHost])) {
      throw new Error(`${host} is a private address, and the repo's address does not name it`);
    }
    response = await fetch(hop, { headers: { 'User-Agent': INDEX_USER_AGENT }, redirect: 'manual', signal, dispatcher });
    if (!isRedirect(response.status)) break;
    await response.body?.cancel();
    if (hops === MAX_HOPS) throw new Error(`more than ${MAX_HOPS} redirects`);
    const next = resolve(hop, response.headers.get('location') ?? '');
    if (next === null) throw new Error(`HTTP ${response.status} to nowhere`);
    hop = next;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_INDEX_BYTES) throw new Error(`over ${MAX_INDEX_BYTES} bytes, the most a television reads`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * What the app would make of the repo at [url]: its dialect, the sources its entries would
 * become, the plugins it offers, and what it names that can't be either. `ok` is false when
 * nothing could be read, or when nothing in it could be a source or a plugin, because a repo
 * that adds nothing is the silent empty answer `doctor` exists to catch.
 */
export async function repoReport(url, { timeoutMs = INDEX_TIMEOUT_MS, lookup = systemLookup } = {}) {
  let bytes;
  try {
    bytes = await fetchIndex(url, timeoutMs, lookup);
  } catch (error) {
    return { ok: false, lines: [`✗ fetch             ${error.message}`] };
  }
  const lines = [`✓ fetch             ${bytes.length} bytes`];
  const read = readIndex(bytes);
  if (read.refused) {
    lines.push(`✗ read              ${read.refused === REFUSAL.TOO_MANY_ENTRIES ? 'names more entries than a television reads' : 'not an index: no plugins, sites, storeHouse or urls list once any disguise is taken off'}`);
    return { ok: false, lines };
  }
  if (read.list) return listReport(read.list, lines);
  const offers = read.entries.length > 0 || read.plugins.length > 0;
  lines.push(`${offers ? '✓' : '✗'} read              ${DIALECT_NAMES[read.dialect]}, ${read.named} named, ${read.entries.length} a source can be made of, ${read.plugins.length} plugins to install`);
  for (const entry of read.entries) {
    lines.push(`    ${entry.yontoType.padEnd(16)}${entry.name}${entry.key === entry.name ? '' : `  (${entry.key})`}`);
  }
  for (const plugin of read.plugins) {
    lines.push(`    ${'plugin'.padEnd(16)}${plugin.name}  (${plugin.id} ${plugin.version})`);
  }
  const skipped = Object.entries(read.skipped).filter(([, count]) => count > 0);
  if (skipped.length > 0) {
    lines.push(`· skipped           ${skipped.map(([why, count]) => `${count} ${SKIPPED_NAMES[why]}`).join(', ')}`);
  }
  return { ok: offers, lines };
}

/**
 * A 多仓 or 多线路 list: the repos it names, which the app offers to pick from. None is fetched
 * here, since real lists name thousands; `doctor` one of them to see what it would add.
 */
function listReport(list, lines) {
  lines.push(`${list.repos.length > 0 ? '✓' : '✗'} read              a list of repos, ${list.named} named, ${list.repos.length} to pick from`);
  for (const repo of list.repos) lines.push(`    ${repo.name}${repo.name === repo.url ? '' : `  (${repo.url})`}`);
  const skipped = Object.entries(list.skipped).filter(([, count]) => count > 0);
  if (skipped.length > 0) {
    lines.push(`· skipped           ${skipped.map(([why, count]) => `${count} ${LIST_SKIPPED_NAMES[why]}`).join(', ')}`);
  }
  return { ok: list.repos.length > 0, lines };
}
