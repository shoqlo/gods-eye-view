import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessFireWeather,
  assessHour,
  equilibriumMoisturePct,
  fosbergIndex,
  hotDryWindyIndex,
  meetsRedFlagScreen,
} from './fireWeather.js';

const near = (actual, expected, tolerance = 0.5) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} not within ${tolerance} of ${expected}`,
  );

test('equilibrium moisture follows the three Simard humidity branches', () => {
  // 35 °C = 95 °F. Hand-computed from Simard (1968).
  near(equilibriumMoisturePct(35, 5), 0.03229 + 0.281073 * 5 - 0.000578 * 5 * 95, 1e-9);
  near(equilibriumMoisturePct(35, 10), 2.22749 + 1.60107 - 0.01478 * 95, 1e-9);
  near(equilibriumMoisturePct(15, 80), 16.37, 0.05);
});

test('Fosberg index is near zero when calm and humid and high when hot, dry and windy', () => {
  near(fosbergIndex(15, 80, 5), 3.0, 0.2);
  near(fosbergIndex(35, 10, 40), 70.7, 0.5);
  assert.equal(fosbergIndex(45, 1, 200), 100);
  assert.equal(fosbergIndex(null, 10, 10), null);
});

test('Hot-Dry-Windy index multiplies VPD in hPa by wind in m/s', () => {
  near(hotDryWindyIndex(5, 39.6), 550, 1e-9);
  assert.equal(hotDryWindyIndex(undefined, 10), null);
});

test('red-flag screen needs low humidity and strong wind or gusts', () => {
  assert.equal(meetsRedFlagScreen({ relativeHumidityPct: 12, windKmh: 35 }), true);
  assert.equal(meetsRedFlagScreen({ relativeHumidityPct: 12, windKmh: 10, gustKmh: 60 }), true);
  assert.equal(meetsRedFlagScreen({ relativeHumidityPct: 25, windKmh: 60 }), false);
  assert.equal(meetsRedFlagScreen({ relativeHumidityPct: 10, windKmh: 10 }), false);
});

test('a red-flag hour is at least very high even with modest indices', () => {
  const hour = assessHour({
    temperatureC: 12,
    relativeHumidityPct: 14,
    windKmh: 33,
    vapourPressureDeficitKpa: 1.2,
  });
  assert.equal(hour.redFlag, true);
  assert.ok(hour.level >= 3);
});

/** An Open-Meteo-shaped payload: 72 h of history then 48 h ahead. */
function forecast(now, { past, next, rainPerHour = 0 }) {
  const time = [];
  const fields = {
    temperature_2m: [],
    relative_humidity_2m: [],
    wind_speed_10m: [],
    wind_gusts_10m: [],
    wind_direction_10m: [],
    vapour_pressure_deficit: [],
    precipitation: [],
  };
  const start = Math.floor(now / 3_600_000) * 3_600_000 - 72 * 3_600_000;
  for (let i = 0; i < 120; i++) {
    const t = start + i * 3_600_000;
    const hour = t <= now ? past : next(i - 72);
    // Open-Meteo returns local ISO times without a zone when timezone=UTC.
    time.push(new Date(t).toISOString().slice(0, 16));
    fields.temperature_2m.push(hour.t);
    fields.relative_humidity_2m.push(hour.rh);
    fields.wind_speed_10m.push(hour.w);
    fields.wind_gusts_10m.push(hour.g ?? hour.w * 1.5);
    fields.wind_direction_10m.push(45);
    fields.vapour_pressure_deficit.push(hour.vpd);
    fields.precipitation.push(t <= now ? rainPerHour : 0);
  }
  return { hourly: { time, ...fields } };
}

const NOW = Date.parse('2026-08-14T18:20:00Z');
const mild = { t: 18, rh: 70, w: 8, vpd: 0.6 };

test('assessment reports the worst hour of the next 24 and its drivers', () => {
  const payload = forecast(NOW, {
    past: mild,
    next: (h) => (h === 4 ? { t: 38, rh: 8, w: 45, g: 70, vpd: 6 } : mild),
  });
  const result = assessFireWeather(payload, NOW);
  assert.equal(result.danger, 'extreme');
  assert.equal(result.current.danger, 'low');
  assert.equal(result.peak_24h.time, '2026-08-14T22:00:00.000Z');
  assert.equal(result.peak_24h.red_flag_screen, true);
  assert.equal(result.red_flag_hours_24h, 1);
  assert.equal(result.rain_72h_mm, 0);
  assert.deepEqual(result.drivers, [
    'humidity down to 8%',
    'wind 45 km/h',
    'gusts 70 km/h',
    'heat 38°C',
    '1 h of red-flag-style conditions',
    'no rain in 72 h',
  ]);
});

test('hours beyond the next 24 do not raise the class', () => {
  const payload = forecast(NOW, {
    past: mild,
    next: (h) => (h === 30 ? { t: 38, rh: 8, w: 45, vpd: 6 } : mild),
  });
  assert.equal(assessFireWeather(payload, NOW).danger, 'low');
});

test('wetting rain in the last 72 hours lowers the class by one step', () => {
  const dryWindy = { t: 30, rh: 18, w: 30, vpd: 3 };
  const dry = assessFireWeather(
    forecast(NOW, { past: mild, next: () => dryWindy }),
    NOW,
  );
  const wet = assessFireWeather(
    forecast(NOW, { past: mild, next: () => dryWindy, rainPerHour: 0.5 }),
    NOW,
  );
  const order = ['low', 'moderate', 'high', 'very_high', 'extreme'];
  assert.equal(order.indexOf(wet.danger), order.indexOf(dry.danger) - 1);
  assert.ok(wet.rain_72h_mm >= 10);
  assert.match(wet.drivers.at(-1), /mm rain in 72 h lowers the class/);
});

test('payloads without hourly data are not assessed', () => {
  assert.equal(assessFireWeather(null, NOW), null);
  assert.equal(assessFireWeather({ hourly: { time: [] } }, NOW), null);
});
