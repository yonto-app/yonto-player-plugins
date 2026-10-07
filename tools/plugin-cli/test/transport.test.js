import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecordTransport, fixtureName } from '../src/transport/record.js';
import { createReplayTransport } from '../src/transport/replay.js';
import { createLiveTransport, unanswered } from '../src/transport/live.js';
import { Code } from '../src/errors.js';
import { RESPONSE_BODY_BYTES } from '../src/host/fetch.js';
import { createSecrets } from '../src/host/mask.js';
import { scratchDir } from '../src/scratch-dir.js';

const inner = {
  calls: 0,
  async request() {
    inner.calls += 1;
    return { status: 200, headers: { 'content-type': 'text/html' }, bodyBase64: Buffer.from('<html/>').toString('base64') };
  },
};

// A fixture's name is the only thing tying a plugin's live request to the file recorded
// for it, so a hand-written fixture set is only reachable if this stays stable.
test('a fixture name is the same every time for the same request', () => {
  const request = { method: 'GET', url: 'https://h.tv/dianying/' };
  assert.equal(fixtureName(request), fixtureName({ ...request }));
  assert.match(fixtureName(request), /^get-[0-9a-f]{16}\.json$/);
});

test('a fixture name distinguishes two POSTs to one URL by their body', () => {
  const url = 'https://h.tv/search/';
  assert.notEqual(fixtureName({ method: 'POST', url, body: 'wd=a' }),
    fixtureName({ method: 'POST', url, body: 'wd=b' }));
});

test('recording writes one fixture per distinct request and replay serves it with no network', async () => {
  const dir = scratchDir('lp-fix-');
  const recorder = createRecordTransport({ inner, dir });

  await recorder.request({ method: 'GET', url: 'https://h.tv/a', headers: {} });
  await recorder.request({ method: 'GET', url: 'https://h.tv/a', headers: {} });

  assert.equal(readdirSync(dir).length, 1, 'the same request is one fixture');

  const replay = createReplayTransport({ dir });
  const res = await replay.request({ method: 'GET', url: 'https://h.tv/a', headers: {} });
  assert.equal(Buffer.from(res.bodyBase64, 'base64').toString(), '<html/>');
});

test('a POST body is part of a fixture identity', async () => {
  const dir = scratchDir('lp-fix-');
  const recorder = createRecordTransport({ inner, dir });

  await recorder.request({ method: 'POST', url: 'https://h.tv/s', headers: {}, body: 'wd=a' });
  await recorder.request({ method: 'POST', url: 'https://h.tv/s', headers: {}, body: 'wd=b' });

  assert.equal(readdirSync(dir).length, 2);
});

test('a recorded fixture keeps a cookie\'s name and not its value, and the run recording it gets both', async () => {
  const dir = scratchDir('lp-fix-');
  const session = 'PHPSESSID=oq71lec90h1dgvhv7qmcman5t4; path=/';
  const signedIn = {
    async request() {
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Set-Cookie': session },
        setCookie: [session, 'nameless'],
        bodyBase64: Buffer.from('<html/>').toString('base64'),
      };
    },
  };
  const recorder = createRecordTransport({ inner: signedIn, dir });

  const live = await recorder.request({
    method: 'GET', url: 'https://h.tv/a', headers: { Cookie: 'uid=signed-in' },
  });

  assert.deepEqual(live.setCookie, [session, 'nameless']);
  const [file] = readdirSync(dir);
  const written = readFileSync(join(dir, file), 'utf8');
  assert.doesNotMatch(written, /oq71lec90h1dgvhv7qmcman5t4|nameless|signed-in/);
  const replayed = await createReplayTransport({ dir }).request({ method: 'GET', url: 'https://h.tv/a', headers: {} });
  assert.deepEqual(replayed.headers, { 'Content-Type': 'text/html' });
  assert.deepEqual(replayed.setCookie, ['PHPSESSID=redacted; path=/', 'redacted']);
});

// The recorder keeps the next one clean; this keeps the ones already committed that way,
// hand-written ones included.
/** A recorder over a server answering [answer], with a session's values held. */
function recordingWith(answer, { hostOwn = false } = {}) {
  const dir = scratchDir('lp-fix-');
  const secrets = createSecrets();
  secrets.add('account-token-cccccccc', '<credential>');
  secrets.add('shared-token-aaaaaaaa', '<server-credential>');
  secrets.add('host-client-id-0123', '<host-client-id>');
  secrets.add('1000000001', '<pin>', { hostOwn: true });
  secrets.add('WXYZ', '<pin>', { hostOwn: true });
  const refusals = [];
  const recorder = createRecordTransport({
    inner: { async request() { return answer; } }, dir, secrets, hostOwn, refused: (file, why) => refusals.push({ file, why }),
  });
  const read = () => readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  return { recorder, refusals, read };
}

test('a recording writes each value the host holds as its placeholder, wherever it is', async () => {
  const { recorder, read } = recordingWith({
    status: 200,
    headers: { 'x-echo': 'shared-token-aaaaaaaa' },
    setCookie: [],
    bodyBase64: Buffer.from('<p>account-token-cccccccc host-client-id-0123</p>').toString('base64'),
  });

  await recorder.request({ method: 'GET', url: 'https://h.tv/a?t=shared-token-aaaaaaaa', headers: {} });

  const [fixture] = read();
  assert.equal(fixture.request.url, 'https://h.tv/a?t=<server-credential>');
  assert.equal(fixture.response.headers['x-echo'], '<server-credential>');
  assert.equal(Buffer.from(fixture.response.bodyBase64, 'base64').toString(), '<p><credential> <host-client-id></p>');
});

test('the host\'s own recording also writes a sign-in\'s id and code as <pin>, a number included', async () => {
  const { recorder, read } = recordingWith({
    status: 201, headers: {}, bodyBase64: Buffer.from('{"id":1000000001,"code":"WXYZ","qr":"https://p.test/qr/WXYZ"}').toString('base64'),
  }, { hostOwn: true });

  await recorder.request({ method: 'GET', url: 'https://p.test/pins/1000000001', headers: {} });

  const [fixture] = read();
  assert.equal(fixture.request.url, 'https://p.test/pins/<pin>');
  assert.deepEqual(JSON.parse(Buffer.from(fixture.response.bodyBase64, 'base64').toString()),
    { id: '<pin>', code: '<pin>', qr: 'https://p.test/qr/<pin>' });
});

test('a plugin\'s recording leaves a four-letter code alone, since the plugin never sees one', async () => {
  const { recorder, read } = recordingWith({ status: 200, headers: {}, bodyBase64: Buffer.from('WXYZ').toString('base64') });

  await recorder.request({ method: 'GET', url: 'https://h.tv/a', headers: {} });

  assert.equal(Buffer.from(read()[0].response.bodyBase64, 'base64').toString(), 'WXYZ');
});

test('a recording writes a held value as its placeholder in every spelling yonto.fetch masks', async () => {
  const dir = scratchDir('lp-fix-');
  const secrets = createSecrets();
  secrets.add('abc/def+gh=12', '<credential>');
  const recorder = createRecordTransport({
    inner: { async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from('<a href="?t=abc%2Fdef%2Bgh%3D12">"abc\\/def+gh=12"</a>').toString('base64') }; } },
    dir, secrets, refused: (file, why) => assert.fail(`${file}: ${why}`),
  });

  await recorder.request({ method: 'GET', url: 'https://h.tv/a', headers: {} });

  const [fixture] = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  assert.equal(Buffer.from(fixture.response.bodyBase64, 'base64').toString(), '<a href="?t=<credential>">"<credential>"</a>');
});

test('a recording writes a held value\'s every spelling as its placeholder inside a JSON body too', async () => {
  const dir = scratchDir('lp-fix-');
  const secrets = createSecrets();
  secrets.add('abc/def+gh=12', '<credential>');
  const recorder = createRecordTransport({
    inner: { async request() { return { status: 200, headers: {}, bodyBase64: Buffer.from('{"next":"?t=abc%2fdef%2bgh%3d12"}').toString('base64') }; } },
    dir, secrets, refused: (file, why) => assert.fail(`${file}: ${why}`),
  });

  await recorder.request({ method: 'GET', url: 'https://h.tv/a', headers: {} });

  const [fixture] = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  assert.deepEqual(JSON.parse(Buffer.from(fixture.response.bodyBase64, 'base64').toString()), { next: '?t=<credential>' });
});

test('a fixture a held value survives in is not written, and the recording says which', async () => {
  // An id inside a longer number cannot be replaced without changing the number, so it survives.
  const { recorder, read, refusals } = recordingWith({
    status: 201, headers: {}, bodyBase64: Buffer.from('{"id":10000000012}').toString('base64'),
  }, { hostOwn: true });

  const answered = await recorder.request({ method: 'GET', url: 'https://p.test/pins', headers: {} });

  assert.deepEqual(read(), []);
  assert.equal(answered.status, 201, 'the run itself carries on');
  assert.match(refusals[0].why, /survived redaction as <pin>, so the fixture was not written/);
});

test('no committed fixture holds a cookie\'s value', () => {
  const plugins = fileURLToPath(new URL('../../../plugins/', import.meta.url));
  const fixtures = readdirSync(plugins).flatMap((plugin) => {
    const dir = join(plugins, plugin, 'fixtures');
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name)) : [];
  });
  assert.ok(fixtures.length > 0, 'found no fixtures to check');

  for (const file of fixtures) {
    const { response } = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!Object.keys(response.headers).some((name) => name.toLowerCase() === 'set-cookie'), file);
    for (const cookie of response.setCookie ?? []) {
      assert.match(cookie, /^([^=;]*=)?redacted(;|$)/, file);
    }
  }
});

test('replay says which request has no fixture rather than hanging or hitting the network', async () => {
  const dir = scratchDir('lp-fix-');
  const replay = createReplayTransport({ dir });

  await assert.rejects(() => replay.request({ method: 'GET', url: 'https://h.tv/missing', headers: {} }),
    (error) => {
      assert.equal(error.code, Code.NO_FIXTURE);
      assert.match(error.message, /https:\/\/h\.tv\/missing/);
      return true;
    });
});

// Loopback, so `npm test` still passes with wifi off — this is the one case in the suite
// that exercises undici rather than a fake, and getSetCookie() is exactly what a fake
// cannot vouch for.
test('the live transport keeps each Set-Cookie separate', async () => {
  const server = createServer((_, res) => {
    res.setHeader('Set-Cookie', ['a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/', 'b=2; HttpOnly']);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await createLiveTransport().request({
      method: 'GET', url: `http://127.0.0.1:${port}/login`, headers: {},
    });
    assert.deepEqual(res.setCookie, ['a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/', 'b=2; HttpOnly']);
  } finally {
    server.close();
  }
});

// kangzj/lantern-tv#333: read as it arrives, so a body far past the limit is never buffered whole.
test('the live transport reads a body to one byte past the limit and no further', async () => {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const sent = RESPONSE_BODY_BYTES + 4 * 1024 * 1024;
  const server = createServer((_, res) => {
    let written = 0;
    const more = () => {
      while (written < sent) {
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', more);
      }
      return res.end();
    };
    more();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await createLiveTransport().request({
      method: 'GET', url: `http://127.0.0.1:${port}/large`, headers: {},
    });
    assert.equal(Buffer.from(res.bodyBase64, 'base64').length, RESPONSE_BODY_BYTES + 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/** A loopback server that runs [onSocket] on each connection it accepts, and its port. */
async function tcpServer(onSocket) {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    onSocket(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** How long a request to [url] took to fail, and what it said, under [limits]. */
async function failureOf(url, limits) {
  const started = Date.now();
  const error = await createLiveTransport(limits).request({ method: 'GET', url, headers: {} })
    .then(() => assert.fail('the request succeeded'), (thrown) => thrown);
  assert.equal(error.code, Code.REQUEST_FAILED);
  // Which limit fired is in the causes, since the message is the host's sentence (kangzj/yonto#645).
  const causes = [];
  for (let e = error.detail?.cause; e; e = e.cause) causes.push(e.message);
  return { tookMs: Date.now() - started, message: error.message, why: causes.join(' / ') };
}

const SCALED = { connectTimeoutMs: 5000, readTimeoutMs: 5000, timeoutMs: 5000 };

// kangzj/yonto#645: the host's sentences, never Node's words; `YontoHostApi.unanswered` says the same.
test('a request that got no answer says why in the host\'s words', () => {
  const failed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('node words'), { code }) });

  assert.equal(unanswered('site.test', failed('DEPTH_ZERO_SELF_SIGNED_CERT')), "site.test's certificate isn't trusted");
  assert.equal(unanswered('site.test', failed('ERR_TLS_CERT_ALTNAME_INVALID')), "site.test's certificate isn't trusted");
  assert.equal(unanswered('site.test', failed('CERT_HAS_EXPIRED')), "site.test's certificate has expired");
  assert.equal(unanswered('site.test', failed('ENOTFOUND')), 'site.test could not be found');
  assert.equal(unanswered('site.test', failed('ECONNREFUSED')), 'site.test refused the connection');
  assert.equal(unanswered('site.test', failed('UND_ERR_CONNECT_TIMEOUT')), 'site.test did not answer in time');
  assert.equal(unanswered('site.test', new Error('aborted'), true), 'site.test did not answer in time');
  assert.equal(unanswered('site.test', failed('ECONNRESET')), 'site.test could not be reached');
});

test('a live request to a closed port, or to a name that does not resolve, says so in the host\'s words', async () => {
  const closed = await tcpServer(() => {});
  const port = closed.port;
  closed.close();
  assert.equal((await failureOf(`http://127.0.0.1:${port}/`, SCALED)).message, '127.0.0.1 refused the connection');

  const nowhere = (hostname, options, callback) => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  const error = await createLiveTransport({ ...SCALED, resolve: nowhere }).request({ method: 'GET', url: 'http://nowhere.test/', headers: {} })
    .then(() => assert.fail('the request succeeded'), (thrown) => thrown);
  assert.equal(error.message, 'nowhere.test could not be found');
});

test('a live request is cancelled when the call it belongs to ends', async () => {
  const server = await tcpServer(() => {});
  try {
    const call = new AbortController();
    const started = Date.now();
    const request = createLiveTransport(SCALED)
      .request({ method: 'GET', url: `http://127.0.0.1:${server.port}/`, headers: {}, signal: call.signal });
    setTimeout(() => call.abort(new Error('the call ended')), 100);

    await assert.rejects(request, (error) => {
      assert.equal(error.code, Code.REQUEST_FAILED);
      assert.equal(error.message, '127.0.0.1 could not be reached');
      return true;
    });
    assert.ok(Date.now() - started < 1000);
  } finally {
    server.close();
  }
});

// kangzj/yonto#513. `CallLimitsRecordTest` holds the device's NetworkModule to the same record.
test('a live request is given the connect, read and whole-request timeouts a television gives it', () => {
  const record = JSON.parse(readFileSync(new URL('../conformance/limits.json', import.meta.url), 'utf8'));

  assert.deepEqual(createLiveTransport().limits, {
    connectTimeoutMs: record.requestConnectTimeoutMs,
    readTimeoutMs: record.requestReadTimeoutMs,
    timeoutMs: record.requestTimeoutMs,
  });
});

test('a live request that cannot finish connecting fails at the connect timeout', async () => {
  // A TCP server that never answers the TLS handshake: connected, never secure.
  const server = await tcpServer(() => {});
  try {
    const { tookMs, message, why } = await failureOf(`https://127.0.0.1:${server.port}/`, { ...SCALED, connectTimeoutMs: 200 });
    assert.ok(tookMs < 2000, `took ${tookMs} ms`);
    assert.equal(message, '127.0.0.1 did not answer in time');
    assert.match(why, /Connect Timeout/);
  } finally {
    server.close();
  }
});

// undici checks its timeouts about once a second, hence the margins.
test('a live request whose site says nothing fails at the read timeout', async () => {
  const server = await tcpServer(() => {});
  try {
    const { tookMs, message, why } = await failureOf(`http://127.0.0.1:${server.port}/`, { ...SCALED, readTimeoutMs: 200 });
    assert.ok(tookMs < 2000, `took ${tookMs} ms`);
    assert.equal(message, '127.0.0.1 did not answer in time');
    assert.match(why, /Headers Timeout/);
  } finally {
    server.close();
  }
});

test('a live request whose site goes quiet partway through the body fails at the read timeout', async () => {
  const server = await tcpServer((socket) => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nxx'));
  try {
    const { tookMs, message, why } = await failureOf(`http://127.0.0.1:${server.port}/`, { ...SCALED, readTimeoutMs: 200 });
    assert.ok(tookMs < 2000, `took ${tookMs} ms`);
    assert.equal(message, '127.0.0.1 did not answer in time');
    assert.match(why, /Body Timeout/);
  } finally {
    server.close();
  }
});

test('a live request whose site never stops trickling fails at the whole-request timeout', async () => {
  // A byte every 50 ms, so no read is ever quiet for long.
  const server = await tcpServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n');
    const trickle = setInterval(() => socket.write('x'), 50);
    socket.on('close', () => clearInterval(trickle));
  });
  try {
    const { tookMs, message, why } = await failureOf(`http://127.0.0.1:${server.port}/`, { ...SCALED, timeoutMs: 300 });
    assert.ok(tookMs < 2000, `took ${tookMs} ms`);
    assert.equal(message, '127.0.0.1 did not answer in time');
    assert.match(why, /no answer within 300 ms/);
  } finally {
    server.close();
  }
});
