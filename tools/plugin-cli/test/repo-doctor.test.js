import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INDEX_USER_AGENT, MAX_INDEX_BYTES, repoReport } from '../src/repo-doctor.js';

/**
 * `doctor <repo-url>` over recorded documents from `conformance/index-reading/`, served from
 * this machine so nothing leaves it.
 */
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const recorded = (file) => {
  const [c] = JSON.parse(readFileSync(new URL(`../conformance/index-reading/${file}`, import.meta.url), 'utf8'));
  return c.body !== undefined ? Buffer.from(c.body, 'utf8') : Buffer.from(c.bodyBase64, 'base64');
};

const agents = [];
let server;
let base;

before(async () => {
  const routes = {
    '/svip': () => [200, recorded('recorded-cang-aes-comments.json')],
    '/spiders': () => [200, recorded('recorded-cang-jpeg.json')],
    '/lines': () => [200, recorded('recorded-urls-list.json')],
    '/empty-list': () => [200, Buffer.from('{"storeHouse": [{"sourceName": "本地", "sourceUrl": "file:///sdcard/tv.json"}]}')],
    '/portal': () => [200, Buffer.from('<!DOCTYPE html><title>Log in to the Wi-Fi</title>')],
    '/huge': () => [200, Buffer.alloc(MAX_INDEX_BYTES + 1, 0x20)],
    '/gone': () => [404, Buffer.from('')],
  };
  server = createServer((req, res) => {
    agents.push(req.headers['user-agent']);
    if (req.url === '/stalls') {
      res.writeHead(200);
      res.write('{"sites": [');
      return;
    }
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/svip' });
      res.end();
      return;
    }
    // A name that resolves to this same server, which the repo's address did not use.
    if (req.url === '/into-a-name') {
      res.writeHead(302, { location: `http://lan-name.test:${server.address().port}/svip` });
      res.end();
      return;
    }
    // `localhost` is this same server under a private name the repo's address did not use.
    if (req.url === '/into-the-lan') {
      res.writeHead(302, { location: `http://localhost:${server.address().port}/svip` });
      res.end();
      return;
    }
    const [status, body] = routes[req.url]?.() ?? [404, Buffer.from('')];
    res.writeHead(status);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('a disguised 仓 reads as its catalogs, with the spiders counted', async () => {
  const report = await repoReport(`${base}/svip`);

  assert.equal(report.ok, true);
  assert.match(report.lines.join('\n'), /✓ read {14}仓, 111 named, 5 a source can be made of/);
  assert.match(report.lines.join('\n'), /maccms-xml {6}\S/);
  assert.match(report.lines.join('\n'), /· skipped {11}106 spider$/m);
});

test('the index is asked for as FongMi asks, and a redirect is followed', async () => {
  agents.length = 0;

  const report = await repoReport(`${base}/moved#sha256=${'a'.repeat(64)}`);

  assert.equal(report.ok, true);
  assert.deepEqual(agents, [INDEX_USER_AGENT, INDEX_USER_AGENT]);
});

// The floor on a repo's fetch, as a television's: the host the address was typed on passes
// (every case here is on 127.0.0.1), and a hop to any other private host is refused there.
test('a repo that redirects to a private host its address did not name is refused at that hop', async () => {
  agents.length = 0;

  const report = await repoReport(`${base}/into-the-lan`);

  assert.equal(report.ok, false);
  assert.match(report.lines.join('\n'), /✗ fetch {13}localhost is a private address, and the repo's address does not name it/);
  assert.equal(agents.length, 1);
});

/** `dns.lookup`'s shape, pointing every `.test` name at this machine, as a LAN name would be. */
const pointedAtHere = (hostname, options, callback) => {
  if (!hostname.endsWith('.test')) return lookup(hostname, options, callback);
  const answer = { address: '127.0.0.1', family: 4 };
  return options?.all ? callback(null, [answer]) : callback(null, answer.address, answer.family);
};

// Only the host as written is under the floor (Jasper, 2026-09-26), so a hop to a name that
// resolves into the LAN is followed, as a television follows it.
test('a repo that redirects to a name resolving into the LAN is read', async () => {
  agents.length = 0;

  const report = await repoReport(`${base}/into-a-name`, { lookup: pointedAtHere });

  assert.equal(report.ok, true, report.lines.join('\n'));
  assert.equal(agents.length, 2);
});

// The name the viewer typed is theirs, wherever it resolves.
test('a repo typed as a name that resolves into the LAN is read', async () => {
  const report = await repoReport(`http://repo.test:${server.address().port}/svip`, { lookup: pointedAtHere });

  assert.equal(report.ok, true, report.lines.join('\n'));
});

test('a repo nothing can be made of fails, and says what it skipped', async () => {
  const report = await repoReport(`${base}/spiders`);

  assert.equal(report.ok, false);
  assert.match(report.lines.join('\n'), /✗ read {14}仓, 47 named, 0 a source can be made of/);
  assert.match(report.lines.join('\n'), /47 spider/);
});

test('a list of repos names each, fetches none, and counts what it skipped', async () => {
  const report = await repoReport(`${base}/lines`);

  assert.equal(report.ok, true);
  const said = report.lines.join('\n');
  assert.match(said, /✓ read {14}a list of repos, 147 named, 131 to pick from/);
  assert.match(said, /^ {4}🌏聚合线路 {2}\(http:\/\/tvjuhe\.mitetech\.cn:5622\/\)$/m);
  assert.match(said, /· skipped {11}1 no http\(s\) address, 15 address named twice$/m);
});

test('a list with nothing to pick from fails', async () => {
  const report = await repoReport(`${base}/empty-list`);

  assert.equal(report.ok, false);
  assert.match(report.lines.join('\n'), /✗ read {14}a list of repos, 1 named, 0 to pick from/);
});

test('a page that is not an index, a bad status and an oversized body each fail', async () => {
  assert.match((await repoReport(`${base}/portal`)).lines.join('\n'), /✗ read {14}not an index/);
  assert.match((await repoReport(`${base}/gone`)).lines.join('\n'), /✗ fetch {13}HTTP 404/);
  const huge = await repoReport(`${base}/huge`);
  assert.equal(huge.ok, false);
  assert.match(huge.lines.join('\n'), /✗ fetch {13}over 1048576 bytes/);
});

test('a repo that stops sending partway through gives up at the timeout', { timeout: 10_000 }, async () => {
  const report = await repoReport(`${base}/stalls`, { timeoutMs: 300 });

  assert.equal(report.ok, false);
  assert.match(report.lines.join('\n'), /✗ fetch {13}.*(?:timeout|aborted)/i);
});

function run(...args) {
  return new Promise((resolve) => {
    const child = spawn('node', [cli, ...args], { encoding: 'utf8' });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('doctor takes a repo address where it takes a plugin directory', async () => {
  const good = await run('doctor', `${base}/svip`);
  assert.equal(good.status, 0, good.out);
  assert.match(good.out, /仓, 111 named, 5 a source can be made of/);

  const empty = await run('doctor', `${base}/spiders`);
  assert.equal(empty.status, 1, empty.out);
});

test('doctor refuses an option it would ignore on a repo', async () => {
  const result = await run('doctor', `${base}/svip`, '--replay');

  assert.equal(result.status, 2);
  assert.match(result.out, /takes no options, not --replay/);
});
