import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { typedHostOf } from '../src/manifest.js';

// One answer per spelling of a repo's address, which `PrivateFloorTypedHostConformanceTest`
// holds the device to as well: the typed host is the one private host a repo's values may
// reach, so two hosts reading one address two ways would open the floor on one of them.
const cases = JSON.parse(readFileSync(new URL('../conformance/repo-typed-hosts.json', import.meta.url), 'utf8'));

for (const { address, typedHost } of cases) {
  test(`the typed host of ${JSON.stringify(address)} is ${typedHost}`, () => {
    assert.equal(typedHostOf(address), typedHost);
  });
}
