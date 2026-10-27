import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_RADIUS_KM,
  RISK_BANDS,
  RISK_VERSION,
  angleBetweenDeg,
  bandCounts,
  bandForScore,
  bearingDeg,
  buildZone,
  distanceKm,
  parseVertex,
  rankZones,
  scoreZone,
  windTowardDeg,
  zoneGeometry,
} from './risk.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

/** A closed square perimeter, ~9,360 km², centred near 40.5N 119.5W. */
function squareRow(overrides = {}) {
  const ring = ['-120 40', '-119 40', '-119 41', '-120 41', '-120 40'];
  return {
    stableId: 'TEST-1',
    name: 'Test Fire',
    state: 'US-NV',
    county: 'Test',
    category: 'WF',
    acres: 1000,
    containedPct: 40,
    behavior: 'Moderate',
    complexity: 'Type 3 Incident',
    cause: 'Natural',
    personnel: 100,
    costToDate: 1_000_000,
    discoveredTime: NOW - 3 * 86_400_000,
    updatedTime: NOW - 60 * 60 * 1000,
    polygons: [[ring]],
    ...overrides,
  };
}

const calmWind = {
  speedMs: 2,
  u: 2,
  v: 0,
  towardDeg: 90,
  validIso: '2026-10-27T12:00:00.000Z',
};

test('bandForScore returns the band whose floor the score meets', () => {
  assert.equal(bandForScore(100).id, 'critical');
  assert.equal(bandForScore(75).id, 'critical');
  assert.equal(bandForScore(74.9).id, 'high');
  assert.equal(bandForScore(60).id, 'high');
  assert.equal(bandForScore(45).id, 'elevated');
  assert.equal(bandForScore(30).id, 'watch');
  assert.equal(bandForScore(0).id, 'low');
  assert.equal(bandForScore(NaN).id, 'low');
  assert.equal(RISK_BANDS.length, 5);
});

test('parseVertex accepts WFIGS vertices and refuses anything else', () => {
  assert.deepEqual(parseVertex('-142.9741 63.3468'), {
    lon: -142.9741,
    lat: 63.3468,
  });
  // The normalized row uses numeric [lon, lat] pairs.
  assert.deepEqual(parseVertex([-142.9741, 63.3468]), {
    lon: -142.9741,
    lat: 63.3468,
  });
  assert.deepEqual(parseVertex(['-142.9', '63.3']), { lon: -142.9, lat: 63.3 });
  assert.equal(parseVertex('42'), null);
  assert.equal(parseVertex('a b'), null);
  assert.equal(parseVertex('200 10'), null);
  assert.equal(parseVertex([1]), null);
  assert.equal(parseVertex(null), null);
});

test('zoneGeometry reads the largest ring, its area and its centroid', () => {
  const geometry = zoneGeometry([
    [['-120 40', '-119 40', '-119 41', '-120 41', '-120 40']],
    // A small stray part must not move the centroid.
    [['-100 10', '-100.01 10', '-100.01 10.01', '-100 10']],
  ]);
  assert.ok(geometry.centroid);
  assert.ok(Math.abs(geometry.centroid.lat - 40.5) < 0.05);
  assert.ok(Math.abs(geometry.centroid.lon + 119.5) < 0.05);
  // 1° of longitude at 40.5N is ~84.7 km, 1° of latitude ~110.6 km.
  assert.ok(
    Math.abs(geometry.areaKm2 - 9_360) < 400,
    `area ${geometry.areaKm2}`,
  );
  assert.equal(geometry.bounds.south, 10);
  assert.equal(geometry.vertices, 9);
});

test('zoneGeometry survives missing, empty and degenerate shapes', () => {
  assert.equal(zoneGeometry(null).centroid, null);
  assert.equal(zoneGeometry([]).centroid, null);
  assert.equal(zoneGeometry([[[]]]).centroid, null);
});

test('buildZone keeps the published incident fields and derives geometry', () => {
  const zone = buildZone(squareRow());
  assert.equal(zone.id, 'TEST-1');
  assert.equal(zone.name, 'Test Fire');
  assert.equal(zone.acres, 1000);
  assert.equal(zone.containedPct, 40);
  assert.ok(zone.centroid);
  assert.ok(zone.areaKm2 > 9000);
});

test('distanceKm and bearingDeg agree with known geometry', () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 1 };
  assert.ok(Math.abs(distanceKm(a, b) - 111.19) < 0.2);
  assert.ok(Math.abs(bearingDeg(a, b) - 90) < 0.5);
  assert.ok(Math.abs(bearingDeg(a, { lat: 1, lon: 0 })) < 0.5);
  assert.equal(distanceKm(null, b), Infinity);
});

test('windTowardDeg converts GFS u/v into a compass bearing', () => {
  assert.equal(Math.round(windTowardDeg(1, 0)), 90); // blowing east
  assert.equal(Math.round(windTowardDeg(0, 1)), 0); // blowing north
  assert.equal(Math.round(windTowardDeg(-1, 0)), 270);
  assert.equal(windTowardDeg(0, 0), null); // calm
  assert.equal(windTowardDeg(NaN, 1), null);
});

test('angleBetweenDeg wraps the short way', () => {
  assert.equal(angleBetweenDeg(10, 350), 20);
  assert.equal(angleBetweenDeg(90, 120), 30);
  assert.equal(angleBetweenDeg(0, 180), 180);
});

test('a contained incident scores below the same incident burning freely', () => {
  const base = buildZone(squareRow());
  const burning = scoreZone(base, { now: NOW, wind: calmWind, assets: [] });
  const contained = scoreZone(buildZone(squareRow({ containedPct: 95 })), {
    now: NOW,
    wind: calmWind,
    assets: [],
  });
  assert.ok(
    contained.score < burning.score,
    `${contained.score} < ${burning.score}`,
  );
  // Containment enters once, through the hazard deficit.
  assert.ok(contained.components.hazard < burning.components.hazard);
  assert.ok(!contained.flags.includes('containment-unknown'));
});

test('a record with no behaviour, containment or cost scores on what is known', () => {
  const bare = scoreZone(
    buildZone(
      squareRow({
        behavior: null,
        containedPct: null,
        costToDate: null,
        complexity: null,
        personnel: null,
        acres: 0.4,
      }),
    ),
    { now: NOW, wind: calmWind, assets: [] },
  );
  const documented = scoreZone(buildZone(squareRow()), {
    now: NOW,
    wind: calmWind,
    assets: [],
  });
  // Absence of evidence must not read as mild evidence, and must not read as
  // severe evidence either: it simply is not credited.
  assert.ok(
    bare.score < documented.score,
    `${bare.score} < ${documented.score}`,
  );
  assert.ok(bare.flags.includes('behaviour-unknown'));
  assert.ok(bare.flags.includes('containment-unknown'));
  assert.ok(bare.flags.includes('cost-unknown'));
  assert.ok(bare.missingInputs.includes('behaviour'));
  assert.equal(bare.confidence, 'low');
  // Size and recency are all that remain: a sub-acre, freshly reported fire.
  assert.equal(bare.components.hazard, 0);
});

test('a large documented incident outranks a data-poor micro-fire', () => {
  const rows = [
    squareRow({
      stableId: 'MICRO',
      name: 'Micro',
      acres: 0.3,
      behavior: null,
      containedPct: null,
      costToDate: null,
    }),
    squareRow({
      stableId: 'MAJOR',
      name: 'Major',
      acres: 120_000,
      behavior: 'High',
      containedPct: 15,
      costToDate: 40_000_000,
    }),
  ];
  const ranked = rankZones(rows, { now: NOW, wind: calmWind, assets: [] });
  assert.equal(ranked.zones[0].id, 'MAJOR');
  assert.ok(ranked.zones[0].score - ranked.zones[1].score > 15);
});

test('extreme behaviour outscores minimal behaviour on identical inputs', () => {
  const extreme = scoreZone(buildZone(squareRow({ behavior: 'Extreme' })), {
    now: NOW,
    wind: calmWind,
    assets: [],
  });
  const minimal = scoreZone(buildZone(squareRow({ behavior: 'Minimal' })), {
    now: NOW,
    wind: calmWind,
    assets: [],
  });
  assert.ok(extreme.components.hazard > minimal.components.hazard);
  assert.ok(extreme.score > minimal.score);
});

test('critical assets near the fire raise exposure and the total', () => {
  const zone = buildZone(squareRow());
  const none = scoreZone(zone, { now: NOW, wind: calmWind, assets: [] });
  const assets = [
    { kind: 'datacenter', name: 'DC1', lat: 40.52, lon: -119.48 },
    { kind: 'datacenter', name: 'DC2', lat: 40.55, lon: -119.6 },
    { kind: 'dam', name: 'Dam1', lat: 40.4, lon: -119.7 },
  ];
  const near = scoreZone(zone, { now: NOW, wind: calmWind, assets });
  assert.equal(near.exposureDetail.withinRadius, 3);
  assert.ok(near.components.exposure > none.components.exposure);
  assert.ok(near.score > none.score);
  assert.ok(near.reasons.some((reason) => reason.includes('within')));
});

test('assets beyond the radius are ignored', () => {
  const zone = buildZone(squareRow());
  const far = scoreZone(zone, {
    now: NOW,
    wind: calmWind,
    assets: [{ kind: 'datacenter', name: 'Far', lat: 45, lon: -119.5 }],
  });
  assert.equal(far.exposureDetail.withinRadius, 0);
});

test('wind blowing toward an asset raises the wind component', () => {
  const zone = buildZone(squareRow());
  // Asset ~25 km east of the centroid: bearing 90, inside the downwind radius.
  const asset = {
    kind: 'datacenter',
    name: 'Downwind',
    lat: 40.5,
    lon: -119.2,
  };
  const across = scoreZone(zone, {
    now: NOW,
    wind: { ...calmWind, towardDeg: 0 },
    assets: [asset],
  });
  const at = scoreZone(zone, {
    now: NOW,
    wind: { ...calmWind, towardDeg: 90 },
    assets: [asset],
  });
  assert.equal(at.exposureDetail.downwind, 1);
  assert.equal(across.exposureDetail.downwind, 0);
  assert.ok(at.components.wind > across.components.wind);
  assert.ok(at.reasons.some((reason) => reason.includes('wind aimed')));
});

test('missing wind is neutral, flagged, and lowers confidence', () => {
  const zone = buildZone(squareRow());
  const withWind = scoreZone(zone, { now: NOW, wind: calmWind, assets: [] });
  const without = scoreZone(zone, { now: NOW, wind: null, assets: [] });
  assert.equal(without.components.wind, 45);
  assert.ok(without.flags.includes('wind-unavailable'));
  assert.equal(withWind.confidence, 'high');
  assert.equal(without.confidence, 'medium');
  assert.notEqual(withWind.confidence, without.confidence);
});

test('with no asset pack at all the zone is flagged and exposure falls back', () => {
  const zone = buildZone(squareRow());
  const scored = scoreZone(zone, { now: NOW, wind: calmWind, assets: null });
  assert.ok(scored.flags.includes('assets-unavailable'));
  assert.deepEqual(scored.missingInputs, ['assets']);
  assert.equal(scored.exposureDetail.withinRadius, 0);
  // One missing input caps confidence at medium even with the other signals.
  assert.equal(scored.confidence, 'medium');

  // Both scored inputs missing is low confidence, and says so twice.
  const blind = scoreZone(zone, { now: NOW, wind: null, assets: null });
  assert.equal(blind.confidence, 'low');
  assert.deepEqual(blind.missingInputs, ['wind', 'assets']);
});

test('a stale perimeter scores below a freshly updated one', () => {
  const fresh = scoreZone(buildZone(squareRow()), {
    now: NOW,
    wind: calmWind,
    assets: [],
  });
  const stale = scoreZone(
    buildZone(squareRow({ updatedTime: NOW - 72 * 3_600_000 })),
    { now: NOW, wind: calmWind, assets: [] },
  );
  assert.ok(stale.components.recency < fresh.components.recency);
  assert.ok(stale.flags.includes('stale-perimeter'));
});

test('scoring is deterministic for the same inputs', () => {
  const row = squareRow();
  const a = scoreZone(buildZone(row), { now: NOW, wind: calmWind, assets: [] });
  const b = scoreZone(buildZone(row), { now: NOW, wind: calmWind, assets: [] });
  assert.deepEqual(a, b);
  assert.equal(a.riskVersion, RISK_VERSION);
});

test('rankZones drops fully contained fires, sorts by score, and limits', () => {
  const rows = [
    squareRow({
      stableId: 'A',
      name: 'Alpha',
      behavior: 'Minimal',
      containedPct: 30,
    }),
    squareRow({
      stableId: 'B',
      name: 'Bravo',
      behavior: 'Extreme',
      containedPct: 5,
    }),
    squareRow({ stableId: 'C', name: 'Charlie', containedPct: 100 }),
  ];
  const ranked = rankZones(rows, {
    now: NOW,
    wind: calmWind,
    assets: [],
    limit: 10,
  });
  assert.equal(ranked.total, 2);
  assert.equal(ranked.zones[0].id, 'B');
  assert.equal(ranked.zones.at(-1).id, 'A');
  assert.equal(ranked.truncated, false);

  const kept = rankZones(rows, {
    now: NOW,
    wind: calmWind,
    assets: [],
    includeContained: true,
  });
  assert.equal(kept.total, 3);

  const limited = rankZones(rows, {
    now: NOW,
    wind: calmWind,
    assets: [],
    limit: 1,
  });
  assert.equal(limited.returned, 1);
  assert.equal(limited.truncated, true);
});

test('rankZones honours a minimum band', () => {
  const rows = [
    squareRow({ stableId: 'A', behavior: 'Minimal', containedPct: 30 }),
    squareRow({ stableId: 'B', behavior: 'Extreme', containedPct: 5 }),
  ];
  const ranked = rankZones(rows, {
    now: NOW,
    wind: calmWind,
    assets: [],
    minBand: 'high',
  });
  assert.ok(ranked.zones.every((zone) => zone.score >= 60));
});

test('bandCounts summarises a scored set', () => {
  const zones = rankZones(
    [
      squareRow({
        stableId: 'A',
        acres: 100,
        behavior: 'Extreme',
        containedPct: 1,
      }),
      squareRow({
        stableId: 'B',
        acres: 200,
        behavior: 'Minimal',
        containedPct: 60,
      }),
    ],
    { now: NOW, wind: calmWind, assets: [] },
  ).zones;
  const counts = bandCounts(zones);
  assert.equal(
    counts.critical + counts.high + counts.elevated + counts.watch + counts.low,
    2,
  );
  assert.equal(counts.acres, 300);
});

test('an incident with no geometry is flagged, not dropped', () => {
  const zone = scoreZone(buildZone(squareRow({ polygons: [] })), {
    now: NOW,
    wind: calmWind,
    assets: [],
  });
  assert.ok(zone.flags.includes('no-geometry'));
  assert.equal(zone.centroid, null);
  assert.ok(zone.score >= 0);
});

test('rankZones counts every scored zone before the limit trims the list', () => {
  const rows = [
    squareRow({
      stableId: 'A',
      acres: 100,
      behavior: 'Extreme',
      containedPct: 1,
    }),
    squareRow({
      stableId: 'B',
      acres: 200,
      behavior: 'Moderate',
      containedPct: 60,
    }),
    squareRow({
      stableId: 'C',
      acres: 300,
      behavior: 'Minimal',
      containedPct: 80,
    }),
  ];
  const ranked = rankZones(rows, {
    now: NOW,
    wind: calmWind,
    assets: [],
    limit: 1,
  });
  assert.equal(ranked.returned, 1);
  assert.equal(ranked.truncated, true);
  assert.equal(ranked.counts.acres, 600);
  assert.equal(
    ranked.counts.critical +
      ranked.counts.high +
      ranked.counts.elevated +
      ranked.counts.watch +
      ranked.counts.low,
    3,
  );
  // Confidence counts describe the whole set too, not just the returned page.
  assert.equal(
    ranked.counts.confidence.high +
      ranked.counts.confidence.medium +
      ranked.counts.confidence.low,
    3,
  );
});

test('windAt samples per zone and overrides the scalar wind', () => {
  const rows = [
    squareRow({ stableId: 'CALM', name: 'Calm' }),
    squareRow({ stableId: 'WINDY', name: 'Windy' }),
  ];
  const ranked = rankZones(rows, {
    now: NOW,
    wind: calmWind,
    assets: [],
    windAt: (zone) =>
      zone.id === 'WINDY'
        ? { speedMs: 14, u: 14, v: 0, towardDeg: 90 }
        : { speedMs: 1, u: 1, v: 0, towardDeg: 90 },
  });
  const windy = ranked.zones.find((zone) => zone.id === 'WINDY');
  const calm = ranked.zones.find((zone) => zone.id === 'CALM');
  assert.ok(windy.components.wind > calm.components.wind);
  assert.equal(windy.wind.speedMs, 14);
});

test('a hot fire with no assets in the pack still scores on hazard alone', () => {
  const scored = scoreZone(
    buildZone(squareRow({ behavior: 'Extreme', containedPct: 0 })),
    {
      now: NOW,
      wind: calmWind,
      assets: [],
    },
  );
  assert.ok(
    scored.components.hazard > 70,
    `hazard ${scored.components.hazard}`,
  );
  // No assets in range, so exposure is carried only by the economic term.
  assert.ok(
    scored.components.exposure < 25,
    `exposure ${scored.components.exposure}`,
  );
  assert.ok(scored.score > 30);
});
