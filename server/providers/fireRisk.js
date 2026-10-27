/**
 * Wildfire Watch risk index (WWRI) for the dev and preview servers.
 *
 * Aggregates three things the app already ingests and scores them with the
 * pure engine in `src/wildfire/risk.js`:
 *
 *   - NIFC WFIGS current perimeters, through this server's own
 *     `/api/fire-perimeters` route (its cache, not a second upstream call)
 *   - NOAA GFS 10 m wind, through this server's own `/api/wind` + grid routes
 *   - the bundled OSM-derived critical-asset packs (datacenters, dams)
 *
 * Routes:
 *   GET /api/fire-risk
 *       ?limit=1..200            ranked zones returned (default 40)
 *       &minBand=critical|high|elevated|watch|low
 *       &includeContained=1      keep incidents at 100% contained
 *
 * Why it goes through sibling routes rather than upstream directly: those two
 * proxies already own their TTL, single-flight, stale-serving and rate limits.
 * A second WFIGS or GFS fetch from here would double the public load for no
 * gain and could disagree with what the globe is drawing.
 *
 * Every response states what is missing. A zone whose wind or asset data could
 * not be loaded says so in `flags` and carries a lower `confidence`; it never
 * quietly scores as though the missing input were benign.
 */

import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RISK_BANDS,
  RISK_VERSION,
  rankZones,
  windTowardDeg,
} from '../../src/wildfire/risk.js';
import { sampleWind } from '../../src/layers/wind/model.js';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

/** Bundled asset packs, in the order they are counted. */
const ASSET_PACKS = Object.freeze([
  {
    kind: 'datacenter',
    label: 'datacenter',
    file: '../../src/data/local_data/datacenters/datacenters.geojsonl',
    source: 'OpenStreetMap contributors (ODbL 1.0)',
  },
  {
    kind: 'dam',
    label: 'dam',
    file: '../../src/data/local_data/dams/dams.geojsonl',
    source: 'OpenStreetMap / OpenInfraMap contributors (ODbL 1.0)',
  },
]);

/** Loopback candidates, most likely first. Vite may bind only one of them. */
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const DEFAULT_TTL_MS = 300_000;
const SIBLING_TIMEOUT_MS = 25_000;
const WIND_MANIFEST_CAP = 64 * 1024;
/** Defence in depth: the GFS grid at 1° is 261 KiB; anything near this is wrong. */
const WIND_GRID_CAP = 4 * 1024 * 1024;
const PERIMETER_CAP = 48 * 1024 * 1024;

const LIMITATIONS = Object.freeze([
  'The index ranks where attention is warranted. It is not a fire-spread forecast, and it is not a life-safety product.',
  'Exposure counts only the bundled datacenter and dam packs. Population, homes, transport, power and ecological values are not yet scored.',
  'Wind is the 1-degree GFS forecast at 10 m above ground, sampled at each incident centroid. Terrain and diurnal slope flows are not represented.',
  'Perimeters are the latest published WFIGS outline, which can lag the fire front by hours. A stale update time lowers the recency component and is reported in flags.',
  'Asset positions are OpenStreetMap features, not verified critical-infrastructure records. A missing feature reads as absent exposure.',
]);

const clampInt = (value, min, max) => Math.min(max, Math.max(min, value));

/** Position of a GeoJSON Point, Polygon or MultiPolygon, in degrees. */
export function geometryPoint(geometry) {
  if (geometry?.type === 'Point') {
    const [lon, lat] = Array.isArray(geometry.coordinates)
      ? geometry.coordinates
      : [];
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  }
  if (geometry?.type === 'MultiPoint') {
    return geometryPoint({
      type: 'Polygon',
      coordinates: [
        Array.isArray(geometry.coordinates) ? geometry.coordinates : [],
      ],
    });
  }
  const rings =
    geometry?.type === 'Polygon'
      ? geometry.coordinates
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates.flat()
        : null;
  if (!Array.isArray(rings)) return null;
  let lon = 0;
  let lat = 0;
  let count = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const position of ring) {
      if (!Array.isArray(position) || position.length < 2) continue;
      const [x, y] = position;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      lon += x;
      lat += y;
      count += 1;
    }
  }
  if (!count) return null;
  return { lon: lon / count, lat: lat / count };
}

/** Read one geojsonl pack into the flat asset shape the engine expects. */
async function readAssetPack(
  pack,
  fileFor = (rel) => fileURLToPath(new URL(rel, import.meta.url)),
) {
  const text = await fsp.readFile(fileFor(pack.file), 'utf8');
  const assets = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue; // A truncated final line must not lose the whole pack.
    }
    const point = geometryPoint(feature?.geometry);
    if (!point) continue;
    assets.push({
      kind: pack.kind,
      name:
        feature?.properties?.name ?? feature?.properties?.tags?.name ?? null,
      lat: point.lat,
      lon: point.lon,
    });
  }
  return assets;
}

/**
 * The asset packs are static build inputs, so they are read once per process
 * and shared by every request. A failed read is remembered as a failure for
 * the same reason: retrying a missing bundled file 60 times a minute helps
 * nobody, and the response already reports the gap.
 */
function createAssetLoader({ loader = readAssetPack } = {}) {
  let pending = null;
  return function loadAssets() {
    pending ??= (async () => {
      const assets = [];
      const packs = [];
      for (const pack of ASSET_PACKS) {
        try {
          const loaded = await loader(pack);
          assets.push(...loaded);
          packs.push({
            kind: pack.kind,
            label: pack.label,
            count: loaded.length,
            source: pack.source,
            status: 'ok',
          });
        } catch {
          packs.push({
            kind: pack.kind,
            label: pack.label,
            count: 0,
            source: pack.source,
            status: 'unavailable',
          });
        }
      }
      return { assets, packs };
    })();
    return pending;
  };
}

/** Fixed-origin aggregation endpoint. No user-supplied URLs are fetched. */
export function fireRiskProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  assets: assetsOverride = undefined,
  assetLoader = createAssetLoader(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  /* ------------------------------------------------------------ sibling I/O */

  async function fetchSibling(req, path, parse, cap) {
    const port = req.socket?.localPort;
    if (!Number.isInteger(port) || port <= 0)
      throw new Error('no_loopback_port');
    let lastError = null;
    for (const host of LOOPBACK_HOSTS) {
      const signal = AbortSignal.timeout(SIBLING_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`http://${host}:${port}${path}`, {
          signal,
          redirect: 'error',
          headers: { accept: '*/*' },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`sibling_http_${response.status}`);
        }
        return await parse(response, cap, signal);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('sibling_unavailable');
  }

  async function readPerimeters(req) {
    const payload = await fetchSibling(
      req,
      '/api/fire-perimeters',
      readResponseJsonCapped,
      PERIMETER_CAP,
    );
    if (!Array.isArray(payload?.rows)) throw new Error('invalid_perimeters');
    return {
      rows: payload.rows,
      fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
      stale: payload.stale === true,
    };
  }

  /**
   * The GFS grid is a raw Float32Array of `u` then `v` (and a scalar block when
   * an overlay is requested). Wind is taken from the plain manifest, so only
   * the first two blocks are read.
   */
  async function readWind(req) {
    const manifest = await fetchSibling(
      req,
      '/api/wind?model=gfs',
      readResponseJsonCapped,
      WIND_MANIFEST_CAP,
    );
    const grid = manifest?.grid;
    if (
      manifest?.unavailable === true ||
      manifest?.stale === true ||
      typeof manifest?.gridUrl !== 'string' ||
      !grid ||
      !Number.isInteger(grid.nx) ||
      !Number.isInteger(grid.ny) ||
      grid.nx < 1 ||
      grid.ny < 1
    ) {
      return { field: null, manifest: manifest ?? null };
    }
    const count = grid.nx * grid.ny;
    const expectedBytes = count * 8; // u and v, Float32 each
    const raw = new Uint8Array(
      await fetchSibling(
        req,
        manifest.gridUrl,
        readResponseBytesCapped,
        WIND_GRID_CAP,
      ),
    );
    if (raw.byteLength < expectedBytes) throw new Error('wind_grid_short');
    const values = new Float32Array(
      raw.buffer,
      0,
      Math.floor(raw.byteLength / 4),
    );
    return {
      field: {
        u: values.subarray(0, count),
        v: values.subarray(count, count * 2),
        nx: grid.nx,
        ny: grid.ny,
        lo1: grid.lo1,
        la1: grid.la1,
        dx: grid.dx,
        dy: grid.dy,
      },
      manifest,
    };
  }

  /** Wind at one centroid, in the shape `scoreZone` consumes. */
  function windAt(field, manifest) {
    const validIso = manifest?.cycle?.validIso ?? null;
    return (zone) => {
      if (!field || !zone.centroid) return null;
      const sampled = sampleWind(field, zone.centroid.lon, zone.centroid.lat);
      if (!Number.isFinite(sampled?.u) || !Number.isFinite(sampled?.v))
        return null;
      return {
        speedMs: Math.hypot(sampled.u, sampled.v),
        u: sampled.u,
        v: sampled.v,
        towardDeg: windTowardDeg(sampled.u, sampled.v),
        validIso,
      };
    };
  }

  /* ---------------------------------------------------------------- request */

  function parseOptions(req) {
    const url = new URL(req.url, 'http://localhost');
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
    const limit = Number.isFinite(parsedLimit)
      ? clampInt(Math.round(parsedLimit), 1, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const rawBand = url.searchParams.get('minBand');
    const minBand = RISK_BANDS.some((band) => band.id === rawBand)
      ? rawBand
      : null;
    const includeContained = ['1', 'true', 'yes'].includes(
      (url.searchParams.get('includeContained') ?? '').toLowerCase(),
    );
    return { limit, minBand, includeContained };
  }

  async function build(req, options) {
    const [perimeters, wind, assetsResult] = await Promise.all([
      readPerimeters(req),
      readWind(req).catch(() => ({ field: null, manifest: null })),
      assetsOverride !== undefined
        ? Promise.resolve(
            assetsOverride === null
              ? { assets: null, packs: [] }
              : { assets: assetsOverride, packs: [] },
          )
        : assetLoader().catch(() => ({ assets: null, packs: [] })),
    ]);

    const ranked = rankZones(perimeters.rows, {
      now: now(),
      assets: assetsResult.assets,
      windAt: windAt(wind.field, wind.manifest),
      limit: options.limit,
      minBand: options.minBand,
      includeContained: options.includeContained,
    });

    return {
      generatedAt: now(),
      riskVersion: RISK_VERSION,
      bands: RISK_BANDS.map((band) => ({
        id: band.id,
        label: band.label,
        min: band.min,
        colour: band.colour,
      })),
      counts: {
        ...ranked.counts,
        scored: ranked.total,
        returned: ranked.returned,
        truncated: ranked.truncated,
      },
      conditions: {
        perimeters: {
          status: 'ok',
          fetchedAt: perimeters.fetchedAt,
          stale: perimeters.stale,
          rows: perimeters.rows.length,
        },
        wind: wind.field
          ? {
              status: 'ok',
              model: wind.manifest?.model ?? 'gfs',
              level: wind.manifest?.level ?? null,
              units: wind.manifest?.units ?? null,
              validIso: wind.manifest?.cycle?.validIso ?? null,
              fetchedAt: wind.manifest?.fetchedAt ?? null,
            }
          : {
              status: 'unavailable',
              // The globe keeps working without wind; the score says so.
              reason: 'wind_unavailable',
            },
        assets: {
          status: assetsResult.assets === null ? 'unavailable' : 'ok',
          total: assetsResult.assets?.length ?? 0,
          packs: assetsResult.packs,
        },
      },
      zones: ranked.zones,
      provenance: [
        {
          source: 'NIFC WFIGS current interagency perimeters',
          detail:
            'Public domain. Served through this server’s /api/fire-perimeters cache.',
        },
        {
          source: 'NOAA GFS 10 m wind',
          detail:
            'Public domain. Served through this server’s /api/wind cache.',
        },
        {
          source: 'OpenStreetMap datacenters and dams',
          detail:
            'Open Database License 1.0. Bundled build inputs, not live feeds.',
        },
      ],
      limitations: LIMITATIONS,
    };
  }

  async function acquire(key, options, req, store) {
    const previous = store.get(key);
    if (previous && now() - previous.savedAt < ttlMs) {
      return { value: previous.value, stale: false };
    }
    try {
      const { promise } = coalesce(key, () => build(req, options));
      const value = await promise;
      store.delete(key);
      store.set(key, { value, savedAt: now() });
      if (store.size > 16) store.delete(store.keys().next().value);
      return { value, stale: false };
    } catch (error) {
      // Serving the last good index beats serving an error page: the globe is
      // still drawing the same perimeters, and the response is marked stale.
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  function coalesce(key, create) {
    const existing = inFlight.get(key);
    if (existing) return { promise: existing };
    const promise = (async () => {
      try {
        return await create();
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return { promise };
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });

    const options = parseOptions(req);
    const key = JSON.stringify(options);
    try {
      const { value, stale } = await acquire(key, options, req, cache);
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'fire_risk_unavailable', riskVersion: RISK_VERSION });
    }
  }

  return {
    name: 'fire-risk',
    configureServer({ middlewares }) {
      middlewares.use('/api/fire-risk', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fire-risk', handler);
    },
  };
}
