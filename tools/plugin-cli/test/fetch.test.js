import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetch } from '../src/host/fetch.js';
import { Code, PluginError } from '../src/errors.js';

function fakeTransport(body = 'hello', status = 200, headers = {}) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      return { status, headers, bodyBase64: Buffer.from(body, 'utf8').toString('base64') };
    },
  };
}

// `createFetch` is handed provenance rather than a union, because the floor exempts a host
// a viewer typed and refuses one a manifest named. Most cases here only care that a host is
// permitted at all, so this names the manifest as the one that permitted it.
function hostsOf(fromManifest, fromViewer = []) {
  return { fromManifest, fromViewer, fromRepo: [], floorExempt: fromViewer, all: [...fromManifest, ...fromViewer] };
}

test('fetches an allowed host and decodes the body as utf-8', async () => {
  const transport = fakeTransport('<html>庆余年</html>');
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['www.aiyingshi.tv']), transport, requests });

  const res = await fetch('https://www.aiyingshi.tv/dianying/');

  assert.equal(res.status, 200);
  assert.equal(res.body, '<html>庆余年</html>');
  assert.equal(transport.calls[0].method, 'GET');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].blocked, false);
});

test('refuses a host that is not in allowedHosts and names it', async () => {
  const transport = fakeTransport();
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['www.aiyingshi.tv']), transport, requests });

  await assert.rejects(
    () => fetch('https://evil.example.com/collect'),
    (error) => {
      assert.equal(error.code, Code.HOST_NOT_ALLOWED);
      assert.match(error.message, /evil\.example\.com/);
      return true;
    },
  );
  assert.equal(transport.calls.length, 0, 'a blocked request must never reach the transport');
  assert.equal(requests[0].blocked, true);
});

test('a leading *. allows subdomains but not the bare domain', async () => {
  const transport = fakeTransport();
  const fetch = createFetch({ hosts: hostsOf(['*.aiyingshi.tv']), transport, requests: [] });

  await fetch('https://img.aiyingshi.tv/a.jpg');
  await assert.rejects(() => fetch('https://aiyingshi.tv/a.jpg'));
});

test('a leading *. does not allow a host that merely contains the suffix', async () => {
  const transport = fakeTransport();
  const fetch = createFetch({ hosts: hostsOf(['*.aiyingshi.tv']), transport, requests: [] });

  await assert.rejects(() => fetch('https://evilaiyingshi.tv/a.jpg'));
  await assert.rejects(() => fetch('https://xaiyingshi.tv/a.jpg'));
});

test('sends the headers and body it was given', async () => {
  const transport = fakeTransport();
  const fetch = createFetch({ hosts: hostsOf(['www.aiyingshi.tv']), transport, requests: [] });

  await fetch('https://www.aiyingshi.tv/search/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'wd=庆余年',
  });

  assert.equal(transport.calls[0].method, 'POST');
  assert.equal(transport.calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(transport.calls[0].body, 'wd=庆余年');
});

test('decodes a GBK page when asked, because plenty of MacCMS sites serve one', async () => {
  const gbk = Buffer.from([0xc7, 0xec, 0xd3, 0xe0, 0xc4, 0xea]); // 庆余年 in GBK
  const transport = {
    async request() { return { status: 200, headers: {}, bodyBase64: gbk.toString('base64') }; },
  };
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests: [] });

  const res = await fetch('https://h.tv/', { encoding: 'gbk' });

  assert.equal(res.body, '庆余年');
});

test('logs the request headers actually sent, so a 403 is debuggable', async () => {
  const transport = fakeTransport('nope', 403);
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests });

  await fetch('https://h.tv/a', { headers: { Referer: 'https://h.tv/' } });

  assert.equal(requests[0].status, 403);
  assert.equal(requests[0].requestHeaders.Referer, 'https://h.tv/');
});

test('logs a request that fails in transport instead of leaving it unrecorded', async () => {
  const transport = { async request() { throw new Error('getaddrinfo ENOTFOUND h.tv'); } };
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests });

  await assert.rejects(
    () => fetch('https://h.tv/a', { headers: { Referer: 'https://h.tv/' } }),
    /ENOTFOUND/,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, null);
  assert.equal(requests[0].failed, true);
  assert.equal(requests[0].blocked, false);
  assert.equal(requests[0].error, 'getaddrinfo ENOTFOUND h.tv');
  assert.equal(requests[0].requestHeaders.Referer, 'https://h.tv/');
});

test('hands every Set-Cookie back as an array and keeps the folded one out of headers', async () => {
  const transport = {
    async request() {
      return {
        status: 200,
        // Capitalised on purpose: undici lowercases, a hand-written fixture need not.
        headers: { 'content-type': 'text/plain', 'Set-Cookie': 'a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT, b=2' },
        setCookie: ['a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT', 'b=2'],
        bodyBase64: Buffer.from('ok', 'utf8').toString('base64'),
      };
    },
  };
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests: [] });

  const res = await fetch('https://h.tv/login');

  assert.deepEqual(res.setCookie, ['a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT', 'b=2']);
  assert.deepEqual(Object.keys(res.headers), ['content-type'],
    'the folded value cannot be split again, so it is not offered under any spelling');
  assert.equal(res.headers['content-type'], 'text/plain', 'every other header is untouched');
});

test('a transport that reports no cookies still yields an array', async () => {
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport: fakeTransport(), requests: [] });
  assert.deepEqual((await fetch('https://h.tv/')).setCookie, []);
});

// The Kotlin host wraps whatever its transport throws; anything reaching a plugin
// uncoded here would be METHOD_THREW on one host and REQUEST_FAILED on the other. The
// errno case is the one that matters: a Node error carries `.code` for the filesystem's
// reasons, so the test cannot be "does it have a code".
for (const [what, thrown] of [
  ['without a code', new Error('socket hang up')],
  ['with an errno', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })],
]) {
  test(`a transport that fails ${what} reaches the plugin as REQUEST_FAILED`, async () => {
    const transport = { async request() { throw thrown; } };
    const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests: [] });

    await assert.rejects(() => fetch('https://h.tv/'), (error) => {
      assert.equal(error.code, Code.REQUEST_FAILED);
      assert.match(error.message, /socket hang up|EACCES/);
      return true;
    });
  });
}

test('a failure the host itself reached keeps its own code', async () => {
  const transport = { async request() { throw new PluginError(Code.NO_FIXTURE, 'no recorded fixture'); } };
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests: [] });

  await assert.rejects(() => fetch('https://h.tv/'), (error) => {
    assert.equal(error.code, Code.NO_FIXTURE, 'replay and live raise their own codes and must pass through');
    return true;
  });
});

test('a port is not part of what the allowlist judges', () => {
  // The device's `URI.host` drops it, so the CLI must too: a self-hosted server on :8096
  // is the case this whole field exists for.
  const transport = fakeTransport();
  const fetch = createFetch({ hosts: hostsOf(['media.example.com']), transport, requests: [] });

  return fetch('https://media.example.com:8096/System/Info');
});

test('a host is matched case-insensitively, on both sides of the comparison', async () => {
  const transport = fakeTransport();
  const fetch = createFetch({ hosts: hostsOf(['Media.Example.com']), transport, requests: [] });

  await fetch('https://MEDIA.example.COM/a.jpg');
  assert.equal(transport.calls.length, 1);
});

// Its own code since kangzj/lantern-tv#651: nothing was sent, so it is not a server's silence.
test('a string that names no host is REQUEST_INVALID, the verdict the device reaches', async () => {
  const transport = fakeTransport();
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['media.example.com']), transport, requests });

  await assert.rejects(
    () => fetch('not a url at all'),
    (error) => {
      assert.ok(error instanceof PluginError);
      assert.equal(error.code, Code.REQUEST_INVALID);
      return true;
    },
  );
  assert.equal(transport.calls.length, 0);
});

// A scripted server: one entry per URL, so a chain can be walked and every request it
// made is left in `calls` to be asserted on.
function scriptedTransport(pages) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const page = pages[req.url];
      if (!page) throw new Error(`no page for ${req.url}`);
      return {
        status: page.status ?? 200,
        headers: page.headers ?? {},
        bodyBase64: Buffer.from(page.body ?? '', 'utf8').toString('base64'),
      };
    },
  };
}

test('a 302 is followed, and the answer says where the body came from', async () => {
  const transport = scriptedTransport({
    'https://a.test/start': { status: 302, headers: { Location: '/landed' } },
    'https://a.test/landed': { body: 'landed' },
  });
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  const res = await fetch('https://a.test/start');

  assert.equal(res.body, 'landed');
  assert.equal(res.status, 200);
  assert.equal(res.url, 'https://a.test/landed');
});

test('every hop is checked against the allowlist, so a redirect cannot leave it', async () => {
  // The whole reason following belongs to the host: a source that 302s to somewhere else
  // would otherwise carry the plugin — and its headers — off the hosts it was allowed.
  const transport = scriptedTransport({
    'https://a.test/start': { status: 302, headers: { location: 'https://evil.test/collect' } },
    'https://evil.test/collect': { body: 'gotcha' },
  });
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests });

  await assert.rejects(
    () => fetch('https://a.test/start'),
    (error) => {
      assert.equal(error.code, Code.HOST_NOT_ALLOWED);
      assert.match(error.message, /evil\.test/);
      return true;
    },
  );
  assert.deepEqual(transport.calls.map((c) => c.url), ['https://a.test/start']);
  assert.equal(requests.at(-1).blocked, true);
});

test("redirect: 'manual' hands the 3xx back instead of following it", async () => {
  const transport = scriptedTransport({
    'https://a.test/start': { status: 302, headers: { location: '/landed' } },
    'https://a.test/landed': { body: 'landed' },
  });
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  const res = await fetch('https://a.test/start', { redirect: 'manual' });

  assert.equal(res.status, 302);
  assert.equal(res.url, 'https://a.test/start');
  assert.equal(res.headers.location, '/landed');
  assert.equal(transport.calls.length, 1);
});

test('a POST redirected 302 becomes a GET with no body, while 307 keeps both', async () => {
  const transport = scriptedTransport({
    'https://a.test/post': { status: 302, headers: { location: '/after' } },
    'https://a.test/keep': { status: 307, headers: { location: '/after' } },
    'https://a.test/after': { body: 'ok' },
  });
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  await fetch('https://a.test/post', { method: 'POST', body: 'q=1' });
  // `!body` rather than `undefined`: through the real bootstrap a bodyless request arrives
  // as null, and what matters is that nothing was carried over.
  assert.deepEqual(transport.calls.map((c) => [c.method, !c.body]), [['POST', false], ['GET', true]]);

  transport.calls.length = 0;
  await fetch('https://a.test/keep', { method: 'POST', body: 'q=1' });
  assert.deepEqual(
    transport.calls.map((c) => [c.method, c.body]),
    [['POST', 'q=1'], ['POST', 'q=1']],
  );
});

test('a redirect to another host drops the headers meant for the first one', async () => {
  const transport = scriptedTransport({
    'https://a.test/start': { status: 302, headers: { location: 'https://b.test/landed' } },
    'https://b.test/landed': { body: 'landed' },
  });
  const fetch = createFetch({ hosts: hostsOf(['a.test', 'b.test']), transport, requests: [] });

  await fetch('https://a.test/start', {
    headers: { Authorization: 'Bearer t', Cookie: 'sid=1', Referer: 'https://a.test/' },
  });

  assert.deepEqual(transport.calls.at(-1).headers, { Referer: 'https://a.test/' });
});

test('a redirect chain that runs out of time is refused as a redirect', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const transport = scriptedTransport({
    'https://a.test/slow': { status: 302, headers: { location: '/slower' } },
    'https://a.test/slower': { status: 302, headers: { location: '/slow' } },
  });
  const slow = { calls: transport.calls, async request(req) { clock += 61_000; return transport.request(req); } };
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport: slow, requests: [] });

  await assert.rejects(
    () => fetch('https://a.test/slow'),
    (error) => {
      assert.equal(error.code, Code.REDIRECT_REFUSED);
      assert.match(error.message, /took longer than/);
      return true;
    },
  );
});

// REDIRECT_REFUSED since kangzj/lantern-tv#651: the server answered, with redirects.
// A server can redirect to something that resolves and still names no host the host can
// reach. That is the server's doing, not a URL the plugin wrote, so it is not REQUEST_INVALID.
test('a redirect to a URL that names no host is refused as a redirect', async () => {
  const transport = scriptedTransport({
    'https://a.test/odd': { status: 302, headers: { location: 'http://1.2.3.999/' } },
  });
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  await assert.rejects(
    () => fetch('https://a.test/odd'),
    (error) => {
      assert.equal(error.code, Code.REDIRECT_REFUSED);
      return true;
    },
  );
});

test('a redirect loop ends as REDIRECT_REFUSED rather than spinning', async () => {
  const transport = scriptedTransport({
    'https://a.test/loop': { status: 302, headers: { location: '/loop' } },
  });
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  await assert.rejects(
    () => fetch('https://a.test/loop'),
    (error) => {
      assert.equal(error.code, Code.REDIRECT_REFUSED);
      assert.match(error.message, /more than 20 redirects/);
      return true;
    },
  );
  assert.equal(transport.calls.length, 21);
});

test('a 3xx with no Location is an answer, not a redirect', async () => {
  const transport = scriptedTransport({ 'https://a.test/odd': { status: 302, body: 'body anyway' } });
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  const res = await fetch('https://a.test/odd');

  assert.equal(res.status, 302);
  assert.equal(res.body, 'body anyway');
});

test('a plugin whose hosts come from its own config reaches one its manifest never named', async () => {
  // A 仓 lists its CMS sites at hosts no manifest could have named. The device host reads
  // the same manifest flag — `PluginManifest.hostsAreEnforced` is where that is argued.
  const transport = fakeTransport('sites');
  const fetch = createFetch({ hosts: hostsOf([]), hostsEnforced: false, transport, requests: [] });

  const res = await fetch('https://whatever.test/api');

  assert.equal(res.body, 'sites');
  assert.equal(transport.calls.length, 1);
});

test('a redirect is not checked either for such a plugin, and still is for every other', async () => {
  const pages = {
    'https://a.test/start': { status: 302, headers: { location: 'https://elsewhere.test/landed' } },
    'https://elsewhere.test/landed': { body: 'landed' },
  };

  const open = createFetch({
    hosts: hostsOf([]), hostsEnforced: false, transport: scriptedTransport(pages), requests: [],
  });
  assert.equal((await open.call(null, 'https://a.test/start')).body, 'landed');

  const closed = createFetch({ hosts: hostsOf(['a.test']), transport: scriptedTransport(pages), requests: [] });
  await assert.rejects(() => closed('https://a.test/start'), (error) => {
    assert.equal(error.code, Code.HOST_NOT_ALLOWED);
    return true;
  });
});

test('the flag is off unless a manifest asks for it', async () => {
  const transport = fakeTransport();
  const fetch = createFetch({ hosts: hostsOf(['a.test']), transport, requests: [] });

  await assert.rejects(() => fetch('https://whatever.test/api'), (error) => {
    assert.equal(error.code, Code.HOST_NOT_ALLOWED);
    return true;
  });
});

test('a plugin with no allowlist still cannot reach the network the device is on', async () => {
  // A 仓 names its own servers and nobody read that list, so it does not get to name the
  // television's own network. `isPrivateHost` is the same rule on the device,
  // and the floor is now every plugin's rather than only this path's.
  const transport = fakeTransport('router');
  const fetch = createFetch({ hosts: hostsOf([]), hostsEnforced: false, transport, requests: [] });

  for (const url of [
    'http://192.168.1.1/admin',
    'http://127.0.0.1:8080/x',
    'http://10.0.0.5/x',
    'http://172.20.1.1/x',
    'http://169.254.1.1/x',
    'http://nas.local/x',
  ]) {
    await assert.rejects(() => fetch(url), (error) => {
      assert.equal(error.code, Code.HOST_NOT_ALLOWED, url);
      return true;
    });
  }
  assert.equal(transport.calls.length, 0, 'nothing reached the transport');
});

test('a private address a person named is still theirs to name', async () => {
  // Named in `fromViewer`, because that is what "a person named it" now means: a host typed
  // into a `url` field. It used to be expressed as an allowlist entry, which a manifest can
  // also write — and the floor exists to refuse exactly that.
  const transport = fakeTransport('my box');
  const fetch = createFetch({
    hosts: hostsOf([], ['192.168.1.50']), hostsEnforced: false, transport, requests: [],
  });

  assert.equal((await fetch('http://192.168.1.50:8096/x')).body, 'my box');
});

test('a public address is unaffected by the floor', async () => {
  const transport = fakeTransport('sites');
  const fetch = createFetch({ hosts: hostsOf([]), hostsEnforced: false, transport, requests: [] });

  assert.equal((await fetch('https://8.8.8.8/x')).body, 'sites');
  assert.equal((await fetch('https://anywhere.test/x')).body, 'sites');
});

// The floor. A plugin may not reach the television's own network because its manifest asked
// to — see contracts/content-source-http.md's "The private-address floor". Mirrored in
// `JsHostApiConformanceTest`, and `conformance/private-floor` runs one plugin through both.

test('a manifest cannot reach a private address by naming it', async () => {
  const transport = fakeTransport('router');
  const fetch = createFetch({ hosts: hostsOf(['192.168.1.1']), transport, requests: [] });

  await assert.rejects(() => fetch('http://192.168.1.1/'), (error) => {
    assert.equal(error.code, Code.HOST_NOT_ALLOWED);
    assert.match(error.message, /^192\.168\.1\.1 is a private address, and nothing the viewer typed names it$/);
    return true;
  });
  assert.equal(transport.calls.length, 0, 'nothing reached the transport');
});

test('a spelling does not get a private address past the floor', async () => {
  // The whole of kangzj/lantern-tv#92 in one case: refused here, and fetched on a
  // television, because only one of the two folded the spelling before classifying it.
  const fetch = createFetch({ hosts: hostsOf(['2130706433']), transport: fakeTransport(), requests: [] });

  await assert.rejects(() => fetch('http://2130706433/'), (error) => {
    assert.match(error.message, /^127\.0\.0\.1 is a private address/);
    return true;
  });
});

test('a url default a viewer never changed is the manifest asking, and is refused', async () => {
  // `hostsWith` puts a value equal to the `default` in fromManifest, which is what this is:
  // the only way a hostsFromConfig manifest can name a host, and still not a viewer's word.
  const fetch = createFetch({
    hosts: hostsOf(['192.168.1.2']), hostsEnforced: false, transport: fakeTransport(), requests: [],
  });

  await assert.rejects(() => fetch('http://192.168.1.2/config.json'), (error) => {
    assert.match(error.message, /^192\.168\.1\.2 is a private address/);
    return true;
  });
});

test('a host the viewer typed is reachable even though it is private', async () => {
  const fetch = createFetch({ hosts: hostsOf([], ['192.168.1.50']), transport: fakeTransport(), requests: [] });

  const response = await fetch('http://192.168.1.50:8096/a');
  assert.equal(response.status, 200);
});

test('the exemption is a host, not a chain', async () => {
  // A viewer typing one address does not hand the plugin the rest of the LAN, so a redirect
  // off the exempt host is refused — the same shape as dropping Authorization when a hop
  // leaves the origin.
  const transport = {
    calls: [],
    async request(req) {
      this.calls.push(req);
      return req.url === 'http://192.168.1.50:8096/moved'
        ? { status: 302, headers: { location: 'http://192.168.1.1/b' }, bodyBase64: '' }
        : { status: 200, headers: {}, bodyBase64: Buffer.from('landed', 'utf8').toString('base64') };
    },
  };
  // A plugin whose hosts are not enforced, so the floor is the only thing deciding and the
  // message is the floor's. On the enforced path the allowlist refuses the second hop first,
  // which the per-hop allowlist cases above already cover.
  const fetch = createFetch({
    hosts: hostsOf([], ['192.168.1.50']), hostsEnforced: false, transport, requests: [],
  });

  await assert.rejects(() => fetch('http://192.168.1.50:8096/moved'), (error) => {
    assert.match(error.message, /^192\.168\.1\.1 is a private address/);
    return true;
  });
  assert.deepEqual(transport.calls.map((c) => c.url), ['http://192.168.1.50:8096/moved'],
    'the second hop never went out');
});

test('a redirect that stays on the exempt host is followed', async () => {
  const transport = {
    async request(req) {
      return req.url.endsWith('/a')
        ? { status: 302, headers: { location: 'http://192.168.1.50:8096/b' }, bodyBase64: '' }
        : { status: 200, headers: {}, bodyBase64: Buffer.from('landed', 'utf8').toString('base64') };
    },
  };
  const fetch = createFetch({
    hosts: hostsOf([], ['192.168.1.50']), hostsEnforced: false, transport, requests: [],
  });

  const response = await fetch('http://192.168.1.50:8096/a');
  assert.equal(response.body, 'landed');
  assert.equal(response.url, 'http://192.168.1.50:8096/b');
});

test('an allowlist entry matches a host written with a root dot', async () => {
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport: fakeTransport(), requests: [] });

  const response = await fetch('https://h.tv./a');
  assert.equal(response.status, 200);
});

test('an allowlist entry written in an odd spelling means what a request means', async () => {
  // `allowedHosts: ["2130706433"]` never matched the canonical `127.0.0.1` the CLI
  // extracted, so the entry permitted nothing here and permitted loopback on a television.
  const fetch = createFetch({ hosts: hostsOf(['0x7f000001'], ['127.0.0.1']), transport: fakeTransport(), requests: [] });

  const response = await fetch('http://127.1/x');
  assert.equal(response.status, 200);
});

test('a wildcard entry is a name suffix and is never folded as an address', async () => {
  // `*.1.1` still matches `192.168.1.1` by suffix exactly as it did — an address has no
  // subdomains — and the floor is what refuses the private host it matched.
  const fetch = createFetch({ hosts: hostsOf(['*.1.1']), transport: fakeTransport(), requests: [] });

  await assert.rejects(() => fetch('http://192.168.1.1/'), (error) => {
    assert.match(error.message, /is a private address/);
    return true;
  });
});

test('an IPv6 host a manifest named through a url default can reach itself', () => {
  // `hostsWith` contributes an unbracketed `2001:db8::1`, and `http://` + that string parses
  // as host `2001` and an invalid port — so the entry matched nothing and the plugin was
  // refused the one host its own manifest named.
  const fetch = createFetch({ hosts: hostsOf(['2001:db8::1']), transport: fakeTransport(), requests: [] });

  return assert.doesNotReject(() => fetch('http://[2001:db8::1]:8096/a'));
});

test('an allowlist entry written as a schemeless host and port matches that host', () => {
  const fetch = createFetch({ hosts: hostsOf(['media.example.com:8096']), transport: fakeTransport(), requests: [] });

  return assert.doesNotReject(() => fetch('https://media.example.com/poster.jpg'));
});

test('a failed request keeps the code the host gave it, for a plugin that re-raises its own', async () => {
  // doctor reads it to tell a missing --replay fixture from a site that is down, after a
  // plugin caught the one and raised the other (kangzj/lantern-tv#331).
  const transport = { async request() { throw new PluginError(Code.NO_FIXTURE, 'no recorded fixture for GET https://h.tv/a'); } };
  const requests = [];
  const fetch = createFetch({ hosts: hostsOf(['h.tv']), transport, requests });

  await assert.rejects(() => fetch('https://h.tv/a'));

  assert.equal(requests[0].code, Code.NO_FIXTURE);
});
