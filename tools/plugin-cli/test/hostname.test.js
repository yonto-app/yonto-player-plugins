import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostOf, hostOfEntry } from '../src/hostname.js';

// The table both hosts answer to. `PluginHostnameConformanceTest` is the JVM twin, and a
// spelling that reaches only one of them is a plugin that behaves differently on a
// television than it did on its author's laptop.
const table = JSON.parse(
  readFileSync(fileURLToPath(new URL('../conformance/hostnames.json', import.meta.url)), 'utf8'));

test('every recorded spelling extracts to its canonical host', () => {
  for (const [url, expected] of Object.entries(table)) {
    assert.equal(hostOf(url), expected, `hostOf(${JSON.stringify(url)})`);
  }
});

test('a host is extracted once, so the same string is never read two ways', () => {
  // The property that makes an allowlist entry and a fetch agree about `2130706433`: the
  // permission and the request ask one function, rather than two parsers agreeing by luck.
  assert.equal(hostOf('http://2130706433/x'), hostOf('http://127.0.0.1/y'));
});

// `hostOfEntry` is the same rule for a string written as a host rather than as a URL, which
// is what an `allowedHosts` entry, a `url` default and anything typed on a remote all are.
test('a bare host:port is a host and a port, not an IPv6 literal', () => {
  // Reading it the other way round is what made `lint` stop warning about a schemeless
  // private address, and what made an IPv6 entry match nothing.
  assert.equal(hostOfEntry('192.168.1.50:8096'), '192.168.1.50');
  assert.equal(hostOfEntry('localhost:3000'), 'localhost');
  assert.equal(hostOfEntry('example.com:8080'), 'example.com');
  assert.equal(hostOfEntry('2130706433:8096'), '127.0.0.1');
});

test('a bare IPv6 literal gets its brackets back, bracketed or not', () => {
  assert.equal(hostOfEntry('::1'), '::1');
  assert.equal(hostOfEntry('[::1]'), '::1');
  assert.equal(hostOfEntry('2001:db8::1'), '2001:db8::1');
  assert.equal(hostOfEntry('[2001:db8::1]:8096'), '2001:db8::1');
});

test('an entry that is already a URL is read as one', () => {
  assert.equal(hostOfEntry('http://192.168.1.2/config.json'), '192.168.1.2');
  assert.equal(hostOfEntry('HTTPS://Example.COM./x'), 'example.com');
  assert.equal(hostOfEntry('ftp://example.com/'), null);
  assert.equal(hostOfEntry(''), null);
  assert.equal(hostOfEntry('   '), null);
});
