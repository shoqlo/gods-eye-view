/**
 * Fire-weather risk from surface weather: the Fosberg Fire Weather Index,
 * the Hot-Dry-Windy Index and a red-flag-style humidity/wind screen,
 * combined into one danger class.
 *
 * These are screening indices computed from a numerical weather model, not
 * an official fire-danger rating. They ignore fuel type, fuel load, terrain
 * and local climatology, all of which decide how a real fire behaves; an
 * official product (NWS Red Flag Warnings, the U.S. National Fire Danger
 * Rating System, the Canadian FWI) always takes precedence.
 */

const KMH_TO_MPH = 0.621371;
const KMH_TO_MS = 1 / 3.6;

/** Danger classes, least to most severe. */
export const FIRE_DANGER_CLASSES = Object.freeze([
  'low',
  'moderate',
  'high',
  'very_high',
  'extreme',
]);

// FFWI band floors for each class above "low". Fosberg's index tops out at
// 100; values above ~50 are commonly treated as critical fire weather.
const FFWI_BANDS = [15, 30, 50, 75];

// HDW band floors (hPa·m/s). HDW is climatology-relative: Srock et al. (2018)
// recommend comparing against the local percentile; these fixed floors are a
// rough global screen only.
const HDW_BANDS = [50, 120, 250, 400];

// Red-flag-style screen: NWS offices use local criteria, typically around
// relative humidity <= 15% with sustained wind >= 20 mph or gusts >= 35 mph.
const RED_FLAG_RH_PCT = 15;
const RED_FLAG_WIND_KMH = 32;
const RED_FLAG_GUST_KMH = 56;

// Rain that has fallen recently wets fine fuels; at least this much in the
// last 72 hours lowers the class by one step.
const WETTING_RAIN_MM = 10;

const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Equilibrium moisture content (%) of fine dead fuel (Simard 1968), the
 * moisture term inside Fosberg's index.
 * @param {number} temperatureC
 * @param {number} relativeHumidityPct
 */
export function equilibriumMoisturePct(temperatureC, relativeHumidityPct) {
  const t = temperatureC * 1.8 + 32;
  const h = Math.min(100, Math.max(0, relativeHumidityPct));
  if (h < 10) return 0.03229 + 0.281073 * h - 0.000578 * h * t;
  if (h <= 50) return 2.22749 + 0.160107 * h - 0.01478 * t;
  return 21.0606 + 0.005565 * h * h - 0.00035 * h * t - 0.483199 * h;
}

/**
 * Fosberg Fire Weather Index (Fosberg 1978), 0 to 100.
 * @param {number} temperatureC
 * @param {number} relativeHumidityPct
 * @param {number} windKmh sustained 10 m wind
 * @returns {?number}
 */
export function fosbergIndex(temperatureC, relativeHumidityPct, windKmh) {
  if (
    finite(temperatureC) == null ||
    finite(relativeHumidityPct) == null ||
    finite(windKmh) == null
  )
    return null;
  const m = Math.max(
    0,
    equilibriumMoisturePct(temperatureC, relativeHumidityPct),
  );
  const ratio = Math.min(1, m / 30);
  const eta = 1 - 2 * ratio + 1.5 * ratio ** 2 - 0.5 * ratio ** 3;
  const windMph = Math.max(0, windKmh) * KMH_TO_MPH;
  const value = (eta * Math.sqrt(1 + windMph ** 2)) / 0.3002;
  return Math.min(100, Math.max(0, value));
}

/**
 * Hot-Dry-Windy Index (Srock et al. 2018) from surface values: vapour
 * pressure deficit (hPa) times wind speed (m/s). The published index takes
 * the maximum over the lowest 500 m of the atmosphere, so a surface-only
 * value understates it.
 * @param {number} vapourPressureDeficitKpa
 * @param {number} windKmh
 * @returns {?number}
 */
export function hotDryWindyIndex(vapourPressureDeficitKpa, windKmh) {
  if (finite(vapourPressureDeficitKpa) == null || finite(windKmh) == null)
    return null;
  return (
    Math.max(0, vapourPressureDeficitKpa * 10) *
    Math.max(0, windKmh) *
    KMH_TO_MS
  );
}

function bandIndex(value, floors) {
  if (value == null) return 0;
  let index = 0;
  for (const floor of floors) if (value >= floor) index++;
  return index;
}

/**
 * Whether the hour meets red-flag-style humidity and wind thresholds.
 * @param {{relativeHumidityPct?: number, windKmh?: number, gustKmh?: number}} hour
 */
export function meetsRedFlagScreen(hour) {
  const rh = finite(hour?.relativeHumidityPct);
  if (rh == null || rh > RED_FLAG_RH_PCT) return false;
  return (
    (finite(hour.windKmh) ?? 0) >= RED_FLAG_WIND_KMH ||
    (finite(hour.gustKmh) ?? 0) >= RED_FLAG_GUST_KMH
  );
}

/**
 * Indices and the danger class for one hour of weather.
 * @param {{temperatureC?: number, relativeHumidityPct?: number, windKmh?: number,
 *   gustKmh?: number, vapourPressureDeficitKpa?: number}} hour
 */
export function assessHour(hour) {
  const ffwi = fosbergIndex(
    hour?.temperatureC,
    hour?.relativeHumidityPct,
    hour?.windKmh,
  );
  const hdw = hotDryWindyIndex(hour?.vapourPressureDeficitKpa, hour?.windKmh);
  const redFlag = meetsRedFlagScreen(hour);
  let level = Math.max(bandIndex(ffwi, FFWI_BANDS), bandIndex(hdw, HDW_BANDS));
  // Red-flag humidity and wind are critical regardless of the indices.
  if (redFlag) level = Math.max(level, 3);
  return { ffwi, hdw, redFlag, level };
}

const round = (value, digits = 1) =>
  value == null ? null : Number(value.toFixed(digits));

/**
 * Assess an Open-Meteo forecast payload (hourly with `past_days`) as of
 * `nowMs`: the current hour, the worst hour of the next 24, and recent rain.
 * Returns null when the payload has no usable hourly data.
 * @param {object} payload Open-Meteo `/v1/forecast` JSON
 * @param {number} [nowMs]
 */
export function assessFireWeather(payload, nowMs = Date.now()) {
  const hourly = payload?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length)
    return null;
  const pick = (name, i) => finite(hourly[name]?.[i]);
  const hours = hourly.time.map((time, i) => ({
    timeMs: Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(time) ? time : `${time}Z`),
    temperatureC: pick('temperature_2m', i),
    relativeHumidityPct: pick('relative_humidity_2m', i),
    windKmh: pick('wind_speed_10m', i),
    gustKmh: pick('wind_gusts_10m', i),
    windDirectionDeg: pick('wind_direction_10m', i),
    vapourPressureDeficitKpa: pick('vapour_pressure_deficit', i),
    precipitationMm: pick('precipitation', i),
  }));
  const hourMs = 3_600_000;
  const past72 = hours.filter(
    (h) => h.timeMs <= nowMs && h.timeMs > nowMs - 72 * hourMs,
  );
  const next24 = hours.filter(
    (h) => h.timeMs > nowMs - hourMs && h.timeMs <= nowMs + 24 * hourMs,
  );
  if (!next24.length) return null;
  const rain72 = past72.reduce((sum, h) => sum + (h.precipitationMm ?? 0), 0);
  const wetted = rain72 >= WETTING_RAIN_MM;

  const assessed = next24.map((hour) => ({ hour, ...assessHour(hour) }));
  const current = assessed[0];
  const peak = assessed.reduce((worst, item) =>
    item.level > worst.level ||
    (item.level === worst.level && (item.ffwi ?? 0) > (worst.ffwi ?? 0))
      ? item
      : worst,
  );
  const redFlagHours = assessed.filter((item) => item.redFlag).length;
  const classOf = (level) =>
    FIRE_DANGER_CLASSES[Math.max(0, level - (wetted ? 1 : 0))];

  const drivers = [];
  const peakHour = peak.hour;
  if ((peakHour.relativeHumidityPct ?? 100) <= 20)
    drivers.push(
      `humidity down to ${Math.round(peakHour.relativeHumidityPct)}%`,
    );
  if ((peakHour.windKmh ?? 0) >= 30)
    drivers.push(`wind ${Math.round(peakHour.windKmh)} km/h`);
  if ((peakHour.gustKmh ?? 0) >= 50)
    drivers.push(`gusts ${Math.round(peakHour.gustKmh)} km/h`);
  if ((peakHour.temperatureC ?? 0) >= 32)
    drivers.push(`heat ${Math.round(peakHour.temperatureC)}°C`);
  if (redFlagHours)
    drivers.push(`${redFlagHours} h of red-flag-style conditions`);
  if (wetted) drivers.push(`${round(rain72)} mm rain in 72 h lowers the class`);
  else if (rain72 < 1) drivers.push('no rain in 72 h');

  const row = (item) => ({
    time: new Date(item.hour.timeMs).toISOString(),
    danger: classOf(item.level),
    ffwi: round(item.ffwi),
    hdw: round(item.hdw),
    red_flag_screen: item.redFlag,
    temperature_c: round(item.hour.temperatureC),
    relative_humidity_pct: round(item.hour.relativeHumidityPct, 0),
    wind_kph: round(item.hour.windKmh),
    gust_kph: round(item.hour.gustKmh),
    wind_direction_deg: round(item.hour.windDirectionDeg, 0),
  });

  return {
    danger: classOf(peak.level),
    current: row(current),
    peak_24h: row(peak),
    red_flag_hours_24h: redFlagHours,
    rain_72h_mm: round(rain72),
    drivers,
  };
}

/** The Open-Meteo hourly variables `assessFireWeather` reads. */
export const FIRE_WEATHER_HOURLY = Object.freeze([
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'vapour_pressure_deficit',
  'precipitation',
]);
