import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFetch } from '../src/host/fetch.js';
import { createLiveTransport } from '../src/transport/live.js';

// Only the host as written is under the private-address floor (Jasper, 2026-09-26): a name is
// reached wherever it resolves, and a private address written as one is still refused.
// `OkHttpPluginTransportTest` and the `private-floor/resolved-name/` conformance suite hold the
// device to the same.

async function loopbackServer() {
  let reached = 0;
  const server = createServer((request, response) => {
    reached += 1;
    response.end('pong');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, reached: () => reached, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** `dns.lookup`'s shape, pointing `named.test` at loopback. */
function pointedAtLoopback(hostname, options, callback) {
  const answer = { address: '127.0.0.1', family: 4 };
  if (options?.all) callback(null, [answer]);
  else callback(null, answer.address, answer.family);
}

function fetchThroughTheHost() {
  return createFetch({
    hosts: { fromManifest: [], fromViewer: [], fromRepo: [], floorExempt: [], all: [] },
    hostsEnforced: false,
    transport: createLiveTransport({ resolve: pointedAtLoopback }),
    requests: [],
  });
}

test('a name that resolves to a private address is reached through yonto.fetch', async () => {
  const server = await loopbackServer();
  try {
    const response = await fetchThroughTheHost()(`http://named.test:${server.port}/ping`);

    assert.equal(response.status, 200);
    assert.equal(server.reached(), 1);
  } finally {
    await server.close();
  }
});

test('a private address written as one is still refused', async () => {
  const fetch = fetchThroughTheHost();
  for (const url of ['http://10.0.0.1/', 'http://127.0.0.1/', 'http://localhost/', 'http://x.local/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(fetch(url), (error) => error.code === 'HOST_NOT_ALLOWED', url);
  }
});
