import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundlePlugin } from '../src/bundle.js';
import { LATEST, OLDEST } from '../src/contract-version.js';
import { loadManifest } from '../src/manifest.js';
import {
  buildIndex, entryProblems, fetchBounded, indexProblems, pluginEntries, pluginEntry, versionedUrl,
} from '../src/index-document.js';
import { scratchDir } from '../src/scratch-dir.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const pluginsDir = fileURLToPath(new URL('../../../plugins/', import.meta.url));
const okDir = fileURLToPath(new URL('../test-plugins/ok/', import.meta.url));

const SHA = 'a'.repeat(64);

function entry(overrides = {}, config = {}) {
  const site = pluginEntry(
    { id: 'demo', name: 'Demo', version: '1.0.0', contractVersion: 21, provides: 'source' },
    'https://plugins.example/demo/demo-1.0.0.zip',
    SHA,
  );
  return { ...site, ...overrides, ext: { ...site.ext, config: { ...site.ext.config, ...config } } };
}

/** A type-50 entry of a type other than `plugin`, with none of the FongMi fields. */
function catalog(yontoType, overrides = {}) {
  return {
    key: 'home-jf', name: '家里的 Jellyfin', type: 50, api: 'https://jf.example.com',
    ext: { yontoType, config: { serverUrl: 'https://jf.example.com' } },
    ...overrides,
  };
}

async function okZip() {
  const { zipPath, sha256 } = await bundlePlugin({ dir: okDir, outDir: scratchDir('lp-index-') });
  return { bytes: readFileSync(zipPath), sha256, manifest: loadManifest(okDir) };
}

test('an index built from plugins/ names each versioned zip with the sha256 bundle printed', async () => {
  const document = await buildIndex({ pluginsDir, baseUrl: 'https://plugins.example/download/' });

  assert.deepEqual(indexProblems(document), []);
  // Whatever plugins/ holds, so adding a plugin never breaks this.
  const published = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, `${d.name}-plugin.js`)))
    .map((d) => loadManifest(join(pluginsDir, d.name)).id)
    .sort();
  assert.deepEqual(document.sites.map((site) => site.ext.config.id), published);
  // The last one, so a build that stopped early or hashed the wrong file can't pass.
  const last = published.at(-1);
  const manifest = loadManifest(join(pluginsDir, last));
  const { sha256 } = await bundlePlugin({ dir: join(pluginsDir, last), outDir: scratchDir('lp-index-') });
  const listed = document.sites.find((site) => site.ext.config.id === last);
  assert.equal(listed.api, `https://plugins.example/download/${last}/${last}-${manifest.version}.zip#sha256=${sha256}`);
  assert.equal(listed.ext.config.contractVersion, manifest.contractVersion);
});

test('building an index writes nothing into a plugin\'s dist/, which is Gradle\'s output', async () => {
  const plugins = scratchDir('lp-index-plugins-');
  cpSync(okDir, join(plugins, 'ok'), { recursive: true, filter: (path) => !path.includes('/dist') });

  const document = await buildIndex({ pluginsDir: plugins, baseUrl: 'https://plugins.example/download/' });

  assert.equal(document.sites.length, 1);
  assert.equal(existsSync(join(plugins, 'ok', 'dist')), false);
});

test('the versioned address is the one the publisher uploads to', () => {
  assert.equal(versionedUrl('https://x.test/d//', 'ddys', '1.2.0'), 'https://x.test/d/ddys/ddys-1.2.0.zip');
});

test('a plugin entry carries its payload in ext.config, described by the plugin type\'s schema', () => {
  assert.deepEqual(entry().ext, {
    yontoType: 'plugin',
    config: { id: 'demo', version: '1.0.0', contractVersion: 21, provides: 'source' },
  });
  const missing = indexProblems({ sites: [entry({}, { version: undefined })] });
  assert.ok(missing.some((p) => p.startsWith('/sites/0/ext/config')), missing.join('\n'));
  // Fields are added within a name, so an extra one is allowed.
  assert.deepEqual(indexProblems({ sites: [entry({}, { size: 12345 })] }), []);
});

/** So a repo can offer a type's handler without downloading every zip it lists. */
test('a handler\'s entry carries the types it handles, copied from its manifest, and another\'s carries none', async () => {
  const document = await buildIndex({ pluginsDir, baseUrl: 'https://plugins.example/download/' });
  for (const site of document.sites) {
    const manifest = loadManifest(join(pluginsDir, site.ext.config.id));
    assert.deepEqual(site.ext.config.handles, manifest.handles?.length ? manifest.handles : undefined, manifest.id);
  }
  assert.ok(document.sites.some((site) => site.ext.config.handles?.length), 'some published plugin is a handler');
  assert.deepEqual(indexProblems({ sites: [entry({}, { handles: ['Not A Type'] })] }).length > 0, true);
});

test('a plugin entry without a sha256 in its api is refused', () => {
  const problems = indexProblems({ sites: [entry({ api: 'https://plugins.example/demo/demo-1.0.0.zip' })] });
  assert.ok(problems.some((p) => p.startsWith('/sites/0/api')), problems.join('\n'));
});

test('a Yonto entry typed as the string "50" is refused', () => {
  const problems = indexProblems({ sites: [entry({ type: '50' })] });
  assert.ok(problems.some((p) => p.startsWith('/sites/0 must NOT be valid')), problems.join('\n'));
});

/**
 * The documents the third review of #626 probed, each read as the app's reader reads it
 * (`readIndex`, #648): which plugin entries are offered, as `key@version`, and what is skipped.
 */
const probes = (() => {
  const plugin = (id, version, overrides = {}) => ({ ...entry({}, { id, version }), key: `yonto:${id}`, ...overrides });
  const cms = (key, api) => ({ ...(key === undefined ? {} : { key }), name: 'c', type: 1, api });
  const zip = (id, version) => `https://plugins.example/${id}/${id}-${version}.zip#sha256=${SHA}`;
  return [
    ['two plugin entries for one id: the first', { sites: [plugin('demo', '1.0.0'), plugin('demo', '2.0.0')] },
      ['yonto:demo@1.0.0'], { duplicate: 1 }],
    ['one id under two keys: both, since only a key makes a duplicate', { sites: [plugin('demo', '1.0.0', { key: 'other' }), plugin('demo', '2.0.0')] },
      ['other@1.0.0', 'yonto:demo@2.0.0'], {}],
    ['a stranger keyed yonto:demo first shadows ours', { sites: [cms('yonto:demo', 'https://c.test/api.php/provide/vod'), plugin('demo', '1.0.0')] },
      [], { duplicate: 1 }],
    ['keyless entries are keyed by their address', { sites: [cms(undefined, 'https://c.test/a'), cms(undefined, 'https://c.test/a'), plugin('demo', '1.0.0')] },
      ['yonto:demo@1.0.0'], { duplicate: 1 }],
    ['an unknown type claims no key, so it shadows nothing', { sites: [{ ...plugin('demo', '1.0.0'), ext: { yontoType: 'future', config: {} } }, plugin('demo', '1.0.0')] },
      ['yonto:demo@1.0.0'], { unknownType: 1 }],
    ['a plugin with no http address claims no key', { sites: [plugin('demo', '1.0.0', { api: `ftp://x.test/demo.zip#sha256=${SHA}` }), plugin('demo', '2.0.0')] },
      ['yonto:demo@2.0.0'], { address: 1 }],
    ['a numeric key and its string are one key', { sites: [cms(7, 'https://c.test/a'), cms('7', 'https://c.test/b'), plugin('demo', '1.0.0')] },
      ['yonto:demo@1.0.0'], { duplicate: 1 }],
    ['a Yonto entry typed "50" claims no key', { sites: [{ ...plugin('demo', '1.0.0'), type: '50' }, plugin('demo', '2.0.0')] },
      ['yonto:demo@2.0.0'], { type: 1 }],
    ['a keyless XPTV script is keyed by its ext, not its class name', {
      sites: [{ name: 'a', type: 3, api: 'csp_X', ext: 'https://s.test/a.js' }, { name: 'b', type: 3, api: 'csp_X', ext: 'https://s.test/b.js' }, plugin('demo', '1.0.0')],
    }, ['yonto:demo@1.0.0'], {}],
    ['a 仓 spider claims no key', { spider: 'x.jar', sites: [{ key: 'yonto:demo', name: 's', type: 3, api: 'csp_Demo' }, plugin('demo', '1.0.0')] },
      ['yonto:demo@1.0.0'], { spider: 1 }],
    ['a keyless plugin is keyed by its address, so a keyed one for the same id is offered too', {
      sites: [plugin('demo', '1.0.0', { key: undefined }), plugin('demo', '1.0.0')],
    }, [`${zip('demo', '1.0.0')}@1.0.0`, 'yonto:demo@1.0.0'], {}],
    ['a plugin whose ext.config is missing still claims its key', { sites: [{ ...plugin('demo', '1.0.0'), ext: { yontoType: 'plugin' } }, plugin('demo', '2.0.0')] },
      ['yonto:demo@undefined'], { duplicate: 1 }],
    ['a key is trimmed', { sites: [cms(' dup ', 'https://c.test/a'), cms('dup', 'https://c.test/b')] },
      [], { duplicate: 1 }],
  ];
})();

for (const [name, document, offered, skipped] of probes) {
  test(`read as the app reads it: ${name}`, () => {
    const read = pluginEntries(document);
    const offeredEntries = read.entries.filter((e) => e.yontoType === 'plugin');
    assert.deepEqual(offeredEntries.map((e) => `${e.key}@${e.config.version}`), offered);
    assert.deepEqual(Object.fromEntries(Object.entries(read.skipped).filter(([, count]) => count > 0)), skipped);
    // Every plugin entry as written is returned, marked offered exactly when the reader offered it.
    assert.equal(read.plugins.filter((plugin) => plugin.offered).length, offered.length);
    assert.equal(read.plugins.length, document.sites.filter((site) => site.type === 50 && site.ext?.yontoType === 'plugin').length);
  });
}

/** One address, two keys: the shadowed entry is the one passed over, whichever comes first. */
test('each plugin entry is marked by its own key, not by an address another entry shares', () => {
  const squatter = { key: 'yonto:demo', name: 'not ours', type: 1, api: 'https://c.test/api.php/provide/vod' };
  const read = pluginEntries({ sites: [squatter, entry(), entry({ key: 'other' })] });

  assert.deepEqual(read.plugins.map(({ site, offered }) => `${site.key}:${offered}`), ['yonto:demo:false', 'other:true']);
});

test('a plugin entry keyed for another id is refused', () => {
  const problems = indexProblems({ sites: [entry({ key: 'yonto:other' })] });
  assert.ok(problems.some((p) => p.includes('its key is yonto:demo')), problems.join('\n'));
});

test('a plugin entry missing a field FongMi needs to leave it alone is refused', () => {
  const site = entry();
  delete site.searchable;
  const problems = indexProblems({ sites: [site] });
  assert.ok(problems.some((p) => p.includes('searchable')), problems.join('\n'));
});

test('the FongMi fields are required on plugin entries only, so a catalog may be searchable', () => {
  assert.deepEqual(indexProblems({ sites: [catalog('maccms-json', { searchable: 1 })] }), []);
});

test('a type-50 entry without yontoType is refused', () => {
  const site = entry();
  delete site.ext.yontoType;
  const problems = indexProblems({ sites: [site] });
  assert.ok(problems.some((p) => p.includes('yontoType')), problems.join('\n'));
});

const typeNames = JSON.parse(readFileSync(new URL('../conformance/yonto-type-names.json', import.meta.url), 'utf8')).cases;

test('a yontoType is a type name by the grammar handles uses too, case for case', () => {
  for (const { name, accepted, why } of typeNames) {
    const problems = indexProblems({ sites: [catalog(name)] }).filter((p) => p.startsWith('/sites/0/ext/yontoType'));
    assert.equal(problems.length === 0, accepted, `${JSON.stringify(name)} (${why}): ${problems.join('\n')}`);
  }
});

test('another yontoType is allowed and not held to the plugin shape', () => {
  assert.deepEqual(indexProblems({ sites: [catalog('jellyfin-server'), entry()] }), []);
  assert.equal(pluginEntries({ sites: [catalog('jellyfin-server'), entry()] }).plugins.filter((p) => p.offered).length, 1);
});

test('somebody else\'s entries are read as they are, string types and extra fields included', () => {
  const theirs = [
    { key: 'suoni', name: '索尼资源', type: '1', api: 'https://suoni.test/api.php/provide/vod/', timeout: 10 },
    { name: '玩偶哥哥', type: 3, api: 'csp_wogg', ext: 'https://plugins.test/js/wogg.js' },
  ];
  assert.deepEqual(indexProblems({ sites: [...theirs, entry({ timeout: 10 })] }), []);
});

test('a download that does not match the entry\'s sha256 is refused', async () => {
  const { bytes, manifest } = await okZip();
  const site = pluginEntry(manifest, 'https://plugins.example/ok.zip', SHA);

  const problems = await entryProblems(site, async () => bytes);

  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`the index says sha256 ${SHA}`));
});

test('a download whose manifest is not the entry\'s id or version is refused, naming each', async () => {
  const { bytes, sha256, manifest } = await okZip();
  const site = pluginEntry(
    { ...manifest, id: 'not-ok', version: '9.9.9' },
    'https://plugins.example/ok.zip',
    sha256,
  );

  const problems = await entryProblems(site, async () => bytes);

  assert.deepEqual(problems, [
    'yonto:not-ok: the index says id not-ok, the plugin says ok',
    `yonto:not-ok: the index says version 9.9.9, the plugin says ${manifest.version}`,
  ]);
});

test('an entry for a contract no host runs is refused before anything is fetched', async () => {
  const { sha256, manifest } = await okZip();
  for (const contractVersion of [OLDEST - 1, LATEST + 1]) {
    const site = pluginEntry({ ...manifest, contractVersion }, 'https://plugins.example/ok.zip', sha256);

    const problems = await entryProblems(site, async () => assert.fail('fetched an entry no host runs'));

    assert.deepEqual(problems, [
      `yonto:ok: the index says contractVersion ${contractVersion}, and no host runs a plugin outside ${OLDEST}–${LATEST}`,
    ]);
  }
});

test('a download that matches its entry passes, and is fetched without its fragment', async () => {
  const { bytes, sha256, manifest } = await okZip();
  const site = pluginEntry(manifest, 'https://plugins.example/ok.zip', sha256);
  const asked = [];

  assert.deepEqual(await entryProblems(site, async (url) => { asked.push(url); return bytes; }), []);
  assert.deepEqual(asked, ['https://plugins.example/ok.zip']);
});

// Waits for the close rather than a fixed time, since a stalled process fires a timer before
// I/O that had already arrived; closeAllConnections lets the file exit if the read never drops it.
test('a bounded fetch stops reading once the ceiling is passed, rather than after the whole body', { timeout: 10_000 }, async (t) => {
  let written = 0;
  let ended;
  const writtenWhenEnded = new Promise((resolve) => { ended = resolve; });
  const chunk = Buffer.alloc(64 * 1024, 1);
  const server = createServer((req, res) => {
    res.on('close', () => ended(written));
    const pump = () => {
      while (written < 64 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetchBounded(`http://127.0.0.1:${server.address().port}/big`, { maxBytes: 1024 * 1024 }), /over 1048576 bytes/);
    const timedOut = new Promise((_, reject) => {
      t.signal.addEventListener('abort', () => reject(new Error('the connection was never dropped')), { once: true });
    });
    const wrote = await Promise.race([writtenWhenEnded, timedOut]);
    assert.ok(wrote < 16 * 1024 * 1024, `the server wrote ${wrote} bytes before the read stopped`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

const run = promisify(execFile);

async function cliExit(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Serves the `ok` test plugin's zip at every path, and answers the entry for it at [path]. */
async function servingOk(run) {
  const { bytes, sha256, manifest } = await okZip();
  const server = createServer((req, res) => res.end(bytes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run((path) => pluginEntry(manifest, `${base}${path}`, sha256));
  } finally {
    server.close();
  }
}

test('index --check counts what the app\'s reader skips, says so, and passes the document', async () => {
  await servingOk(async (ok) => {
    const file = join(scratchDir('lp-index-'), 'index.json');
    const theirs = { key: 'dup', name: 'A', type: 1, api: 'https://a.test/' };
    writeFileSync(file, JSON.stringify({ sites: [theirs, { ...theirs, name: 'B' }, ok('/one.zip'), ok('/two.zip')] }));

    const result = await cliExit(['index', '--check', file]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /1 plugin entries, 1 other entries/);
    assert.match(result.stdout, /skipped as a reader skips them: repeating an earlier entry's key 2/);
    assert.match(result.stdout, /yonto:ok .*\(not offered: a reader skips it\)/);
  });
});

/** A check that passes an index nobody can install from proves nothing. */
test('index --check fails when a plugin entry cannot be fetched, a shadowed one included', async () => {
  const dir = scratchDir('lp-index-');
  const unreachable = entry({ api: `http://127.0.0.1:9/demo-1.0.0.zip#sha256=${SHA}` });
  const squatter = { key: 'yonto:demo', name: 'not ours', type: 1, api: 'https://b.test/' };

  writeFileSync(join(dir, 'only.json'), JSON.stringify({ sites: [unreachable] }));
  const only = await cliExit(['index', '--check', join(dir, 'only.json')]);
  assert.equal(only.code, 1);
  assert.match(only.stderr, /couldn't fetch http:\/\/127\.0\.0\.1:9\/demo-1\.0\.0\.zip/);

  writeFileSync(join(dir, 'shadowed.json'), JSON.stringify({ sites: [squatter, unreachable] }));
  const shadowed = await cliExit(['index', '--check', join(dir, 'shadowed.json')]);
  assert.equal(shadowed.code, 1);
  assert.match(shadowed.stdout, /0 plugin entries, 1 other entries/);
});

test('index --check fails on a list of repos, and says doctor is what reads one', async () => {
  const dir = scratchDir('lp-index-');
  try {
    const file = join(dir, 'list.json');
    writeFileSync(file, JSON.stringify({ urls: [{ url: 'https://a.test/x.json', name: 'x' }] }));

    const result = await cliExit(['index', '--check', file]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /✗ a list of 1 repos, not an index: `doctor` reads a list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('index refuses an option it does not know rather than building instead of checking', async () => {
  const result = await cliExit(['index', '--chek', 'index.json']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--chek is not an option index understands/);
});

/** Builds an index of the `ok` test plugin against an `--expect` file; `uploaded` is its one entry. */
async function expecting() {
  const plugins = scratchDir('lp-index-plugins-');
  cpSync(okDir, join(plugins, 'ok'), { recursive: true, filter: (path) => !path.includes('/dist') });
  const manifest = loadManifest(okDir);
  // Bundled from the copy the index builds from, since the sha256 depends on the path (#638).
  const { sha256 } = await bundlePlugin({ dir: join(plugins, 'ok'), outDir: scratchDir('lp-index-') });
  const uploaded = `${versionedUrl('https://plugins.example/d', manifest.id, manifest.version)}#sha256=${sha256}`;
  const expected = join(scratchDir('lp-index-'), 'expected');
  const build = (lines) => {
    writeFileSync(expected, lines.map((line) => `${line}\n`).join(''));
    return cliExit(['index', plugins, '--base-url', 'https://plugins.example/d', '--expect', expected]);
  };
  return { uploaded, build };
}

test('index --expect prints the index when it lists exactly the builds the publisher uploads', async () => {
  const { uploaded, build } = await expecting();

  const right = await build([uploaded]);

  assert.equal(right.code, 0, right.stderr);
  assert.equal(JSON.parse(right.stdout).sites[0].api, uploaded);
});

test('index --expect fails, printing nothing, when the index leaves out a build this run uploads', async () => {
  const { uploaded, build } = await expecting();
  const alsoUploaded = uploaded.replace('/ok/ok-', '/other/other-');

  const result = await build([uploaded, alsoUploaded]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(`does not list ${alsoUploaded}, which this run uploads`), result.stderr);
});

test('index --expect fails, printing nothing, when the index lists a build this run does not upload', async () => {
  const { uploaded, build } = await expecting();

  const result = await build([]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(`lists ${uploaded}, which this run does not upload`), result.stderr);
});

test('index --check of a pinned index whose bytes differ fetches nothing it lists', async () => {
  const { bytes, sha256, manifest } = await okZip();
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    if (req.url === '/index.json') {
      res.end(JSON.stringify({ sites: [pluginEntry(manifest, `http://127.0.0.1:${server.address().port}/ok.zip`, sha256)] }));
    } else {
      res.end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/index.json`;

    const pinnedWrong = await cliExit(['index', '--check', `${url}#sha256=${SHA}`]);
    assert.equal(pinnedWrong.code, 1);
    assert.match(pinnedWrong.stderr, /nothing it lists was fetched/);
    assert.deepEqual(asked, ['/index.json']);

    const plain = await cliExit(['index', '--check', url]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.deepEqual(asked, ['/index.json', '/index.json', '/ok.zip']);
  } finally {
    server.close();
  }
});

test('index --check takes a sha256 pin on a file path as it does on an address', async () => {
  const file = join(scratchDir('lp-index-'), 'index.json');
  const text = JSON.stringify({ sites: [] });
  writeFileSync(file, text);
  const sha256 = createHash('sha256').update(text).digest('hex');

  const right = await cliExit(['index', '--check', `${file}#sha256=${sha256}`]);
  assert.equal(right.code, 0, right.stderr);
  assert.match(right.stdout, /matches the sha256 in its address/);

  const wrong = await cliExit(['index', '--check', `${file}#sha256=${SHA}`]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /nothing it lists was fetched/);
});

test('index --check reports every bad entry, not only the first', async () => {
  const { bytes, sha256, manifest } = await okZip();
  const file = join(scratchDir('lp-index-'), 'index.json');
  const server = createServer((req, res) => res.end(bytes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const good = pluginEntry(manifest, `${base}/ok.zip`, sha256);
    const wrongSha = pluginEntry({ ...manifest, id: 'second' }, `${base}/second.zip`, SHA);
    const wrongVersion = pluginEntry({ ...manifest, id: 'third', version: '0.0.1' }, `${base}/third.zip`, sha256);
    writeFileSync(file, JSON.stringify({ sites: [good, wrongSha, wrongVersion] }));

    const result = await cliExit(['index', '--check', file]);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✓ yonto:ok/);
    assert.match(result.stderr, /yonto:second: the index says sha256/);
    assert.match(result.stderr, /yonto:third: the index says version 0\.0\.1/);
  } finally {
    server.close();
  }
});
