import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HOPS, carriesBody, headersFor, isPrivate, isRedirect, methodFor, resolve,
} from '../src/host/redirect.js';

// Mirrors `PluginRedirectTest.kt` case for case: the two hosts have to follow a 3xx by the
// same rules, and `conformance/host-api` only runs one chain through both.

test('a status is a redirect only when it carries somewhere to go', () => {
  for (const status of [301, 302, 303, 307, 308]) assert.equal(isRedirect(status), true, String(status));
  // 304 is a cache answer and 305 names a proxy; neither is somewhere to follow.
  for (const status of [200, 204, 300, 304, 305, 306, 400, 500]) {
    assert.equal(isRedirect(status), false, String(status));
  }
});

test('a Location is resolved against the URL it arrived from', () => {
  assert.equal(resolve('https://a.test/start', '/landed'), 'https://a.test/landed');
  assert.equal(resolve('https://a.test/deep/start', 'next'), 'https://a.test/deep/next');
  assert.equal(resolve('https://a.test/start', 'https://b.test/landed'), 'https://b.test/landed');
  assert.equal(resolve('https://a.test/start', '  /landed  '), 'https://a.test/landed');
});

test('a Location that resolves to nothing this host fetches is null, not a guess', () => {
  assert.equal(resolve('https://a.test/start', 'javascript:alert(1)'), null);
  assert.equal(resolve('https://a.test/start', 'ftp://a.test/landed'), null);
  assert.equal(resolve('not a url', '/landed'), null);
});

test('a tab or a line break inside a Location is removed, not a reason to fail', () => {
  // This parser removes them and OkHttp's does not, so without stripping them here a
  // folded header would be followed in a CLI and refused on a television.
  assert.equal(resolve('https://a.test/start', '/lan\tded'), 'https://a.test/landed');
  assert.equal(resolve('https://a.test/start', '/lan\r\nded'), 'https://a.test/landed');
});

test('a POST becomes a GET on 301 and 302, and on 303 whatever it was', () => {
  assert.equal(methodFor(301, 'POST'), 'GET');
  assert.equal(methodFor(302, 'POST'), 'GET');
  assert.equal(methodFor(303, 'POST'), 'GET');
  assert.equal(methodFor(303, 'PUT'), 'GET');
  assert.equal(methodFor(303, 'HEAD'), 'HEAD');
  assert.equal(methodFor(302, 'GET'), 'GET');
});

test('307 and 308 exist so a method survives, and it does', () => {
  assert.equal(methodFor(307, 'POST'), 'POST');
  assert.equal(methodFor(308, 'POST'), 'POST');
  assert.equal(carriesBody(307, 'POST'), true);
  assert.equal(carriesBody(302, 'POST'), false, 'a method that changed cannot take its body with it');
});

test('leaving the origin drops what was meant for the one being left', () => {
  const headers = { Authorization: 'Bearer t', Cookie: 'sid=1', Referer: 'https://a.test/' };
  const kept = { Referer: 'https://a.test/' };

  assert.deepEqual(headersFor(headers, 'https://a.test/start', 'https://a.test/landed', true), headers);
  assert.deepEqual(headersFor(headers, 'https://a.test/start', 'https://b.test/landed', true), kept);
  // A downgrade is another origin: a bearer token must not go out in clear because the
  // host it was for said so. And so is another port, usually another service on one box.
  assert.deepEqual(headersFor(headers, 'https://a.test/start', 'http://a.test/landed', true), kept);
  assert.deepEqual(headersFor(headers, 'https://a.test/start', 'https://a.test:8443/landed', true), kept);
});

test('a method that lost its body loses what described it', () => {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '4', Accept: '*/*' };

  assert.deepEqual(headersFor(headers, 'https://a.test/a', 'https://a.test/b', true), headers);
  assert.deepEqual(headersFor(headers, 'https://a.test/a', 'https://a.test/b', false), { Accept: '*/*' });
});

test('the ceiling is the one both hosts name', () => {
  assert.equal(MAX_HOPS, 20);
});

// `isPrivate` had no test of its own on either host and was covered only through what
// `yonto.fetch` did with it. These mirror `PrivateHostTest.kt` case for case.

test('a canonical host is classified without guessing at its spelling', () => {
  // Extraction folded these before they arrived, which is the point: `isPrivate` never
  // sees `2130706433` or `192.168.001.1`, so it does not need to know they are addresses.
  assert.equal(isPrivate('127.0.0.1'), true);
  assert.equal(isPrivate('10.0.0.1'), true);
  assert.equal(isPrivate('192.168.1.1'), true);
  assert.equal(isPrivate('169.254.1.1'), true);
  assert.equal(isPrivate('0.0.0.0'), true);
  assert.equal(isPrivate('172.16.0.1'), true);
  assert.equal(isPrivate('172.31.255.255'), true);
  assert.equal(isPrivate('172.32.0.1'), false);
  assert.equal(isPrivate('172.15.0.1'), false);
  assert.equal(isPrivate('8.8.8.8'), false);
  assert.equal(isPrivate('example.com'), false);
});

// Carrier-grade NAT, which Tailscale hands its devices from (kangzj/lantern-tv#334).
test('100.64.0.0/10 is private, and its neighbours are not', () => {
  for (const host of ['100.64.0.0', '100.100.1.1', '100.127.255.255']) assert.equal(isPrivate(host), true, host);
  for (const host of ['100.63.255.255', '100.128.0.0']) assert.equal(isPrivate(host), false, host);
});

test('198.18.0.0/15 is private, and its neighbours are not', () => {
  for (const host of ['198.18.0.0', '198.19.255.255']) assert.equal(isPrivate(host), true, host);
  for (const host of ['198.17.255.255', '198.20.0.0']) assert.equal(isPrivate(host), false, host);
});

// An IPv6 address carrying an IPv4 one to deliver to is that IPv4 address (#675's review).
test('NAT64, 6to4 and Teredo are whatever IPv4 address they carry', () => {
  for (const host of ['64:ff9b::c0a8:146', '64:ff9b::7f00:1', '2002:c0a8:146::', '::ffff:0:c0a8:146', '2001:0:4136:e378:8000:63bf:3f57:feb9', '64:ff9b:1::a']) {
    assert.equal(isPrivate(host), true, host);
  }
  for (const host of ['64:ff9b::808:808', '2002:808:808::', '::ffff:0:808:808', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2606:4700:4700::1111']) {
    assert.equal(isPrivate(host), false, host);
  }
});

test('a root dot does not hide loopback', () => {
  // `localhost.` used to reach here whole, and neither host called it private — while
  // `lint` stripped the dot and warned. Extraction strips it now, so this is what arrives.
  assert.equal(isPrivate('localhost'), true);
  assert.equal(isPrivate('dev.localhost'), true);
  assert.equal(isPrivate('nas.local'), true);
  assert.equal(isPrivate('notlocal'), false);
});

test('an unbracketed IPv6 address is classified by its first group', () => {
  // OkHttp never bracketed one, so the device's bracket branch was dead code and `[::1]`
  // classified as public there. Canonical form is unbracketed on both hosts now.
  assert.equal(isPrivate('::1'), true);
  assert.equal(isPrivate('::'), true);
  assert.equal(isPrivate('fc00::1'), true);
  assert.equal(isPrivate('fd12:3456::1'), true);
  assert.equal(isPrivate('fe80::1'), true);
  assert.equal(isPrivate('febf::1'), true);
  assert.equal(isPrivate('fec0::1'), false);
  assert.equal(isPrivate('2001:db8::1'), false);
  // A group is not zero-padded in canonical form, so `fc::1` is 00fc:… and is genuinely
  // outside fc00::/7 — and a name beginning "fc" is not an address at all.
  assert.equal(isPrivate('fc::1'), false);
  assert.equal(isPrivate('fcbarcelona.com'), false);
});

test('an IPv4-compatible IPv6 address is the address it carries', () => {
  // `::127.0.0.1` canonicalises to `::7f00:1` — OkHttp does not fold it the way it folds
  // `::ffff:`, so the canonical form does not either and the classification has to.
  assert.equal(isPrivate('::7f00:1'), true);
  assert.equal(isPrivate('::c0a8:101'), true);
  assert.equal(isPrivate('::a00:1'), true);
  assert.equal(isPrivate('::2'), true);
  // 8.8.8.8 in the same clothing is still 8.8.8.8.
  assert.equal(isPrivate('::808:808'), false);
  assert.equal(isPrivate('2001:db8::1'), false);
});

// Each of these would read as private if its shape went unchecked: too few parts for a dotted
// quad, a four-label name, a group too wide for IPv6, and too few groups without a `::`.
test('what is not an address is not read as one', () => {
  for (const host of ['10.0.1', 'www.bbc.co.uk', '2002:c0a8:10146::', '2002:c0a8:146']) {
    assert.equal(isPrivate(host), false, host);
  }
});
