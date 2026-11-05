/**
 * Wildfire Watch finder: the logic behind the `/wildfire` page.
 *
 * The page asks one question — "what are you looking for?" — and this module
 * turns the answer, plus any refinements, into a list of fires, a plain
 * sentence describing that list, a shareable link and a CSV file.
 *
 * Pure on purpose: no DOM, no network, no clock (callers pass `now`) and no
 * imports. The same file runs under `node --test` and is served to the browser
 * unchanged as an ES module (`/wildfire/finder.js`), so the page and its tests
 * cannot drift apart.
 *
 * Zones are the ranked rows of `/api/fire-risk`: they arrive ordered by score,
 * highest first, which is the "risk" order.
 */

/** What a person can be looking for, in the order the page offers them. */
export const GOALS = Object.freeze([
  Object.freeze({ id: 'attention', sort: 'risk' }),
  Object.freeze({ id: 'near', sort: 'distance' }),
  Object.freeze({ id: 'assets', sort: 'exposure' }),
  Object.freeze({ id: 'new', sort: 'newest' }),
  Object.freeze({ id: 'watched', sort: 'risk' }),
]);

export const GOAL_IDS = Object.freeze(GOALS.map((goal) => goal.id));

/** Orders the page offers. `distance` needs a place. */
export const SORT_IDS = Object.freeze([
  'risk',
  'distance',
  'exposure',
  'newest',
  'size',
]);

/** Distances offered for "near a place", in kilometres. */
export const RADIUS_CHOICES_KM = Object.freeze([25, 50, 100, 250, 500]);
export const DEFAULT_RADIUS_KM = 100;

/** "New" means discovered within this many days. */
export const NEW_WITHIN_DAYS = 3;

/** Size floors offered, in acres. */
export const ACRE_CHOICES = Object.freeze([0, 100, 1000, 10000, 100000]);

/** "Hide fires at least this contained" choices, in percent. 0 = show all. */
export const CONTAINED_CHOICES = Object.freeze([0, 50, 90]);

/** The bands, most severe first, used when a payload does not carry them. */
export const DEFAULT_BANDS = Object.freeze([
  Object.freeze({ id: 'critical', label: 'CRITICAL', min: 75 }),
  Object.freeze({ id: 'high', label: 'HIGH', min: 60 }),
  Object.freeze({ id: 'elevated', label: 'ELEVATED', min: 45 }),
  Object.freeze({ id: 'watch', label: 'WATCH', min: 30 }),
  Object.freeze({ id: 'low', label: 'LOW', min: 0 }),
]);

/** US state and territory names, for a readable state filter. */
export const US_STATES = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
  GU: 'Guam',
  VI: 'U.S. Virgin Islands',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
});

/** Fire-weather classes from `/api/fire-weather`, least to most severe. */
export const FIRE_WEATHER_LEVELS = Object.freeze([
  'low',
  'moderate',
  'high',
  'very_high',
  'extreme',
]);

const FIRE_WEATHER_LABELS = Object.freeze({
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  very_high: 'Very high',
  extreme: 'Extreme',
});

/** The globe link's layer codes: active fires (w), perimeters (2), wind (k). */
const FIRE_MODE_LAYERS = 'w.2.k';
const LAYER_STATE_VERSION = 2;

const MAX_QUERY_CHARS = 80;
const MAX_PLACE_CHARS = 120;
const MAX_WATCHED = 500;
const DAY_MS = 86_400_000;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/* ------------------------------------------------------------- criteria */

/** The page's starting point: every fire, highest risk first. */
export function defaultCriteria() {
  return {
    goal: 'attention',
    query: '',
    state: '',
    minBand: '',
    minAcres: 0,
    hideContainedPct: 0,
    place: null,
    radiusKm: DEFAULT_RADIUS_KM,
    sort: 'risk',
  };
}

/**
 * Switch goal. The goal's own order replaces the current one; refinements the
 * person set (search, state, band, size, containment, place) are kept, because
 * changing what you look for should not silently forget where you look.
 */
export function withGoal(criteria, goalId) {
  const goal = GOALS.find((entry) => entry.id === goalId);
  if (!goal) return criteria;
  return { ...criteria, goal: goal.id, sort: goal.sort };
}

/** Back to every fire, keeping only the goal and the place. */
export function clearRefinements(criteria) {
  const goal = GOALS.find((entry) => entry.id === criteria.goal) ?? GOALS[0];
  return {
    ...defaultCriteria(),
    goal: goal.id,
    sort: goal.sort,
    place: criteria.place,
    radiusKm: criteria.radiusKm,
  };
}

/** How many refinements are narrowing the list (the goal is not one). */
export function refinementCount(criteria) {
  let count = 0;
  if (criteria.query) count += 1;
  if (criteria.state) count += 1;
  if (criteria.minBand) count += 1;
  if (criteria.minAcres > 0) count += 1;
  if (criteria.hideContainedPct > 0) count += 1;
  return count;
}

/* ------------------------------------------------------------- geometry */

/** Great-circle distance in kilometres. */
export function distanceKm(a, b) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function validPoint(point) {
  return (
    point != null &&
    finite(point.lat) &&
    finite(point.lon) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lon) <= 180
  );
}

/**
 * Read "lat, lon" typed into the place box. Accepts a comma or spaces between
 * the two numbers and an optional degree sign; anything else is a place name.
 * @returns {{lat:number, lon:number}|null}
 */
export function parseCoordinates(text) {
  const match = String(text ?? '')
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?$/);
  if (!match) return null;
  const point = { lat: Number(match[1]), lon: Number(match[2]) };
  return validPoint(point) ? point : null;
}

/* --------------------------------------------------------------- fields */

/** Two-letter state code from the feed's `US-CA` form, or ''. */
export function stateCode(zone) {
  const raw = String(zone?.state ?? '')
    .trim()
    .toUpperCase();
  const code = raw.startsWith('US-') ? raw.slice(3) : raw;
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/** "California", or the code when the name is unknown. */
export function stateName(code) {
  return US_STATES[code] ?? code;
}

/** States present in the list, with how many fires each has, by name. */
export function stateOptions(zones) {
  const counts = new Map();
  for (const zone of Array.isArray(zones) ? zones : []) {
    const code = stateCode(zone);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts]
    .map(([code, count]) => ({ code, name: stateName(code), count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Fold case and accents so "Québec" and "quebec" match. */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesQuery(zone, query) {
  if (!query) return true;
  const code = stateCode(zone);
  const hay = normalizeText(
    [zone.name, zone.county, code, stateName(code), zone.id]
      .filter(Boolean)
      .join(' '),
  );
  return hay.includes(normalizeText(query));
}

/** Whether a fire has infrastructure near it or downwind of it. */
export function hasAssetsNearby(zone) {
  const detail = zone?.exposureDetail;
  return Boolean(
    detail && ((detail.withinRadius ?? 0) > 0 || (detail.downwind ?? 0) > 0),
  );
}

function bandFloor(bands, minBand) {
  if (!minBand) return null;
  return (bands ?? DEFAULT_BANDS).find((band) => band.id === minBand) ?? null;
}

/* -------------------------------------------------------------- finding */

/**
 * Apply a goal and its refinements to the ranked list.
 *
 * Missing data is handled the same way every time, and the page says so:
 * a size floor hides fires with no reported size; "hide contained" keeps fires
 * whose containment is not reported, because half the feed does not report it.
 *
 * @param {Array<object>} zones Ranked zones from `/api/fire-risk`.
 * @param {object} criteria From `defaultCriteria` / `decodeCriteria`.
 * @param {{now?: number, bands?: Array<{id:string,min:number}>, watched?: Set<string>}} [context]
 * @returns {{rows: Array<{zone: object, distanceKm: number|null}>, needsPlace: boolean}}
 */
export function findFires(zones, criteria, context = {}) {
  const now = finite(context.now) ? context.now : 0;
  const watched = context.watched instanceof Set ? context.watched : new Set();
  const floor = bandFloor(context.bands, criteria.minBand);
  const place = validPoint(criteria.place) ? criteria.place : null;
  const needsPlace = criteria.goal === 'near' && !place;
  if (needsPlace) return { rows: [], needsPlace };

  const rows = [];
  for (const zone of Array.isArray(zones) ? zones : []) {
    if (!zone) continue;
    const distance =
      place && validPoint(zone.centroid)
        ? distanceKm(place, zone.centroid)
        : null;

    // The goal.
    if (
      criteria.goal === 'near' &&
      (distance === null || distance > criteria.radiusKm)
    )
      continue;
    if (criteria.goal === 'assets' && !hasAssetsNearby(zone)) continue;
    if (criteria.goal === 'new') {
      if (
        !finite(zone.discoveredAt) ||
        zone.discoveredAt < now - NEW_WITHIN_DAYS * DAY_MS
      )
        continue;
    }
    if (criteria.goal === 'watched' && !watched.has(zone.id)) continue;

    // The refinements.
    if (!matchesQuery(zone, criteria.query)) continue;
    if (criteria.state && stateCode(zone) !== criteria.state) continue;
    if (floor && !(finite(zone.score) && zone.score >= floor.min)) continue;
    if (
      criteria.minAcres > 0 &&
      !(finite(zone.acres) && zone.acres >= criteria.minAcres)
    )
      continue;
    if (
      criteria.hideContainedPct > 0 &&
      finite(zone.containedPct) &&
      zone.containedPct >= criteria.hideContainedPct
    )
      continue;

    rows.push({ zone, distanceKm: distance });
  }
  return { rows: sortRows(rows, criteria.sort, Boolean(place)), needsPlace };
}

function sortRows(rows, sort, hasPlace) {
  const by = (pick) => (a, b) => {
    const x = pick(a);
    const y = pick(b);
    // Unknown values sink to the bottom whatever the direction.
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  const score = (row) => (finite(row.zone.score) ? row.zone.score : null);
  const sorted = [...rows];
  if (sort === 'distance' && hasPlace)
    sorted.sort(
      by((row) => (row.distanceKm === null ? null : -row.distanceKm)),
    );
  else if (sort === 'exposure')
    sorted.sort(
      (a, b) =>
        by((row) =>
          finite(row.zone.components?.exposure)
            ? row.zone.components.exposure
            : null,
        )(a, b) || by(score)(a, b),
    );
  else if (sort === 'newest')
    sorted.sort(
      by((row) =>
        finite(row.zone.discoveredAt) ? row.zone.discoveredAt : null,
      ),
    );
  else if (sort === 'size')
    sorted.sort(by((row) => (finite(row.zone.acres) ? row.zone.acres : null)));
  // 'risk' (and distance without a place) keeps the engine's own ranking.
  return sorted;
}

/* ------------------------------------------------------------- language */

function plural(count, one, many = `${one}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function radiusText(km) {
  return `${km.toLocaleString('en-US')} km`;
}

const SORT_TEXT = Object.freeze({
  risk: 'highest risk first',
  distance: 'nearest first',
  exposure: 'most exposed infrastructure first',
  newest: 'newest first',
  size: 'largest first',
});

/**
 * One sentence saying what is on screen, e.g.
 * "6 of 77 fires · within 100 km of Redding, California · High or above · nearest first".
 */
export function describeView(criteria, { shown, total, bands } = {}) {
  const parts = [
    shown === total
      ? `${plural(total, 'fire')} burning now`
      : `${shown.toLocaleString('en-US')} of ${plural(total, 'fire')}`,
  ];
  if (criteria.goal === 'near' && criteria.place)
    parts.push(
      `within ${radiusText(criteria.radiusKm)} of ${criteria.place.label || 'the chosen place'}`,
    );
  if (criteria.goal === 'assets')
    parts.push('with infrastructure nearby or downwind');
  if (criteria.goal === 'new')
    parts.push(`discovered in the last ${NEW_WITHIN_DAYS} days`);
  if (criteria.goal === 'watched') parts.push('on your watchlist');
  if (criteria.state) parts.push(stateName(criteria.state));
  const floor = bandFloor(bands, criteria.minBand);
  if (floor && floor.min > 0)
    parts.push(`${titleCase(floor.label ?? floor.id)} or above`);
  if (criteria.minAcres > 0)
    parts.push(`at least ${criteria.minAcres.toLocaleString('en-US')} acres`);
  if (criteria.hideContainedPct > 0)
    parts.push(`hiding fires ${criteria.hideContainedPct}% or more contained`);
  if (criteria.query) parts.push(`matching “${criteria.query}”`);
  const order =
    criteria.sort === 'distance' && !criteria.place
      ? SORT_TEXT.risk
      : SORT_TEXT[criteria.sort];
  if (shown > 1 && order) parts.push(order);
  return parts.join(' · ');
}

/** What to say when nothing matches, specific to what was asked. */
export function emptyHint(criteria, { total } = {}) {
  if (!total) return 'The incident feed reports no active fire right now.';
  if (criteria.goal === 'near' && !criteria.place)
    return 'Type a town, an address or coordinates above, or use your location.';
  const refined = refinementCount(criteria) > 0;
  const tail = refined ? ' Or clear the filters you set.' : '';
  switch (criteria.goal) {
    case 'near': {
      const wider = RADIUS_CHOICES_KM.find((km) => km > criteria.radiusKm);
      return (
        `No reported fire within ${radiusText(criteria.radiusKm)} of ${criteria.place.label || 'this place'}.` +
        (wider ? ` Try ${radiusText(wider)}.` : '') +
        tail
      );
    }
    case 'assets':
      return (
        'No fire has a datacenter or dam within 25 km, or downwind, right now.' +
        tail
      );
    case 'new':
      return (
        `No fire was discovered in the last ${NEW_WITHIN_DAYS} days.` + tail
      );
    case 'watched':
      return refined
        ? 'None of your watched fires match these filters. Clear them to see the whole watchlist.'
        : 'Your watchlist is empty. Open any fire and press Watch to keep it here.';
    default:
      return 'No fire matches these filters. Clear them to see every fire.';
  }
}

function titleCase(text) {
  const lower = String(text).toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The fire-weather card's words, from a `/api/fire-weather` assessment. */
export function describeFireWeather(assessment) {
  if (!assessment || !FIRE_WEATHER_LEVELS.includes(assessment.danger))
    return null;
  const peak = assessment.peak_24h ?? {};
  const lines = [];
  if (typeof peak.time === 'string' && peak.time.length >= 16)
    lines.push(
      `Worst hour: ${peak.time.slice(11, 16)} UTC${finite(peak.ffwi) ? ` (fire weather index ${Math.round(peak.ffwi)} of 100)` : ''}.`,
    );
  if (Array.isArray(assessment.drivers) && assessment.drivers.length)
    lines.push(`Why: ${assessment.drivers.join(', ')}.`);
  return {
    level: assessment.danger,
    rank: FIRE_WEATHER_LEVELS.indexOf(assessment.danger),
    label: FIRE_WEATHER_LABELS[assessment.danger],
    redFlagHours: finite(assessment.red_flag_hours_24h)
      ? assessment.red_flag_hours_24h
      : 0,
    lines,
  };
}

/* ------------------------------------------------------------ the link */

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readNumber(params, key) {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The view as a query string, leaving out anything at its default so a shared
 * link stays short and readable: `?goal=near&place=Redding&lat=40.59&lon=-122.39`.
 */
export function encodeCriteria(criteria) {
  const params = new URLSearchParams();
  const defaults = defaultCriteria();
  const goal = GOALS.find((entry) => entry.id === criteria.goal) ?? GOALS[0];
  if (goal.id !== defaults.goal) params.set('goal', goal.id);
  if (criteria.place && validPoint(criteria.place)) {
    if (criteria.place.label) params.set('place', criteria.place.label);
    params.set('lat', criteria.place.lat.toFixed(4));
    params.set('lon', criteria.place.lon.toFixed(4));
  }
  if (criteria.radiusKm !== defaults.radiusKm)
    params.set('r', String(criteria.radiusKm));
  if (criteria.query) params.set('q', criteria.query);
  if (criteria.state) params.set('st', criteria.state);
  if (criteria.minBand) params.set('band', criteria.minBand);
  if (criteria.minAcres > 0) params.set('acres', String(criteria.minAcres));
  if (criteria.hideContainedPct > 0)
    params.set('cont', String(criteria.hideContainedPct));
  if (criteria.sort !== goal.sort) params.set('sort', criteria.sort);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Read a view from a query string. Every value is checked; anything malformed
 * falls back to its default rather than producing a half-broken view.
 * @param {string} search `location.search`
 * @param {{bands?: Array<{id:string}>}} [context]
 */
export function decodeCriteria(search, context = {}) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  const criteria = defaultCriteria();
  const goal = GOALS.find((entry) => entry.id === params.get('goal'));
  if (goal) {
    criteria.goal = goal.id;
    criteria.sort = goal.sort;
  }
  const lat = readNumber(params, 'lat');
  const lon = readNumber(params, 'lon');
  if (lat !== null && lon !== null && validPoint({ lat, lon })) {
    const label = String(params.get('place') ?? '')
      .trim()
      .slice(0, MAX_PLACE_CHARS);
    criteria.place = {
      lat,
      lon,
      label: label || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    };
  }
  const radius = readNumber(params, 'r');
  if (radius !== null)
    criteria.radiusKm = Math.round(clampNumber(radius, 1, 1000));
  criteria.query = String(params.get('q') ?? '')
    .trim()
    .slice(0, MAX_QUERY_CHARS);
  const state = String(params.get('st') ?? '')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(state)) criteria.state = state;
  const bands = context.bands ?? DEFAULT_BANDS;
  const band = params.get('band');
  if (bands.some((entry) => entry.id === band)) criteria.minBand = band;
  const acres = readNumber(params, 'acres');
  if (acres !== null && acres > 0)
    criteria.minAcres = Math.round(clampNumber(acres, 0, 10_000_000));
  const contained = readNumber(params, 'cont');
  if (contained !== null && contained > 0)
    criteria.hideContainedPct = Math.round(clampNumber(contained, 1, 100));
  const sort = params.get('sort');
  if (SORT_IDS.includes(sort)) criteria.sort = sort;
  return criteria;
}

/**
 * A link that opens the 3D globe on a point with only the fire layers on:
 * active fires, fire perimeters and wind.
 */
export function globeLink(point, { altitudeM = 120_000 } = {}) {
  if (!validPoint(point)) return '/';
  const params = new URLSearchParams({
    v: String(LAYER_STATE_VERSION),
    lat: point.lat.toFixed(4),
    lon: point.lon.toFixed(4),
    alt: String(Math.round(clampNumber(altitudeM, 5_000, 3_000_000))),
    heading: '0',
    pitch: '-60',
  });
  // `l` lists exactly the layers to show; every other layer is left off.
  return `/#${params.toString()}&l=${FIRE_MODE_LAYERS}`;
}

/** A camera height that frames a fire's perimeter, in metres. */
export function fireAltitudeM(zone) {
  const box = zone?.bounds;
  if (!box || ![box.west, box.east, box.south, box.north].every(finite))
    return 60_000;
  const midLat = ((box.north + box.south) / 2) * (Math.PI / 180);
  const spanKm = Math.max(
    (box.north - box.south) * 111,
    (box.east - box.west) * 111 * Math.cos(midLat),
  );
  return clampNumber(spanKm * 3_000, 20_000, 600_000);
}

/**
 * Where to point the globe so every listed fire is in view: the middle of
 * their centres and a height that spans them. Null when no fire has a position.
 */
export function rowsView(rows) {
  const points = (Array.isArray(rows) ? rows : [])
    .map((row) => row?.zone?.centroid)
    .filter(validPoint);
  if (!points.length) return null;
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const north = Math.max(...lats);
  const south = Math.min(...lats);
  const east = Math.max(...lons);
  const west = Math.min(...lons);
  const midLat = (north + south) / 2;
  const spanKm = Math.max(
    (north - south) * 111,
    (east - west) * 111 * Math.cos(midLat * (Math.PI / 180)),
  );
  return {
    point: { lat: midLat, lon: (east + west) / 2 },
    altitudeM: clampNumber(spanKm * 2_000, 80_000, 6_000_000),
  };
}

/** A camera height that shows a place and its search radius, in metres. */
export function placeAltitudeM(radiusKm) {
  return clampNumber(radiusKm * 3_500, 40_000, 3_000_000);
}

/* ------------------------------------------------------------ watchlist */

/** The watchlist the globe panel keeps, read from its stored JSON. */
export function parseWatchlist(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed
            .filter((id) => typeof id === 'string' && id.length <= 200)
            .slice(0, MAX_WATCHED)
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Add or remove one fire; returns a new set. */
export function toggleWatch(watched, id) {
  const next = new Set(watched);
  if (next.has(id)) next.delete(id);
  else if (next.size < MAX_WATCHED) next.add(id);
  return next;
}

/* ------------------------------------------------------------------ CSV */

export const CSV_COLUMNS = Object.freeze([
  'rank',
  'name',
  'state',
  'county',
  'band',
  'score',
  'acres',
  'contained_pct',
  'discovered_utc',
  'perimeter_age_h',
  'distance_km',
  'assets_within_25km',
  'assets_downwind',
  'nearest_asset_km',
  'wind_m_s',
  'evidence',
  'reasons',
  'lat',
  'lon',
  'incident_id',
  'risk_version',
  'generated_utc',
]);

/**
 * Spreadsheets run a cell that starts with = + - @ (or a tab or return) as a
 * formula. Fire names come from an outside feed, so text cells that start that
 * way are prefixed with an apostrophe, which spreadsheets show as plain text.
 */
function safeText(value) {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : safeText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isoOrEmpty(ms) {
  return finite(ms) ? new Date(ms).toISOString() : '';
}

function round(value, digits) {
  return finite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * The rows on screen as CSV, in screen order, with the index version and the
 * time the index was generated on every row so a saved file explains itself.
 */
export function toCsv(rows, { generatedAt, riskVersion } = {}) {
  const lines = [CSV_COLUMNS.join(',')];
  rows.forEach((row, index) => {
    const zone = row.zone;
    const detail = zone.exposureDetail ?? {};
    const cells = [
      index + 1,
      zone.name,
      stateCode(zone),
      zone.county,
      zone.band,
      round(zone.score, 1),
      round(zone.acres, 1),
      round(zone.containedPct, 0),
      isoOrEmpty(zone.discoveredAt),
      round(zone.ageHours, 1),
      round(row.distanceKm, 1),
      finite(detail.withinRadius) ? detail.withinRadius : null,
      finite(detail.downwind) ? detail.downwind : null,
      round(detail.nearestKm, 1),
      round(zone.wind?.speedMs, 1),
      zone.confidence,
      Array.isArray(zone.reasons) ? zone.reasons.join('; ') : '',
      round(zone.centroid?.lat, 4),
      round(zone.centroid?.lon, 4),
      zone.id,
      zone.riskVersion ?? riskVersion,
      isoOrEmpty(generatedAt),
    ];
    lines.push(cells.map(csvCell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

/** A file name that says when and what: `wildfire-watch-2026-11-05-near.csv`. */
export function csvFileName(criteria, now) {
  const day = finite(now) ? new Date(now).toISOString().slice(0, 10) : 'export';
  return `wildfire-watch-${day}-${criteria.goal}.csv`;
}
