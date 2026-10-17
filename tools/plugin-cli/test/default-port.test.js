import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';
import { createHost } from '../src/host/index.js';
import { createEngine } from '../src/engines/quickjs.js';
import { Code } from '../src/errors.js';
import { scratchDir } from '../src/scratch-dir.js';

// kangzj/yonto#1871: a Jellyfin or Emby typed as a bare `192.168.1.20` is saved as
// `http://192.168.1.20`, port 80, and was told to check its network. Both servers listen on
// 8096, so the plugins try the address as typed and then that port, as the servers' own apps do.

const SERVERS = [
  { id: 'jellyfin', prefix: '', unreachable: Code.REQUEST_FAILED },
  { id: 'emby', prefix: '/emby', unreachable: Code.UNREACHABLE },
];

function body(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

const info = { status: 200, headers: {}, bodyBase64: body({ ServerName: 'home', Id: 'server-id', Version: '10.10.0' }) };
const loginOk = { status: 200, headers: {}, bodyBase64: body({ AccessToken: 'token', User: { Id: 'user' } }) };
const viewsOk = {
  status: 200,
  headers: {},
  bodyBase64: body({ Items: [{ Id: 'lib', Name: 'Films', CollectionType: 'movies' }] }),
};
// What else answers on port 80 at home: a router's page, or some other service's JSON.
const OTHER_PAGES = {
  'a web page': { status: 200, headers: {}, bodyBase64: Buffer.from('<html>router</html>').toString('base64') },
  'another service\'s JSON': { status: 200, headers: {}, bodyBase64: body({ status: 'ok' }) },
};

/** A server at each origin given, answering like a media server; any other origin refuses the connection. */
function servers(answering, others = {}) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const origin = new URL(req.url).origin;
      if (others[origin]) return others[origin];
      if (!answering.includes(origin)) throw new Error(`connect refused: ${origin}`);
      if (req.url.includes('/System/Info/Public')) return info;
      if (req.url.includes('AuthenticateByName')) return loginOk;
      if (req.url.includes('/Views')) return viewsOk;
      return { status: 404, headers: {}, bodyBase64: body({}) };
    },
    origins() {
      return this.calls.map((c) => new URL(c.url).origin);
    },
  };
}

function engineFor(server, serverUrl, transport, storeDir = scratchDir(`lp-${server.id}-port-`), timeoutMs = undefined) {
  const dir = fileURLToPath(new URL(`../../../plugins/${server.id}/`, import.meta.url));
  const config = { serverUrl, username: 'demo', password: 'hunter2' };
  const host = createHost({ manifest: loadManifest(dir), config, transport, storeDir, pluginDir: dir });
  return createEngine({ dir, host, timeoutMs });
}

/** A host that drops packets: every request waits out a connect timeout, then fails. */
function silent(waitMs) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      await new Promise((resolve) => { setTimeout(resolve, waitMs); });
      throw new Error('connect timed out');
    },
  };
}

for (const server of SERVERS) {
  test(`${server.id}: an address with no port reaches the server on 8096 when the typed one does not answer`, async () => {
    const transport = servers(['http://192.168.1.20:8096']);

    const categories = await engineFor(server, 'http://192.168.1.20', transport).call('getCategories', []);

    assert.deepEqual(categories.map((c) => c.id), ['lib']);
    assert.deepEqual(transport.calls.slice(0, 2).map((c) => c.url), [
      `http://192.168.1.20${server.prefix}/System/Info/Public`,
      `http://192.168.1.20:8096${server.prefix}/System/Info/Public`,
    ], 'the address as typed is tried first');
    assert.ok(transport.calls.slice(2).every((c) => c.url.startsWith('http://192.168.1.20:8096/')),
      transport.calls.map((c) => c.url).join('\n'));
  });

  test(`${server.id}: a path typed after the host is kept on the default port`, async () => {
    const transport = servers(['http://media.home:8096']);

    await engineFor(server, 'http://media.home/media', transport).call('getCategories', []);

    assert.equal(transport.calls.at(-1).url, `http://media.home:8096/media${server.prefix}/Users/user/Views`);
  });

  test(`${server.id}: an IPv6 address with no port gets the port after its brackets`, async () => {
    const transport = servers(['http://[fd00::20]:8096']);

    await engineFor(server, 'http://[fd00::20]', transport).call('getCategories', []);

    assert.equal(transport.calls.at(-1).url, `http://[fd00::20]:8096${server.prefix}/Users/user/Views`);
  });

  test(`${server.id}: an address that answers as typed is used as typed, even with the server on 8096 too`, async () => {
    const transport = servers(['http://media.home', 'http://media.home:8096']);

    await engineFor(server, 'http://media.home', transport).call('getCategories', []);

    const afterProbes = transport.origins().slice(2);
    assert.ok(afterProbes.length > 0 && afterProbes.every((origin) => origin === 'http://media.home'), afterProbes.join(' '));
  });

  for (const [what, page] of Object.entries(OTHER_PAGES)) {
    test(`${server.id}: ${what} on port 80 is passed over for 8096`, async () => {
      const transport = servers(['http://192.168.1.20:8096'], { 'http://192.168.1.20': page });

      const categories = await engineFor(server, 'http://192.168.1.20', transport).call('getCategories', []);

      assert.deepEqual(categories.map((c) => c.id), ['lib']);
      assert.equal(transport.calls.at(-1).url, `http://192.168.1.20:8096${server.prefix}/Users/user/Views`);
    });
  }

  test(`${server.id}: the address that answered is remembered, so a later runtime does not look again`, async () => {
    const storeDir = scratchDir(`lp-${server.id}-port-`);
    await engineFor(server, 'http://192.168.1.20', servers(['http://192.168.1.20:8096']), storeDir)
      .call('getCategories', []);
    const later = servers(['http://192.168.1.20:8096']);

    await engineFor(server, 'http://192.168.1.20', later, storeDir).call('getCategories', []);

    assert.deepEqual(later.calls.map((c) => c.url), [`http://192.168.1.20:8096${server.prefix}/Users/user/Views`]);
  });

  test(`${server.id}: an address that stops answering is forgotten, so the next call looks again`, async () => {
    const storeDir = scratchDir(`lp-${server.id}-port-`);
    await engineFor(server, 'http://192.168.1.20', servers(['http://192.168.1.20:8096']), storeDir)
      .call('getCategories', []);
    await assert.rejects(
      () => engineFor(server, 'http://192.168.1.20', servers([]), storeDir).call('getCategories', []),
      (error) => error.code === server.unreachable,
    );
    const moved = servers(['http://192.168.1.20']);

    await engineFor(server, 'http://192.168.1.20', moved, storeDir).call('getCategories', []);

    assert.equal(moved.calls[0].url, `http://192.168.1.20${server.prefix}/System/Info/Public`);
    assert.equal(moved.calls.at(-1).url, `http://192.168.1.20${server.prefix}/Users/user/Views`);
  });

  test(`${server.id}: when neither answers, the typed address's own failure is what the viewer reads`, async () => {
    const transport = servers([]);

    await assert.rejects(
      () => engineFor(server, 'http://192.168.1.20', transport).call('getCategories', []),
      (error) => error.code === server.unreachable,
    );
    // Each asked once: a host that drops packets takes a connect timeout per request, and a third
    // would outlast the call's budget and end it as a timeout instead.
    assert.deepEqual(transport.calls.map((c) => c.url), [
      `http://192.168.1.20${server.prefix}/System/Info/Public`,
      `http://192.168.1.20:8096${server.prefix}/System/Info/Public`,
    ]);
  });

  // Scaled down: a connect timeout longer than the budget, as 15 s against 20 s is once two are in a row.
  test(`${server.id}: a host that drops packets fails as unreachable within one connect timeout`, async () => {
    const transport = silent(500);

    await assert.rejects(
      () => engineFor(server, 'http://192.168.1.20', transport, undefined, 400).call('getCategories', []),
      (error) => error.code === server.unreachable,
    );
    assert.equal(transport.calls.length, 2);
  });

  test(`${server.id}: a page on port 80 with nothing on 8096 is read as the typed address's own answer`, async () => {
    const transport = servers([], { 'http://192.168.1.20': OTHER_PAGES['a web page'] });

    await assert.rejects(
      () => engineFor(server, 'http://192.168.1.20', transport).call('getCategories', []),
      (error) => /not the media server/.test(error.message),
    );
    assert.equal(transport.calls.at(-1).url, `http://192.168.1.20${server.prefix}/Users/AuthenticateByName`);
  });

  for (const typed of ['https://media.home', 'http://media.home:80', 'http://[fd00::20]:8920']) {
    test(`${server.id}: ${typed} was typed in full and is never tried on another port`, async () => {
      const origin = new URL(typed).origin;
      const transport = servers([origin]);

      await engineFor(server, typed, transport).call('getCategories', []);

      assert.ok(transport.origins().every((o) => o === origin), transport.origins().join(' '));
      assert.ok(transport.calls.every((c) => !c.url.includes('/System/Info/Public')), 'no probe');
    });
  }
}
