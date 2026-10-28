import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, parseCatalogue } from '../src/agent/catalogue.ts';

test('parses prefixes, years, comments, duplicates and the size limit', () => {
  const p = parseCatalogue('# comment\nPaper Comets (2024)\ntv: Corner Booth\npodcast: The Layover Hour\nmusic: Night Ferry\nPaper Comets (2024)\nx\nfilm: Extra', 4);
  assert.deepEqual(p.items.map((i) => [i.domain, i.title, i.year ?? null]), [
    ['movie', 'Paper Comets', 2024],
    ['tv_show', 'Corner Booth', null],
    ['podcast', 'The Layover Hour', null],
    ['artist', 'Night Ferry', null],
  ]);
  assert.deepEqual(p.rejected.map((r) => r.reason), ['duplicate', 'too short', 'over the 4-title limit']);
});

test('unknown prefixes are kept as part of a film title', () => {
  const p = parseCatalogue('Mission: Impossible', 5);
  assert.equal(p.items[0]!.title, 'Mission: Impossible');
  assert.equal(p.items[0]!.domain, 'movie');
});

test('normalizeTitle ignores articles, accents, punctuation and the synthetic suffix', () => {
  assert.equal(normalizeTitle('The Amélie!'), normalizeTitle('amelie'));
  assert.equal(normalizeTitle('Harbor Lights (synthetic)'), 'harbor lights');
});

test('accepts CSV rows from a distributor list, including quoted titles with commas', () => {
  const p = parseCatalogue('type,title,year\nmovie,"Paper Comets, Part 2",2024\ntv,Corner Booth,\npodcast,The Layover Hour', 10);
  assert.deepEqual(p.items.map((i) => [i.domain, i.title, i.year ?? null]), [
    ['movie', 'Paper Comets, Part 2', 2024],
    ['tv_show', 'Corner Booth', null],
    ['podcast', 'The Layover Hour', null],
  ]);
});
