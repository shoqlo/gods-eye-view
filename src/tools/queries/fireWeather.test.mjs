import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import {
  fireWeatherProxy,
  fireWeatherUrl,
  resetFireWeatherCache,
} from '../../../server/providers/regional/fire-weather.js';

const assessment = {
  danger: 'very_high',
  current: { time: '2026-08-14T18:00:00.000Z', danger: 'high', ffwi: 41.2 },
  peak_24h: {
    time: '2026-08-14T22:00:00.000Z',
    danger: 'very_high',
    ffwi: 58.3,
    hdw: 210,
    red_flag_screen: true,
  },
  red_flag_hours_24h: 3,
  rain_72h_mm: 0,
  drivers: ['humidity down to 11%', 'wind 38 km/h'],
};

const fireWeather = {
  calls: [],
  async getRisk(lat, lon) {
    this.calls.push([lat, lon]);
    return { status: 'ready', retrievedAt: '2026-08-14T18:20:00.000Z', assessment };
  },
};

const fires = (rows, extra = {}) => ({
  async getSnapshot() {
    return { fires: rows, ...extra };
  },
});

const call = (services, args) =>
  composeCatalog({ tools: coreTools, services }).call('get_fire_weather_risk', args);

test('fire weather risk summarises danger, peak hour and nearby detections', async () => {
  fireWeather.calls = [];
  const result = await call(
    {
      fireWeather,
      fires: fires([
        { lat: 34.25, lon: -118.2, frp: 12 },
        { lat: 34.3, lon: -118.25, frp: 95 },
        { lat: 40, lon: -100, frp: 300 },
      ]),
    },
    { location: { lat: 34.2, lon: -118.2 }, radius_km: 25 },
  );
  assert.deepEqual(fireWeather.calls, [[34.2, -118.2]]);
  assert.match(
    result.summary,
    /very high danger over the next 24 hours, peaking 22:00 UTC at FFWI 58\.3 \(humidity down to 11%, wind 38 km\/h\); 2 fire detections within 25 km/,
  );
  assert.equal(result.data.nearby_fire_detections.count, 2);
  assert.equal(result.data.nearby_fire_detections.strongest.frp_mw, 95);
  assert.equal(result.data.red_flag_hours_24h, 3);
  assert.match(result.data.method, /not|Official warnings take precedence/);
});

test('fire weather risk still answers without a FIRMS key or fire service', async () => {
  const keyless = await call(
    { fireWeather, fires: fires([], { keyRequired: true }) },
    { location: { lat: 34.2, lon: -118.2 } },
  );
  assert.equal(keyless.data.nearby_fire_detections, null);
  assert.doesNotMatch(keyless.summary, /fire detection/);

  const broken = await call(
    {
      fireWeather,
      fires: {
        async getSnapshot() {
          throw new Error('upstream down');
        },
      },
    },
    { location: { lat: 34.2, lon: -118.2 } },
  );
  assert.equal(broken.data.nearby_fire_detections, null);
});

test('fire weather tool is offered only when the service exists', () => {
  const without = composeCatalog({ tools: coreTools, services: {} });
  assert.ok(!without.list().some((tool) => tool.name === 'get_fire_weather_risk'));
  const withService = composeCatalog({ tools: coreTools, services: { fireWeather } });
  assert.ok(withService.list().some((tool) => tool.name === 'get_fire_weather_risk'));
});

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
    },
    end(body) {
      this.body = body;
    },
  };
}

const request = async (proxy, url, method = 'GET') => {
  const res = fakeResponse();
  await proxy.handle(
    { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res,
  );
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
};

test('the Open-Meteo request asks for hourly fire-weather variables with history', () => {
  const url = new URL(fireWeatherUrl({ latitude: 34.2, longitude: -118.2 }));
  assert.equal(url.host, 'api.open-meteo.com');
  assert.equal(url.searchParams.get('past_days'), '3');
  assert.match(url.searchParams.get('hourly'), /relative_humidity_2m/);
  assert.match(url.searchParams.get('hourly'), /vapour_pressure_deficit/);
});

test('the proxy validates input, caches per 0.1° cell and fails cleanly with no cache', async () => {
  resetFireWeatherCache();
  let calls = 0;
  let fail = false;
  const now = Date.now();
  const time = Array.from({ length: 6 }, (_, i) =>
    new Date(now - 2 * 3_600_000 + i * 3_600_000).toISOString().slice(0, 16),
  );
  const series = (v) => time.map(() => v);
  const proxy = fireWeatherProxy({
    fetchJson: async () => {
      calls++;
      if (fail) throw new Error('down');
      return {
        hourly: {
          time,
          temperature_2m: series(30),
          relative_humidity_2m: series(15),
          wind_speed_10m: series(30),
          wind_gusts_10m: series(45),
          wind_direction_10m: series(90),
          vapour_pressure_deficit: series(3.5),
          precipitation: series(0),
        },
      };
    },
  });

  assert.equal((await request(proxy, '/?latitude=abc&longitude=1')).status, 400);
  assert.equal((await request(proxy, '/?latitude=1&longitude=1', 'POST')).status, 405);

  const first = await request(proxy, '/?latitude=34.21&longitude=-118.22');
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-fire-weather'], 'MISS');
  assert.ok(['high', 'very_high', 'extreme'].includes(first.json.assessment.danger));

  const second = await request(proxy, '/?latitude=34.24&longitude=-118.18');
  assert.equal(second.headers['x-fire-weather'], 'HIT');
  assert.equal(calls, 1);

  fail = true;
  const missing = await request(proxy, '/?latitude=10&longitude=10');
  assert.equal(missing.status, 503);
});
