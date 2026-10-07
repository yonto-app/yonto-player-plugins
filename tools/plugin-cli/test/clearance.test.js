import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearanceForHop, clearanceFromEnv } from '../src/host/clearance.js';
import { cookieLoginOf } from '../src/host/credential.js';
import { createFetch } from '../src/host/fetch.js';
import { hostsWith } from '../src/manifest.js';
import { fixtureName } from '../src/transport/record.js';
import { scratchDir } from '../src/scratch-dir.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// `PluginClearancesRecordTest` walks the same record through the device's `yonto.fetch`.
const RECORD = JSON.parse(readFileSync(new URL('../conformance/clearances.json', import.meta.url), 'utf8'));

function scriptedTransport(answers = {}) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const answer = answers[req.url] ?? { status: 200 };
      return {
        status: answer.status,
        headers: answer.location === undefined ? {} : { location: answer.location },
        setCookie: answer.setCookie ?? [],
        bodyBase64: '',
      };
    },
  };
}

/** The one value of [name] a hop carried, or null; two spellings of it is a failure. */
function headerOf(headers, name) {
  const found = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  assert.ok(found.length <= 1, `two ${name} headers: ${JSON.stringify(headers)}`);
  return found.length === 0 ? null : found[0][1];
}

for (const c of RECORD.cases) {
  test(`clearances.json: ${c.why}`, async () => {
    const manifest = { id: 'probe', configSchema: [], hostsFromConfig: false, ...c.manifest };
    const transport = scriptedTransport(c.answers);
    const fetch = createFetch({
      hosts: hostsWith(manifest),
      hostsEnforced: manifest.hostsFromConfig !== true,
      transport,
      requests: [],
      login: cookieLoginOf(manifest),
      credential: () => c.credential ?? null,
      clearanceFor: (url) => clearanceForHop(manifest, url, [c.clearance]),
    });

    const answer = await fetch(c.url, { headers: c.headers });

    assert.deepEqual(
      transport.calls.map((call) => ({
        url: call.url, cookie: headerOf(call.headers, 'cookie'), userAgent: headerOf(call.headers, 'user-agent'),
      })),
      c.sent,
    );
    assert.deepEqual(answer.setCookie, c.setCookie);
  });
}

test('each hop the host logs says whether it carried a clearance, as a television marks the sites a call reached', async () => {
  const manifest = { allowedHosts: ['site.test', 'other.test'], capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] };
  const clearance = { site: 'https://site.test', cookies: [{ name: 'cf_clearance', value: 'held' }], userAgent: 'WebView/152' };
  const requests = [];
  const fetch = createFetch({
    hosts: hostsWith({ configSchema: [], ...manifest }),
    transport: scriptedTransport({ 'https://site.test/go': { status: 302, location: 'https://other.test/landed' } }),
    requests,
    clearanceFor: (url) => clearanceForHop(manifest, url, [clearance]),
  });

  await fetch('https://site.test/go');
  await fetch('https://elsewhere.test/').catch(() => null);

  assert.deepEqual(requests.map((r) => [r.url, r.clearanceSent]), [
    ['https://site.test/go', true], ['https://other.test/landed', false], ['https://elsewhere.test/', false],
  ]);
});

// From the environment through `createHost` to a plugin's `yonto.fetch`, the way `run` does
// it: the clearance's cookie name is withheld from what the site set, and only while it is held.
test('a clearance in the environment reaches the plugin run under it', () => {
  const dir = join(scratchDir('lp-'), 'cleared');
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  const manifest = {
    kind: 'content-source', id: 'cleared', name: 'Cleared', version: '1.0.0', contractVersion: 21, provides: 'source',
    allowedHosts: ['site.test'], capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }],
  };
  writeFileSync(join(dir, 'cleared-plugin.js'), `/* yonto-plugin\n${JSON.stringify(manifest, null, 2)}\n*/\n` +
    "export default {\n  async getCategories() { return []; },\n" +
    "  async search() { const r = await yonto.fetch('https://site.test/'); return [{ id: r.setCookie.join('|'), title: 't' }]; },\n};\n");
  const request = { method: 'GET', url: 'https://site.test/' };
  writeFileSync(join(dir, 'fixtures', fixtureName(request)), JSON.stringify({
    request: { ...request, body: null },
    response: { status: 200, headers: {}, setCookie: ['cf_clearance=reissued', 'mine=1'], bodyBase64: '' },
  }));
  const seen = (env) => JSON.parse(execFileSync('node', [CLI, 'run', dir, 'search', '"x"', '--replay'], {
    encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env },
  }))[0].id;

  assert.equal(seen({}), 'cf_clearance=reissued|mine=1');
  assert.equal(seen({
    YONTO_PLUGIN_CLEARANCE: 'cf_clearance=held',
    YONTO_PLUGIN_CLEARANCE_UA: 'WebView/152',
    YONTO_PLUGIN_CLEARANCE_SITE: 'https://site.test',
  }), 'mine=1');
});

test('a clearance is taken from the environment only whole, and only for a site it could be sent to', () => {
  const whole = {
    YONTO_PLUGIN_CLEARANCE: '__jsluid_s=v; __jsl_clearance_s=a=b',
    YONTO_PLUGIN_CLEARANCE_UA: 'WebView/152',
    YONTO_PLUGIN_CLEARANCE_SITE: 'https://site.test',
  };
  assert.equal(clearanceFromEnv({}), null);
  assert.deepEqual(clearanceFromEnv(whole), {
    site: 'https://site.test',
    cookies: [{ name: '__jsluid_s', value: 'v' }, { name: '__jsl_clearance_s', value: 'a=b' }],
    userAgent: 'WebView/152',
  });

  for (const missing of Object.keys(whole)) {
    assert.throws(() => clearanceFromEnv({ ...whole, [missing]: undefined }), /go together/, missing);
  }
  for (const site of [
    'http://site.test', 'https://192.168.1.2', 'https://nas.local', 'https://Site.TEST', 'https://site.test/',
    'https://site.test/list', 'site.test',
  ]) {
    assert.throws(() => clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE_SITE: site }), /public https/, site);
  }
  assert.throws(() => clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE: 'bare' }), /name=value/);
  for (const cookies of [' ; ', 'cf clearance=a', 'cf_clearance=a\r\nX-Evil: 1', 'cf_clearance= a']) {
    assert.throws(() => clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE: cookies }), /name=value/, cookies);
  }
  assert.throws(() => clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE: 'cf=1; cf=2' }), /twice/);
  assert.throws(() => clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE_UA: 'WebView\nX-Evil: 1' }), /User-Agent/);
  // A real WebView agent has semicolons in it, and a header carries them.
  assert.equal(clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE_UA: 'Mozilla/5.0 (Linux; Android 16; wv)' }).userAgent,
    'Mozilla/5.0 (Linux; Android 16; wv)');
  assert.equal(clearanceFromEnv({ ...whole, YONTO_PLUGIN_CLEARANCE_SITE: 'https://[2606:4700::1]' }).site,
    'https://[2606:4700::1]');
});
