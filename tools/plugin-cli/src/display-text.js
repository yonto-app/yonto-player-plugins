import { readFileSync } from 'node:fs';

// What a television does to a source's display text, recorded once for both hosts:
// DisplayTextRecordTest holds the app to the same file.
export const DISPLAY_TEXT = JSON.parse(readFileSync(new URL('../conformance/display-text.json', import.meta.url), 'utf8'));

const inRanges = (ranges) => (character) =>
  ranges.some(([from, to]) => character.codePointAt(0) >= from && character.codePointAt(0) <= to);
export const removes = inRanges(DISPLAY_TEXT.removed);
export const spaces = inRanges(DISPLAY_TEXT.spaced);

/** A one-line field as a television shows it, as `SourceText.kt`'s `asLine` makes it. */
export function asLine(text) {
  const kept = [...text].filter((character) => !removes(character)).join('');
  return [...kept.replace(/\r\n/g, ' ')].map((character) => (spaces(character) ? ' ' : character)).join('');
}
