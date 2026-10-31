import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SORT,
  SORT_MODES,
  filterZones,
  hasFilters,
  matchesSearch,
  normalizeSearch,
  sortZones,
} from './filter.js';

const BAND_ORDER = ['critical', 'high', 'elevated', 'watch', 'low'];

const zone = (overrides = {}) => ({
  id: 'CA-2026-0001',
  name: 'Creek',
  state: 'US-CA',
  band: 'high',
  score: 61,
  acres: 1200,
  ageHours: 6,
  ...overrides,
});

test('normalizeSearch folds case, accents and whitespace', () => {
  assert.equal(normalizeSearch('  QuÉbec   Ridge '), 'quebec ridge');
  assert.equal(normalizeSearch(null), '');
});

test('an empty query keeps everything', () => {
  assert.equal(matchesSearch(zone(), ''), true);
  assert.equal(matchesSearch(zone(), '   '), true);
});

test('search covers name, state code and incident id', () => {
  assert.equal(matchesSearch(zone(), 'cree'), true);
  assert.equal(matchesSearch(zone(), 'CA'), true);
  assert.equal(matchesSearch(zone(), '0001'), true);
  assert.equal(matchesSearch(zone(), 'oregon'), false);
});

test('search ignores complexity, which would match half the feed', () => {
  assert.equal(
    matchesSearch(zone({ complexity: 'Type 1 Incident' }), 'type'),
    false,
  );
});

test('search is accent- and case-insensitive in both directions', () => {
  assert.equal(matchesSearch(zone({ name: 'Cañon' }), 'canon'), true);
  assert.equal(matchesSearch(zone({ name: 'Canon' }), 'cañón'), true);
});

test('filterZones applies the band floor, not an exact band', () => {
  const zones = [
    zone({ id: 'a', band: 'critical' }),
    zone({ id: 'b', band: 'high' }),
    zone({ id: 'c', band: 'elevated' }),
    zone({ id: 'd', band: 'low' }),
  ];
  const kept = filterZones(
    zones,
    { minBand: 'elevated' },
    { bandOrder: BAND_ORDER },
  );
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ['a', 'b', 'c'],
  );
});

test('filterZones with no floor keeps every band', () => {
  const zones = [
    zone({ id: 'a', band: 'low' }),
    zone({ id: 'b', band: 'critical' }),
  ];
  assert.equal(filterZones(zones, {}, { bandOrder: BAND_ORDER }).length, 2);
});

test('a band the order does not know is never shown by a band filter', () => {
  const zones = [
    zone({ id: 'x', band: 'unknown' }),
    zone({ id: 'y', band: 'low' }),
  ];
  const kept = filterZones(
    zones,
    { minBand: 'low' },
    { bandOrder: BAND_ORDER },
  );
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ['y'],
  );
});

test('watchedOnly keeps only the ids on the list', () => {
  const zones = [zone({ id: 'a' }), zone({ id: 'b' })];
  const kept = filterZones(
    zones,
    { watchedOnly: true, watched: new Set(['b']) },
    { bandOrder: BAND_ORDER },
  );
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ['b'],
  );
});

test('the criteria combine: query, band and watched all narrow', () => {
  const zones = [
    zone({ id: 'a', name: 'Creek', band: 'high' }),
    zone({ id: 'b', name: 'Creek', band: 'low' }),
    zone({ id: 'c', name: 'Bench', band: 'high' }),
  ];
  const kept = filterZones(
    zones,
    {
      query: 'creek',
      minBand: 'elevated',
      watchedOnly: true,
      watched: new Set(['b', 'c', 'a']),
    },
    { bandOrder: BAND_ORDER },
  );
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ['a'],
  );
});

test('sortZones leaves the engine ranking alone by default', () => {
  const zones = [zone({ id: 'a', score: 40 }), zone({ id: 'b', score: 80 })];
  assert.equal(DEFAULT_SORT, 'risk');
  assert.deepEqual(
    sortZones(zones, 'risk').map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    zones.map((entry) => entry.id),
    ['a', 'b'],
  );
});

test('sortZones by size puts the largest first and unknown acres last', () => {
  const zones = [
    zone({ id: 'small', acres: 40 }),
    zone({ id: 'unknown', acres: null }),
    zone({ id: 'large', acres: 67071 }),
  ];
  assert.deepEqual(
    sortZones(zones, 'size').map((entry) => entry.id),
    ['large', 'small', 'unknown'],
  );
});

test('sortZones by newest puts unknown age last, never first', () => {
  const zones = [
    zone({ id: 'stale', ageHours: 1912 }),
    zone({ id: 'unknown', ageHours: null }),
    zone({ id: 'fresh', ageHours: 0.5 }),
  ];
  assert.deepEqual(
    sortZones(zones, 'newest').map((entry) => entry.id),
    ['fresh', 'stale', 'unknown'],
  );
});

test('sorting does not mutate the list it was given', () => {
  const zones = [zone({ id: 'a', acres: 1 }), zone({ id: 'b', acres: 2 })];
  sortZones(zones, 'size');
  assert.deepEqual(
    zones.map((entry) => entry.id),
    ['a', 'b'],
  );
});

test('sortZones survives a malformed payload', () => {
  assert.deepEqual(sortZones(null, 'size'), []);
  assert.deepEqual(sortZones([null, undefined], 'size'), [null, undefined]);
});

test('the sort modes are ids the panel can label and translate', () => {
  assert.deepEqual(SORT_MODES, ['risk', 'size', 'newest']);
});

test('hasFilters is true only when something actually narrows the list', () => {
  assert.equal(hasFilters(), false);
  assert.equal(hasFilters({ query: '   ' }), false);
  assert.equal(hasFilters({ minBand: null }), false);
  assert.equal(hasFilters({ watchedOnly: false }), false);
  assert.equal(hasFilters({ query: 'creek' }), true);
  assert.equal(hasFilters({ minBand: 'high' }), true);
  assert.equal(hasFilters({ watchedOnly: true }), true);
});
