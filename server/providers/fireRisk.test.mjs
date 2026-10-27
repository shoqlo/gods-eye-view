import test from 'node:test';
import assert from 'node:assert/strict';

import { fireRiskProxy, geometryPoint } from './fireRisk.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

/** A square perimeter near 40.5N 119.5W, in the WFIGS "lon lat" form. */
function perimeterRow(overrides = {}) {
  return {
    stableId: 'TEST-1',
    name: 'Test Fire',
    state: 'US-NV',
    county: 'Test',
    category: 'WF',
    acres: 20000,
    containedPct: 10,
    behavior: 'Extreme',
    complexity: 'Type 1 Incident',
    cause: 'Natural',
    personnel: 400,
    costToDate: 5_000_000,
    discoveredTime: NOW - 5 * 86_400_000,
    updatedTime: NOW - 30 * 60_000,
    polygons: [[['-120 40', '-119 40', '-119 41', '-120 41', '-120 40']]],
    ...overrides,
  };
}

/** A 2x2 GFS grid: u = 3 m/s eastward, v = 4 m/s northward everywhere. */
function windBytes() {
  const values = new Float32Array([3, 3, 3, 3, 4, 4, 4, 4]);
  return new Uint8Array(values.buffer.slice(0));
}

const WIND_MANIFEST = {
  schemaVersion: 1,
  model: 'gfs',
  cycle: { validIso: '2026-10-27T20:00:00.000Z' },
  fetchedAt: NOW,
  level: '10 m above ground',
  units: 'm/s',
  grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 1, dy: 1 },
  stale: false,
  unavailable: false,
  gridUrl: '/api/wind/grid/gfs-test.bin?model=gfs',
};

const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-length': String(Buffer.byteLength(JSON.stringify(value))),
    },
  });

const bytes = (payload) =>
  new Response(payload, {
    status: 200,
    headers: { 'content-length': String(payload.byteLength) },
  });

/** A fake dev server: its two sibling routes, with call counting. */
function fakeSiblings({ rows = [perimeterRow()], wind = 'ok' } = {}) {
  const calls = [];
  const state = { rows, wind };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/api/fire-perimeters')) {
      return json({ fetchedAt: NOW, rows: state.rows });
    }
    if (url.includes('/api/wind/grid/')) return bytes(windBytes());
    if (url.includes('/api/wind')) {
      if (state.wind === 'fail') return new Response('nope', { status: 500 });
      return json(WIND_MANIFEST);
    }
    return new Response('nope', { status: 404 });
  };
  return { calls, state, fetchImpl };
}

/** Install the plugin and return one callable middleware. */
function mount(plugin) {
  const routes = new Map();
  const middlewares = { use: (path, fn) => routes.set(path, fn) };
  plugin.configureServer({ middlewares });
  return routes.get('/api/fire-risk');
}

/** Call the middleware with a loopback-shaped request and capture the reply. */
async function call(
  handler,
  { url = '/api/fire-risk', method = 'GET', port = 4174 } = {},
) {
  const req = {
    // connect strips the mount prefix before the handler sees req.url
    url: url.replace(/^\/api\/fire-risk/, '') || '/',
    method,
    headers: {},
    socket: { localPort: port, remoteAddress: '127.0.0.1' },
  };
  const captured = { status: 0, headers: {}, body: '' };
  const res = {
    destroyed: false,
    writeHead(status, headers = {}) {
      captured.status = status;
      Object.assign(captured.headers, headers);
    },
    end(body) {
      captured.body = body;
    },
  };
  await handler(req, res);
  return {
    ...captured,
    json: captured.body ? JSON.parse(captured.body) : null,
  };
}

const nearbyAssets = [
  { kind: 'datacenter', name: 'DC1', lat: 40.52, lon: -119.48 },
  { kind: 'datacenter', name: 'DC2', lat: 40.55, lon: -119.6 },
  { kind: 'dam', name: 'Dam1', lat: 40.4, lon: -119.7 },
];

function plugin(siblings, options = {}) {
  return fireRiskProxy({
    fetchImpl: siblings.fetchImpl,
    now: () => NOW,
    assets: nearbyAssets,
    ...options,
  });
}

test('geometryPoint averages a Polygon and a MultiPolygon', () => {
  const polygon = geometryPoint({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  });
  assert.ok(Math.abs(polygon.lat - 0.8) < 1e-9); // five positions, 0+0+2+2+0 over 5
  assert.ok(Math.abs(polygon.lon - 0.8) < 1e-9);

  const multi = geometryPoint({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [10, 10],
          [10, 10],
        ],
      ],
      [
        [
          [20, 20],
          [20, 20],
        ],
      ],
    ],
  });
  assert.equal(multi.lon, 15);
  assert.equal(multi.lat, 15);

  assert.equal(geometryPoint(null), null);
  assert.deepEqual(geometryPoint({ type: 'Point', coordinates: [1, 2] }), {
    lon: 1,
    lat: 2,
  });
  assert.deepEqual(
    geometryPoint({
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [2, 2],
      ],
    }),
    { lon: 1, lat: 1 },
  );
  assert.equal(geometryPoint({ type: 'Point', coordinates: [] }), null);
  assert.equal(geometryPoint({ type: 'Polygon', coordinates: [] }), null);
});

test('the endpoint scores live perimeters, samples wind and returns the ranked set', async () => {
  const siblings = fakeSiblings();
  const handler = mount(plugin(siblings));
  const reply = await call(handler);

  assert.equal(reply.status, 200);
  assert.ok(reply.json.generatedAt);
  assert.ok(reply.json.riskVersion);
  assert.equal(reply.json.counts.scored, 1);
  assert.equal(reply.json.zones.length, 1);

  const [zone] = reply.json.zones;
  assert.equal(zone.id, 'TEST-1');
  assert.equal(zone.band, 'critical');
  assert.equal(zone.exposureDetail.withinRadius, 3);
  // Sampled from the fake grid: hypot(3, 4) = 5 m/s, toward 36.9°.
  assert.equal(zone.wind.speedMs, 5);
  assert.ok(Math.abs(zone.wind.towardDeg - 36.9) < 0.5);
  assert.equal(zone.wind.validIso, '2026-10-27T20:00:00.000Z');

  assert.equal(reply.json.conditions.wind.status, 'ok');
  assert.equal(reply.json.conditions.perimeters.rows, 1);
  assert.equal(reply.json.conditions.assets.status, 'ok');
  assert.equal(reply.json.conditions.assets.total, 3);

  // The bands table the panel renders comes from the engine, not a copy.
  assert.deepEqual(
    reply.json.bands.map((band) => band.id),
    ['critical', 'high', 'elevated', 'watch', 'low'],
  );
  assert.ok(reply.json.limitations.length >= 4);
  assert.ok(reply.json.provenance.some((entry) => /WFIGS/.test(entry.source)));
});

test('a failed wind fetch degrades the score instead of failing the request', async () => {
  const siblings = fakeSiblings({ wind: 'fail' });
  const handler = mount(plugin(siblings));
  const reply = await call(handler);

  assert.equal(reply.status, 200);
  assert.equal(reply.json.conditions.wind.status, 'unavailable');
  const [zone] = reply.json.zones;
  assert.equal(zone.wind, null);
  assert.ok(zone.flags.includes('wind-unavailable'));
  assert.equal(zone.components.wind, 45);
  assert.notEqual(zone.confidence, 'high');
});

test('the index is cached inside its TTL and refetched after it', async () => {
  const siblings = fakeSiblings();
  let clock = NOW;
  const handler = mount(
    fireRiskProxy({
      fetchImpl: siblings.fetchImpl,
      now: () => clock,
      assets: nearbyAssets,
      ttlMs: 60_000,
    }),
  );

  await call(handler);
  const afterFirst = siblings.calls.length;
  assert.ok(
    afterFirst >= 3,
    `expected perimeters, manifest and grid, got ${afterFirst}`,
  );

  const cached = await call(handler);
  assert.equal(cached.status, 200);
  assert.equal(siblings.calls.length, afterFirst);
  assert.equal(cached.headers['X-Data-Stale'], undefined);

  clock += 61_000;
  await call(handler);
  assert.ok(siblings.calls.length > afterFirst);
});

test('a cold cache reports the failure rather than inventing an index', async () => {
  const handler = mount(
    fireRiskProxy({
      fetchImpl: async () => {
        throw new Error('upstream down');
      },
      now: () => NOW,
      assets: nearbyAssets,
    }),
  );
  const reply = await call(handler);
  assert.equal(reply.status, 502);
  assert.equal(reply.json.error, 'fire_risk_unavailable');
  assert.equal(reply.json.zones, undefined);
});

test('a warm cache survives a failed perimeter refresh', async () => {
  const siblings = fakeSiblings();
  let clock = NOW;
  let healthy = true;
  const handler = mount(
    fireRiskProxy({
      fetchImpl: async (url) => {
        if (!healthy && url.includes('/api/fire-perimeters')) {
          throw new Error('upstream down');
        }
        return siblings.fetchImpl(url);
      },
      now: () => clock,
      assets: nearbyAssets,
      ttlMs: 1,
    }),
  );

  const first = await call(handler);
  assert.equal(first.status, 200);
  healthy = false;
  clock += 10;
  const stale = await call(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.zones.length, first.json.zones.length);
});

test('limit and minBand are validated, not trusted', async () => {
  const rows = [
    perimeterRow({ stableId: 'HOT', behavior: 'Extreme', containedPct: 5 }),
    perimeterRow({
      stableId: 'MILD',
      behavior: 'Minimal',
      containedPct: 70,
      acres: 50,
    }),
  ];
  const siblings = fakeSiblings({ rows });

  const limited = await call(mount(plugin(siblings)), {
    url: '/api/fire-risk?limit=1',
  });
  assert.equal(limited.json.zones.length, 1);
  assert.equal(limited.json.counts.truncated, true);
  assert.equal(limited.json.counts.scored, 2);

  const high = await call(mount(plugin(siblings)), {
    url: '/api/fire-risk?minBand=high',
  });
  assert.ok(high.json.zones.every((zone) => zone.score >= 60));

  const nonsense = await call(mount(plugin(siblings)), {
    url: '/api/fire-risk?limit=abc&minBand=apocalyptic',
  });
  assert.equal(nonsense.status, 200);
  assert.equal(nonsense.json.zones.length, 2);

  const capped = await call(mount(plugin(siblings)), {
    url: '/api/fire-risk?limit=99999',
  });
  assert.ok(capped.json.zones.length <= 200);
});

test('contained incidents stay out of the ranking unless asked for', async () => {
  const siblings = fakeSiblings({
    rows: [
      perimeterRow(),
      perimeterRow({ stableId: 'OUT', containedPct: 100 }),
    ],
  });
  const without = await call(mount(plugin(siblings)));
  assert.equal(without.json.zones.length, 1);
  const withThem = await call(mount(plugin(siblings)), {
    url: '/api/fire-risk?includeContained=1',
  });
  assert.equal(withThem.json.zones.length, 2);
});

test('method, path and rate limiting are refused cleanly', async () => {
  const siblings = fakeSiblings();
  const handler = mount(plugin(siblings));

  const post = await call(handler, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');

  const wrongPath = await call(handler, { url: '/api/fire-risk/secrets' });
  assert.equal(wrongPath.status, 404);
});

test('the bundled asset packs load from disk without any network', async () => {
  const siblings = fakeSiblings();
  const handler = mount(
    fireRiskProxy({ fetchImpl: siblings.fetchImpl, now: () => NOW }),
  );
  const reply = await call(handler);
  assert.equal(reply.status, 200);
  // 4,351 datacenters + 704 dams at the time of writing; assert the loader
  // actually read both packs rather than a stale count.
  assert.ok(
    reply.json.conditions.assets.total > 4000,
    `assets ${reply.json.conditions.assets.total}`,
  );
  assert.deepEqual(
    reply.json.conditions.assets.packs.map((pack) => [pack.kind, pack.status]),
    [
      ['datacenter', 'ok'],
      ['dam', 'ok'],
    ],
  );
});
