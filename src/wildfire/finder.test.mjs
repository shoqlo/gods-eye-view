import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BANDS,
  clearRefinements,
  csvFileName,
  decodeCriteria,
  defaultCriteria,
  describeFireWeather,
  describeView,
  emptyHint,
  encodeCriteria,
  findFires,
  fireAltitudeM,
  globeLink,
  parseCoordinates,
  parseWatchlist,
  refinementCount,
  rowsView,
  stateCode,
  stateOptions,
  toCsv,
  toggleWatch,
  withGoal,
} from './finder.js';
import { RISK_BANDS } from './risk.js';

const NOW = Date.parse('2026-08-14T18:00:00Z');
const DAY = 86_400_000;
const REDDING = { lat: 40.5865, lon: -122.3917, label: 'Redding, California' };

/** Zones in the engine's ranked order, highest score first. */
const zones = [
  {
    id: 'park',
    name: 'Park Fire',
    state: 'US-CA',
    county: 'Butte',
    score: 81,
    band: 'critical',
    acres: 120000,
    containedPct: 12,
    discoveredAt: NOW - 1 * DAY,
    centroid: { lat: 39.95, lon: -121.8 },
    bounds: { west: -122.1, east: -121.5, south: 39.7, north: 40.2 },
    components: { hazard: 70, exposure: 55, wind: 60, recency: 100 },
    exposureDetail: { withinRadius: 2, downwind: 1, nearestKm: 9.4 },
    wind: { speedMs: 7.2 },
    confidence: 'high',
    reasons: ['extreme behaviour', 'wind aimed at 1 asset'],
    ageHours: 2,
    riskVersion: '1.0.0',
  },
  {
    id: 'smith',
    name: 'Smith River Complex',
    state: 'US-CA',
    county: 'Del Norte',
    score: 52,
    band: 'elevated',
    acres: 8000,
    containedPct: null,
    discoveredAt: NOW - 20 * DAY,
    centroid: { lat: 41.85, lon: -123.9 },
    components: { hazard: 40, exposure: 0, wind: 45, recency: 85 },
    exposureDetail: { withinRadius: 0, downwind: 0, nearestKm: null },
    confidence: 'medium',
    reasons: ['little containment'],
  },
  {
    id: 'sisi',
    name: 'Sisi',
    state: 'US-OR',
    county: 'Lane',
    score: 27,
    band: 'low',
    acres: null,
    containedPct: 95,
    discoveredAt: NOW - 2 * DAY,
    centroid: { lat: 43.9, lon: -122.6 },
    components: { hazard: 10, exposure: 20, wind: 30, recency: 55 },
    exposureDetail: { withinRadius: 1, downwind: 0, nearestKm: 22 },
    confidence: 'low',
    reasons: ['no acute signal in the current record'],
  },
  {
    id: 'nowhere',
    name: '=HYPERLINK("http://example.test","click")',
    state: null,
    score: 12,
    band: 'low',
    acres: 3,
    containedPct: 0,
    discoveredAt: null,
    centroid: null,
    components: { hazard: 5, exposure: 0, wind: 45, recency: 15 },
    exposureDetail: null,
    reasons: [],
  },
];

const ids = (result) => result.rows.map((row) => row.zone.id);
const context = { now: NOW, bands: RISK_BANDS };

test('the default view is every fire in the engine order', () => {
  const result = findFires(zones, defaultCriteria(), context);
  assert.deepEqual(ids(result), ['park', 'smith', 'sisi', 'nowhere']);
  assert.equal(result.needsPlace, false);
});

test('the finder uses the same band floors as the engine', () => {
  assert.deepEqual(
    DEFAULT_BANDS.map((band) => [band.id, band.min]),
    RISK_BANDS.map((band) => [band.id, band.min]),
  );
});

test('"near a place" waits for a place, then keeps fires within the radius, nearest first', () => {
  const waiting = findFires(zones, withGoal(defaultCriteria(), 'near'), context);
  assert.equal(waiting.needsPlace, true);
  assert.deepEqual(waiting.rows, []);

  const near = { ...withGoal(defaultCriteria(), 'near'), place: REDDING, radiusKm: 250 };
  const result = findFires(zones, near, context);
  assert.deepEqual(ids(result), ['park', 'smith']);
  assert.ok(result.rows[0].distanceKm < result.rows[1].distanceKm);
  assert.ok(Math.abs(result.rows[0].distanceKm - 86.8) < 0.5, `${result.rows[0].distanceKm}`);

  const tight = findFires(zones, { ...near, radiusKm: 25 }, context);
  assert.deepEqual(ids(tight), []);
});

test('"near infrastructure" keeps fires with assets close or downwind, most exposed first', () => {
  const result = findFires(zones, withGoal(defaultCriteria(), 'assets'), context);
  assert.deepEqual(ids(result), ['park', 'sisi']);
});

test('"new fires" keeps fires discovered in the last three days, newest first', () => {
  const result = findFires(zones, withGoal(defaultCriteria(), 'new'), context);
  assert.deepEqual(ids(result), ['park', 'sisi']);
});

test('"my watchlist" keeps only watched fires', () => {
  const result = findFires(zones, withGoal(defaultCriteria(), 'watched'), {
    ...context,
    watched: new Set(['sisi', 'gone']),
  });
  assert.deepEqual(ids(result), ['sisi']);
});

test('refinements narrow the list and treat missing data as documented', () => {
  const base = defaultCriteria();
  assert.deepEqual(ids(findFires(zones, { ...base, state: 'CA' }, context)), ['park', 'smith']);
  assert.deepEqual(ids(findFires(zones, { ...base, minBand: 'elevated' }, context)), ['park', 'smith']);
  // A size floor hides fires with no reported size.
  assert.deepEqual(ids(findFires(zones, { ...base, minAcres: 1 }, context)), ['park', 'smith', 'nowhere']);
  // Hiding contained fires keeps fires whose containment is not reported.
  assert.deepEqual(
    ids(findFires(zones, { ...base, hideContainedPct: 90 }, context)),
    ['park', 'smith', 'nowhere'],
  );
  // Search covers name, county, state code and state name, ignoring case and accents.
  assert.deepEqual(ids(findFires(zones, { ...base, query: 'del norte' }, context)), ['smith']);
  assert.deepEqual(ids(findFires(zones, { ...base, query: 'OREGON' }, context)), ['sisi']);
  assert.deepEqual(ids(findFires(zones, { ...base, query: 'Párk' }, context)), ['park']);
});

test('sorting by size or newest puts unknown values last', () => {
  const bySize = findFires(zones, { ...defaultCriteria(), sort: 'size' }, context);
  assert.deepEqual(ids(bySize), ['park', 'smith', 'nowhere', 'sisi']);
  const byNewest = findFires(zones, { ...defaultCriteria(), sort: 'newest' }, context);
  assert.deepEqual(ids(byNewest), ['park', 'sisi', 'smith', 'nowhere']);
});

test('switching goal keeps the refinements and the place, clearing keeps the goal', () => {
  const refined = { ...defaultCriteria(), state: 'CA', query: 'x', place: REDDING };
  const switched = withGoal(refined, 'new');
  assert.equal(switched.goal, 'new');
  assert.equal(switched.sort, 'newest');
  assert.equal(switched.state, 'CA');
  assert.equal(switched.place, REDDING);
  assert.equal(refinementCount(switched), 2);
  const cleared = clearRefinements(switched);
  assert.equal(cleared.goal, 'new');
  assert.equal(cleared.place, REDDING);
  assert.equal(refinementCount(cleared), 0);
});

test('the summary sentence says what is on screen and why', () => {
  const near = { ...withGoal(defaultCriteria(), 'near'), place: REDDING, minBand: 'high' };
  assert.equal(
    describeView(near, { shown: 1, total: 4, bands: RISK_BANDS }),
    '1 of 4 fires · within 100 km of Redding, California · High or above',
  );
  assert.equal(
    describeView(defaultCriteria(), { shown: 4, total: 4, bands: RISK_BANDS }),
    '4 fires burning now · highest risk first',
  );
  assert.equal(
    describeView({ ...defaultCriteria(), state: 'OR', minAcres: 1000 }, { shown: 0, total: 4 }),
    '0 of 4 fires · Oregon · at least 1,000 acres',
  );
});

test('empty results explain themselves for each goal', () => {
  assert.match(emptyHint(withGoal(defaultCriteria(), 'near'), { total: 4 }), /Type a town/);
  assert.match(
    emptyHint({ ...withGoal(defaultCriteria(), 'near'), place: REDDING, radiusKm: 50 }, { total: 4 }),
    /No reported fire within 50 km of Redding, California\. Try 100 km\./,
  );
  assert.match(emptyHint(withGoal(defaultCriteria(), 'watched'), { total: 4 }), /watchlist is empty/);
  assert.match(emptyHint(defaultCriteria(), { total: 0 }), /no active fire/);
});

test('a view survives the trip through a shared link', () => {
  const view = {
    ...withGoal(defaultCriteria(), 'near'),
    place: REDDING,
    radiusKm: 250,
    state: 'CA',
    minBand: 'elevated',
    minAcres: 1000,
    hideContainedPct: 50,
    query: 'river',
    sort: 'size',
  };
  const link = encodeCriteria(view);
  assert.match(link, /^\?goal=near&place=Redding/);
  const back = decodeCriteria(link, { bands: RISK_BANDS });
  assert.deepEqual(back, { ...view, place: { ...REDDING, lat: 40.5865, lon: -122.3917 } });
  assert.equal(encodeCriteria(defaultCriteria()), '');
});

test('a malformed link falls back to defaults field by field', () => {
  const back = decodeCriteria(
    '?goal=hack&lat=999&lon=1&r=-5&st=California&band=ultra&acres=abc&cont=500&sort=chaos&q=' +
      'x'.repeat(500),
  );
  assert.equal(back.goal, 'attention');
  assert.equal(back.place, null);
  assert.equal(back.radiusKm, 1);
  assert.equal(back.state, '');
  assert.equal(back.minBand, '');
  assert.equal(back.minAcres, 0);
  assert.equal(back.hideContainedPct, 100);
  assert.equal(back.sort, 'risk');
  assert.equal(back.query.length, 80);
});

test('coordinates typed into the place box are recognised', () => {
  assert.deepEqual(parseCoordinates('40.5865, -122.3917'), { lat: 40.5865, lon: -122.3917 });
  assert.deepEqual(parseCoordinates(' -33.9  151.2 '), { lat: -33.9, lon: 151.2 });
  assert.deepEqual(parseCoordinates('51.5°, -0.12°'), { lat: 51.5, lon: -0.12 });
  assert.equal(parseCoordinates('Redding'), null);
  assert.equal(parseCoordinates('95, 10'), null);
});

test('state codes and the state menu come from the feed', () => {
  assert.equal(stateCode({ state: 'US-CA' }), 'CA');
  assert.equal(stateCode({ state: 'or' }), 'OR');
  assert.equal(stateCode({ state: null }), '');
  assert.deepEqual(stateOptions(zones), [
    { code: 'CA', name: 'California', count: 2 },
    { code: 'OR', name: 'Oregon', count: 1 },
  ]);
});

test('the globe link opens fire mode at the fire', () => {
  const link = globeLink(zones[0].centroid, { altitudeM: fireAltitudeM(zones[0]) });
  assert.match(link, /^\/#v=2&lat=39\.9500&lon=-121\.8000&alt=\d+&heading=0&pitch=-60&l=w\.2\.k$/);
  assert.equal(globeLink(null), '/');
  const alt = fireAltitudeM(zones[0]);
  assert.ok(alt >= 20_000 && alt <= 600_000);
  assert.equal(fireAltitudeM({}), 60_000);
});

test('the watchlist is read defensively and toggled immutably', () => {
  assert.deepEqual([...parseWatchlist('["a","b",3]')], ['a', 'b']);
  assert.deepEqual([...parseWatchlist('not json')], []);
  assert.deepEqual([...parseWatchlist('{"a":1}')], []);
  const start = new Set(['a']);
  const added = toggleWatch(start, 'b');
  assert.deepEqual([...start], ['a']);
  assert.deepEqual([...added], ['a', 'b']);
  assert.deepEqual([...toggleWatch(added, 'a')], ['b']);
});

test('the CSV is escaped, formula-safe and self-describing', () => {
  const result = findFires(zones, defaultCriteria(), context);
  const csv = toCsv(result.rows, { generatedAt: NOW, riskVersion: '1.0.0' });
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith('rank,name,state,county,band,score'));
  assert.ok(lines[1].startsWith('1,Park Fire,CA,Butte,critical,81,120000,12,'));
  assert.match(lines[1], /,extreme behaviour; wind aimed at 1 asset,39\.95,-121\.8,park,1\.0\.0,2026-08-14T18:00:00\.000Z$/);
  // A name that would run as a formula is neutralised and quoted.
  assert.match(lines[4], /^4,"'=HYPERLINK\(""http:\/\/example\.test"",""click""\)",/);
  // Negative numbers are numbers, not text, and are left alone.
  assert.match(lines[1], /,-121\.8,/);
  assert.equal(csvFileName(withGoal(defaultCriteria(), 'near'), NOW), 'wildfire-watch-2026-08-14-near.csv');
});

test('fire weather is described in plain words', () => {
  const card = describeFireWeather({
    danger: 'very_high',
    peak_24h: { time: '2026-08-14T22:00:00.000Z', ffwi: 58.3 },
    red_flag_hours_24h: 3,
    drivers: ['humidity down to 11%', 'wind 38 km/h'],
  });
  assert.deepEqual(card, {
    level: 'very_high',
    rank: 3,
    label: 'Very high',
    redFlagHours: 3,
    lines: [
      'Worst hour: 22:00 UTC (fire weather index 58 of 100).',
      'Why: humidity down to 11%, wind 38 km/h.',
    ],
  });
  assert.equal(describeFireWeather({ danger: 'apocalyptic' }), null);
  assert.equal(describeFireWeather(null), null);
});

test('the globe overview frames every listed fire', () => {
  const result = findFires(zones, defaultCriteria(), context);
  const view = rowsView(result.rows);
  // Park, Smith and Sisi have positions; the fourth has none and is ignored.
  assert.ok(Math.abs(view.point.lat - (39.95 + 43.9) / 2) < 1e-9);
  assert.ok(Math.abs(view.point.lon - (-121.8 + -123.9) / 2) < 1e-9);
  assert.ok(view.altitudeM > 400_000 && view.altitudeM < 6_000_000, `${view.altitudeM}`);
  assert.equal(rowsView([]), null);
  assert.equal(rowsView([{ zone: { centroid: null } }]), null);
});
