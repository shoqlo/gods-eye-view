import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchRegionalJson } from './http.js';
import { validRegionalPoint } from './query.js';
import {
  FIRE_WEATHER_HOURLY,
  assessFireWeather,
} from '../../../src/data/fireWeather.js';

// Open-Meteo updates its models hourly; a 15-minute cache per 0.1° cell keeps
// a map of watched areas well inside the free tier.
const FIRE_WEATHER_CACHE_MS = 15 * 60_000;
const FIRE_WEATHER_STALE_MS = 3 * 60 * 60_000;
const FIRE_WEATHER_MAX_CACHE = 240;
const FIRE_WEATHER_MAX_RESPONSE_BYTES = 512 * 1024;

const _cache = new Map();
const _inFlight = new Map();
const _rateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 120,
});

function trimCache() {
  while (_cache.size > FIRE_WEATHER_MAX_CACHE) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

/** The Open-Meteo request for a point's fire-weather assessment. */
export function fireWeatherUrl(point) {
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(4),
    longitude: point.longitude.toFixed(4),
    hourly: FIRE_WEATHER_HOURLY.join(','),
    past_days: '3',
    forecast_days: '2',
    timezone: 'UTC',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

async function fetchFireWeather(point, fetchJson = fetchRegionalJson) {
  const payload = await fetchJson(fireWeatherUrl(point), {
    maxBytes: FIRE_WEATHER_MAX_RESPONSE_BYTES,
    redirect: 'error',
  });
  const assessment = assessFireWeather(payload);
  if (!assessment) throw new Error('Fire weather unavailable');
  return assessment;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * `/api/fire-weather?latitude=..&longitude=..`: Fosberg / Hot-Dry-Windy
 * screening for the next 24 hours at a point, from Open-Meteo (keyless).
 * @param {{fetchJson?: Function}} [options] injectable upstream for tests
 */
export function fireWeatherProxy({ fetchJson } = {}) {
  async function refresh(point, key) {
    const assessment = await fetchFireWeather(point, fetchJson);
    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      assessment,
    };
    _cache.set(key, { payload, cachedAt: Date.now() });
    trimCache();
    return payload;
  }

  async function handle(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    const url = new URL(req.url || '', 'http://localhost');
    const point = validRegionalPoint(url.searchParams);
    if (!point)
      return sendJson(res, 400, {
        error: 'Valid latitude and longitude are required',
      });
    const key = `${point.latitude.toFixed(1)},${point.longitude.toFixed(1)}`;
    const now = Date.now();
    const cached = _cache.get(key);
    // A cached cell costs nothing upstream, so it is served before the limiter:
    // behind a reverse proxy every user shares one limiter bucket.
    if (cached && now - cached.cachedAt <= FIRE_WEATHER_CACHE_MS)
      return sendJson(
        res,
        200,
        { ...cached.payload, status: 'cached' },
        { 'Cache-Control': 'public, max-age=120', 'X-Fire-Weather': 'HIT' },
      );
    if (!_inFlight.has(key) && !_rateLimiter(clientKey(req)))
      return sendJson(
        res,
        429,
        { error: 'Rate limit exceeded' },
        { 'Retry-After': '10' },
      );
    const request = coalesceProxyRequest(_inFlight, key, () =>
      refresh(point, key),
    );
    try {
      const payload = await request.promise;
      sendJson(res, 200, payload, {
        'Cache-Control': 'public, max-age=120',
        'X-Fire-Weather': request.shared ? 'INFLIGHT' : 'MISS',
      });
    } catch {
      if (cached && now - cached.cachedAt <= FIRE_WEATHER_STALE_MS)
        return sendJson(
          res,
          200,
          { ...cached.payload, status: 'stale' },
          { 'Cache-Control': 'no-store', 'X-Fire-Weather': 'STALE' },
        );
      sendJson(
        res,
        503,
        { error: 'Fire weather is temporarily unavailable' },
        { 'Cache-Control': 'no-store' },
      );
    }
  }

  return {
    name: 'fire-weather-proxy',
    handle,
    configureServer(server) {
      server.middlewares.use('/api/fire-weather', handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/fire-weather', handle);
    },
  };
}

/** Test hook: forget cached assessments. */
export function resetFireWeatherCache() {
  _cache.clear();
  _inFlight.clear();
}
