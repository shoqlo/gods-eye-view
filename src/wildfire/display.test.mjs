import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAND_ORDER,
  CONFIDENCE_LABELS,
  FLAG_LABELS,
  componentLine,
  evidenceLine,
  formatAcres,
  formatAge,
  formatClock,
  formatCount,
  zoneMeta,
} from './display.js';

test('formatCount separates thousands and refuses non-numbers', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(5048), '5,048');
  assert.equal(formatCount(683990), '683,990');
  assert.equal(formatCount(12.6), '13');
  // A missing value is a dash, never "NaN" or "0": the reader must see the gap.
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount(Number.NaN), '—');
  assert.equal(formatCount(Number.POSITIVE_INFINITY), '—');
});

test('formatAcres keeps a decimal for sub-ten-acre fires', () => {
  assert.equal(formatAcres(0.25), '0.3');
  assert.equal(formatAcres(0.48), '0.5');
  assert.equal(formatAcres(6.07), '6.1');
  // Ten acres and above are integers: a tenth of an acre is noise there.
  assert.equal(formatAcres(10), '10');
  assert.equal(formatAcres(1365), '1,365');
  assert.equal(formatAcres(67071), '67,071');
  assert.equal(formatAcres(null), '—');
});

test('formatAge switches unit at the hour and two-day boundaries', () => {
  assert.equal(formatAge(0), '1 min');
  assert.equal(formatAge(0.25), '15 min');
  assert.equal(formatAge(0.99), '59 min');
  assert.equal(formatAge(1), '1 h');
  assert.equal(formatAge(23.4), '23 h');
  assert.equal(formatAge(47.9), '48 h');
  assert.equal(formatAge(48), '2 d');
  assert.equal(formatAge(1911), '80 d');
  assert.equal(formatAge(null), 'age unknown');
});

test('formatClock renders a local time and a neutral phrase otherwise', () => {
  const clock = formatClock(Date.UTC(2026, 9, 27, 12, 0, 0));
  assert.match(clock, /^\d{1,2}:\d{2}(\s?[AP]M)?$/i);
  assert.equal(formatClock(null), 'unknown time');
  assert.equal(formatClock(Number.NaN), 'unknown time');
});

test('zoneMeta shows the facts present and omits the ones that are not', () => {
  const full = zoneMeta({
    state: 'US-OR',
    acres: 67071,
    containedPct: 90,
    behaviour: 'Minimal',
    ageHours: 1911,
  });
  assert.equal(
    full,
    'OR · 67,071 ac · 90% contained · Minimal behaviour · updated 80 d ago',
  );

  // A data-poor incident must not read as four unknowns in a row.
  const bare = zoneMeta({ state: 'US-WI', acres: 0.48, ageHours: 0.1 });
  assert.equal(bare, 'WI · 0.5 ac · updated 6 min ago');
  assert.ok(!/contained|behaviour/.test(bare));

  assert.equal(zoneMeta(null), '');
  assert.equal(zoneMeta({ ageHours: null }), 'updated age unknown ago');
});

test('componentLine prints all four components, dash for a gap', () => {
  assert.equal(
    componentLine({ hazard: 45.4, exposure: 17.8, wind: 45, recency: 15 }),
    'hazard 45.4 · exposure 17.8 · wind 45 · recency 15',
  );
  assert.equal(
    componentLine(null),
    'hazard — · exposure — · wind — · recency —',
  );
  assert.equal(
    componentLine({ hazard: 20 }),
    'hazard 20 · exposure — · wind — · recency —',
  );
});

test('evidenceLine names the version, the confidence and each flag', () => {
  const line = evidenceLine({
    riskVersion: 'wwri-1',
    confidence: 'low',
    flags: ['behaviour-unknown', 'containment-unknown'],
  });
  assert.equal(
    line,
    'Risk index vwwri-1 · poorly evidenced · behaviour not published · containment not published',
  );

  // An unrecognised flag is shown verbatim rather than dropped silently.
  assert.match(
    evidenceLine({ riskVersion: 2, confidence: 'high', flags: ['brand-new'] }),
    /brand-new$/,
  );

  assert.equal(evidenceLine(null), 'Risk index v— · unknown evidence');
});

test('every engine flag and confidence level has a label', () => {
  for (const flag of [
    'wind-unavailable',
    'assets-unavailable',
    'behaviour-unknown',
    'containment-unknown',
    'cost-unknown',
    'stale-perimeter',
    'no-geometry',
  ]) {
    assert.equal(
      typeof FLAG_LABELS[flag],
      'string',
      `missing label for ${flag}`,
    );
    assert.ok(FLAG_LABELS[flag].length > 0, `empty label for ${flag}`);
  }
  for (const level of ['high', 'medium', 'low']) {
    assert.ok(CONFIDENCE_LABELS[level], `missing label for ${level}`);
  }
});

test('BAND_ORDER runs most severe first and matches the engine bands', async () => {
  const { RISK_BANDS } = await import('./risk.js');
  assert.deepEqual(
    [...BAND_ORDER],
    RISK_BANDS.map((band) => band.id),
  );
});

test("the lines follow the reader locale, not the writer's", async () => {
  const { setLocale } = await import('../i18n/index.js');
  try {
    setLocale('es');
    // Abbreviations, decimal marks and grouping are the reader's, not en-US's.
    assert.equal(formatAge(6), '6 h');
    assert.equal(formatAge(1911), '80 d');
    assert.equal(formatAcres(12000), '12.000');
    assert.equal(formatAcres(0.5), '0,5');
    assert.equal(
      zoneMeta({ state: 'US-OR', acres: 12000, ageHours: 80 }),
      'OR · 12.000 acres · actualizado hace 3 d',
    );
    assert.match(
      evidenceLine({ riskVersion: 'wwri-1', confidence: 'high' }),
      /bien respaldado/,
    );
  } finally {
    setLocale('en');
  }
  assert.equal(formatAge(6), '6 h');
  assert.equal(formatAcres(1200), '1,200');
});
