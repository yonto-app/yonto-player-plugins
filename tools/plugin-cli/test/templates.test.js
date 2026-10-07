import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { runDoctor } from '../src/doctor.js';
import { scratchDir } from '../src/scratch-dir.js';

/** `templates/video-blog`, the plugin the developer guide's tutorial builds, and `init`, which copies the templates. */
const dir = fileURLToPath(new URL('../templates/video-blog/', import.meta.url));
const manifest = loadManifest(dir);
const config = JSON.parse(readFileSync(join(dir, 'doctor.json'), 'utf8'));

function engineOver(transport) {
  const host = createHost({
    manifest,
    config,
    transport,
    storeDir: scratchDir('lp-video-blog-'),
    pluginDir: dir,
  });
  return { host, engine: createEngine({ dir, host }) };
}

const answering = (status, body) => ({
  async request() {
    return { status, headers: {}, bodyBase64: Buffer.from(body, 'utf8').toString('base64') };
  },
});

const failure = (promise) => promise.then(() => null, (error) => error);

test('doctor --replay passes over the recorded feed', async () => {
  const { host, engine } = engineOver(createReplayTransport({ dir: join(dir, 'fixtures') }));

  const report = await runDoctor({ engine, requests: host.requests, logs: host.logs, query: manifest.probeQuery });

  assert.deepEqual(report.steps.filter((step) => !step.ok), []);
});

test('a post with no video attached is not a title', async () => {
  const { engine } = engineOver(createReplayTransport({ dir: join(dir, 'fixtures') }));

  const titles = await engine.call('getMediaList', ['latest', { page: 1 }]);

  assert.deepEqual(titles.map((title) => title.id), ['post-3', 'post-2']);
});

test('a title that is not in the feed is not found', async () => {
  const { engine } = engineOver(createReplayTransport({ dir: join(dir, 'fixtures') }));

  const error = await failure(engine.call('getMediaDetail', ['post-9']));

  assert.equal(error.code, 'NOT_FOUND');
});

test('an address that is not a feed is unavailable, and says so', async () => {
  const { engine } = engineOver(answering(200, '<html><body>Welcome</body></html>'));

  const error = await failure(engine.call('getCategories', []).then(() => engine.call('getMediaList', ['latest', { page: 1 }])));

  assert.equal(error.code, 'UNAVAILABLE');
  assert.match(error.message, /not an RSS feed/);
});

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function yontoPlugin(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

for (const template of ['blank', 'video-blog']) {
  test(`init --template ${template} writes a plugin that lints and passes doctor`, () => {
    const parent = scratchDir('lp-init-');

    const made = yontoPlugin(parent, 'init', 'my-plugin', '--template', template, '--name', 'My $& plugin');
    assert.equal(made.status, 0, made.stderr);

    const created = join(parent, 'my-plugin');
    assert.ok(readdirSync(created).includes('my-plugin-plugin.js'));
    const header = loadManifest(created);
    assert.equal(header.id, 'my-plugin');
    assert.equal(header.name, 'My $& plugin');
    const lint = yontoPlugin(created, 'lint');
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const doctor = yontoPlugin(created, 'doctor', ...(template === 'blank' ? [] : ['--replay']));
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  });
}

test('init refuses an id that is not one, a directory that exists and a template that does not', () => {
  const parent = scratchDir('lp-init-');
  yontoPlugin(parent, 'init', 'taken');

  assert.match(yontoPlugin(parent, 'init', 'Bad Id').stderr, /cannot be an id/);
  assert.match(yontoPlugin(parent, 'init', 'index').stderr, /cannot be an id/);
  assert.match(yontoPlugin(parent, 'init', 'taken').stderr, /already exists/);
  assert.match(yontoPlugin(parent, 'init', 'fresh', '--template', 'nope').stderr, /choose one of blank, video-blog/);
  assert.match(yontoPlugin(parent, 'init', 'fresh', '--name', 'a */ b').stderr, /cannot contain \*\//);
  assert.match(yontoPlugin(parent, 'init', 'fresh', '--name', '').stderr, /cannot be empty/);
  assert.match(yontoPlugin(parent, 'init', 'fresh', '--name', '--template', 'blank').stderr, /--name needs a value/);
  assert.equal(readdirSync(parent).join(), 'taken');
});
