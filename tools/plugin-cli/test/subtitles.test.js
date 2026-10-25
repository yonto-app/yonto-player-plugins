import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { subtitlesKept } from '../src/subtitles.js';

const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL('../conformance/subtitle-hosts.json', import.meta.url)), 'utf8'));

test('every recorded case keeps the subtitles the device keeps', () => {
  for (const { name, stream, allowedHosts, subtitles, kept } of cases) {
    const found = subtitlesKept({ url: stream, subtitles: subtitles.map((url) => ({ url, label: 'L' })) }, allowedHosts);
    assert.deepEqual(found.map((subtitle) => subtitle.url), kept, name);
  }
});
