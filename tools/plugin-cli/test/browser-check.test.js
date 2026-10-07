import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  browserCheckRefusals, challengeAware, clearsAt, challengeHints, challengeRefusal, noticingChallenges,
  raisesUndeclaredChallenge, siteOf,
} from '../src/browser-check.js';
import { Code, PluginError } from '../src/errors.js';

const record = JSON.parse(readFileSync(new URL('../conformance/browser-checks.json', import.meta.url), 'utf8'));

// BrowserChecksRecordTest walks the same record through the device's BrowserChecks.
test('a raised challenge is offered or refused as conformance/browser-checks.json says', () => {
  for (const { why, manifest, url, reached, refusal } of record.cases) {
    assert.equal(challengeRefusal(manifest, url, new Set(reached)), refusal, why);
  }
});

test('a fromConfig plugin with a cookieLogin clears everywhere it covers but the login site', () => {
  const manifest = {
    allowedHosts: [],
    hostsFromConfig: true,
    capabilities: [{ type: 'cookieLogin', url: 'https://login.test/' }, { type: 'browserCheck', fromConfig: true }],
  };
  assert.equal(clearsAt(manifest, 'https://login.test'), false);
  assert.equal(clearsAt(manifest, 'https://catalog.test'), true);
  assert.equal(clearsAt({ ...manifest, capabilities: manifest.capabilities.slice(0, 1) }, 'https://catalog.test'), false);
});

test('a fromConfig check never clears a site over http or on a private address', () => {
  const manifest = { allowedHosts: [], hostsFromConfig: true, capabilities: [{ type: 'browserCheck', fromConfig: true }] };
  assert.equal(clearsAt(manifest, 'https://catalog.test'), true);
  assert.equal(clearsAt(manifest, 'http://catalog.test'), false);
  assert.equal(clearsAt(manifest, 'https://192.168.1.2'), false);
  assert.equal(clearsAt(manifest, 'https://nas.local'), false);
});

// A clearance is stored by the string a site prints, so it has to read back to the same site.
test('an IPv6 site prints bracketed, and reads back to itself', () => {
  assert.equal(siteOf('https://[2606:4700::1]:8443/list'), 'https://[2606:4700::1]');
  assert.equal(siteOf(siteOf('https://[2606:4700::1]:8443/list')), 'https://[2606:4700::1]');
  assert.equal(siteOf('https://site.test:8443/'), 'https://site.test');
});

const site = (extra = {}) => ({ allowedHosts: ['site.test'], capabilities: [], ...extra });

test('lint takes a url-form check at a site the plugin reaches', () => {
  assert.deepEqual(browserCheckRefusals(site({ capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] })), []);
});

test('lint refuses a fromConfig check on a plugin whose hosts are named in its manifest', () => {
  const [refusal] = browserCheckRefusals(site({ capabilities: [{ type: 'browserCheck', fromConfig: true }] }));
  assert.match(refusal, /does not declare hostsFromConfig/);
});

test('lint refuses a fromConfig check beside any other', () => {
  const refusals = browserCheckRefusals({
    allowedHosts: [],
    hostsFromConfig: true,
    capabilities: [{ type: 'browserCheck', fromConfig: true }, { type: 'browserCheck', url: 'https://a.test/' }],
  });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /stands alone/);
});

test('lint refuses a check at a host allowedHosts does not admit, and not on a hostsFromConfig plugin', () => {
  const check = { type: 'browserCheck', url: 'https://elsewhere.test/' };
  assert.match(browserCheckRefusals(site({ capabilities: [check] }))[0], /allowedHosts does not admit/);
  assert.deepEqual(browserCheckRefusals({ allowedHosts: [], hostsFromConfig: true, capabilities: [check] }), []);
});

test('lint admits a check at a host a wildcard entry covers', () => {
  const manifest = { allowedHosts: ['*.site.test'], capabilities: [{ type: 'browserCheck', url: 'https://www.site.test/' }] };
  assert.deepEqual(browserCheckRefusals(manifest), []);
});

// The matching is a copy of host/fetch.js's private `hostAllowed` until the host phase exports
// it (kangzj/lantern-tv#359), so it is held to that function's own edges here.
test('a wildcard entry is a name suffix, never a string one, and not the bare domain', () => {
  const at = (url) => browserCheckRefusals({ allowedHosts: ['*.site.test'], capabilities: [{ type: 'browserCheck', url }] });
  assert.match(at('https://evilsite.test/')[0], /allowedHosts does not admit/);
  assert.match(at('https://site.test/')[0], /allowedHosts does not admit/);
  assert.deepEqual(at('https://a.b.site.test/'), []);
});

test('an allowedHosts entry is compared as a host, whatever case or port it was written in', () => {
  const at = (entry) => browserCheckRefusals({ allowedHosts: [entry], capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] });
  assert.deepEqual(at('SITE.test'), []);
  assert.deepEqual(at('site.test:8443'), []);
  assert.match(at('other.test')[0], /allowedHosts does not admit/);
});

test('lint refuses a check on the viewer\'s own network', () => {
  const manifest = { allowedHosts: ['192.168.1.1'], capabilities: [{ type: 'browserCheck', url: 'https://192.168.1.1/' }] };
  assert.match(browserCheckRefusals(manifest)[0], /viewer's own network/);
});

test('lint refuses a check on the site of the plugin\'s cookieLogin', () => {
  const manifest = site({
    capabilities: [
      { type: 'cookieLogin', url: 'https://site.test/login' },
      { type: 'browserCheck', url: 'https://site.test/' },
    ],
  });
  assert.match(browserCheckRefusals(manifest)[0], /site of this plugin's cookieLogin/);
});

test('lint refuses one site named twice', () => {
  const manifest = site({
    capabilities: [
      { type: 'browserCheck', url: 'https://site.test/' },
      { type: 'browserCheck', url: 'https://site.test/other' },
    ],
  });
  assert.deepEqual(browserCheckRefusals(manifest), ['browserCheck names https://site.test twice']);
});

test('a plugin raising CHALLENGED with no browserCheck is noticed, by constructor or by hand', () => {
  assert.equal(raisesUndeclaredChallenge({ 'a.js': 'throw yonto.error.challenged(url)' }, site()), true);
  assert.equal(raisesUndeclaredChallenge({ 'a.js': "throw Object.assign(new Error(url), { code: 'CHALLENGED' })" }, site()), true);
  assert.equal(raisesUndeclaredChallenge({ 'a.js': 'return []' }, site()), false);
  const declared = site({ capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] });
  assert.equal(raisesUndeclaredChallenge({ 'a.js': 'throw yonto.error.challenged(url)' }, declared), false);
});

const raising = (url, requests, hops) => ({
  async exports() { return ['getCategories']; },
  async call() {
    requests.push(...hops);
    throw new PluginError(Code.CHALLENGED, url);
  },
});

test('run and doctor say a challenge at a site the call reached is where a television opens a browser', async () => {
  const requests = [];
  const manifest = site({ capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] });
  const engine = challengeAware(raising('https://site.test/list', requests, [
    { url: 'https://site.test/list', status: 403 },
  ]), manifest, requests);

  const thrown = await engine.call('getCategories', []).then(() => assert.fail('did not throw'), (e) => e);

  assert.equal(thrown.code, Code.CHALLENGED);
  assert.equal(thrown.message, 'at https://site.test/list: a television offers the viewer a browser check here');
  assert.equal(await engine.exports().then((names) => names.length), 1);
});

test('run and doctor say which rule a refused challenge failed, reading only this call\'s requests', async () => {
  const requests = [{ url: 'https://site.test/earlier', status: 200 }];
  const manifest = site({ capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] });
  const engine = challengeAware(raising('https://site.test/list', requests, []), manifest, requests);

  const thrown = await engine.call('getCategories', []).then(() => assert.fail('did not throw'), (e) => e);

  assert.equal(thrown.message, 'at https://site.test/list, which yonto.fetch did not reach it in this call; ' +
    'a television reports it as unavailable');
  assert.equal(thrown.detail.refusal, 'yonto.fetch did not reach it in this call');
});

test('a request that never got an answer did not reach its site', async () => {
  const requests = [];
  const manifest = site({ capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] });
  const engine = challengeAware(raising('https://site.test/', requests, [
    { url: 'https://site.test/', status: null, failed: true },
  ]), manifest, requests);

  const thrown = await engine.call('getCategories', []).then(() => assert.fail('did not throw'), (e) => e);

  assert.match(thrown.message, /did not reach it in this call/);
});

test('every other failure passes through untouched', async () => {
  const engine = challengeAware({
    async call() { throw new PluginError(Code.UNAVAILABLE, 'down'); },
  }, site(), []);

  const thrown = await engine.call('getCategories', []).then(() => assert.fail('did not throw'), (e) => e);

  assert.equal(thrown.code, Code.UNAVAILABLE);
  assert.equal(thrown.message, 'down');
});

test('doctor notes a cf-mitigated challenge, and whether the plugin covered and raised it', async () => {
  const challenged = new Set();
  const transport = noticingChallenges({
    async request({ url }) {
      return url.includes('site.test')
        ? { status: 403, headers: { 'CF-Mitigated': 'challenge' }, bodyBase64: '' }
        : { status: 200, headers: {}, bodyBase64: '' };
    },
  }, challenged);
  await transport.request({ url: 'https://site.test/list' });
  await transport.request({ url: 'https://quiet.test/' });

  const covered = site({ capabilities: [{ type: 'browserCheck', url: 'https://site.test/' }] });
  const raisedIt = { steps: [{ code: Code.CHALLENGED, detail: { url: 'https://site.test/list' } }] };
  assert.deepEqual(challengeHints(covered, raisedIt, challenged), [
    '⚠ challenge         https://site.test answered with cf-mitigated: challenge — a browserCheck covers it, ' +
      'and the plugin raised CHALLENGED',
  ]);
  assert.deepEqual(challengeHints(site(), { steps: [{ code: Code.UNAUTHENTICATED }] }, challenged), [
    '⚠ challenge         https://site.test answered with cf-mitigated: challenge — no browserCheck covers it, ' +
      'and the plugin did not raise CHALLENGED for it',
  ]);
});
