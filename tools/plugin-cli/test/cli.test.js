import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST, OLDEST } from '../src/contract-version.js';
import { scratchDir } from '../src/scratch-dir.js';

// `lint` is exercised as a real subprocess, not by importing cli.js — cli.js runs
// main() unconditionally against process.argv on import, so a subprocess is the only
// way to call it without hijacking the test runner's own argv.
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const okDir = fileURLToPath(new URL('../test-plugins/ok/', import.meta.url));
const noSourceDir = fileURLToPath(new URL('../test-plugins/no-source/', import.meta.url));
const lanHostDir = fileURLToPath(new URL('../test-plugins/lan-host/', import.meta.url));
const cangSignsDir = fileURLToPath(new URL('../test-plugins/cang-signs/', import.meta.url));
const publicDefaultDir = fileURLToPath(new URL('../test-plugins/public-default/', import.meta.url));
const behindDir = fileURLToPath(new URL('../test-plugins/behind-contract/', import.meta.url));
const beyondDir = fileURLToPath(new URL('../test-plugins/beyond-contract/', import.meta.url));
const takenApartDir = fileURLToPath(new URL('../test-plugins/taken-apart/', import.meta.url));
const brokenHelperDir = fileURLToPath(new URL('../test-plugins/broken-helper/', import.meta.url));
const importedHelperDir = fileURLToPath(new URL('../test-plugins/imported-helper/', import.meta.url));
const siblingHelperDir = fileURLToPath(new URL('../test-plugins/sibling-helper/', import.meta.url));
const halfAPluginDir = fileURLToPath(new URL('../test-plugins/half-a-plugin/', import.meta.url));
const noExportDir = fileURLToPath(new URL('../test-plugins/no-export/', import.meta.url));
const unresolvedImportDir = fileURLToPath(new URL('../test-plugins/unresolved-import/', import.meta.url));
const awaitsAtTopLevelDir = fileURLToPath(new URL('../test-plugins/awaits-at-top-level/', import.meta.url));
const borrowedExportDir = fileURLToPath(new URL('../test-plugins/borrowed-export/', import.meta.url));
const computedKeyDir = fileURLToPath(new URL('../test-plugins/computed-key/', import.meta.url));
const unknownCallDir = fileURLToPath(new URL('../test-plugins/unknown-call/', import.meta.url));
const pickerDir = fileURLToPath(new URL('../test-plugins/picker/', import.meta.url));
const deafPickerDir = fileURLToPath(new URL('../test-plugins/deaf-picker/', import.meta.url));
const blindPickerDir = fileURLToPath(new URL('../test-plugins/blind-picker/', import.meta.url));
const remoteCatalogsDir = fileURLToPath(new URL('../test-plugins/remote-catalogs/', import.meta.url));
const subSourcesDir = fileURLToPath(new URL('../test-plugins/sub-sources/', import.meta.url));
const redeemsTokensDir = fileURLToPath(new URL('../test-plugins/redeems-tokens/', import.meta.url));
const redeemsUndeclaredDir = fileURLToPath(new URL('../test-plugins/redeems-undeclared/', import.meta.url));
const remoteCatalogsNoPickerDir = fileURLToPath(new URL('../test-plugins/remote-catalogs-no-picker/', import.meta.url));
const writesToLoginDir = fileURLToPath(new URL('../test-plugins/writes-to-login/', import.meta.url));

test('lint passes a manifest with an entry file that parses', () => {
  const output = execFileSync('node', [cli, 'lint', okDir], { encoding: 'utf8' });
  assert.match(output, /✓ manifest/);
  assert.match(output, /✓ bundle.*builds/);
});

// Since #100 "there is no entry file" and "there is no manifest" are one statement: the
// manifest lives in the file's own header, so a directory without it holds no plugin.
test('lint says a directory with no entry file holds no plugin at all', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', noSourceDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /no-source-plugin\.js could not be read/);
      assert.match(error.stderr, /a plugin is that file/);
      return true;
    },
  );
});

test('lint refuses the plugin id index, the tag the plugin index is published on', () => {
  const indexDir = fileURLToPath(new URL('../test-plugins/id-index/', import.meta.url));
  assert.throws(
    () => execFileSync('node', [cli, 'lint', indexDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID\s+the id index is reserved/);
      return true;
    },
  );
});

/** The publisher names a release after the directory, not the id, so the directory counts too. */
test('lint refuses a plugin in a directory named index, whatever its id', () => {
  const indexDir = fileURLToPath(new URL('../test-plugins/named-index/index/', import.meta.url));
  assert.throws(
    () => execFileSync('node', [cli, 'lint', indexDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID\s+the directory name index is reserved/);
      return true;
    },
  );
});

// The warning has to survive a refactor of the loop that prints it, so it is asserted
// through the command rather than only through the classifier underneath.
test('lint names a private address a manifest reached for', () => {
  const output = execFileSync('node', [cli, 'lint', lanHostDir], { encoding: 'utf8' });

  assert.match(output, /⚠ configSchema\.configUrl default names 192\.168\.1\.1/);
  assert.match(output, /viewer's own network/);
  // The promise the warning makes, pinned: it used to say the refusal was being settled and
  // that an author should not rely on it. Both hosts refuse it now, and a warning that drifts
  // back to a maybe is a warning an author is right to ignore.
  assert.match(output, /Both hosts refuse this: the request fails with HOST_NOT_ALLOWED/);
});

test('a plugin naming nothing on the viewer’s network draws nothing', () => {
  const output = execFileSync('node', [cli, 'lint', okDir], { encoding: 'utf8' });

  assert.doesNotMatch(output, /⚠/);
});

// The `lan-host` fixture's only host is a `url` default — `hostsFromConfig` holds its
// allowedHosts to maxItems: 0 — so this fails if that branch is dropped, which the
// clean-case test above cannot notice.
test('a url default pointed somewhere public draws nothing, so the branch is read not assumed', () => {
  const output = execFileSync('node', [cli, 'lint', publicDefaultDir], { encoding: 'utf8' });

  assert.match(output, /✓ manifest/);
  assert.doesNotMatch(output, /⚠/);
});

test('lint refuses a plugin that declares a contract older than any host runs', () => {
  // Every host refuses it (`PluginManifests` answers UNSUPPORTED_CONTRACT), and below 21 it
  // was written against `lantern`, which no host defines any more.
  let failed;
  try {
    execFileSync('node', [cli, 'lint', behindDir], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('lint accepted a plugin declaring a contract no host runs');
  } catch (error) {
    failed = error;
  }
  const output = `${failed.stdout}${failed.stderr}`;
  assert.match(output, /CONTRACT_VERSION/);
  assert.match(output, new RegExp(`declares contractVersion 20, and no host runs a plugin below ${OLDEST}`));
});

test('lint refuses a plugin that still names lantern, which no host defines', () => {
  // Declaring 21 is not enough: a plugin calling `lantern.fetch` dies at that call on every host.
  const dir = fileURLToPath(new URL('../test-plugins/says-lantern/', import.meta.url));
  let failed;
  try {
    execFileSync('node', [cli, 'lint', dir], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('lint accepted a plugin naming lantern');
  } catch (error) {
    failed = error;
  }
  assert.match(failed.stderr, /CONTRACT_VERSION/);
  assert.match(failed.stderr, /says-lantern-plugin\.js names lantern, which no host has defined since contract 21/);
});

test('lint says which contract a plugin needs when it declares it correctly', () => {
  const output = execFileSync('node', [cli, 'lint', okDir], { encoding: 'utf8' });

  assert.match(output, /✓ contract\s+21/);
});

// A result field lint cannot see (kangzj/lantern-tv#358): a plugin exporting getFilters may
// answer with `init`, so 13 is not a declaration to talk it down from.
test('lint does not call a declaration too high when an answer may need it', () => {
  const output = execFileSync('node', [cli, 'lint', opensRankedDir], { encoding: 'utf8' });

  assert.doesNotMatch(output, /⚠ contract/);
  assert.match(output, /✓ contract {10}21\n/);
});

test('lint refuses a contract version no host speaks, so the refusal is not a viewer\u2019s', () => {
  // The other end of the same gate. A version below what the plugin uses is refused above;
  // a version above what any host has ever shipped is refused by every host there is —
  // `PluginManifests` answers UNSUPPORTED_CONTRACT for it — after a download, on a
  // television. The CLI is the one host an author runs, so it says it first.
  let failed;
  try {
    execFileSync('node', [cli, 'lint', beyondDir], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('lint accepted a contract version no host speaks');
  } catch (error) {
    failed = error;
  }
  const output = `${failed.stdout}${failed.stderr}`;
  assert.match(output, /CONTRACT_VERSION/);
  assert.match(output, new RegExp(`declares contractVersion 99, and no host speaks past ${LATEST}`));
});

test('lint says when a plugin reaches the host in a shape no name can be read out of', () => {
  // The version underneath is a floor, not an answer — nothing can be placed from a
  // pattern — so the line has to say that rather than print a confident number.
  const output = execFileSync('node', [cli, 'lint', takenApartDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract.*taken-apart-plugin\.js reaches yonto in a shape no name can be read out of/);
});

test('lint names the file that does not parse, rather than printing a stack trace', () => {
  // Every file is read, not only the entry, so a broken helper has to fail the way a broken
  // entry already does — and say which file, since esbuild is handed the text rather than
  // the path and reports `<stdin>` on its own.
  let failed;
  try {
    execFileSync('node', [cli, 'lint', brokenHelperDir], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('lint accepted a plugin with a file that does not parse');
  } catch (error) {
    failed = error;
  }
  const output = `${failed.stdout}${failed.stderr}`;
  assert.match(output, /MISSING_EXPORT/);
  assert.match(output, /src\/lib\/half\.js could not be read/);
  assert.ok(!output.includes('at async'), 'a stack trace reached the author');
});

test('a plugin that cannot be built gets one sentence from every command, naming its own line', () => {
  // The same failure from the same bundler on the same file: `doctor` and `bundle` printed
  // esbuild's own log and a Node stack, `lint` its log and then a sentence, and `run` a
  // different sentence again (kangzj/lantern-tv#452).
  const said = ['lint', 'doctor', 'bundle', 'run'].map((command) => {
    const args = command === 'run' ? [cli, command, unresolvedImportDir, 'getCategories'] : [cli, command, unresolvedImportDir];
    try {
      execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      assert.equal(error.status, 1, `${command} exited ${error.status}`);
      const failure = error.stderr.split('\n').filter((line) => line.startsWith('✗'));
      assert.equal(failure.length, 1, `${command} printed ${error.stderr}`);
      assert.ok(!error.stderr.includes('[ERROR]'), `${command} let esbuild print its own log`);
      assert.ok(!/^\s+at /m.test(error.stderr), `${command} printed a stack`);
      return failure[0];
    }
    return assert.fail(`${command} built a plugin whose import does not resolve`);
  });

  assert.match(said[0], /BUILD_FAILED  unresolved-import-plugin\.js could not be built: unresolved-import-plugin\.js:14:23: Could not resolve "\.\/src\/nowhere\.js"/);
  assert.deepEqual(new Set(said).size, 1, said.join('\n'));
});

test('a plugin that awaits at the top level lints and bundles', () => {
  // A bundling refusal wearing the message for a missing export, on a plugin the device
  // runs (kangzj/lantern-tv#457).
  for (const command of ['lint', 'bundle']) {
    const out = scratchDir('lp-');
    const dir = join(out, 'awaits-at-top-level');
    mkdirSync(dir);
    writeFileSync(join(dir, 'awaits-at-top-level-plugin.js'), readFileSync(join(awaitsAtTopLevelDir, 'awaits-at-top-level-plugin.js')));
    execFileSync('node', [cli, command, dir], { encoding: 'utf8', stdio: 'pipe' });
  }
});

test('lint reads an imported helper the walk never looked at', () => {
  // The walk took the entry file and `src/**`. esbuild follows an import anywhere, so a
  // helper in `lib/` was read by the build and by no scan, and what it called went unseen
  // (kangzj/lantern-tv#327). Named by its path relative to the plugin, so the author can open it.
  const output = execFileSync('node', [cli, 'lint', importedHelperDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract {10}lib\/clock\.js calls yonto\.teleport/);
});

test('a helper beside the entry is a helper, not a second entry', () => {
  // The exports scan reads the entry only — a helper's own default export is not what the
  // app calls. Which file that is used to be inferred from punctuation, "the key with no
  // `/`", on the premise that every helper lives under `src/`. True of the walk that made
  // those keys, false once the bundler made them: a sibling's relative path is a bare
  // basename too.
  //
  // So this helper's internal `{ getSubSources() {} }` read as the plugin exporting one,
  // and lint refused the plugin over it — needs 4, plus a warning about an export it could
  // not follow. Found reviewing kangzj/lantern-tv#347.
  const output = execFileSync('node', [cli, 'lint', siblingHelperDir], { encoding: 'utf8' });

  assert.match(output, /✓ contract\s+21/);
  assert.doesNotMatch(output, /getSubSources/);
  assert.doesNotMatch(output, /⚠/);
});

test('lint refuses a plugin missing a method the app calls with no fallback', () => {
  // `lint` is what `bundlePluginAssets` runs on every Gradle build, and it is the only gate
  // that needs no live site. Without this, a plugin missing `search` builds into an APK and
  // fails on the television as `Can't reach this source. Check the TV's network connection`
  // — because `MISSING_EXPORT` is not an honoured code and lands as a reasonless
  // `Unavailable` (kangzj/lantern-tv#326).
  let failed;
  try {
    execFileSync('node', [cli, 'lint', halfAPluginDir], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('lint accepted a plugin the app cannot call');
  } catch (error) {
    failed = error;
  }
  const output = `${failed.stdout}${failed.stderr}`;
  assert.match(output, /MISSING_EXPORT/);
  assert.match(output, /getMediaList, getMediaDetail, search/);
  // The optional ones are absent too and must not be named — that is the whole point of
  // reading `conformance/optional-methods.json` rather than a second hand-kept list.
  assert.doesNotMatch(output, /getFilters|getRecommendations|checkHealth|getSubSources/);
});

test('and warns instead when it could not follow the export at all', () => {
  // A default export assembled by spreading something this cannot enumerate: the methods
  // are real, and refusing the plugin would be refusing the scan's own blindness. Same
  // shape as the `getSubSources` check.
  const output = execFileSync('node', [cli, 'lint', borrowedExportDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract.*appears not to export/);
  assert.match(output, /run `doctor` against the real site/);
});

test('but a plugin that default-exports nothing at all is refused, not excused', () => {
  // Not the same case, though `exportedKeys` used to answer `null` for both. Nothing
  // exported is the scan seeing clearly and finding nothing — the engine says so too
  // ("must default-export an object of methods") — so excusing it handed the one plugin
  // that certainly cannot work the benefit of a doubt that does not exist
  // (found reviewing kangzj/lantern-tv#354).
  let failed;
  try {
    execFileSync('node', [cli, 'lint', noExportDir], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('lint excused a plugin that exports nothing');
  } catch (error) {
    failed = error;
  }
  const output = `${failed.stdout}${failed.stderr}`;
  assert.match(output, /MISSING_EXPORT/);
  assert.doesNotMatch(output, /may be the scan rather than the plugin/);
});

test('an indirect computed key is blindness, not an absence', () => {
  // `{ [NAMES[0]]() {} }` is a real export on both hosts — `Object.keys` sees it — and a
  // key this cannot fold. It was read as absent, so `lint` refused a plugin that runs
  // (found reviewing kangzj/lantern-tv#354). A *literal* computed key is folded by the
  // minifier before the scan and is unaffected.
  const output = execFileSync('node', [cli, 'lint', computedKeyDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract.*appears not to export/);
});

test('lint names the record a plugin should look in when it calls something no host has', () => {
  // The message has to point at the list of host functions, not at the file that records
  // when each arrived — adding a name there would not silence it, and that file carries no
  // names by design.
  const output = execFileSync('node', [cli, 'lint', unknownCallDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract.*yonto\.teleport/);
  assert.match(output, /conformance\/host-functions\.json/);
});

const deadEntryDir = fileURLToPath(new URL('../test-plugins/dead-entry/', import.meta.url));

// The failure this replaces lands on a viewer: the plugin installs, every request is
// refused, and the refusal prints the very entry that was supposed to permit it.
test('lint refuses an allowedHosts entry no host can ever match', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', deadEntryDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /999\.999\.999\.999/);
      assert.match(error.stderr, /example\.123/);
      // A leading zero commits a part to octal, so this was meant to be an address and
      // fails to be one — which makes it no host rather than the name "08".
      assert.match(error.stderr, /\b08\b/);
      // A wildcard whose suffix is the tail of no address: a dotted quad has four parts.
      assert.match(error.stderr, /\*\.1\.2\.3\.4\.5/);
      // What must NOT be refused, in the same message: a real name, and a wildcard that
      // genuinely matches — `hostAllowed` accepts `192.168.1.1` for `*.1.1`, which is why
      // the suffix is judged by what it can match rather than by what it parses to.
      assert.doesNotMatch(error.stderr, /h\.tv/);
      assert.doesNotMatch(error.stderr, /\*\.1\.1\b/);
      // Refused before the private-address warning, which goes to stdout: a numeric
      // wildcard suffix draws that warning by design, and "your entry is on the viewer's
      // own network" is the wrong sentence for one that is not a host at all.
      assert.doesNotMatch(error.stdout, /⚠/);
      return true;
    },
  );
});

// The plugins that ship are the regression bar: a rule that refuses one of them is wrong.
test('every plugin this repository ships still lints', () => {
  // Read off disk rather than listed here, the way contract-version.test.js and
  // doctor.test.js do: a fifth plugin has to clear this bar too.
  const pluginsDir = fileURLToPath(new URL('../../../plugins/', import.meta.url));
  const ids = readdirSync(pluginsDir).filter((id) => existsSync(join(pluginsDir, id, `${id}-plugin.js`)));
  assert.ok(ids.length >= 4, `expected the shipped plugins, found ${ids.join(', ')}`);
  for (const id of ids) {
    const dir = fileURLToPath(new URL(`../../../plugins/${id}/`, import.meta.url));
    assert.match(execFileSync('node', [cli, 'lint', dir], { encoding: 'utf8' }), /✓ manifest/);
  }
});

const deadDefaultDir = fileURLToPath(new URL('../test-plugins/dead-default/', import.meta.url));

// The same rule on the other side of the form: a default seeds the editor, so one that
// names no host makes a form that refuses its own prefilled value the moment a viewer taps
// Save — and the author, whose plugin lints clean, hears about it from them.
test('lint refuses a url default the editor would refuse on Save', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', deadDefaultDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /configSchema\.siteUrl default example\.123/);
      assert.doesNotMatch(error.stderr, /mirrorUrl/);
      return true;
    },
  );
});

const requiredBoolDir = fileURLToPath(new URL('../test-plugins/required-bool/', import.meta.url));

// The refusal judged a field by its `default` alone, and a bool has no use for one: it is
// one of two strings, a form has no third thing to show, and `PluginConfigForm.normalize`
// answers 'false' for one nobody touched — so `validate` can never call it missing and the
// install works exactly as `source` promises. Refusing it left an author to drop `required`
// or write `source-type` and mean neither.
test('lint accepts a source whose only required field is a bool, which is never unanswered', () => {
  const output = execFileSync('node', [cli, 'lint', requiredBoolDir], { encoding: 'utf8' });

  assert.match(output, /provides=source/);
  assert.doesNotMatch(output, /required with no default/);
});

const staleChoiceDir = fileURLToPath(new URL('../test-plugins/stale-choice/', import.meta.url));

// What a plugin is handed has to be what a television hands it, or a check that passes here
// is a check of a different program. `configFor` seeds the manifest's defaults and once
// passed them through verbatim: a `choice` default naming no option this manifest offers
// reached the plugin as that string, while `PluginConfigForm.normalize` blanks it on a
// device, and a `bool` with no default reached it as nothing at all where a device says
// 'false'. Both were silent — a different branch taken rather than a refusal anyone sees.
test('a plugin is handed the config a television would hand it, not the manifest verbatim', () => {
  const output = execFileSync('node', [cli, 'run', staleChoiceDir, 'getCategories'], { encoding: 'utf8' });

  // The plugin JSON-stringifies what it was handed, and `run` prints JSON, so a string is
  // escaped once more on the way out. A blanked choice is no answer at all, and no key, as
  // on a device (kangzj/lantern-tv#414), which is `undefined` rather than a quoted nothing.
  assert.ok(output.includes('quality:undefined'), `choice default not blanked: ${output}`);
  assert.ok(output.includes('subs:\\"false\\"'), `bool not seeded: ${output}`);
});

const claimsASourceDir = fileURLToPath(new URL('../test-plugins/claims-a-source/', import.meta.url));
/** Runs the CLI and hands back how it ended, whether that was a success or not. */
function ran(args, options = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [cli, ...args], { encoding: 'utf8', stdio: 'pipe', ...options }), stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}


test('run from inside a plugin directory needs no directory, as the other commands do', () => {
  // The usage writes the directory as optional and lint, doctor and bundle all default it,
  // so `run getCategories` read the method as a directory (kangzj/lantern-tv#343).
  const { status, stdout, stderr } = ran(['run', 'getCategories'], { cwd: staleChoiceDir });

  assert.equal(status, 0, stderr);
  assert.ok(stdout.includes('quality:'), stdout);
});

test('an argument that is not JSON says so, and shows the quoting', () => {
  const { status, stderr } = ran(['run', staleChoiceDir, 'search', '庆余年']);

  assert.equal(status, 2);
  assert.match(stderr, /庆余年 is not JSON/);
  assert.ok(stderr.includes(`'"庆余年"'`), stderr);
  assert.ok(!/^\s+at /m.test(stderr), `a stack reached the author: ${stderr}`);
});

test('a directory that is not there is named, not read as a method', () => {
  // `run jellyfn getCategories` from plugins/ used to say jellyfn/jellyfn-plugin.js could not
  // be read, which points at the typo; reading it as a method named the wrong folder instead.
  const { status, stderr } = ran(['run', 'no-such-plugin', 'getCategories'], { cwd: tmpdir() });

  assert.equal(status, 2);
  assert.match(stderr, /no-such-plugin is not a directory/);
});

test('a file named for the method does not stand in for the plugin directory', () => {
  const dir = join(scratchDir('lp-'), 'stale-choice');
  mkdirSync(dir);
  writeFileSync(join(dir, 'stale-choice-plugin.js'), readFileSync(join(staleChoiceDir, 'stale-choice-plugin.js')));
  writeFileSync(join(dir, 'getCategories'), 'notes');

  const { status, stderr } = ran(['run', 'getCategories'], { cwd: dir });

  assert.equal(status, 0, stderr);
});

test('the quoting shown for an argument survives an apostrophe', () => {
  const { stderr } = ran(['run', staleChoiceDir, 'search', "it's"]);

  // What a shell makes of the suggestion is the argument, JSON-quoted once.
  const suggested = stderr.slice(stderr.indexOf('search ') + 'search '.length).trim();
  assert.equal(execFileSync('sh', ['-c', `printf %s ${suggested}`], { encoding: 'utf8' }), '"it\'s"');
});

test('a required field named like an inherited property is refused as missing, not a crash', () => {
  const dir = join(scratchDir('lp-'), 'inherited-name');
  mkdirSync(dir);
  writeFileSync(join(dir, 'inherited-name-plugin.js'), readFileSync(join(staleChoiceDir, 'stale-choice-plugin.js'), 'utf8')
    .replace('"id": "stale-choice"', '"id": "inherited-name"')
    .replace('"id": "subs",\n      "label": "Subtitles",\n      "type": "bool"', '"id": "toString",\n      "label": "Token",\n      "type": "text"'));

  const { status, stderr } = ran(['run', dir, 'getCategories']);

  assert.equal(status, 1, stderr);
  assert.match(stderr, /CONFIG_MISSING .*toString \(text\)/);
});

test('a plugin is found from inside its own directory, however the path is spelt', () => {
  // `basename('.')` is `.`, so `lint .` looked for `.-plugin.js` (kangzj/lantern-tv#490).
  for (const spelling of ['.', './', '../stale-choice']) {
    for (const args of [['lint', spelling], ['run', spelling, 'getCategories']]) {
      const { status, stderr } = ran(args, { cwd: staleChoiceDir });
      assert.equal(status, 0, `${args.join(' ')}: ${stderr}`);
    }
  }
});

test('doctor pages a listing the way its manifest says it pages', () => {
  // A cursor from a plugin that declares cursor paging is handed back; read without the
  // manifest, the same answer is refused as a cursor a television would never return.
  const { stdout } = ran(['doctor', fileURLToPath(new URL('../test-plugins/pages-by-cursor/', import.meta.url))]);

  assert.match(stdout, /✓ getMediaList \(next page\) +1 item/);
});

test('lint refuses a url default the editor would refuse, asked the way the form asks', () => {
  // `::1` read as a bare host is loopback, but typed into the form it is no address the
  // editor saves, and a run refused it where lint only warned (kangzj/lantern-tv#537).
  const dir = join(scratchDir('lp-'), 'loopback-default');
  mkdirSync(dir);
  writeFileSync(join(dir, 'loopback-default-plugin.js'), `/* yonto-plugin
{ "kind": "content-source", "id": "loopback-default", "name": "L", "version": "1.0.0",
  "contractVersion": 21, "provides": "source-type", "allowedHosts": [],
  "configSchema": [{ "id": "server", "label": "Server", "type": "url", "default": "::1" }] }
*/
export default {
  async getCategories() { return []; }, async getMediaList() { return []; },
  async getMediaDetail() { return null; }, async search() { return []; },
};
`);

  const { status, stderr } = ran(['lint', dir]);

  assert.equal(status, 1);
  assert.match(stderr, /configSchema\.server default ::1 names no host/);
});

test('run with no method says what run takes', () => {
  const { status, stderr } = ran(['run'], { cwd: staleChoiceDir });

  assert.equal(status, 2);
  assert.match(stderr, /run \[dir\] <method> \[args\.\.\.\]/);
});

test('--help is an answer, not a failure', () => {
  const { status, stdout } = ran(['--help']);

  assert.equal(status, 0);
  assert.match(stdout, /yonto-plugin <command>/);
});


// A television takes `provides` at its word: installing a `source` writes that profile out
// of the manifest's own defaults, asking nothing. This refusal is the only thing holding
// the word to the truth, so a plugin that claims to be a source and then wants an answer is
// refused on the author's machine rather than on somebody's television.
test('lint refuses a plugin that claims to be a source and cannot be configured without asking', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', claimsASourceDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /provides says this plugin is a source/);
      assert.match(error.stderr, /siteUrl is required with no default/);
      assert.match(error.stderr, /provides: 'source-type'/);
      return true;
    },
  );
});

// The other direction is deliberately not a rule: a plugin whose fields are all optional
// may still want each instance added on purpose, and only its author knows that. `lan-host`
// is such a plugin — one `url` field, not required — and it lints.
test('lint accepts a source-type whose fields a viewer could have left alone', () => {
  assert.match(execFileSync('node', [cli, 'lint', lanHostDir], { encoding: 'utf8' }), /provides=source-type/);
});

// The manifest has to say which it is — a plugin that leaves it out is a plugin whose
// author never decided, and an install would have to guess on their behalf.
test('lint refuses a manifest that does not say what the plugin provides', () => {
  const dir = scratchDir('yonto-no-provides-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename(dir)}-plugin.js`),
    readFileSync(join(okDir, 'ok-plugin.js'), 'utf8').replace(/^\s*"provides".*\n/m, ''));

  assert.throws(
    () => execFileSync('node', [cli, 'lint', dir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /must have required property 'provides'/);
      return true;
    },
  );
});

const needsConfigDir = fileURLToPath(new URL('../test-plugins/needs-config/', import.meta.url));
const opensRankedDir = fileURLToPath(new URL('../test-plugins/opens-ranked/', import.meta.url));
const defaultedDir = fileURLToPath(new URL('../test-plugins/defaulted-config/', import.meta.url));
const jellyfinDir = fileURLToPath(new URL('../../../plugins/jellyfin/', import.meta.url));

// The failure this replaces was seven identical `not a URL:` lines with nothing after the
// colon, which is what a required field reaches a plugin as when nobody filled it in.
test('doctor refuses a plugin whose required config is missing, naming the field', () => {
  assert.throws(
    // With the plugin's own doctor.json blanked, since that is what would satisfy it.
    () => execFileSync('node', [cli, 'doctor', needsConfigDir], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":""}' },
    }),
    (error) => {
      assert.match(error.stderr, /CONFIG_MISSING/);
      assert.match(error.stderr, /siteUrl \(url\)/);
      // A field that is not required is not asked for.
      assert.doesNotMatch(error.stderr, /note/);
      // The two ways to supply it, because neither was written down anywhere.
      assert.match(error.stderr, /doctor\.json/);
      assert.match(error.stderr, /YONTO_PLUGIN_CONFIG/);
      return true;
    },
  );
});

test('doctor takes the required config from the environment', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":"https://h.tv"}' },
    }),
    (error) => {
      // Past the config gate: it is asking for a fixture now, not refusing to start.
      assert.doesNotMatch(error.stdout, /CONFIG_MISSING/);
      assert.match(error.stdout, /NO_FIXTURE/);
      return true;
    },
  );
});

// Telling an author to `--record` is wrong for a plugin whose fixtures were never
// recordable — plugins/ddys needs a session cookie and a cookie must not be committed.
test('replay says when a plugin has no recorded fixtures at all', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":"https://h.tv"}' },
    }),
    (error) => {
      assert.match(error.stdout, /no recorded fixtures at all/);
      assert.doesNotMatch(error.stdout, /re-run with --record/);
      return true;
    },
  );
});

// The file is the point of the change: an author should not have to remember an
// environment variable to exercise a plugin that cannot run without config.
test('doctor takes the required config from the plugin\'s own doctor.json', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.doesNotMatch(error.stdout, /CONFIG_MISSING/);
      assert.match(error.stdout, /from-the-file\.test/);
      return true;
    },
  );
});

test('YONTO_PLUGIN_CONFIG wins over the file, so one run can differ', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":"https://from-the-env.test"}' },
    }),
    (error) => {
      assert.match(error.stdout, /from-the-env\.test/);
      assert.doesNotMatch(error.stdout, /from-the-file\.test/);
      return true;
    },
  );
});

// A television has no way to give a plugin anything but a string, so a config that runs
// here and nowhere else is the CLI/device split this tool exists to remove.
test('a config value that is not a string is refused, naming the field', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":8096}' },
    }),
    (error) => {
      assert.match(error.stderr, /CONFIG_INVALID/);
      assert.match(error.stderr, /siteUrl in YONTO_PLUGIN_CONFIG is number/);
      return true;
    },
  );
});

test('config that is not JSON says which of the two it was', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: 'nonsense' },
    }),
    (error) => {
      assert.match(error.stderr, /CONFIG_INVALID/);
      assert.match(error.stderr, /YONTO_PLUGIN_CONFIG could not be read/);
      return true;
    },
  );
});

// The other half of replay's two-way message. A plugin that *has* fixtures and is missing
// one is the case `--record` is the right advice for, and nothing asserted it.
test('replay still says to record when the plugin has fixtures but not this one', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'run', jellyfinDir, 'search', '"nothing-was-recorded-for-this"', '--replay'],
      { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /re-run with --record/);
      assert.doesNotMatch(error.stderr, /no recorded fixtures at all/);
      return true;
    },
  );
});

// What the editor would have saved: a viewer types `h.tv` on a remote and gets a working
// source, so an author who writes the same thing must not get `not a URL: h.tv/list`.
test('a url field is given a scheme and trimmed, the way the editor saves one', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":"  h.tv  "}' },
    }),
    (error) => {
      assert.match(error.stdout, /http:\/\/h\.tv\/list/);
      return true;
    },
  );
});

// And without the path's trailing slashes, which the editor drops too (kangzj/lantern-tv#351):
// a plugin appending `/list` to `h.tv/` would otherwise ask for `//list` here and not on a box.
test('a url field loses its trailing slashes, the way the editor saves one', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":"h.tv/base//"}' },
    }),
    (error) => {
      assert.match(error.stdout, /http:\/\/h\.tv\/base\/list/);
      return true;
    },
  );
});

// A manifest `default` is a value the device really stores — the form is seeded with it and
// a viewer who taps Save has kept it — so the plugin has to be handed it here too, not
// merely counted as present by the gate.
test('a manifest default reaches the plugin, not just the required-config check', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', defaultedDir, '--replay'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.doesNotMatch(error.stdout, /CONFIG_MISSING/);
      assert.doesNotMatch(error.stdout, /undefined/);
      assert.match(error.stdout, /https:\/\/from-the-manifest\.test\/list/);
      return true;
    },
  );
});

// A key the manifest never declared reaches a plugin nowhere on a television, because the
// editor builds a profile's config out of configSchema alone.
test('a config key no field declares is dropped, as the device drops it', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'doctor', needsConfigDir, '--replay'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YONTO_PLUGIN_CONFIG: '{"siteUrl":"https://h.tv","undeclared":"kept?"}' },
    }),
    (error) => {
      assert.doesNotMatch(error.stdout, /kept\?/);
      return true;
    },
  );
});

// kangzj/lantern-tv#89: a hostsFromConfig plugin cannot have signed artwork, because signing
// follows an allowlist it has none of. The boundary is settled — the alternative lets a
// stranger's config decide where a token goes — so what was missing was anyone saying it.
test('lint says a hostsFromConfig plugin cannot have signed artwork', () => {
  const output = execFileSync('node', [cli, 'lint', cangSignsDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract {10}getImageHeaders is exported by a hostsFromConfig plugin/);
  assert.match(output, /a manifest that names the hosts they come from/);
});

test('a plugin with an allowlist may sign, and hears nothing about it', () => {
  // jellyfin exports getImageHeaders and has a `url` field rather than hostsFromConfig —
  // the case the warning must not fire on, or it fires on the only plugin that uses this.
  const jellyfin = fileURLToPath(new URL('../../../plugins/jellyfin/', import.meta.url));

  const output = execFileSync('node', [cli, 'lint', jellyfin], { encoding: 'utf8' });

  assert.doesNotMatch(output, /getImageHeaders is exported by a hostsFromConfig plugin/);
});

// A picker whose answer nothing reads is a switch that appears to work and changes nothing,
// which reaches a viewer with no error anywhere in it.
test('lint refuses a plugin that offers libraries and never reads which one was picked', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', deafPickerDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /yonto\.subSource\(\) is never read/);
      return true;
    },
  );
});

test('lint says the library a viewer picks is thrown away when the pick is never read', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', deafPickerDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /so the library a viewer picks is thrown away/);
      return true;
    },
  );
});

test('a plugin that reads the pick lints clean', () => {
  const output = execFileSync('node', [cli, 'lint', pickerDir], { encoding: 'utf8' });

  // Named as a reason for version 4, and not warned about: the pairing rule is silent
  // exactly when both halves are there.
  assert.match(output, /✓ contract {10}21\n/);
  assert.doesNotMatch(output, /⚠/);
});

// The scan cannot see a host reached through a local name, and refusing a plugin that does
// read the pick is worse than warning about one that does not.
test('a picker the scan cannot read is warned about rather than refused', () => {
  const output = execFileSync('node', [cli, 'lint', blindPickerDir], { encoding: 'utf8' });

  assert.match(output, /⚠ contract {10}getSubSources is exported and no yonto\.subSource\(\) call was found/);
});

// No plugin under plugins/ is several libraries since tvbox and xptv retired, so this is what
// carries the pick from `YONTO_PLUGIN_SUBSOURCE` through the commands an author runs.
test('run reads the library the host was told to, and offers the rest', () => {
  const pickedSouth = { env: { ...process.env, YONTO_PLUGIN_SUBSOURCE: 'south' } };

  const offered = JSON.parse(ran(['run', subSourcesDir, 'getSubSources']).stdout);
  const south = JSON.parse(ran(['run', subSourcesDir, 'getSubSources'], pickedSouth).stdout);
  const searched = JSON.parse(ran(['run', subSourcesDir, 'search', '"片"'], pickedSouth).stdout);

  assert.deepEqual(offered.items.map((it) => [it.id, it.available ?? true]), [['north', true], ['south', true], ['resting', false]]);
  assert.equal(offered.activeId, 'north');
  assert.equal(south.activeId, 'south');
  assert.deepEqual(searched, [{ id: 'south-1', title: '南方资源库的第1部片' }]);
});

test('run on a resting pick reads the library the source fell through to', () => {
  const pickedResting = { env: { ...process.env, YONTO_PLUGIN_SUBSOURCE: 'resting' } };

  const offered = JSON.parse(ran(['run', subSourcesDir, 'getSubSources'], pickedResting).stdout);
  const listed = JSON.parse(ran(['run', subSourcesDir, 'getMediaList', '"latest"', '{"page":2}'], pickedResting).stdout);

  assert.equal(offered.activeId, 'north');
  assert.deepEqual(listed.map((it) => it.id), ['north-2']);
});

test('doctor walks the library that was picked, and says which one it read', () => {
  const { status, stdout } = ran(['doctor', subSourcesDir], { env: { ...process.env, YONTO_PLUGIN_SUBSOURCE: 'south' } });

  assert.equal(status, 0, stdout);
  assert.match(stdout, /✓ getSubSources +3 libraries \(1 unavailable\), reading 南方资源库/);
});

test('a source with a remote library list and a picker lints clean', () => {
  const output = execFileSync('node', [cli, 'lint', subSourcesDir], { encoding: 'utf8' });

  assert.match(output, /✓ contract {10}21\n/);
  assert.doesNotMatch(output, /⚠/);
});

// A `track` option is the only thing that could ever call getStream, so a plugin exporting
// one without admitting it may answer a token has declared a surface nothing can reach —
// and the app, reading the manifest alone, would decode its options with `stream` required.
test('lint refuses a plugin that exports getStream without declaring playbackTokens', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', redeemsUndeclaredDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /getStream is exported and playbackTokens is not declared/);
      return true;
    },
  );
});

test('a source that declares playbackTokens and redeems its own token lints clean', () => {
  const output = execFileSync('node', [cli, 'lint', redeemsTokensDir], { encoding: 'utf8' });

  assert.match(output, /✓ contract {10}21\n/);
  assert.doesNotMatch(output, /⚠/);
});

// A source whose library list is a document somewhere else declares it, and the declaration
// is what buys the picker a wait to show instead of closing on an empty answer.
test('a source that declares a remote library list lints clean', () => {
  const output = execFileSync('node', [cli, 'lint', remoteCatalogsDir], { encoding: 'utf8' });

  assert.match(output, /✓ contract {10}21\n/);
  assert.doesNotMatch(output, /⚠/);
});

// The declaration says one thing, about one call. Without that call it says nothing at all,
// and there is no reading of the manifest under which it was meant.
test('lint refuses a remote library list on a plugin with no picker', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', remoteCatalogsNoPickerDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /catalogsAreRemote says this source has to fetch its library list/);
      return true;
    },
  );
});

const handlerDir = fileURLToPath(new URL('../test-plugins/handler/', import.meta.url));
const refusedHandlerDir = fileURLToPath(new URL('../test-plugins/refused-handler/', import.meta.url));

test('lint accepts a handler whose form holds the types it claims', () => {
  const { status, stdout, stderr } = ran(['lint', handlerDir]);

  assert.equal(status, 0, stderr);
  assert.match(stdout, /✓ manifest/);
});

test('lint refuses a handler for every rule it breaks, all at once', () => {
  const { status, stderr } = ran(['lint', refusedHandlerDir]);

  assert.equal(status, 1);
  assert.match(stderr, /MANIFEST_INVALID {2}handles is refused/);
  for (const reason of [
    /plugin is a short id, which is Yonto's, and contracts\/yonto-types\/ has no plugin\.schema\.json/,
    /maccms-jsn is a short id/,
    /maccms-xml's api is a url field, and configSchema declares it as text/,
    /maccms-xml fills dialect with xml/,
    /exports getSubSources/,
    /declares catalogsAreRemote/,
    /provides 'source-type', not 'source'/,
  ]) assert.match(stderr, reason);
});

test('lint refuses a type name outside the shared grammar at the manifest, saying what one is', () => {
  const dir = scratchDir('yonto-bad-name-');
  const plugin = readFileSync(join(handlerDir, 'handler-plugin.js'), 'utf8')
    .replace('"io.github.someone.alist"', '"io.github.a-"');
  mkdirSync(join(dir, 'bad-name'));
  writeFileSync(join(dir, 'bad-name', 'bad-name-plugin.js'), plugin);

  const { status, stderr } = ran(['lint', join(dir, 'bad-name')]);

  assert.equal(status, 1);
  assert.match(stderr, /MANIFEST_INVALID/);
  assert.match(stderr, /\/handles\/2 must match pattern.* — A short id for Yonto's own type/);
});

test('a hostsFromConfig plugin that signs nothing hears nothing', () => {
  // xptv-js: hostsFromConfig and no getImageHeaders. What is under test is the lint rule
  // rather than the plugin.
  const xptvJs = fileURLToPath(new URL('../../../plugins/xptv-js/', import.meta.url));

  const output = execFileSync('node', [cli, 'lint', xptvJs], { encoding: 'utf8' });

  assert.doesNotMatch(output, /getImageHeaders is exported by a hostsFromConfig plugin/);
});

test('lint refuses a cookieLogin that writes a session into a config field', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', writesToLoginDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /writesTo/);
      return true;
    },
  );
});

/**
 * What `lint` says about the XPTV loader, which kangzj/lantern-tv#374 asked to be decided
 * rather than left to happen.
 *
 * The worry was that its answer here is an unverifiable author claim: this plugin fetches a
 * stranger's JavaScript and runs it, `contract-version.js` cannot see fetched code at all,
 * and CI lints every directory under `plugins/`. The decision is that **lint says exactly
 * what it says about any other plugin, and that it can is a property worth holding** —
 * because kangzj/lantern-tv#371 built the twelve shims out of explicit `yonto.x.y`
 * references instead of handing `yonto` to them as a value. That is what keeps the scan
 * able to read the whole host surface this plugin has, so the number is derived and checked
 * in both directions rather than declared.
 *
 * Which is a decision one edit can undo. Destructure the host here — `const { fetch } =
 * yonto` — and the scan lands in `unclassified`, lint's answer silently becomes a floor
 * plus a warning, and nothing else in the suite would notice. This is what notices.
 *
 * The part that stays unknowable is what the fetched code does, and no lint could answer it:
 * a catalog reaches the host through these shims or it reaches around them with
 * `new Function('return this')()`, and neither is a contract version. `plugins/xptv-js/AGENTS.md`'s
 * *What a hostile catalog reaches* is where that lives.
 */
test('lint reads the XPTV loader whole: a derived contract version and no warning', () => {
  const pluginDir = fileURLToPath(new URL('../../../plugins/xptv-js/', import.meta.url));

  const output = execFileSync('node', [cli, 'lint', pluginDir], { encoding: 'utf8' });

  // Printed only when the version the scan derived equals the one the manifest declares.
  assert.match(output, /✓ contract {10}21\n/);
  // The shims are named calls, so the host surface is read rather than guessed at: a
  // destructured host would have been warned about as one no name can be read out of.
  assert.doesNotMatch(output, /⚠/);
});

/**
 * The wire, not the logic: `createHost` collects what a plugin says, `runDoctor` attributes
 * it to a step and `formatReport` prints it — and none of that reaches a person unless
 * `doctor()` in `cli.js` passes the host's log along.
 *
 * Every other test of this mechanism hands `runDoctor` a log directly, so all of them stay
 * green with that one argument dropped. This is the argument at the one call site that
 * `AGENTS.md` says a reviewer's eye slides over because it looks like plumbing.
 */
test('doctor prints what the plugin said, through the command an author actually runs', () => {
  const { stdout } = ran(['doctor', fileURLToPath(new URL('../test-plugins/says-while-reading/', import.meta.url))]);

  // Said by the plugin while the detail was read, and printed under that step.
  assert.match(stdout, /✓ getMediaDetail .*\n {4}· info {2}title m: 1 tracks, 0 of them a share\n/);
});

const undrivenLoginDir = fileURLToPath(new URL('../test-plugins/undriven-login/', import.meta.url));
const drivenLoginDir = fileURLToPath(new URL('../test-plugins/driven-login/', import.meta.url));

// kangzj/lantern-tv#340: both hosts accept a login no host drives, and a television never draws it.
test('lint warns about a login no host drives, and passes the plugin', () => {
  const output = execFileSync('node', [cli, 'lint', undrivenLoginDir], { encoding: 'utf8' });

  assert.match(output, /⚠ cookieLogin at https:\/\/other\.example\/login will never be offered.*https:\/\/ddys\.app/);
});

const pointerLoginDir = fileURLToPath(new URL('../test-plugins/pointer-login/', import.meta.url));
const browserCheckDir = fileURLToPath(new URL('../test-plugins/browser-check/', import.meta.url));

// kangzj/lantern-tv#359: accepted and ignored was the trap, so the schema refuses it now.
test('lint refuses a pointerLogin, which no host ever drove', () => {
  assert.throws(
    () => execFileSync('node', [cli, 'lint', pointerLoginDir], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.match(error.stderr, /MANIFEST_INVALID/);
      assert.match(error.stderr, /capabilities/);
      return true;
    },
  );
});

test('lint takes a browserCheck, and says nothing about it as a login', () => {
  const output = execFileSync('node', [cli, 'lint', browserCheckDir], { encoding: 'utf8' });

  assert.doesNotMatch(output, /will never be offered/);
  assert.match(output, /✓ contract {10}21\n/);
});

test('lint says nothing about the login a host does drive', () => {
  const output = execFileSync('node', [cli, 'lint', drivenLoginDir], { encoding: 'utf8' });

  assert.doesNotMatch(output, /will never be offered/);
});

const saysPartialDir = fileURLToPath(new URL('../test-plugins/says-partial/', import.meta.url));

// kangzj/lantern-tv#357: the sentence a television shows under the row, so an author sees it too.
test('doctor prints a partial answer\'s sentence under the step that said it, and nowhere else', () => {
  const output = execFileSync('node', [cli, 'doctor', saysPartialDir], { encoding: 'utf8' });

  // Cleaned as a television cleans a line: the override and the bell are gone.
  assert.match(output, /✓ getMediaList +1 item[^\n]*\n {4}◐ partial 四个站点中有一个没有回应，列表可能不全。\n/);
  assert.match(output, /✓ getMediaList \(next page\)[^\n]*\n {4}◐ partial 第二页只问到了三个站点。\n/);
  // The listing's first sentence was replaced by its second, the categories' is on a method no
  // screen shows it for, the detail's is blank once cleaned, and the search took its own back.
  assert.equal(output.match(/◐/g).length, 2, output);
});

test('run prints a partial answer\'s sentence beside the answer, cleaned, not inside it', () => {
  const { status, stdout, stderr } = spawnSync('node',
    [cli, 'run', saysPartialDir, 'getMediaList', '"a"', '{"page":1,"filters":{}}'], { encoding: 'utf8' });

  assert.equal(status, 0, stderr);
  assert.match(stderr, /◐ partial 四个站点中有一个没有回应，列表可能不全。\n/);
  assert.deepEqual(JSON.parse(stdout), [{ id: 'm', title: 'M' }]);
});

test('run prints no partial sentence for a method a television shows none for, or for a bell', () => {
  for (const method of ['getCategories', 'getMediaDetail']) {
    const { status, stderr } = spawnSync('node', [cli, 'run', saysPartialDir, method, '"m"'], { encoding: 'utf8' });

    assert.equal(status, 0, stderr);
    assert.doesNotMatch(stderr, /◐/, method);
  }
});
