import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Code, PluginError } from './errors.js';
import { headerJson } from './header.js';
import { isPrivate } from './host/redirect.js';
import { hostOf, hostOfEntry } from './hostname.js';

const contract = (file) => JSON.parse(readFileSync(new URL(`../../../contracts/${file}`, import.meta.url), 'utf8'));

/** The one grammar for a Yonto type name, which `handles` and an index's `ext.yontoType` both $ref. */
export const typeNameSchema = contract('yonto-type-name.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
addFormats(ajv);
ajv.addSchema(typeNameSchema);
const validate = ajv.compile(contract('manifest.schema.json'));

export function validateManifest(manifest) {
  const valid = validate(manifest);
  if (valid) return { valid: true, errors: [] };
  const errors = validate.errors.map((e) => ({
    path: e.instancePath || '/',
    message: (e.instancePath ? `${e.instancePath} ${e.message}` : e.message) + detailOf(e),
  }));
  return { valid: false, errors };
}

/** What Ajv's sentence leaves out: which key, and what would have been accepted. */
function detailOf(e) {
  const { missingProperty, additionalProperty, allowedValues, allowedValue } = e.params ?? {};
  if (missingProperty) return `: ${missingProperty}`;
  if (additionalProperty) {
    const near = nearestKey(additionalProperty, Object.keys(e.parentSchema?.properties ?? {}));
    return `: ${additionalProperty}` + (near ? ` (did you mean ${near}?)` : '');
  }
  if (allowedValues) return `: ${allowedValues.join(', ')}`;
  if (e.keyword === 'const') return `: ${allowedValue}`;
  if (e.keyword === 'pattern' && e.parentSchema?.description) return ` — ${e.parentSchema.description}`;
  return '';
}

const NEAR_ENOUGH = 2;

function nearestKey(key, known) {
  const typed = key.toLowerCase();
  const scored = known.map((name) => ({ name, distance: editDistance(typed, name.toLowerCase()) }));
  const best = scored.sort((a, b) => a.distance - b.distance)[0];
  return best && best.distance <= NEAR_ENOUGH && best.distance * 2 < key.length ? best.name : null;
}

// Two neighbouring letters swapped count as one edit, so `tpye` is as near `type` as `typ` is.
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * A plugin's entry file, which since kangzj/lantern-tv#100 is the whole plugin.
 *
 * Named for the plugin and sitting at the top of its own directory, so a tab bar, a stack
 * frame and a grep hit all say which plugin they are about — four plugins all called
 * `src/source.js` said nothing (kangzj/lantern-tv#197). Derived from the directory name
 * rather than from the manifest's `id`, because the manifest lives in this file's own
 * header: anything that had to read the id to find the file could never open it.
 */
export function entryFile(dir) {
  // Resolved first: `.` is the directory an author is standing in, and `basename('.')` is
  // not its name (kangzj/lantern-tv#490).
  return join(dir, `${basename(resolve(dir))}-plugin.js`);
}

/**
 * The manifest in the entry file's own header.
 *
 * One file, read as text: see `header.js` for why the manifest is a comment rather than an
 * export, and `contracts/README.md` for who else reads it.
 */
export function loadManifest(dir) {
  const file = entryFile(dir);
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `${file} could not be read — a plugin is that file: ${cause.message}`, { file });
  }

  let parsed;
  try {
    parsed = JSON.parse(headerJson(source));
  } catch (cause) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `${file}'s yonto-plugin header is not a manifest: ${cause.message}`, { file });
  }
  const { valid, errors } = validateManifest(parsed);
  if (!valid) {
    throw new PluginError(Code.MANIFEST_INVALID, `${file} is not a valid manifest`, { file, errors });
  }
  return { configSchema: [], capabilities: [], ...parsed };
}

/** The one `configSchema` type that widens the allowlist. */
export const FIELD_TYPE_URL = 'url';

/** A field whose value has to be one of the options its own manifest lists. */
export const FIELD_TYPE_CHOICE = 'choice';

/** A plugin that is a source, rather than a kind of source. See `provides` in the schema. */
export const PROVIDES_SOURCE = 'source';

/** A `bool` is never unanswered: see `unanswerableFields`. */
const FIELD_TYPE_BOOL = 'bool';

/**
 * The `configSchema` fields a viewer has to answer before this plugin can run at all —
 * required, with no `default` standing in for one.
 *
 * The same set `requireConfig` refuses to run without here and `PluginConfigForm.validate`
 * refuses to save without on a device. `lint` reads it to hold `provides` to its word:
 * a plugin claiming to be a source is one an install can add having asked nothing, so a
 * field in here says it is not.
 *
 * A `bool` never belongs in it, whatever it declares. It is one of two strings and a form
 * has no third thing to show, so `PluginConfigForm.normalize` answers `'false'` for one
 * nobody touched and `validate` cannot return `MissingRequired` for it — a required bool
 * with no default installs exactly as `provides: "source"` promises. Judging it by its
 * `default` alone refused a plugin whose install works, on its author's machine, leaving
 * them to drop `required` or write `source-type` and mean neither.
 */
export function unanswerableFields(manifest) {
  return (manifest.configSchema ?? [])
    .filter((field) => field.type !== FIELD_TYPE_BOOL)
    .filter((field) => field.required && !(field.default ?? '').trim());
}

/**
 * The hosts a plugin may reach, and who said so.
 *
 * The manifest's own list, plus the host of every `url` field the viewer filled in. That
 * is the only way a plugin can reach a server nobody could have named when it was
 * written — a Jellyfin, an Emby, someone's own MacCMS box all live at a hostname only
 * their owner knows.
 *
 * Kept apart rather than flattened, because the private-address floor turns on which of
 * the two named a host: a plugin may not reach the television's own network because its
 * manifest asked to, and a viewer typing an address is the whole exception. A `url` field
 * carrying a `default` is the manifest asking — the editor seeds the form with it and a
 * viewer who taps Save has typed nothing — so a stored value equal to the default counts
 * as the manifest's. See contracts/content-source-http.md's "The private-address floor".
 *
 * A plugin cannot widen this by itself: it declares that it has a server field, and a
 * person decides what goes in it. The host contributed is the URL's host exactly — no
 * wildcard, no suffix — so filling in `https://media.example.com:8096/jellyfin` reaches
 * `media.example.com` and nothing else, on any port.
 *
 * A catalog's values have a third author. `origin` is given for one, `{ viewerTyped, repoUrl }`:
 * the keys the viewer typed are theirs whatever the default says, and every other `url` value
 * is `fromRepo`, a repo's or the migration's. That widens the allowlist to exactly its host and
 * does not open the floor, except on the host the viewer typed as the repo's address
 * (`repoUrl`, before any redirect). So a home server's repo can name catalogs on that server
 * and cannot name the router.
 *
 * `fromManifest` holds what the manifest wrote, a `*.` wildcard entry included, so it is
 * matched rather than compared. `fromViewer` and `fromRepo` hold canonical hosts only, and
 * `floorExempt` is the hosts the floor lets through, which is why it can compare one against
 * a request's host directly.
 *
 * Mirrors `PluginManifest.hostsWith`; `conformance/private-floor` holds both to it.
 */
export function hostsWith(manifest, config = {}, origin = null) {
  const named = (manifest.configSchema ?? [])
    .filter((field) => field.type === FIELD_TYPE_URL)
    // The stored value is a URL, because that is what the editor saves; the `default` is
    // written as a host, because that is what an author types. Hosts are compared, not the
    // strings — the stored value has been through `SourceUrl.normalize`, which fills in a
    // missing scheme, so a manifest seeding `192.168.1.1:8080` is saved as
    // `http://192.168.1.1:8080` and a raw comparison would call the manifest's own default a
    // viewer's word. That is the floor defeated by a spelling, one layer up from #92.
    .map((field) => ({ host: hostOf(config[field.id]), namer: namerOf(field, config, origin) }))
    .filter((entry) => entry.host !== null);
  const namedBy = (namer) => named.filter((e) => e.namer === namer).map((e) => e.host);

  const fromManifest = [...manifest.allowedHosts, ...namedBy('manifest')];
  const fromViewer = namedBy('viewer');
  const fromRepo = namedBy('repo');
  const typedRepoHost = origin?.repoUrl ? typedHostOf(origin.repoUrl) : null;
  const floorExempt = [...fromViewer, ...fromRepo.filter((host) => host === typedRepoHost)];
  // Deduplicated, because this is the list a refusal prints and a manifest that names a
  // host in `allowedHosts` *and* seeds it as a `url` default — which ddys and iyingshi
  // both do — would otherwise tell an author `[ddys.app, ddys.app]`.
  const all = [...new Set([...fromManifest, ...fromViewer, ...fromRepo])];
  return { fromManifest, fromViewer, fromRepo, floorExempt, all };
}

/**
 * The typed host of a repo: the canonical host of the address the viewer typed, before any
 * redirect, or null when it names none. Mirrors `PrivateFloor.typedHostOf`;
 * `conformance/repo-typed-hosts.json` holds both to one answer per spelling.
 */
export function typedHostOf(repoUrl) {
  return hostOfEntry(repoUrl);
}

function namerOf(field, config, origin) {
  if (origin === null) return hostOf(config[field.id]) === hostOfEntry(field.default ?? '') ? 'manifest' : 'viewer';
  return (origin.viewerTyped ?? []).includes(field.id) ? 'viewer' : 'repo';
}

/**
 * Whether any host this plugin could ever be asked for would satisfy this `allowedHosts`
 * entry — or, put the other way, whether the entry is dead.
 *
 * The schema's pattern (`^(\\*\\.)?[a-z0-9.-]+$`) accepts plenty of strings that are not
 * hosts, and `hostAllowed` compares canonical forms, so an entry that canonicalises to
 * nothing matches nothing. A request's host is never null, so it cannot match by accident
 * either: the plugin is simply refused at every fetch, and the refusal prints the entry
 * that was supposed to permit it.
 *
 * A `*.` entry is judged by what it can match rather than by its suffix alone, the same way
 * `namesPrivateAddress` judges one — `hostAllowed` accepts by `host.endsWith('.' + suffix)`,
 * so `*.1.1` genuinely matches `192.168.1.1` even though `1.1` alone canonicalises to
 * `1.0.0.1`. A numeric suffix is the tail of some dotted quad when it has at most three
 * parts and every part is an octet; anything longer or larger is the tail of no address,
 * and no name can end in it either, because a host ending in a number is read as an address
 * or as nothing.
 */
const OCTET = /^(0|[1-9][0-9]{0,2})$/;

export function canMatchAHost(entry) {
  const written = String(entry).trim().toLowerCase();
  if (!written.startsWith('*.')) return hostOfEntry(written) !== null;

  const suffix = written.slice(2).replace(/\.$/, '');
  if (suffix === '') return false;
  if (/^[0-9.]+$/.test(suffix)) {
    const parts = suffix.split('.');
    // Decimal and without a leading zero, because that is the only spelling a canonical
    // host is ever written in — `hostOf` rebuilds a dotted quad out of the numbers, so
    // `192.168.0.01` comes back as `192.168.0.1` and ends in `.1`, never in `.01`.
    return parts.length <= 3 && parts.every((part) => OCTET.test(part) && Number(part) <= 255);
  }
  return hostOfEntry(`a.${suffix}`) !== null;
}

/**
 * Whether an `allowedHosts` entry names, or can match, an address on the viewer's own
 * network.
 *
 * Put through `hostOf` before it is classified, because a private address has many
 * spellings and `isPrivate` only knows the canonical one: `127.1`, `2130706433`,
 * `0x7f000001` and `0177.0.0.1` are all loopback.
 *
 * A `*.` entry is judged by what it can *match*, not by what its suffix parses to —
 * `hostAllowed` accepts a wildcard by `host.endsWith('.' + suffix)`, so `*.1.1` matches
 * `192.168.1.1` while its suffix alone normalises to the public-looking `1.0.0.1`. Any
 * suffix that is only digits and dots is the tail of some IPv4 address and therefore of
 * some private one, so it is named. That over-reports on a suffix nobody would register as
 * a domain, which is the safe direction for this.
 *
 * The literal a manifest wrote, never a name resolved to an address: `lan.example.com` with
 * an A record on the LAN is not caught and is not meant to be. The claim is that a plugin
 * cannot *name* a private address, not that it cannot reach one.
 */
export function namesPrivateAddress(entry) {
  const written = String(entry).trim().toLowerCase().replace(/\.$/, '');
  if (written.startsWith('*.')) {
    const suffix = written.slice(2);
    // Only digits and dots is the tail of some IPv4 address, and therefore of a private one.
    if (/^[0-9.]+$/.test(suffix)) return true;
    // Otherwise judged by a host it would match rather than by the suffix alone, so that
    // `*.local` is read as the mDNS name it admits rather than as the word "local".
    return namesPrivateAddress(`a.${suffix}`);
  }
  if (written === 'localhost' || written.endsWith('.localhost') || written.endsWith('.local')) return true;
  const host = hostOfEntry(written);
  return host !== null && isPrivate(host);
}
