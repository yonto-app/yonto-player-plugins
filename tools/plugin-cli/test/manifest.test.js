import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMatchAHost, editDistance, hostsWith, namesPrivateAddress, unanswerableFields, validateManifest } from '../src/manifest.js';

const valid = {
  kind: 'content-source',
  id: 'iyingshi',
  name: '爱影视',
  version: '1.0.0',
  contractVersion: 21,
  provides: 'source',
  allowedHosts: ['www.aiyingshi.tv'],
};

test('accepts a minimal valid manifest', () => {
  assert.deepEqual(validateManifest(valid), { valid: true, errors: [] });
});

// Withdrawn in kangzj/lantern-tv#440: the chooser stored a set nothing ever read.
test('refuses a multi field, which was withdrawn with its chooser', () => {
  const field = { id: 'catalogs', label: 'Catalogs', type: 'multi', optionsFrom: 'subSources' };
  const { valid: ok, errors } = validateManifest({ ...valid, configSchema: [field] });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === '/configSchema/0/type'), JSON.stringify(errors));
});

test('names the offending field when one is missing', () => {
  const { valid: ok, errors } = validateManifest({ ...valid, allowedHosts: undefined });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /allowedHosts/);
});

test('rejects a version that is not X.Y.Z', () => {
  const { valid: ok, errors } = validateManifest({ ...valid, version: '1.0' });
  assert.equal(ok, false);
  assert.equal(errors[0].path, '/version');
});

// This once asserted the opposite — an empty list was "never what an author meant". It is
// exactly what a source with no site of its own means by it: a Jellyfin lives only where
// its owner put it, so the manifest names nothing and a `url` config field is the only
// thing that can widen the list. The alternative was a committed placeholder host that no
// reader could tell from a real entry.
test('accepts an empty allowedHosts, which a url config field is then the only way to widen', () => {
  const manifest = { ...valid, allowedHosts: [], configSchema: [{ id: 'serverUrl', label: 'Server', type: 'url' }] };

  assert.equal(validateManifest(manifest).valid, true);
  assert.deepEqual(hostsWith(manifest, {}).all, []);
  assert.deepEqual(hostsWith(manifest, { serverUrl: 'https://jf.example.com:8096' }).all, ['jf.example.com']);
});

test('still rejects a missing allowedHosts, which is an author forgetting rather than saying none', () => {
  const withoutHosts = { ...valid };
  delete withoutHosts.allowedHosts;
  assert.equal(validateManifest(withoutHosts).valid, false);
});

test('accepts a probeQuery, which is how a non-Latin catalog gets a search doctor can run', () => {
  assert.equal(validateManifest({ ...valid, probeQuery: '庆余年' }).valid, true);
  assert.equal(validateManifest({ ...valid, probeQuery: '' }).valid, false);
});

test('accepts a probeCategory, which is how a plugin whose first category has no page 2 gets one doctor can page', () => {
  assert.equal(validateManifest({ ...valid, probeCategory: 'document' }).valid, true);
  assert.equal(validateManifest({ ...valid, probeCategory: '' }).valid, false);
  assert.equal(validateManifest({ ...valid, probeCategory: 42 }).valid, false);
});

// Required in the contract and defaulted on a device, which is not a contradiction: an
// author has to decide, and a host meeting a manifest written before the field existed
// reads `source-type` rather than refusing a plugin it could run.
test('requires provides, and only knows two answers', () => {
  const without = { ...valid };
  delete without.provides;
  assert.equal(validateManifest(without).valid, false);
  assert.equal(validateManifest({ ...valid, provides: 'source-type' }).valid, true);
  assert.equal(validateManifest({ ...valid, provides: 'whatever' }).valid, false);
});

// What `lint` holds `provides: 'source'` to, and what `requireConfig` refuses to run
// without: a field with no answer and no default is a question, and an install that claims
// to ask nothing cannot have one.
test('a field is unanswerable when it is required and nothing defaults it', () => {
  const fields = [
    { id: 'siteUrl', label: 'Site', type: 'url', required: true, default: 'h.tv' },
    { id: 'note', label: 'Note', type: 'text' },
    { id: 'serverUrl', label: 'Server', type: 'url', required: true },
    { id: 'blank', label: 'Blank', type: 'text', required: true, default: '   ' },
  ];

  assert.deepEqual(unanswerableFields({ ...valid, configSchema: fields }).map((f) => f.id),
    ['serverUrl', 'blank']);
  assert.deepEqual(unanswerableFields(valid), []);
});

// Strict for the author only: a television drops a key it does not know (PluginManifestsTest).
test('refuses a top-level key it does not know, naming it and the key it is nearest', () => {
  const { valid: ok, errors } = validateManifest({ ...valid, hostFromConfig: true });

  assert.equal(ok, false);
  assert.deepEqual(errors, [{
    path: '/',
    message: 'must NOT have additional properties: hostFromConfig (did you mean hostsFromConfig?)',
  }]);
});

test('names no key when nothing it knows is near the one it refuses', () => {
  const { errors } = validateManifest({ ...valid, somethingElseEntirely: 1, catalogsAreLocal: true, url: 1 });

  assert.deepEqual(errors.map((e) => e.message), [
    'must NOT have additional properties: somethingElseEntirely',
    'must NOT have additional properties: catalogsAreLocal',
    'must NOT have additional properties: url',
  ]);
});

test('a swap of two neighbouring letters is one edit, and only a swap is', () => {
  assert.equal(editDistance('tpye', 'type'), 1);
  assert.equal(editDistance('abcd', 'badc'), 2);
  assert.equal(editDistance('aab', 'aba'), 1);
  assert.equal(editDistance('cb', 'bd'), 2);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('a short key swapped or in the wrong case still gets its hint', () => {
  const { errors } = validateManifest({ ...valid, configSchema: [{ id: 'a', label: 'A', type: 'text', tpye: 'url', ID: 'b' }] });

  assert.deepEqual(errors.map((e) => e.message), [
    '/configSchema/0 must NOT have additional properties: tpye (did you mean type?)',
    '/configSchema/0 must NOT have additional properties: ID (did you mean id?)',
  ]);
});

test('names no key for a short one that is near only because it is short', () => {
  const { errors } = validateManifest({ ...valid, configSchema: [{ id: 'a', label: 'A', type: 'text', min: 1 }] });

  assert.equal(errors[0].message, '/configSchema/0 must NOT have additional properties: min');
});

test('refuses a key a config field does not know, which would otherwise make a required field optional', () => {
  const field = { id: 'site', label: 'Site', type: 'url', defualt: 'https://example.com', requried: true };
  const { valid: ok, errors } = validateManifest({ ...valid, configSchema: [field] });

  assert.equal(ok, false);
  assert.deepEqual(errors.map((e) => e.message), [
    '/configSchema/0 must NOT have additional properties: defualt (did you mean default?)',
    '/configSchema/0 must NOT have additional properties: requried (did you mean required?)',
  ]);
});

test('refuses a key a choice option does not know', () => {
  const field = { id: 'mode', label: 'Mode', type: 'choice', options: [{ id: 'a', label: 'A', lable: 'A' }] };
  const { errors } = validateManifest({ ...valid, configSchema: [field] });

  assert.deepEqual(errors.map((e) => e.path), ['/configSchema/0/options/0']);
  assert.match(errors[0].message, /lable \(did you mean label\?\)$/);
});

test('an enum or a constant it refuses lists what it would have accepted', () => {
  const { errors } = validateManifest({
    ...valid, kind: 'catalog', provides: 'site', configSchema: [{ id: 'a', label: 'A', type: 'number' }],
  });

  assert.deepEqual(errors.map((e) => e.message), [
    '/kind must be equal to constant: content-source',
    '/provides must be equal to one of the allowed values: source, source-type',
    '/configSchema/0/type must be equal to one of the allowed values: text, secret, url, choice, bool',
  ]);
});

test('rejects a malformed iconUrl', () => {
  const { valid: ok, errors } = validateManifest({ ...valid, iconUrl: 'not a url' });
  assert.equal(ok, false);
  assert.equal(errors[0].path, '/iconUrl');
});

// Mirrors `PluginManifestTest`, case for case: the two hosts must answer the same way
// about the same manifest and the same configured values.

const configurable = (fields) => ({ ...valid, configSchema: fields });

test('a url field a viewer filled in widens the allowlist to that host and no other', () => {
  const manifest = configurable([{ id: 'siteUrl', label: 'Server', type: 'url' }]);

  assert.deepEqual(
    hostsWith(manifest, { siteUrl: 'https://media.example.com:8096/jellyfin' }).all,
    ['www.aiyingshi.tv', 'media.example.com'],
  );
});

test('the host a url field contributes is its name only — no port, whatever case it was typed in', () => {
  // `URL.host` would say `media.example.com:8096` while the device's `URI.host` says
  // `media.example.com`, so a Jellyfin on :8096 would be reachable from a CLI run and
  // refused on a television.
  const manifest = configurable([{ id: 'siteUrl', label: 'Server', type: 'url' }]);

  assert.deepEqual(
    hostsWith(manifest, { siteUrl: 'HTTPS://Media.Example.COM:8096/jellyfin' }).all,
    ['www.aiyingshi.tv', 'media.example.com'],
  );
});

test('a field that is not a url widens nothing, whatever a viewer puts in it', () => {
  const manifest = configurable([
    { id: 'note', label: 'Note', type: 'text' },
    { id: 'secretUrl', label: 'Secret', type: 'secret' },
  ]);

  assert.deepEqual(
    hostsWith(manifest, { note: 'https://evil.example.com', secretUrl: 'https://evil.example.com' }).all,
    ['www.aiyingshi.tv'],
  );
});

test('a url field left blank, or holding something that is not a url, widens nothing', () => {
  const manifest = configurable([
    { id: 'a', label: 'A', type: 'url' },
    { id: 'b', label: 'B', type: 'url' },
    { id: 'c', label: 'C', type: 'url' },
    { id: 'd', label: 'D', type: 'url' },
  ]);

  assert.deepEqual(
    hostsWith(manifest, { a: '', b: '   ', c: 'not a url at all', d: '//scheme.example.com' }).all,
    ['www.aiyingshi.tv'],
  );
});

test('a manifest with no configSchema is unchanged by whatever config carries', () => {
  assert.deepEqual(hostsWith(valid, { siteUrl: 'https://evil.example.com' }).all, ['www.aiyingshi.tv']);
});

// A private address has many spellings and only one is a dotted quad: `127.1` is loopback,
// so are `2130706433`, `0x7f000001` and `0177.0.0.1`.
test('every spelling of a private address is one lint names', () => {
  for (const entry of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1',
                       '192.168.1.1', '10.0.0.5', '172.16.0.1', '169.254.1.1',
                       'localhost', 'localhost.', 'printer.local', 'box.localhost']) {
    assert.equal(namesPrivateAddress(entry), true, `${entry} is on the viewer's own network`);
  }
});

test('a public host is not', () => {
  for (const entry of ['ddys.app', 'www.aiyingshi.tv', '172.32.0.1', '8.8.8.8', '*.ddys.app']) {
    assert.equal(namesPrivateAddress(entry), false, `${entry} is not`);
  }
});

// A wildcard is matched by suffix — `hostAllowed` accepts it by `host.endsWith('.' + suffix)`
// — so it has to be judged by what it can match rather than by what its suffix parses to.
// `*.1.1` matches 192.168.1.1 while its suffix alone normalises to a public-looking 1.0.0.1.
test('a wildcard is judged by what it can match, not by what its suffix parses to', () => {
  const matches = (entry, host) => host.endsWith(entry.slice(1));

  for (const [entry, reaches] of [['*.1', '192.168.1.1'], ['*.1.1', '192.168.1.1'],
                                  ['*.168.1.1', '192.168.1.1'], ['*.0.1', '10.0.0.1']]) {
    assert.equal(matches(entry, reaches), true, `${entry} reaches ${reaches}`);
    assert.equal(namesPrivateAddress(entry), true, `${entry} must be named`);
  }
  assert.equal(namesPrivateAddress('*.local'), true);
});

// The schema's pattern has no colon, so an IPv6 literal cannot be written here at all and
// is rejected as an invalid manifest before anything classifies it.
test('the schema keeps IPv6 out of allowedHosts entirely', () => {
  for (const host of ['::1', 'fc00::1', 'fe80::1', '[::1]']) {
    assert.equal(validateManifest({ ...valid, allowedHosts: [host] }).valid, false,
      `${host} should not be writable as an allowedHosts entry`);
  }
});

// The guarantee is about the literal, never a name resolved to an address.
test('a public name pointing at a private address is not caught, and is not meant to be', () => {
  assert.equal(namesPrivateAddress('lan.example.com'), false);
});

// Provenance: the floor exempts a host a viewer typed and refuses one a manifest named, so
// `hostsWith` has to say which is which rather than hand over a union.

const withUrlField = {
  ...valid,
  allowedHosts: ['www.aiyingshi.tv'],
  configSchema: [{ id: 'siteUrl', label: 'Site', type: 'url', default: 'https://www.aiyingshi.tv/' }],
};

test('a host a viewer typed is separated from one the manifest named', () => {
  const hosts = hostsWith(withUrlField, { siteUrl: 'http://192.168.1.50:8096/' });

  assert.deepEqual(hosts.fromManifest, ['www.aiyingshi.tv']);
  assert.deepEqual(hosts.fromViewer, ['192.168.1.50']);
  assert.deepEqual(hosts.all, ['www.aiyingshi.tv', '192.168.1.50']);
});

test('a url field left at its default is the manifest naming a host, not a viewer', () => {
  // The editor seeds the form with `default`, so a viewer who taps Save has typed nothing.
  // It is also the only way a hostsFromConfig manifest can name a host at all.
  const hosts = hostsWith(withUrlField, { siteUrl: 'https://www.aiyingshi.tv/' });

  assert.deepEqual(hosts.fromViewer, []);
  assert.deepEqual(hosts.fromManifest, ['www.aiyingshi.tv', 'www.aiyingshi.tv']);
});

test('a blank url field names nothing, whoever would have said it', () => {
  assert.deepEqual(hostsWith(withUrlField, { siteUrl: '' }).all, ['www.aiyingshi.tv']);
  assert.deepEqual(hostsWith(withUrlField, {}).all, ['www.aiyingshi.tv']);
});

test('a viewer-typed host is canonical, so the floor can compare it to a request', () => {
  const hosts = hostsWith(withUrlField, { siteUrl: 'http://2130706433:8096/' });

  assert.deepEqual(hosts.fromViewer, ['127.0.0.1']);
});

test('a default written without a scheme is still the manifest naming that host', () => {
  // The device stores what `SourceUrl.normalize` returns, which fills in a missing scheme.
  // Comparing the written strings called the manifest's own default a viewer's word, and the
  // floor exempts a viewer's word — so a manifest reached the LAN with nobody typing an
  // address. That is the whole of what the floor forbids, defeated by a spelling.
  const manifest = {
    ...valid,
    allowedHosts: [],
    hostsFromConfig: true,
    configSchema: [{ id: 'box', label: 'Box', type: 'url', default: '192.168.1.1:8080' }],
  };

  const hosts = hostsWith(manifest, { box: 'http://192.168.1.1:8080' });

  assert.deepEqual(hosts.fromViewer, []);
  assert.deepEqual(hosts.fromManifest, ['192.168.1.1']);
});

// A repo's word: a catalog's value the viewer did not type is the repo's, which widens the
// allowlist and opens the floor only on the host the viewer typed as the repo's address.
// Mirrors `PluginManifestTest`.

const repoCatalog = {
  ...valid,
  allowedHosts: [],
  configSchema: [
    { id: 'api', label: 'API', type: 'url' },
    { id: 'ext', label: 'Ext', type: 'url' },
  ],
};

test('a value the viewer did not type is the repo\'s, reachable and not past the floor', () => {
  const hosts = hostsWith(repoCatalog, { api: 'http://192.168.1.61/api.php' }, { viewerTyped: [] });

  assert.deepEqual(hosts.fromRepo, ['192.168.1.61']);
  assert.deepEqual(hosts.fromManifest, []);
  assert.deepEqual(hosts.all, ['192.168.1.61']);
  assert.deepEqual(hosts.floorExempt, []);
});

test('a repo\'s value on the host its address was typed on passes the floor, and another private one does not', () => {
  const hosts = hostsWith(
    repoCatalog,
    { api: 'http://192.168.1.60:9000/api.php', ext: 'http://192.168.1.1/x.js' },
    { viewerTyped: [], repoUrl: '192.168.1.60:8080/index.json' },
  );

  assert.deepEqual(hosts.floorExempt, ['192.168.1.60']);
});

test('the typed host is exempt only where one of the repo\'s values names it', () => {
  const listed = { ...repoCatalog, allowedHosts: ['192.168.1.60'] };
  const hosts = hostsWith(listed, { api: 'https://cms.example/' }, { viewerTyped: [], repoUrl: 'http://192.168.1.60/index.json' });

  assert.deepEqual(hosts.floorExempt, []);
});

test('a value the viewer typed over a repo\'s is theirs, wherever it points', () => {
  const hosts = hostsWith(repoCatalog, { api: 'http://192.168.1.50:8096/' }, { viewerTyped: ['api'], repoUrl: 'http://192.168.1.60/' });

  assert.deepEqual(hosts.fromViewer, ['192.168.1.50']);
  assert.deepEqual(hosts.fromRepo, []);
  assert.deepEqual(hosts.floorExempt, ['192.168.1.50']);
});

test('a viewer who replaces the default with their own box is the viewer', () => {
  const manifest = {
    ...valid,
    allowedHosts: [],
    configSchema: [{ id: 'box', label: 'Box', type: 'url', default: 'http://192.168.1.1/' }],
  };

  assert.deepEqual(hostsWith(manifest, { box: 'http://192.168.1.50:8096/' }).fromViewer, ['192.168.1.50']);
});

test('the list a refusal prints holds each host once', () => {
  // ddys and iyingshi both name a host in allowedHosts and seed the same one as a `url`
  // default, so the message said `[ddys.app, ddys.app]` to the author reading it.
  const manifest = {
    ...valid,
    allowedHosts: ['ddys.app'],
    configSchema: [{ id: 'siteUrl', label: 'Site', type: 'url', default: 'https://ddys.app/' }],
  };

  assert.deepEqual(hostsWith(manifest, { siteUrl: 'https://ddys.app/' }).all, ['ddys.app']);
});

test('lint warns on a private address written as a schemeless host and port', () => {
  // `192.168.1.50:8096` is what gets typed on a remote, and it is the spelling a manifest
  // may legally put in a `url` default — so it is exactly the one the warning must catch.
  for (const entry of ['192.168.1.1:8080', '127.0.0.1:8096', '10.0.0.5:80', 'localhost:3000']) {
    assert.equal(namesPrivateAddress(entry), true, entry);
  }
  assert.equal(namesPrivateAddress('example.com:8080'), false);
});

// The table rather than one case each, because the rule's whole difficulty is telling a
// string that is no host from one that only looks odd.
test('an allowedHosts entry is dead when no host it is compared against could equal it', () => {
  const matchable = [
    'h.tv',
    'ddys.app',
    'media_server.local',      // an underscore is ordinary on a home network
    '0xg',                     // never a number, so an ordinary domain name
    '127.1',                   // a real address, oddly spelled
    '*.aiyingshi.tv',
    '*.1.1',                   // `hostAllowed` really does accept 192.168.1.1 for this
    '*.0',                     // the tail of any address ending in zero
    '*.255',
    // `hostAllowed` strips a trailing dot off the suffix before comparing, so these match
    // exactly what they would without one — refusing them would refuse a working entry.
    '*.1.1.',
    '*.example.com.',
  ];
  const dead = [
    '999.999.999.999',         // no octet may exceed 255
    '1.2.3.4.5',               // a dotted quad has four parts
    'example.123',             // ends in a number, so read as an address and fails to be one
    '08',                      // a leading zero commits it to octal, and 8 is not octal
    '*..',                     // schema-valid, and its suffix is nothing at all
    '*.1.2.3.4',               // a host ending in `.1.2.3.4` needs five labels; a quad has four
    '*.1.2.3.4.5',             // the tail of no address, and no name may end in a number
    '*.1..1',                  // no canonical address has an empty part
    '*.999.999',
    '*.256',
    // A canonical host is rebuilt from the numbers, so `192.168.0.01` is written
    // `192.168.0.1` and ends in `.1` — nothing can ever end in `.01`.
    '*.01',
    '*.0255',
    '*.example.123',
  ];
  for (const entry of matchable) assert.equal(canMatchAHost(entry), true, entry);
  for (const entry of dead) assert.equal(canMatchAHost(entry), false, entry);
});

test('handles is a list of distinct names, and lint judges the names', () => {
  assert.equal(validateManifest({ ...valid, handles: ['maccms-json', 'io.github.someone.alist'] }).valid, true);
  for (const handles of ['maccms-json', ['maccms-json', 'maccms-json'], [''], [50]]) {
    assert.equal(validateManifest({ ...valid, handles }).valid, false, JSON.stringify(handles));
  }
});

// A field id is a letter and then letters, digits or `_`, which the device checks too.
test('refuses a config field whose id starts with an underscore', () => {
  const field = { id: '_prefix', label: 'Prefix', type: 'text' };
  const { valid: ok, errors } = validateManifest({ ...valid, configSchema: [field] });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path === '/configSchema/0/id'), JSON.stringify(errors));
});
