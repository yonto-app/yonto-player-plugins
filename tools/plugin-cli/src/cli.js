#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { clearanceFromEnv } from './host/clearance.js';
import { undrivenLoginWarnings } from './host/credential.js';
import {
  browserCheckRefusals, challengeAware, challengeHints, noticingChallenges, raisesUndeclaredChallenge,
} from './browser-check.js';
import { LINK_LOGIN, SERVICES, linkLoginOf, linkLoginRefusals, linkRecord } from './link-login.js';
import { checkLink, exportLine, learningHostSecrets, runLink } from './link.js';
import { createSecrets } from './host/mask.js';
import { hostClientIdOf } from './host/session.js';
import { FIELD_TYPE_URL, PROVIDES_SOURCE, canMatchAHost, entryFile, loadManifest, namesPrivateAddress, unanswerableFields } from './manifest.js';
import { hostOf } from './hostname.js';
import { Code, PluginError } from './errors.js';
import { createHost } from './host/index.js';
import { createLiveTransport } from './transport/live.js';
import { createRecordTransport } from './transport/record.js';
import { createReplayTransport } from './transport/replay.js';
import { createEngine } from './engines/quickjs.js';
import { scratchDir } from './scratch-dir.js';
import { validateResult } from './contract.js';
import { runDoctor } from './doctor.js';
import { partialShown } from './partial.js';
import { formatReport } from './format.js';
import { bundlePlugin } from './bundle.js';
import { buildPlugin, bundleRoot } from './build.js';
import { configOf } from './config.js';
import { contractVersionOf, LATEST, OLDEST } from './contract-version.js';
import { handlesRefusals } from './yonto-types.js';
import { repoReport } from './repo-doctor.js';
import { initPlugin, templateNames } from './init.js';
import { METHODS, OPTIONAL_METHODS } from './contract.js';
import { createHash } from 'node:crypto';
import {
  buildIndex, entryProblems, fetchBounded, indexProblems, pinnedSha256, pluginEntries,
} from './index-document.js';

const RESERVED_ID = 'index';

const USAGE = `yonto-plugin <command> [options]

  init <id> [--template <name>] [--name <display name>]
                                a new plugin in ./<id>, from a template (templates: ${templateNames().join(', ')};
                                default blank)
  lint [dir]                    validate the header's manifest and the code under it, no network
  run [dir] <method> [args...]  call one method with JSON-parsed args, live network
  doctor [dir]                  walk the whole contract and report which step failed
  link [dir]                    sign in to a linkLogin plugin's service with a code, as a
                                television does: eval "$(yonto-plugin link [dir])"
  doctor <repo-url>             read a 仓, XPTV or Yonto index as a television would: its
                                dialect, the sources its entries become, the plugins it
                                offers, what it skips
  bundle [dir]                  the publishable .js, plus a zip of it and its sha256
  index <plugins-dir> --base-url <url> [--only <ids>] [--expect <file>]
                                an index listing every plugin under <plugins-dir> at
                                <url>/<id>/<id>-<version>.zip, printed as JSON; with --only,
                                just the comma-separated ids, each of which must be there;
                                with --expect, refused unless it lists exactly the addresses
                                (url#sha256=hex, one per line) in <file>
  index --check <file-or-url>   validate an index, then download each plugin it lists and
                                hold it to its sha256, id, version and contract

Options:
  --record                      run live and save each response as a fixture (run, doctor);
                                the host's own requests go to fixtures/host/, and a fixture a
                                held credential survives redaction in is not written
  --replay                      serve responses from saved fixtures instead of the network (run, doctor)

Config (run, doctor):
  <dir>/doctor.json             what this plugin reads as yonto.config, committed beside it
  YONTO_PLUGIN_CONFIG='{…}'   the same thing for one run, over the top of that file.
  YONTO_PLUGIN_SUBSOURCE=id   which of a source's libraries to read, for a plugin that
                                offers several (yonto.subSource())
  YONTO_PLUGIN_CREDENTIAL=…   the session a television would be holding for a plugin that
                                declares a cookieLogin. The host attaches it to that
                                capability's own site; the plugin never reads it, and it is
                                never written to a file — which is why it is only ever an
                                environment variable and never doctor.json
  YONTO_PLUGIN_CLEARANCE='name=value; …'
  YONTO_PLUGIN_CLEARANCE_UA=…
  YONTO_PLUGIN_CLEARANCE_SITE=https://host
                                what passing a browser check at that site won, copied from
                                your own browser, with the agent it was won under. All three
                                or none. The host sends it to that site alone, per redirect
                                hop, while a browserCheck covers the site, and the plugin
                                never reads it: environment only, like the credential
  YONTO_PLUGIN_SESSION='{…}'  what a television holds for a linkLogin plugin once it is
                                signed in, as \`link\` prints it: the account credential and
                                what it was linked under. The host lists the account's servers
                                with it and attaches each server's own credential per hop; the
                                plugin never reads either. Environment only, like the credential
`;

/** [text] as one single-quoted shell word, an apostrophe in it included. */
function shellQuoted(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function init(rest) {
  const positional = [];
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--template' || rest[i] === '--name') {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError(`${rest[i]} needs a value`);
      options[rest[i]] = rest[++i];
    } else {
      positional.push(rest[i]);
    }
  }
  if (positional.length !== 1) throw new UsageError('init <id> [--template <name>] [--name <display name>]');
  let target;
  try {
    target = initPlugin({ id: positional[0], template: options['--template'] ?? 'blank', name: options['--name'], parent: process.cwd() });
  } catch (error) {
    throw new UsageError(error.message);
  }
  console.log(`✓ created ${relative(process.cwd(), target)}/`);
  console.log(`  next: cd ${positional[0]} && yonto-plugin lint && yonto-plugin doctor`);
  return 0;
}

/** Something wrong with how the command was typed, rather than with the plugin. */
class UsageError extends Error {}

function clearancesFromEnv() {
  try {
    return [clearanceFromEnv(process.env)].filter((clearance) => clearance !== null);
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/**
 * [secrets] is what the host holds this run, which a recording writes as placeholders; [hostOwn]
 * is the host's own transport, whose fixtures are kept apart so a replay serves them to the host
 * and never to the plugin.
 */
function transportFor(flags, fixturesDir, { secrets, hostOwn = false, learn } = {}) {
  if (flags.has('--replay')) return createReplayTransport({ dir: fixturesDir });
  const live = createLiveTransport();
  if (!flags.has('--record')) return live;
  return createRecordTransport({
    inner: live, dir: fixturesDir, secrets, hostOwn, learn,
    refused: (file, why) => {
      console.error(`✗ --record  ${file}: ${why}`);
      process.exitCode = 1;
    },
  });
}

/** `YONTO_PLUGIN_SESSION`, read, or null. */
function sessionFromEnv() {
  const text = process.env.YONTO_PLUGIN_SESSION;
  if (!text) return null;
  try {
    const session = JSON.parse(text);
    if (typeof session?.credential !== 'string' || session.record === null || typeof session.record !== 'object') {
      throw new Error('it holds no credential and record');
    }
    return session;
  } catch (error) {
    throw new UsageError(`YONTO_PLUGIN_SESSION could not be read: ${error.message} — sign in again with \`yonto-plugin link\``);
  }
}

/**
 * What a plugin would read as `yonto.config` here: the plugin's own `doctor.json` if it
 * has one, with `YONTO_PLUGIN_CONFIG` over the top of it.
 *
 * A plugin whose `configSchema` has a required field cannot run without one, and until
 * there was somewhere to put it the answer was an environment variable named nowhere in
 * the documentation — so `doctor` on a plugin with a `url` field failed every step with
 * `not a URL:` and read as a broken plugin. `doctor.json` is the same idea as `probeQuery`
 * in the manifest: what this plugin needs in order to be exercised, written down once
 * beside it instead of retyped by every author.
 *
 * Beside the plugin rather than in the manifest, and never inside the bundle: `bundle`
 * packs the manifest and the source and nothing else, so a value written for a fixture
 * cannot travel to a television. That is also what makes it safe for a field of type
 * `secret` — the fixture-shaped fake one, not a real key.
 */
function configFor(dir, manifest) {
  const file = join(dir, 'doctor.json');
  const sources = [
    // What the form opens with, as `PluginConfigForm.initialValues` seeds it.
    ['the manifest\'s defaults', Object.fromEntries((manifest.configSchema ?? [])
      .filter((field) => field.default !== undefined)
      .map((field) => [field.id, field.default]))],
    [file, existsSync(file) ? readConfig(readFileSync(file, 'utf8'), file) : {}],
    ['YONTO_PLUGIN_CONFIG', readConfig(process.env.YONTO_PLUGIN_CONFIG || '{}', 'YONTO_PLUGIN_CONFIG')],
  ];

  const answers = {};
  for (const [source, values] of sources) {
    for (const [id, value] of Object.entries(values)) {
      // Every value a television hands a plugin is a string — the editor's form has no
      // other kind of answer to give. A number would run on this host and on no other,
      // which is the split this tool exists to remove, so it is refused not coerced.
      if (typeof value !== 'string') {
        throw new PluginError(Code.CONFIG_INVALID,
          `${id} in ${source} is ${typeof value} — every config value a television gives a plugin is a string`,
          { id, source });
      }
      answers[id] = value;
    }
  }
  return configOf(manifest.configSchema ?? [], answers);
}

function readConfig(text, source) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('it is not a JSON object');
    }
    return parsed;
  } catch (cause) {
    throw new PluginError(Code.CONFIG_INVALID, `${source} could not be read: ${cause.message}`, { source });
  }
}

/**
 * Refuses before the first call rather than after the seventh failure.
 *
 * A required field nobody filled in reaches the plugin as no key at all, and what comes
 * back names neither the field nor the requirement — `not a URL:` with nothing after the
 * colon, once per step, which reads as a plugin that is broken rather than one that was
 * never configured.
 */
function requireConfig(manifest, config, dir) {
  // Only what the plugin will actually be handed — a `default` is already in there, put
  // that way by `configFor`, because that is what the device does: the editor seeds the
  // form with it and a viewer who taps Save has stored it without typing. `configOf` leaves
  // no key for a field with no answer and always gives a bool one, as `validate` does, so a
  // required field is missing exactly when it has no key of its own.
  const missing = (manifest.configSchema ?? [])
    .filter((field) => field.required && !Object.hasOwn(config, field.id))
    .map((field) => `${field.id} (${field.type})`);
  if (missing.length === 0) return;
  throw new PluginError(Code.CONFIG_MISSING,
    `${manifest.id} cannot run without ${missing.join(', ')} — put it in ${join(dir, 'doctor.json')} ` +
    "or pass YONTO_PLUGIN_CONFIG='{\"field\":\"value\"}'",
    { missing });
}

function hostAndEngine(dir, flags) {
  const manifest = loadManifest(dir);
  const fixturesDir = join(dir, 'fixtures');
  const config = configFor(dir, manifest);
  requireConfig(manifest, config, dir);
  const challenged = new Set();
  const secrets = createSecrets();
  const login = linkLoginOf(manifest);
  const hostTransport = transportFor(flags, join(fixturesDir, 'host'), {
    secrets, hostOwn: true, learn: login === null ? undefined : learningHostSecrets(login.service, secrets),
  });
  const host = createHost({
    manifest,
    config,
    transport: noticingChallenges(transportFor(flags, fixturesDir, { secrets }), challenged),
    hostTransport,
    secrets,
    // What a television holds for a linkLogin: environment only, never a file.
    session: sessionFromEnv(),
    warn: (line) => console.error(`⚠ ${line}`),
    storeDir: scratchDir(`yonto-${manifest.id}-`),
    pluginDir: dir,
    // Whatever the viewer would have picked on a television. Absent is the ordinary case
    // and means the same thing there: nobody has chosen yet, so the source picks for
    // itself — see the contract's "A source that is several".
    subSource: process.env.YONTO_PLUGIN_SUBSOURCE || null,
    // What a viewer's box would hold after logging in. Never `doctor.json`: that file is
    // committed beside the plugin, and a session is the one thing here that is a real
    // secret rather than a fixture-shaped fake.
    credential: process.env.YONTO_PLUGIN_CREDENTIAL || null,
    // The same reason: a clearance is a credential a television holds, never a fixture.
    clearances: clearancesFromEnv(),
  });
  const engine = challengeAware(createEngine({ dir, host }), manifest, host.requests);
  return {
    manifest, requests: host.requests, logs: host.logs, takePartial: host.takePartial, engine, challenged,
    conceal: host.redact, login, linked: host.yonto.session?.linked() ?? false, hostTransport,
    clientId: hostClientIdOf(resolve(dir), manifest),
  };
}

// "the header's manifest and the code under it" (USAGE, above): the manifest check is
// loadManifest, which reads the file's own header, and the code check is that what follows
// it parses — not a full `bundle`, which would also require every `import` to resolve.
async function lint(dir) {
  const manifest = loadManifest(dir);
  // The publisher tags each plugin's release with its directory's name, and `index` is the tag
  // the index lives on (tools/publish-plugins.sh), so neither the id nor the directory may be it.
  const named = [manifest.id, basename(resolve(dir))].filter((name) => name === RESERVED_ID);
  if (named.length > 0) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `${manifest.id === RESERVED_ID ? 'the id' : 'the directory name'} ${RESERVED_ID} is reserved: ` +
      'it is the release the plugin index is published on');
  }
  console.log(`✓ manifest          id=${manifest.id} version=${manifest.version} ` +
    `contract=${manifest.contractVersion} provides=${manifest.provides} ` +
    `hosts=[${manifest.allowedHosts.join(', ')}]`);

  // loadManifest above already read this file — a plugin *is* it since #100, so by the
  // time there is a manifest at all the file exists and its header parsed. What is left to
  // check is the half a header cannot vouch for: that the JavaScript under it builds.
  //
  // The build rather than a parse of the entry alone, and here rather than ninety lines
  // down inside the contract scan: the line below says the bundle is fine, so it has to be
  // printed by something that knows. It used to print after an `esbuild.transform` of the
  // entry, and an unresolvable import then failed later, under a message about `src/`.
  const entry = entryFile(dir);
  const built = await pluginSources(dir);
  console.log(`✓ bundle            ${entry} builds`);

  // Refused before the private-address warning below, because a dead entry would otherwise
  // be described as an address on the viewer's own network — `*.1.2.3.4.5` draws that
  // warning by design, since any numeric suffix is treated as the tail of some private
  // address, and "your entry is a LAN address" is the wrong sentence for one that is not a
  // host at all.
  //
  // A refusal rather than a warning, unlike the private-address case: that one is a real
  // host an author may have had a reason for, and this is a string that will never be one.
  // The failure it replaces gives an author nothing to go on — every request fails with
  // `HOST_NOT_ALLOWED: 999.999.999.999 is not in this plugin's allowedHosts
  // [999.999.999.999, …]`, a message whose list contains the entry that was meant to match.
  const dead = manifest.allowedHosts.filter((entry) => !canMatchAHost(entry));
  if (dead.length > 0) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `allowedHosts names ${dead.join(', ')}, which no host can ever match — ` +
      'an entry is compared as a canonical host, and these are not hosts',
      { dead });
  }

  // The same rule on the other side of the form. A `url` default seeds the editor, so a
  // default that names no host produces a form refusing its own prefilled value the moment
  // a viewer taps Save — and the author, whose plugin lints clean, hears about it from
  // them. Asked of `configOf`, which is the form's own question and is held to the device's
  // by `conformance/config.json`: a default read as a bare host let `::1` through here, as
  // loopback, when the form refuses it (kangzj/lantern-tv#537).
  const unreachable = (manifest.configSchema ?? [])
    .filter((field) => field.type === FIELD_TYPE_URL && field.default)
    .filter((field) => {
      try {
        configOf([field], { [field.id]: field.default });
        return false;
      } catch (refused) {
        if (refused?.code !== Code.CONFIG_INVALID) throw refused;
        return true;
      }
    });
  if (unreachable.length > 0) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `${unreachable.map((f) => `configSchema.${f.id} default ${f.default}`).join(', ')} names no host — ` +
      'the editor refuses one on Save, so a viewer could never keep it',
      { unreachable: unreachable.map((f) => f.id) });
  }

  // `provides` is the manifest's word about what this plugin is, and a television takes it
  // at that word: a `source` is a source the moment it is on the box, read out of the
  // manifest's own defaults, having asked nothing. A required field with no default is a
  // question, so a `source` carrying one is a promise the television cannot keep — it
  // would not be a source at all.
  //
  // This is the whole of what holds the declaration to the truth, which is why it is a
  // refusal and not a warning. The other direction is not checked and is not a mistake: a
  // plugin whose fields are all optional may still want the viewer to add each instance
  // deliberately, and only its author knows that.
  if (manifest.provides === PROVIDES_SOURCE) {
    const unanswered = unanswerableFields(manifest);
    if (unanswered.length > 0) {
      const named = unanswered.map((f) => f.id);
      throw new PluginError(Code.MANIFEST_INVALID,
        `provides says this plugin is a source, but ${named.join(', ')} ` +
        `${named.length === 1 ? 'is' : 'are'} required with no default, so nothing can ` +
        'make it a source without asking — ' +
        `give ${named.length === 1 ? 'the field' : 'those fields'} a default, ` +
        "or say provides: 'source-type'",
        { unanswered: named });
    }
  }

  // Deciding to reach the television's own network is a viewer's call — not a manifest's.
  // Every field a manifest can name a host in is read; see manifestNamedHosts for why a
  // `url` default is not a viewer naming anything, and why reading only `allowedHosts`
  // would be vacuous for exactly the plugins whose hosts are least checked.
  //
  // The wording promises nothing. A declared host still satisfies the allowlist check that
  // ought to refuse it, so this warns about a plugin that works and should not; and a host
  // spelled `127.1` or `2130706433` is already refused by this host and not by the device,
  // which is a disagreement the floor has to settle rather than something to describe here.
  for (const { where, host } of manifestNamedHosts(manifest).filter((n) => namesPrivateAddress(n.host))) {
    console.log(`    ⚠ ${where} names ${host}, which is on the viewer's own network. ` +
      'A manifest should not be the thing that decides to go there — only an address a ' +
      'viewer types into a url config field for themselves. Both hosts refuse this: the ' +
      'request fails with HOST_NOT_ALLOWED unless a viewer typed that host.');
  }

  for (const warning of undrivenLoginWarnings(manifest)) {
    console.log(`    ⚠ ${warning}`);
  }

  const capabilityRefusals = [...browserCheckRefusals(manifest), ...linkLoginRefusals(manifest)];
  if (capabilityRefusals.length > 0) {
    throw new PluginError(Code.MANIFEST_INVALID, 'capabilities is refused',
      { errors: capabilityRefusals.map((message) => ({ message })) });
  }

  // What the plugin's own source says it needs, against what the manifest claims. A plugin
  // that declares less than it uses installs onto an app that cannot run it: a host
  // function it calls is missing (`yonto.now is not a function`, which reads as a broken
  // plugin) or a method it exports is never called (artwork that silently stops
  // authenticating). Both are decided here, on the author's machine.
  let surface;
  try {
    surface = await contractVersionOf(built.sources, manifest, built.entry);
  } catch (cause) {
    // `cause` already names the file — see `contractVersionOf` — because "this plugin"
    // is not somewhere an author can open.
    throw new PluginError(Code.MISSING_EXPORT, cause.message, { dir });
  }
  for (const { path, why } of surface.unscannable) {
    // The noisy direction, taken deliberately and said out loud: a refusal traceable to one
    // of these files is worth a second look before an author changes their manifest.
    console.log(`⚠ contract          ${path} was read whole, strings and all — ${why}`);
  }
  if (surface.oldName.length > 0) {
    throw new PluginError(Code.CONTRACT_VERSION,
      `${surface.oldName.map((u) => u.path).join(', ')} names lantern, which no host has defined since ` +
      'contract 21: reach the host through yonto',
      { files: surface.oldName.map((u) => u.path) });
  }
  for (const { path } of surface.unclassified) {
    console.log(`⚠ contract          ${path} reaches yonto in a shape no name can be read ` +
      'out of — a namespace held as a value, or a destructured or computed reference — so ' +
      'the version below is a floor rather than an answer');
  }
  // `yonto.session` is installed for a linkLogin plugin alone, so a call to it anywhere else
  // is a TypeError on every host.
  const sessionCalls = surface.calls.filter((name) => name.startsWith('yonto.session.'));
  if (sessionCalls.length > 0 && !(manifest.capabilities ?? []).some((capability) => capability?.type === LINK_LOGIN)) {
    throw new PluginError(Code.MANIFEST_INVALID,
      `${sessionCalls.join(', ')} is called and no linkLogin is declared: yonto.session is only a linkLogin plugin's`,
      { calls: sessionCalls });
  }
  if (raisesUndeclaredChallenge(built.sources, manifest)) {
    console.log('⚠ contract          this plugin raises CHALLENGED and declares no browserCheck, so a ' +
      'television reports every challenge it raises as unavailable and opens no browser');
  }
  for (const { path, name } of surface.unknown) {
    console.log(`⚠ contract          ${path} calls ${name}, which is not a host function — ` +
      'the ones there are live in conformance/host-functions.json');
  }

  // A `hostsFromConfig` plugin cannot have signed artwork, and this is the only place an
  // author hears so. `ImageRequestHeaders.signFor` is given the profile's allowlist, and
  // such a plugin has none by design — so `getImageHeaders` is collected, stored, and
  // applied to nothing, because a 仓's posters come from the CMS sites its config names and
  // those are exactly the hosts no allowlist admits.
  //
  // Refusing it is the settled boundary rather than an omission: the alternative is a
  // stranger's config file deciding where a viewer's token is sent, since for this plugin
  // class nothing bounds where a request goes either. See contracts/content-source-http.md's
  // "Media the app fetches for a plugin".
  //
  // A warning and not a refusal, because the manifest is legal and the plugin runs — what
  // it loses is one optional export. Silence is what made this worth saying: the failure is
  // a poster that 401s, and nothing logs it (kangzj/lantern-tv#81).
  if (manifest.hostsFromConfig && surface.exports.includes('getImageHeaders')) {
    console.log('⚠ contract          getImageHeaders is exported by a hostsFromConfig plugin, so ' +
      'nothing will be signed with it. Artwork headers are sent only to the hosts a profile\'s ' +
      'allowlist admits, and this manifest has none — a plugin that needs signed pictures ' +
      'needs a manifest that names the hosts they come from.');
  }
  // The other half of a pairing, and this one is a refusal rather than a warning. A `track`
  // option is the only thing that could ever call `getStream`, and only `playbackTokens`
  // says this source may answer one — so the export without the declaration is a method
  // nothing will ever call. Worse than useless, because the manifest is what a host reads:
  // an app that was never told to expect a token decodes the option with `stream` required
  // and fails the whole title rather than the one row.
  //
  // The converse is not checked and is not an omission: a plugin declaring the fact and
  // emitting no token has a floor it does not need, which costs a viewer nothing.
  if (surface.exports.includes('getStream') && manifest.playbackTokens !== true) {
    throw new PluginError(Code.MANIFEST_INVALID,
      'getStream is exported and playbackTokens is not declared — a track option is the ' +
      'only thing that would ever call it, and a manifest that does not say this source ' +
      'may answer one is a manifest no host will offer a token to',
      { dir });
  }

  // A picker whose answer nothing reads. `getSubSources` offers a viewer a choice, and
  // `yonto.subSource()` is the only way that choice comes back — so a plugin exporting one
  // without reading the other gives a television a list, takes the pick, rebuilds the source
  // and shows exactly what it showed before. A switch that appears to work and changes
  // nothing is the failure mode with no error in it at all.
  //
  // Refused only where the scan can be sure. A plugin reaching the host in a shape no name
  // can be read out of — `const { subSource } = yonto` — is the case this cannot see, and
  // refusing a plugin that does read it is worse than warning about one that does not.
  if (surface.exports.includes('getSubSources') && !surface.calls.includes('yonto.subSource')) {
    const blind = surface.unclassified.length > 0 || surface.unscannable.length > 0;
    if (blind) {
      console.log('⚠ contract          getSubSources is exported and no yonto.subSource() call was ' +
        'found, but this plugin reaches the host in a shape names cannot be read out of — if the ' +
        'choice really is read, ignore this; if it is not, the picker it offers changes nothing.');
    } else {
      throw new PluginError(Code.MISSING_EXPORT,
        'getSubSources is exported and yonto.subSource() is never read, so the library a viewer ' +
        'picks is thrown away: the picker would appear to work and change nothing',
        { exported: 'getSubSources' });
    }
  }

  // A declaration about a call the plugin does not have. `catalogsAreRemote` says one
  // thing — that answering `getSubSources` may have to go and read a document first — so on
  // a plugin that exports no `getSubSources` it says nothing at all, and what it buys, a
  // picker that waits instead of closing, is bought for a picker that never opens.
  //
  // Refused rather than warned about, because unlike the `hostsFromConfig` case above there
  // is no reading of this manifest under which it is meaningful: the author either meant a
  // different field or forgot the export.
  if (manifest.catalogsAreRemote && !surface.exports.includes('getSubSources')) {
    throw new PluginError(Code.MISSING_EXPORT,
      'catalogsAreRemote says this source has to fetch its library list, but getSubSources is ' +
      'never exported, so there is no library list to fetch — export it, or drop the declaration',
      { declared: 'catalogsAreRemote' });
  }

  const handlesRefused = handlesRefusals(manifest, surface.exports);
  if (handlesRefused.length > 0) {
    throw new PluginError(Code.MANIFEST_INVALID, 'handles is refused',
      { errors: handlesRefused.map((message) => ({ message })) });
  }

  // The other end of the same gate. A host refuses a manifest above the range it shipped
  // with — `PluginManifests` answers UNSUPPORTED_CONTRACT — so a version above the newest
  // one anybody has shipped installs nowhere, and the viewer meets that after a download.
  // This is the one host an author runs, so it is where the refusal belongs.
  if (manifest.contractVersion > LATEST) {
    throw new PluginError(Code.CONTRACT_VERSION,
      `manifest declares contractVersion ${manifest.contractVersion}, and no host speaks past ` +
      `${LATEST}: every app refuses a manifest above the range it shipped with`,
      { declared: manifest.contractVersion, latest: LATEST });
  }
  // And the bottom of it: every host refuses a manifest below the oldest version it runs, which
  // for 21 means one written against `lantern`, the host global's old name.
  if (manifest.contractVersion < OLDEST) {
    throw new PluginError(Code.CONTRACT_VERSION,
      `manifest declares contractVersion ${manifest.contractVersion}, and no host runs a plugin below ` +
      `${OLDEST}: declare ${OLDEST} and reach the host through yonto`,
      { declared: manifest.contractVersion, oldest: OLDEST });
  }
  const required = Math.max(OLDEST, surface.required);
  const reasons = surface.reasons.filter((r) => r.version > OLDEST);
  if (manifest.contractVersion < required) {
    const because = reasons.map((r) => `${r.name} (${r.path})`);
    throw new PluginError(Code.CONTRACT_VERSION,
      `manifest declares contractVersion ${manifest.contractVersion}, but this plugin needs ` +
      `${required}: ${[...new Set(because)].join(', ')}`,
      { declared: manifest.contractVersion, required });
  }
  const mayNeed = surface.mayAnswerWith.filter((field) => field.version === manifest.contractVersion);
  if (manifest.contractVersion > required && mayNeed.length === 0) {
    console.log(`⚠ contract          declares ${manifest.contractVersion}, uses nothing newer than ` +
      `${required} — a version higher than it needs refuses apps that could run it`);
  }

  // The four the app calls with nothing to fall back on. A plugin without one cannot work,
  // and the television says so badly: `MISSING_EXPORT` is not an honoured code, so it lands
  // as `Unavailable` with no reason and a viewer reads "Can't reach this source. Check the
  // TV's network connection" about a plugin that was never going to answer
  // (kangzj/lantern-tv#326). `doctor` catches it and needs a live site; this does not, and
  // this is what `bundlePluginAssets` runs on every build.
  //
  // Derived from `conformance/optional-methods.json` rather than listed here, so the one
  // place that says which methods may be absent keeps saying it.
  //
  // Last of the contract checks, after the version ones: a version to correct is a line the
  // author has already written, and a method to add is one they have not. Telling them
  // about the file they are holding first is the more useful order.
  //
  // Warned rather than refused where the export could not be followed — a plugin whose
  // default export this cannot read looks like one exporting nothing, and refusing it would
  // be refusing the scan's own blindness. Same shape and same signal as `getSubSources`.
  const missing = METHODS
    .filter((method) => !OPTIONAL_METHODS.has(method))
    .filter((method) => !surface.exports.includes(method));
  if (missing.length > 0) {
    const told = `${missing.join(', ')}, and the app calls ` +
      `${missing.length === 1 ? 'it' : 'them'} with nothing to fall back on — on a television ` +
      'that reads as a source it cannot reach';
    // `unscannable` and not `nothingExported`: a file this could not read might export
    // everything, and refusing it would be refusing the scan's own blindness. A file that
    // default-exports nothing is not that case — the scan saw, and there was nothing —
    // so `no-export` is refused like any other plugin the app cannot call.
    //
    // Narrowed to the export's own reason: a *helper* with an unbalanced quote also lands
    // in `unscannable`, and says nothing about whether the entry's export was readable
    // (found in review, unreachable through the minifier today, cheap to rule out).
    if (surface.unscannable.some((u) => u.why === 'an export this could not follow')) {
      console.log(`⚠ contract          this plugin appears not to export ${told}. ` +
        'Its export could not be followed, so this may be the scan rather than the plugin — ' +
        'run `doctor` against the real site, which asks the engine instead of reading.');
    } else {
      throw new PluginError(Code.MISSING_EXPORT, `this plugin does not export ${told}`, { missing });
    }
  }

  if (required === manifest.contractVersion || mayNeed.length > 0) {
    const because = [
      ...new Set(reasons.map((r) => r.name)),
      ...(required === manifest.contractVersion ? [] : mayNeed.map((field) => `${field.name} (may answer with)`)),
    ];
    console.log(`✓ contract          ${manifest.contractVersion}${because.length ? ` — ${because.join(', ')}` : ''}`);
  }

  return 0;
}

async function run(dir, method, rawArgs, flags) {
  const { requests, takePartial, engine, conceal } = hostAndEngine(dir, flags);
  const result = await engine.call(method, rawArgs.map((arg) => {
    try {
      return JSON.parse(arg);
    } catch {
      throw new UsageError(`${arg} is not JSON: every argument is parsed as JSON, so a string needs ` +
        `quotes of its own inside the shell's — ${method} ${shellQuoted(JSON.stringify(arg))}`);
    }
  }));

  for (const r of requests) {
    console.error(conceal(`  ${r.blocked ? 'BLOCKED' : r.status} ${r.method} ${r.url} ${r.bytes}B ${r.ms}ms`));
  }
  const partial = partialShown(method, takePartial());
  if (partial !== null) console.error(`  ◐ partial ${partial}`);
  const { valid, errors } = validateResult(method, result);
  console.log(conceal(JSON.stringify(result, null, 2)));
  if (!valid) {
    for (const e of errors) console.error(`✗ RESULT_INVALID   ${e.message}`);
    return 1;
  }
  return 0;
}

async function doctor(dir, flags) {
  const {
    manifest, requests, logs, takePartial, engine, challenged, conceal, login, linked, hostTransport, clientId,
  } = hostAndEngine(dir, flags);
  // A signed-out linkLogin plugin: its service's start and one poll, live, and every step that
  // needs the login reported as such rather than as a failure.
  const loggedOut = login !== null && !linked;
  const linkSteps = !loggedOut ? []
    : flags.has('--replay')
      ? [{ method: 'link start', ok: true, skipped: true, code: null, ms: 0, requests: 0,
        message: 'skipped — a sign-in is checked live, never from fixtures' }]
      : await checkLink({ service: login.service, transport: hostTransport, clientId });
  // `a` finds nothing on a catalog that isn't written in Latin script, so a plugin that
  // knows a word its own site answers to says so in the manifest rather than making
  // every author pass one in.
  const query = manifest.probeQuery ?? process.env.YONTO_PLUGIN_QUERY ?? 'a';
  // The plugin's own files, not the bundle: a warning has to name a line an author can open.
  const report = await runDoctor({
    engine, requests, logs, takePartial, query, category: manifest.probeCategory ?? null,
    sources: (await pluginSources(dir)).sources, pagination: manifest.pagination, loggedOut,
  });
  report.steps.unshift(...linkSteps);
  report.ok = report.ok && linkSteps.every((step) => step.ok);
  console.log(formatReport(manifest, report, requests, conceal));
  for (const line of challengeHints(manifest, report, challenged)) console.log(line);
  return report.ok ? 0 : 1;
}

function isAddress(arg) {
  return /^https?:\/\//i.test(arg ?? '');
}

async function doctorRepo(url, flags) {
  if (flags.size > 0) throw new UsageError(`doctor <repo-url> reads the repo live and takes no options, not ${[...flags].join(' ')}`);
  const report = await repoReport(url);
  console.log(report.lines.join('\n'));
  return report.ok ? 0 : 1;
}

/**
 * Every host a manifest names, and where it named it.
 *
 * Four places, because the schema has four fields that carry one and any of them is the
 * manifest choosing rather than a viewer:
 *
 * - `allowedHosts`, the obvious one;
 * - a `configSchema` field of type `url` with a `default` — the editor seeds the form with
 *   it, so a viewer who taps Save has named nothing, and `hostsWith` counts that host as
 *   the manifest's rather than the viewer's. The only way a `hostsFromConfig` manifest can
 *   name a host at all;
 * - `capabilities[].url`, which is the page a login capability will open;
 * - `iconUrl`, which the image loader fetches.
 *
 * The last two reach nothing today — `cookieLogin` is deferred and no icon is loaded from a
 * manifest yet — so they are here for what they say rather than what they do. A manifest
 * pointing either at the television's own network is still a manifest deciding to go there,
 * and an author should hear about it before the day it starts working.
 */
function manifestNamedHosts(manifest) {
  const named = [
    ...manifest.allowedHosts.map((host) => ({ where: 'allowedHosts', host })),
    ...(manifest.configSchema ?? [])
      .filter((field) => field.type === FIELD_TYPE_URL && field.default)
      .map((field) => ({ where: `configSchema.${field.id} default`, host: field.default })),
    ...(manifest.capabilities ?? [])
      .filter((capability) => capability.url)
      .map((capability) => ({ where: `capabilities.${capability.type} url`, host: capability.url })),
    ...(manifest.iconUrl ? [{ where: 'iconUrl', host: manifest.iconUrl }] : []),
  ];
  // A bare `allowedHosts` entry is already a host; the others are URLs, so take the host
  // out where there is one and leave the string alone where there is not — an entry that
  // names no host at all is for the schema to reject, not for this to guess at.
  return named.map((entry) => ({ ...entry, host: hostOf(entry.host) ?? entry.host }));
}

/**
 * The plugin's own file and every `.js` it can import, keyed by the path a warning prints.
 *
 * The entry is at the top of the directory and helpers are under `src/`, so a key with no
 * `/` in it is the plugin itself — which is how `contract-version` tells the plugin's
 * exports from a helper's. `dist/` is not walked: its `.js` is this command's own output.
 */
async function pluginSources(dir) {
  const entry = entryFile(dir);
  const sources = {};
  const put = (abs) => {
    sources[resolve(abs) === resolve(entry) ? basename(entry) : relative(dir, resolve(abs))] =
      readFileSync(abs, 'utf8');
  };

  // Two questions, two answers, and walking one directory used to be asked to give both.
  //
  // *Does everything here parse* is about the files an author has in front of them, so it
  // is still the walk: a `.js` under the plugin that nothing imports is still a file they
  // will wonder about, and the walk is what reports it.
  if (existsSync(entry)) put(entry);
  const walk = (at, prefix) => {
    if (!existsSync(at)) return;
    for (const found of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.isDirectory()) walk(join(at, found.name), `${prefix}${found.name}/`);
      else if (found.name.endsWith('.js')) put(join(at, found.name));
    }
  };
  walk(join(dir, 'src'), 'src/');

  // *What does this plugin call* is about what ships, so it is asked of the bundler. The
  // walk guessed and guessed short: esbuild follows an import anywhere, so a helper one
  // directory up was read by the build and by no scan, and a plugin calling `yonto.now()`
  // through it linted as contract 1 and ran. `contract-version.js` calls that the one
  // direction it is not allowed to be wrong in (kangzj/lantern-tv#327).
  const built = await buildPlugin(dir, { format: 'esm', metafile: true });
  // The keys are what a warning prints and what `contract-version` tells the plugin's own
  // exports by — a key with no `/` is the plugin itself — so the entry keeps its bare
  // basename and everything else is named relative to the plugin. An import that escapes
  // the directory therefore reads as `../lib/text.js`, which is both true and a `/`.
  // Named relative to the bundler's working directory, which is not necessarily cwd.
  for (const input of Object.keys(built.metafile.inputs)) put(resolve(bundleRoot(dir), input));
  return { sources, entry: basename(entry) };
}

/**
 * Signs in to a linkLogin plugin's service and prints the one line `eval` needs, to stdout, and
 * everything else to stderr, so the credential lands in the shell's environment and in no
 * scrollback, history or file.
 */
async function link(dir) {
  const manifest = loadManifest(dir);
  const login = linkLoginOf(manifest);
  if (login === null) {
    const refused = linkLoginRefusals(manifest);
    throw new UsageError(refused.length > 0
      ? `${manifest.id}'s linkLogin is refused: ${refused.join('; ')}`
      : `${manifest.id} declares no linkLogin, so there is nothing to sign in to (services: ${Object.keys(SERVICES).join(', ')})`);
  }
  let credential;
  try {
    credential = await runLink({
      service: login.service,
      transport: createLiveTransport(),
      clientId: hostClientIdOf(resolve(dir), manifest),
      sleep: (ms) => new Promise((wake) => { setTimeout(wake, ms); }),
      say: (line) => console.error(line),
    });
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return 1;
  }
  console.error('Logged in');
  console.log(exportLine(credential, linkRecord(manifest, Date.now())));
  return 0;
}

async function bundle(dir) {
  const { jsPath, zipPath, sha256, bytes } = await bundlePlugin({ dir, outDir: join(dir, 'dist') });
  // The file first, because it is the one a plugin now *is* — the zip is the shim.
  console.log(jsPath);
  console.log(zipPath);
  console.log(bytes);
  console.log(sha256);
  return 0;
}

/**
 * `index`'s own arguments, parsed by refusing anything it doesn't know: `--chek` read as
 * absent would build an index instead of checking one.
 */
function indexArguments(rest) {
  const usage = 'index <plugins-dir> --base-url <url> [--only <ids>] [--expect <file>], or index --check <file-or-url>';
  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--base-url' || arg === '--check' || arg === '--expect' || arg === '--only') {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError(`${arg} needs a value: ${usage}`);
      options[arg] = rest[++i];
    } else if (arg.startsWith('--')) {
      throw new UsageError(`${arg} is not an option index understands: ${usage}`);
    } else {
      positional.push(arg);
    }
  }
  if (options['--check'] !== undefined) {
    if (positional.length > 0 || Object.keys(options).length > 1) {
      throw new UsageError(`--check takes only the index: ${usage}`);
    }
    return { check: options['--check'] };
  }
  if (positional.length !== 1 || options['--base-url'] === undefined) throw new UsageError(usage);
  const only = options['--only']?.split(',').map((id) => id.trim()).filter(Boolean);
  if (only !== undefined && only.length === 0) throw new UsageError(`--only names no plugin: ${usage}`);
  return { pluginsDir: positional[0], baseUrl: options['--base-url'], only, expect: options['--expect'] };
}

/** `readIndex`'s skip counts, in words. */
const SKIPPED = {
  plugin: 'a plugin entry missing what an install needs',
  duplicate: "repeating an earlier entry's key or plugin id",
  unknownType: 'of a type Yonto doesn\'t know',
  type: 'of a type no reader takes',
  spider: 'a 仓 spider',
  address: 'no http address',
};

async function index(rest) {
  const args = indexArguments(rest);
  if (args.check === undefined) {
    const built = await buildIndex(args);
    // The publisher's check that the index names exactly the builds it uploads: one line per
    // address, `<url>#sha256=<hex>`. A mismatch prints nothing to stdout, so nothing is uploaded.
    if (args.expect !== undefined) {
      const expected = readFileSync(args.expect, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
      const listed = built.plugins.map((plugin) => plugin.url);
      const missing = expected.filter((api) => !listed.includes(api));
      const unexpected = listed.filter((api) => !expected.includes(api));
      for (const api of missing) console.error(`✗ the index does not list ${api}, which this run uploads`);
      for (const api of unexpected) console.error(`✗ the index lists ${api}, which this run does not upload`);
      if (missing.length + unexpected.length > 0) return 1;
    }
    console.log(JSON.stringify(built, null, 2));
    return 0;
  }

  const remote = /^https?:\/\//i.test(args.check);
  let bytes;
  try {
    // A pin is a fragment on a path as on an address: never part of what is read.
    const where = args.check.replace(/#.*$/, '');
    bytes = remote ? await fetchBounded(where) : readFileSync(where);
  } catch (error) {
    console.error(`✗ couldn't read ${args.check}: ${error.message}`);
    return 1;
  }
  const pinned = pinnedSha256(args.check);
  if (pinned !== null) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== pinned) {
      console.error(`✗ the address pins sha256 ${pinned}, the index is ${actual}; nothing it lists was fetched`);
      return 1;
    }
    console.log('✓ index             matches the sha256 in its address');
  }

  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    console.error(`✗ not JSON: ${error.message}`);
    return 1;
  }
  const problems = indexProblems(document);
  const read = pluginEntries(document);
  if (read.refused) {
    console.error(`✗ a reader refuses this index: ${read.refused}`);
    return 1;
  }
  if (read.list) {
    console.error(`✗ a list of ${read.list.repos.length} repos, not an index: \`doctor\` reads a list`);
    return 1;
  }
  const offered = read.plugins.filter((plugin) => plugin.offered).length;
  console.log(`${problems.length ? '✗' : '✓'} schema            ${offered} plugin entries, ${read.entries.length} catalog entries`);
  for (const problem of problems) console.error(`    ${problem}`);
  // Skipped, as the app's reader skips them, rather than failing the document.
  const skipped = Object.entries(read.skipped).filter(([, count]) => count > 0);
  if (skipped.length > 0) {
    console.log(`⚠ skipped as a reader skips them: ${skipped.map(([why, count]) => `${SKIPPED[why] ?? why} ${count}`).join(', ')}`);
  }

  // Every plugin entry, one a reader passes over included: an index is only as good as its worst zip.
  let failed = problems.length > 0;
  for (const { plugin, offered: isOffered } of read.plugins) {
    const found = await entryProblems(plugin, fetchBounded);
    const label = String(plugin?.id ?? '(no id)');
    const note = isOffered ? '' : '  (not offered: a reader skips it)';
    console.log(`${found.length ? '✗' : '✓'} ${label.padEnd(18)}${plugin?.version ?? ''}${note}`);
    for (const problem of found) console.error(`    ${problem}`);
    failed ||= found.length > 0;
  }
  return failed ? 1 : 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
  const args = rest.filter((arg) => !arg.startsWith('--'));

  try {
    switch (command) {
      case 'init':
        process.exit(init(rest));
        break;
      case 'lint':
        process.exit(await lint(args[0] ?? process.cwd()));
        break;
      case 'run': {
        // The directory is optional, as it is for every other command, so the first
        // argument is one only if it is a directory: otherwise it is the method, which needs
        // a plugin here. Where there is none, a first argument that is not a directory is far
        // more likely a directory mistyped than a method, and it is named as one.
        const dirGiven = args.length > 0 && statSync(args[0], { throwIfNoEntry: false })?.isDirectory() === true;
        if (!dirGiven && args.length > 0 && !existsSync(entryFile(process.cwd()))) {
          throw new UsageError(`${args[0]} is not a directory, and ${process.cwd()} is not a plugin — ` +
            'run [dir] <method> [args...]');
        }
        const [method, ...rawArgs] = dirGiven ? args.slice(1) : args;
        if (method === undefined) throw new UsageError('run needs a method: run [dir] <method> [args...]');
        process.exit(await run(dirGiven ? args[0] : process.cwd(), method, rawArgs, flags));
        break;
      }
      case 'doctor':
        process.exit(await (isAddress(args[0]) ? doctorRepo(args[0], flags) : doctor(args[0] ?? process.cwd(), flags)));
        break;
      case 'link':
        process.exit(await link(args[0] ?? process.cwd()));
        break;
      case 'bundle':
        process.exit(await bundle(args[0] ?? process.cwd()));
        break;
      case 'index':
        process.exit(await index(rest));
        break;
      case '--help':
      case 'help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        console.error(USAGE);
        process.exit(2);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`✗ ${error.message}`);
      process.exit(2);
    }
    if (error instanceof PluginError) {
      console.error(`✗ ${error.code}  ${error.message}`);
      for (const e of error.detail.errors ?? []) console.error(`                    ${e.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
