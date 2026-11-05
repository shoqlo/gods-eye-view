/**
 * The Wildfire Watch finder page (`/wildfire`), served as `/wildfire/app.js`.
 *
 * All decisions — which fires match, in what order, what the summary says,
 * what goes in a link or a CSV — are made by `finder.js`, which is unit
 * tested. This file only reads the controls, fetches, and draws. Every
 * upstream string is written with `textContent`, never parsed as markup.
 */

import {
  ACRE_CHOICES,
  CONTAINED_CHOICES,
  DEFAULT_BANDS,
  GOAL_IDS,
  RADIUS_CHOICES_KM,
  SORT_IDS,
  clearRefinements,
  csvFileName,
  decodeCriteria,
  describeFireWeather,
  describeView,
  emptyHint,
  encodeCriteria,
  findFires,
  fireAltitudeM,
  globeLink,
  parseCoordinates,
  parseWatchlist,
  placeAltitudeM,
  refinementCount,
  rowsView,
  stateCode,
  stateName,
  stateOptions,
  toCsv,
  toggleWatch,
  withGoal,
} from './finder.js';

const RISK_URL = '/api/fire-risk?limit=200&outline=1';
const WEATHER_URL = '/api/fire-weather';
const GEOCODE_URL = '/api/geocode';
const REFRESH_MS = 5 * 60_000;
// Shared with the globe's Fire Watch panel (src/ui/fireWatch.js).
const WATCH_KEY = 'gev.fire-watch.watched';

/** Where the location view gets its pictures. Both load in the reader's browser. */
const IMAGERY = Object.freeze({
  gibs: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
  cameras:
    'https://cameras.alertcalifornia.org/public-camera-data/all_cameras-v3.json',
  frames: 'https://cameras.alertcalifornia.org/public-camera-data/',
  radiusKm: 60,
  maxCameras: 3,
  width: 800,
  height: 560,
  days: 9,
  minFrameBytes: 12000,
  layers: {
    hls: {
      id: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
      label: '30 m detail',
    },
    viirs: {
      id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
      label: 'Daily (VIIRS)',
    },
    falseColour: {
      id: 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
      label: 'False colour',
    },
  },
  heat: 'VIIRS_SNPP_Thermal_Anomalies_375m_All',
});

const SORT_LABELS = {
  risk: 'Highest risk first',
  distance: 'Nearest first',
  exposure: 'Most exposed infrastructure first',
  newest: 'Newest first',
  size: 'Largest first',
};

const PART_LABELS = [
  ['hazard', 'Fire behaviour', '35%'],
  ['exposure', 'Infrastructure', '30%'],
  ['wind', 'Wind', '20%'],
  ['recency', 'Report freshness', '15%'],
];

const FLAG_TEXT = {
  'wind-unavailable': 'no wind data',
  'assets-unavailable': 'infrastructure data unavailable',
  'behaviour-unknown': 'fire behaviour not reported',
  'containment-unknown': 'containment not reported',
  'cost-unknown': 'cost not reported',
  'stale-perimeter': 'perimeter more than two days old',
  'no-geometry': 'no mapped perimeter',
};

const EVIDENCE_TEXT = {
  high: 'Well evidenced',
  medium: 'Partly evidenced',
  low: 'Poorly evidenced',
};

const WEATHER_COLOURS = {
  low: '#6fcf97',
  moderate: '#d6c84f',
  high: '#ff9f43',
  very_high: '#ff5e3a',
  extreme: '#d63cff',
};

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  goals: [...document.querySelectorAll('.goal')],
  placePanel: $('place-panel'),
  placeForm: $('place-form'),
  placeInput: $('place-input'),
  useLocation: $('use-location'),
  radius: $('radius'),
  placeChoices: $('place-choices'),
  placeNote: $('place-note'),
  weather: $('weather'),
  refine: $('refine'),
  refineCount: $('refine-count'),
  q: $('q'),
  state: $('state'),
  band: $('band'),
  acres: $('acres'),
  cont: $('cont'),
  sort: $('sort'),
  summary: $('summary'),
  clear: $('clear'),
  copyLink: $('copy-link'),
  download: $('download'),
  openGlobe: $('open-globe'),
  globeHome: $('globe-home'),
  flash: $('flash'),
  empty: $('empty'),
  results: $('results'),
};

let payload = null;
let waiting = null; // a refresh that arrived while a fire was open
let loadFailed = false;
let criteria = decodeCriteria(location.search);
let watched = readWatched();
let current = { rows: [], needsPlace: false };
const weather = { key: '', state: 'idle', card: null, message: '' };

/* ------------------------------------------------------------ helpers */

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function bands() {
  return Array.isArray(payload?.bands) && payload.bands.length
    ? payload.bands
    : DEFAULT_BANDS;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fillSelect(select, entries) {
  select.textContent = '';
  for (const [value, label] of entries) {
    const optionNode = make('option', '', label);
    optionNode.value = String(value);
    select.appendChild(optionNode);
  }
}

function number(value, digits = 0) {
  return finite(value)
    ? value.toLocaleString('en-US', {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      })
    : '';
}

/** "1 fire", "12 fires". */
function fireCount(count) {
  const word = count === 1 ? 'fire' : 'fires';
  return `${count.toLocaleString('en-US')} ${word}`;
}

function ago(ms) {
  if (!finite(ms)) return 'at an unknown time';
  const minutes = Math.max(0, (Date.now() - ms) / 60_000);
  if (minutes < 1.5) return 'just now';
  if (minutes < 90) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function ageText(hours) {
  if (!finite(hours)) return 'update time unknown';
  if (hours < 1)
    return `updated ${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `updated ${Math.round(hours)} h ago`;
  return `updated ${Math.round(hours / 24)} days ago`;
}

function safeColour(value) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)
    ? value
    : '#9aabba';
}

function flash(message) {
  el.flash.textContent = message;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    el.flash.textContent = '';
  }, 2500);
}

function readWatched() {
  try {
    return parseWatchlist(localStorage.getItem(WATCH_KEY));
  } catch {
    return new Set();
  }
}

function writeWatched() {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify([...watched]));
  } catch {
    /* private mode or a full quota: the list still works for this visit */
  }
}

/* ------------------------------------------------------------ controls */

function setUpControls() {
  fillSelect(
    el.radius,
    RADIUS_CHOICES_KM.map((km) => [km, `${km.toLocaleString('en-US')} km`]),
  );
  fillSelect(
    el.acres,
    ACRE_CHOICES.map((acres) => [
      acres,
      acres ? `${acres.toLocaleString('en-US')} acres or more` : 'Any size',
    ]),
  );
  fillSelect(
    el.cont,
    CONTAINED_CHOICES.map((pct) => [
      pct,
      pct ? `Hide fires ${pct}% or more contained` : 'Show all',
    ]),
  );
  fillSelect(
    el.sort,
    SORT_IDS.map((id) => [id, SORT_LABELS[id]]),
  );
}

/** Put the criteria into the controls, so a shared link shows what it set. */
function showCriteria() {
  for (const button of el.goals)
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.goal === criteria.goal),
    );
  el.placePanel.hidden = criteria.goal !== 'near';
  if (criteria.place && document.activeElement !== el.placeInput)
    el.placeInput.value = criteria.place.label ?? '';
  // A shared link may carry a distance the menu does not offer; show it once.
  if (
    ![...el.radius.options].some(
      (entry) => entry.value === String(criteria.radiusKm),
    )
  ) {
    const extra = make('option', '', `${criteria.radiusKm} km`);
    extra.value = String(criteria.radiusKm);
    el.radius.appendChild(extra);
  }
  el.radius.value = String(criteria.radiusKm);
  if (document.activeElement !== el.q) el.q.value = criteria.query;
  el.band.value = criteria.minBand;
  el.acres.value = String(
    ACRE_CHOICES.includes(criteria.minAcres) ? criteria.minAcres : 0,
  );
  el.cont.value = String(
    CONTAINED_CHOICES.includes(criteria.hideContainedPct)
      ? criteria.hideContainedPct
      : 0,
  );
  el.sort.value = criteria.sort;
  const count = refinementCount(criteria);
  el.refineCount.textContent = count ? `(${count} active)` : '';
  if (count) el.refine.open = true;
  el.clear.hidden = count === 0;
}

function showStates(zones) {
  const chosen = criteria.state;
  const entries = [['', 'All states']];
  for (const option of stateOptions(zones))
    entries.push([option.code, `${option.name} (${option.count})`]);
  if (chosen && !entries.some(([code]) => code === chosen))
    entries.push([chosen, `${stateName(chosen)} (0)`]);
  fillSelect(el.state, entries);
  el.state.value = chosen;
}

function update(next) {
  criteria = next;
  history.replaceState(
    null,
    '',
    `${location.pathname}${encodeCriteria(criteria)}${location.hash}`,
  );
  render();
  if (criteria.goal === 'near' && criteria.place) loadWeather(criteria.place);
}

function wireControls() {
  for (const button of el.goals) {
    button.addEventListener('click', () => {
      update(withGoal(criteria, button.dataset.goal));
      if (criteria.goal === 'near' && !criteria.place) el.placeInput.focus();
    });
  }
  el.q.addEventListener('input', () =>
    update({ ...criteria, query: el.q.value.trim().slice(0, 80) }),
  );
  el.state.addEventListener('change', () =>
    update({ ...criteria, state: el.state.value }),
  );
  el.band.addEventListener('change', () =>
    update({ ...criteria, minBand: el.band.value }),
  );
  el.acres.addEventListener('change', () =>
    update({ ...criteria, minAcres: Number(el.acres.value) || 0 }),
  );
  el.cont.addEventListener('change', () =>
    update({ ...criteria, hideContainedPct: Number(el.cont.value) || 0 }),
  );
  el.sort.addEventListener('change', () =>
    update({ ...criteria, sort: el.sort.value }),
  );
  el.radius.addEventListener('change', () =>
    update({ ...criteria, radiusKm: Number(el.radius.value) || 100 }),
  );
  el.clear.addEventListener('click', () => update(clearRefinements(criteria)));
  el.placeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    findPlace(el.placeInput.value);
  });
  el.useLocation.addEventListener('click', useMyLocation);
  el.copyLink.addEventListener('click', copyLink);
  el.download.addEventListener('click', downloadCsv);
}

/* -------------------------------------------------------------- places */

function shortLabel(label) {
  return String(label ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

function setPlace(place) {
  el.placeChoices.hidden = true;
  update({
    ...withGoal(criteria, 'near'),
    place,
    sort: criteria.goal === 'near' ? criteria.sort : 'distance',
  });
}

function placeNote(message) {
  el.placeNote.textContent = message;
  el.placeNote.hidden = !message;
}

async function findPlace(text) {
  const query = String(text ?? '').trim();
  if (!query) {
    placeNote(
      'Type a town, an address, or coordinates such as 40.59, -122.39.',
    );
    return;
  }
  const point = parseCoordinates(query);
  if (point) {
    placeNote('');
    setPlace({
      ...point,
      label: `${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}`,
    });
    return;
  }
  placeNote('Looking up the place…');
  let response;
  try {
    response = await fetch(
      `${GEOCODE_URL}?q=${encodeURIComponent(query.slice(0, 120))}`,
      {
        headers: { accept: 'application/json' },
      },
    );
  } catch {
    placeNote(
      'Place search could not be reached. Type coordinates instead, or use your location.',
    );
    return;
  }
  if (response.status === 401 || response.status === 403) {
    placeNote(
      'Place search needs you to be signed in. You can still type coordinates.',
    );
    return;
  }
  if (response.status === 429) {
    placeNote(
      'Too many place searches just now. Wait a minute, or type coordinates.',
    );
    return;
  }
  if (!response.ok) {
    placeNote(
      'Place search is unavailable on this server right now. Type coordinates instead, or use your location.',
    );
    return;
  }
  let results = [];
  try {
    const body = await response.json();
    results = (Array.isArray(body?.results) ? body.results : [])
      .map((result) => ({
        lat: result?.geometry?.location?.lat,
        lon: result?.geometry?.location?.lng,
        label: shortLabel(result?.formatted_address),
      }))
      .filter((place) => finite(place.lat) && finite(place.lon) && place.label)
      .slice(0, 5);
  } catch {
    results = [];
  }
  if (!results.length) {
    placeNote(
      `No place found for “${query}”. Add the state or country, or type coordinates.`,
    );
    return;
  }
  placeNote('');
  setPlace(results[0]);
  showChoices(results.slice(1));
}

function showChoices(others) {
  el.placeChoices.textContent = '';
  if (!others.length) {
    el.placeChoices.hidden = true;
    return;
  }
  el.placeChoices.appendChild(
    make('span', '', 'Not the right place? Other matches:'),
  );
  for (const place of others) {
    const button = make('button', '', place.label);
    button.type = 'button';
    button.addEventListener('click', () => setPlace(place));
    el.placeChoices.appendChild(button);
  }
  el.placeChoices.hidden = false;
}

function useMyLocation() {
  if (!navigator.geolocation) {
    placeNote(
      'This browser cannot share its location. Type a place or coordinates instead.',
    );
    return;
  }
  placeNote('Asking your browser for your location…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      placeNote('');
      setPlace({
        lat: Number(position.coords.latitude.toFixed(4)),
        lon: Number(position.coords.longitude.toFixed(4)),
        label: 'your location',
      });
    },
    () =>
      placeNote(
        'Your location is not available (permission refused or no fix). Type a place instead.',
      ),
    { timeout: 10_000, maximumAge: 300_000 },
  );
}

/* ------------------------------------------------------- fire weather */

async function loadWeather(place) {
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  if (weather.key === key && weather.state !== 'error') {
    drawWeather();
    return;
  }
  Object.assign(weather, { key, state: 'loading', card: null, message: '' });
  drawWeather();
  try {
    const response = await fetch(
      `${WEATHER_URL}?latitude=${place.lat.toFixed(4)}&longitude=${place.lon.toFixed(4)}`,
      { headers: { accept: 'application/json' } },
    );
    if (weather.key !== key) return;
    if (response.status === 401 || response.status === 403)
      throw new Error('Fire weather needs you to be signed in.');
    if (!response.ok)
      throw new Error(
        'Fire weather is unavailable right now. The fire list below is unaffected.',
      );
    const body = await response.json();
    const card = describeFireWeather(body?.assessment);
    if (!card) throw new Error('Fire weather is unavailable for this place.');
    Object.assign(weather, {
      state: 'ready',
      card,
      stale: body?.status === 'stale',
    });
  } catch (error) {
    if (weather.key !== key) return;
    Object.assign(weather, {
      state: 'error',
      message: error?.message || 'Fire weather is unavailable right now.',
    });
  }
  drawWeather();
}

function drawWeather() {
  const box = el.weather;
  box.textContent = '';
  if (criteria.goal !== 'near' || !criteria.place || weather.state === 'idle') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.style.setProperty(
    '--wx',
    weather.card ? WEATHER_COLOURS[weather.card.level] : 'var(--dim)',
  );
  box.appendChild(
    make('h3', '', `Fire weather near ${criteria.place.label}, next 24 hours`),
  );
  if (weather.state === 'loading') {
    box.appendChild(make('p', 'note', 'Checking the forecast…'));
    return;
  }
  if (weather.state === 'error') {
    box.appendChild(make('p', 'note', weather.message));
    return;
  }
  const card = weather.card;
  const level = make('p', 'wx-level');
  const gauge = make('span', 'wx-gauge');
  gauge.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i += 1)
    gauge.appendChild(make('i', i <= card.rank ? 'on' : ''));
  level.appendChild(gauge);
  level.appendChild(make('strong', '', card.label));
  box.appendChild(level);
  for (const line of card.lines) box.appendChild(make('p', '', line));
  if (card.redFlagHours)
    box.appendChild(
      make(
        'p',
        '',
        `${card.redFlagHours} of the next 24 hours meet red-flag-style humidity and wind thresholds.`,
      ),
    );
  box.appendChild(
    make(
      'p',
      'note',
      'Weather only: how easily a fire could start and spread here. It does not say whether anything is burning (that is the list below), and it is not an official fire-danger rating. Follow local warnings.' +
        (weather.stale
          ? ' This forecast is from the last successful check.'
          : ''),
    ),
  );
}

/* ---------------------------------------------------------------- list */

function render() {
  const zones = payload?.zones ?? [];
  const context = { now: Date.now(), bands: bands(), watched };
  current = findFires(zones, criteria, context);
  showCriteria();
  showStates(zones);
  drawStatus();
  drawWeather();

  for (const goal of GOAL_IDS) {
    const slot = document.querySelector(`[data-count="${goal}"]`);
    if (!slot) continue;
    if (!payload) {
      slot.textContent = '';
      continue;
    }
    const counted = findFires(zones, withGoal(criteria, goal), context);
    slot.textContent = counted.needsPlace
      ? 'choose a place'
      : fireCount(counted.rows.length);
  }

  if (!payload) {
    el.summary.textContent = loadFailed ? '' : 'Loading…';
    el.results.textContent = '';
    el.empty.hidden = !loadFailed;
    el.empty.textContent = loadFailed
      ? 'The live fire list is unavailable: the server could not reach the incident feed. It retries every five minutes.'
      : '';
    el.download.disabled = true;
    return;
  }

  el.summary.textContent = describeView(criteria, {
    shown: current.rows.length,
    total: zones.length,
    bands: bands(),
  });
  const hint = current.rows.length
    ? ''
    : emptyHint(criteria, { total: zones.length });
  el.empty.textContent = hint;
  el.empty.hidden = !hint;
  el.download.disabled = current.rows.length === 0;

  const view =
    criteria.place && criteria.goal === 'near'
      ? { point: criteria.place, altitudeM: placeAltitudeM(criteria.radiusKm) }
      : rowsView(current.rows);
  el.openGlobe.href = view
    ? globeLink(view.point, { altitudeM: view.altitudeM })
    : '/';
  el.openGlobe.textContent =
    criteria.goal === 'near' && criteria.place
      ? 'Open this place on the 3D map'
      : 'Open these on the 3D map';

  el.results.textContent = '';
  for (const entry of current.rows) el.results.appendChild(row(entry));
  openFromHash();
}

function drawStatus() {
  el.status.textContent = '';
  if (!payload) {
    el.status.textContent = loadFailed
      ? 'The live fire list is unavailable right now.'
      : 'Loading the live fire list…';
    return;
  }
  const parts = [
    `${number(payload.counts?.scored ?? payload.zones.length)} fires ranked`,
  ];
  parts.push(`list updated ${ago(payload.generatedAt)}`);
  const perimeters = payload.conditions?.perimeters;
  if (finite(perimeters?.fetchedAt))
    parts.push(`incident feed read ${ago(perimeters.fetchedAt)}`);
  if (payload.conditions?.wind?.status !== 'ok')
    parts.push('wind data unavailable');
  if (payload.stale || perimeters?.stale)
    parts.push('showing the last good list');
  if (payload.counts?.truncated)
    parts.push(`top ${number(payload.zones.length)} shown`);
  el.status.appendChild(document.createTextNode(parts.join(' · ')));
  if (waiting) {
    el.status.appendChild(document.createTextNode(' · newer data is ready'));
    const button = make('button', '', 'Update the list');
    button.type = 'button';
    button.addEventListener('click', () => {
      payload = waiting;
      waiting = null;
      render();
    });
    el.status.appendChild(button);
  }
}

function placeText(zone) {
  const code = stateCode(zone);
  const parts = [];
  if (zone.county)
    parts.push(
      /county|parish|borough/i.test(zone.county)
        ? zone.county
        : `${zone.county} County`,
    );
  if (code) parts.push(stateName(code));
  return parts.join(', ');
}

function metaText(entry) {
  const zone = entry.zone;
  const parts = [];
  const where = placeText(zone);
  if (where) parts.push(where);
  if (finite(zone.acres))
    parts.push(`${number(zone.acres, zone.acres < 10 ? 1 : 0)} acres`);
  if (finite(zone.containedPct))
    parts.push(`${Math.round(zone.containedPct)}% contained`);
  if (finite(entry.distanceKm))
    parts.push(
      `${number(entry.distanceKm, entry.distanceKm < 10 ? 1 : 0)} km away`,
    );
  parts.push(ageText(zone.ageHours));
  return parts.join(' · ');
}

function row(entry) {
  const zone = entry.zone;
  const item = make('li', 'row');
  item.dataset.id = String(zone.id ?? '');
  const details = document.createElement('details');
  const summary = document.createElement('summary');

  const band = make('span', 'band', String(zone.bandLabel ?? zone.band ?? '—'));
  band.style.setProperty('--band', safeColour(zone.bandColour));
  const score = make(
    'span',
    'score',
    finite(zone.score) ? String(Math.round(zone.score)) : '—',
  );
  score.setAttribute(
    'aria-label',
    `risk score ${finite(zone.score) ? Math.round(zone.score) : 'unknown'} of 100`,
  );
  const main = make('span', 'main');
  const name = make('span', 'name', String(zone.name ?? 'Unnamed fire'));
  const star = make('span', 'star', '★');
  star.setAttribute('aria-label', 'on your watchlist');
  star.hidden = !watched.has(zone.id);
  name.appendChild(star);
  main.appendChild(name);
  main.appendChild(make('span', 'meta', metaText(entry)));
  const reasons = Array.isArray(zone.reasons) ? zone.reasons : [];
  if (reasons.length)
    main.appendChild(make('span', 'why', reasons.slice(0, 2).join(' · ')));
  summary.append(band, score, main);
  details.appendChild(summary);

  const detail = make('div', 'detail');
  details.appendChild(detail);
  // Build the inside only when opened: a long list stays light.
  details.addEventListener('toggle', () => {
    if (details.open && !detail.childElementCount)
      fillDetail(zone, detail, star);
  });
  item.appendChild(details);
  return item;
}

function fillDetail(zone, detail, star) {
  const actions = make('div', 'row-actions');
  const watch = make('button', '', watched.has(zone.id) ? 'Unwatch' : 'Watch');
  watch.type = 'button';
  watch.addEventListener('click', () => {
    watched = toggleWatch(watched, zone.id);
    writeWatched();
    const on = watched.has(zone.id);
    watch.textContent = on ? 'Unwatch' : 'Watch';
    star.hidden = !on;
    flash(on ? 'Added to your watchlist' : 'Removed from your watchlist');
    refreshGoalCounts();
  });
  const locate = make('button', '', 'View location');
  locate.type = 'button';
  locate.addEventListener('click', () => {
    locate.hidden = true;
    locationView(zone, detail);
  });
  actions.append(watch, locate);
  if (zone.centroid && finite(zone.centroid.lat) && finite(zone.centroid.lon)) {
    const globe = make('a', '', 'Open on the 3D map');
    globe.href = globeLink(zone.centroid, { altitudeM: fireAltitudeM(zone) });
    actions.appendChild(globe);
  }
  detail.appendChild(actions);

  detail.appendChild(make('h3', '', 'Why this score'));
  const list = make('ul');
  for (const reason of Array.isArray(zone.reasons) ? zone.reasons : [])
    list.appendChild(make('li', '', String(reason)));
  detail.appendChild(list);

  detail.appendChild(
    make('h3', '', 'How the score is built (each part 0–100)'),
  );
  const parts = make('div', 'parts');
  for (const [key, label, weight] of PART_LABELS) {
    const part = make('div', 'part');
    const value = zone.components?.[key];
    part.appendChild(
      make('strong', '', finite(value) ? String(Math.round(value)) : '—'),
    );
    part.appendChild(document.createTextNode(`${label} · weight ${weight}`));
    parts.appendChild(part);
  }
  detail.appendChild(parts);

  const exposure = zone.exposureDetail;
  if (exposure) {
    const bits = [];
    bits.push(
      `${exposure.withinRadius ?? 0} datacenter or dam site${exposure.withinRadius === 1 ? '' : 's'} within 25 km`,
    );
    if (finite(exposure.nearestKm))
      bits.push(`nearest ${number(exposure.nearestKm, 1)} km`);
    if (exposure.downwind) bits.push(`${exposure.downwind} downwind`);
    detail.appendChild(make('p', '', `Infrastructure: ${bits.join(' · ')}.`));
  }
  if (zone.wind && finite(zone.wind.speedMs))
    detail.appendChild(
      make(
        'p',
        '',
        `Wind at the fire: ${number(zone.wind.speedMs, 1)} m/s (${number(zone.wind.speedMs * 3.6, 0)} km/h).`,
      ),
    );
  const missing = (Array.isArray(zone.flags) ? zone.flags : []).map(
    (flag) => FLAG_TEXT[flag] ?? String(flag).replace(/-/g, ' '),
  );
  detail.appendChild(
    make(
      'p',
      '',
      `${EVIDENCE_TEXT[zone.confidence] ?? 'Evidence unknown'}${missing.length ? `. Missing: ${missing.join(', ')}` : ''}. Risk index v${zone.riskVersion ?? payload?.riskVersion ?? '?'}.`,
    ),
  );
}

function refreshGoalCounts() {
  const zones = payload?.zones ?? [];
  const slot = document.querySelector('[data-count="watched"]');
  if (!slot || !payload) return;
  const counted = findFires(zones, withGoal(criteria, 'watched'), {
    now: Date.now(),
    bands: bands(),
    watched,
  });
  slot.textContent = fireCount(counted.rows.length);
}

let hashOpened = false;
function openFromHash() {
  if (hashOpened) return;
  const id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (!id) return;
  for (const item of el.results.querySelectorAll('li.row')) {
    if (item.dataset.id !== id) continue;
    hashOpened = true;
    const details = item.querySelector('details');
    if (details) details.open = true;
    item.scrollIntoView({ block: 'center' });
    return;
  }
}

/* ------------------------------------------------------- share, export */

async function copyLink() {
  const url = `${location.origin}${location.pathname}${encodeCriteria(criteria)}`;
  try {
    await navigator.clipboard.writeText(url);
    flash('Link copied');
  } catch {
    window.prompt('Copy this link:', url);
  }
}

function downloadCsv() {
  if (!payload || !current.rows.length) return;
  const csv = toCsv(current.rows, {
    generatedAt: payload.generatedAt,
    riskVersion: payload.riskVersion,
  });
  // The byte-order mark makes spreadsheet programs read the file as UTF-8.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const link = make('a');
  link.href = URL.createObjectURL(blob);
  link.download = csvFileName(criteria, Date.now());
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  flash(`Saved ${fireCount(current.rows.length)}`);
}

/* ------------------------------------------------------- the location view */

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function todayUtc() {
  return isoDay(new Date());
}

function shiftDay(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoDay(date);
}

function paddedBounds(zone) {
  const box = zone.bounds;
  if (!box) return null;
  const span = Math.max(box.east - box.west, box.north - box.south);
  const pad = Math.max(0.02, span * 0.35);
  return {
    west: box.west - pad,
    south: box.south - pad,
    east: box.east + pad,
    north: box.north + pad,
  };
}

function gibsUrl(bounds, day, layerId, format) {
  const box = [bounds.west, bounds.south, bounds.east, bounds.north]
    .map((value) => value.toFixed(5))
    .join(',');
  const params = [
    'SERVICE=WMS',
    'VERSION=1.1.1',
    'REQUEST=GetMap',
    `LAYERS=${encodeURIComponent(layerId)}`,
    'SRS=EPSG:4326',
    `BBOX=${box}`,
    `WIDTH=${IMAGERY.width}`,
    `HEIGHT=${IMAGERY.height}`,
    `FORMAT=${encodeURIComponent(format)}`,
    `TIME=${encodeURIComponent(day)}`,
  ];
  if (format === 'image/png') params.push('TRANSPARENT=TRUE');
  return `${IMAGERY.gibs}?${params.join('&')}`;
}

function outlinePoints(zone, bounds) {
  const ring = zone.outline;
  if (!Array.isArray(ring) || ring.length < 3) return '';
  return ring
    .map(([lon, lat]) => {
      const x =
        ((lon - bounds.west) / (bounds.east - bounds.west)) * IMAGERY.width;
      const y =
        ((bounds.north - lat) / (bounds.north - bounds.south)) * IMAGERY.height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function frameAge(seconds) {
  if (!finite(seconds)) return 'age unknown';
  const minutes = Math.max(0, Date.now() / 1000 - seconds) / 60;
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function distanceKmBetween(a, b) {
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

let cameraList = null;
let cameraListRequest = null;

function loadCameras() {
  if (cameraList) return Promise.resolve(cameraList);
  if (cameraListRequest) return cameraListRequest;
  cameraListRequest = fetch(IMAGERY.cameras, {
    headers: { accept: 'application/json' },
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((value) => {
      const features = Array.isArray(value?.features) ? value.features : [];
      const list = [];
      for (const feature of features) {
        const props = feature?.properties;
        const coords = feature?.geometry?.coordinates;
        if (
          !props ||
          !coords ||
          !Array.isArray(props.stream_ids) ||
          !props.stream_ids.length
        )
          continue;
        list.push({
          name: props.name || props.id,
          stream: props.stream_ids[0],
          lat: coords[1],
          lon: coords[0],
          lastFrame: props.last_frame_ts,
        });
      }
      cameraList = list;
      return list;
    })
    .catch(() => {
      cameraListRequest = null;
      return null;
    });
  return cameraListRequest;
}

function renderCameras(zone, list, host, note) {
  host.textContent = '';
  if (!zone.centroid) {
    note.textContent =
      'This fire has no published position, so nearby cameras cannot be found.';
    return;
  }
  if (!list) {
    note.textContent =
      'Live cameras are unavailable right now: the ALERTCalifornia camera list could not be read.';
    return;
  }
  const near = list
    .map((camera) => ({ camera, km: distanceKmBetween(zone.centroid, camera) }))
    .filter((entry) => entry.km <= IMAGERY.radiusKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, IMAGERY.maxCameras);
  if (!near.length) {
    note.textContent = `No ALERTCalifornia camera within ${IMAGERY.radiusKm} km. The live camera network covers California only.`;
    return;
  }
  note.textContent =
    'Live cameras near this fire. A camera points wherever its operator last left it, so it may not be looking at the fire. Frames update about every 15 seconds; © ALERTCalifornia, UC San Diego.';
  for (const { camera, km } of near) {
    const figure = make('figure', 'cam');
    const img = document.createElement('img');
    img.alt = `Live camera ${camera.name}, ${Math.round(km)} km from the fire`;
    img.loading = 'lazy';
    img.src = `${IMAGERY.frames}${encodeURIComponent(camera.stream)}/latest-frame.jpg?t=${Date.now()}`;
    const caption = document.createElement('figcaption');
    caption.appendChild(make('strong', '', String(camera.name)));
    caption.appendChild(
      make(
        'span',
        '',
        ` · ${Math.round(km)} km · ${frameAge(camera.lastFrame)}`,
      ),
    );
    figure.append(img, caption);
    host.appendChild(figure);
  }
}

function locationView(zone, host) {
  const bounds = paddedBounds(zone);
  const body = make('div', 'loc');
  const head = make('div', 'loc-head');
  head.append(
    make('span', 'loc-title', 'Look at the ground'),
    make('span', 'loc-sub', 'Satellite is the last pass, not live video.'),
  );
  body.appendChild(head);

  if (!bounds) {
    body.appendChild(
      make(
        'p',
        'sat-note',
        'This fire has no published perimeter, so there is nothing to frame.',
      ),
    );
    host.appendChild(body);
    return;
  }

  const sat = make('div', 'sat');
  const base = document.createElement('img');
  base.alt = '';
  base.loading = 'lazy';
  const heat = document.createElement('img');
  heat.alt = '';
  heat.hidden = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${IMAGERY.width} ${IMAGERY.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const points = outlinePoints(zone, bounds);
  if (points) {
    const polygon = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'polygon',
    );
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', '#ffd166');
    polygon.setAttribute('stroke-width', '2');
    polygon.setAttribute('vector-effect', 'non-scaling-stroke');
    polygon.setAttribute('points', points);
    svg.appendChild(polygon);
  }
  sat.append(base, heat, svg);
  body.appendChild(sat);

  const note = make('p', 'sat-note');
  body.appendChild(note);

  const controls = make('div', 'sat-controls');
  const previous = make('button', '', '←');
  previous.type = 'button';
  previous.setAttribute('aria-label', 'Previous day');
  const dayLabel = make('span', 'sat-date');
  const next = make('button', '', '→');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next day');
  const layer = document.createElement('select');
  layer.setAttribute('aria-label', 'Satellite layer');
  fillSelect(
    layer,
    Object.entries(IMAGERY.layers).map(([id, spec]) => [id, spec.label]),
  );
  const heatLabel = document.createElement('label');
  const heatBox = document.createElement('input');
  heatBox.type = 'checkbox';
  heatLabel.append(heatBox, make('span', '', 'Heat detections'));
  controls.append(previous, dayLabel, next, layer, heatLabel);
  body.appendChild(controls);

  const state = { day: shiftDay(todayUtc(), -1), layer: 'hls' };
  let request = 0;
  const oldestDay = () => shiftDay(todayUtc(), -IMAGERY.days);

  // A blank GIBS frame is a tiny uniform image (a few kilobytes); a frame with
  // ground in it is tens or hundreds. The size is a cheap "did a pass happen"
  // test, and CORS lets the page read it.
  function frameBytes(url) {
    return fetch(url, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => blob.size)
      .catch(() => -1); // if the check fails, show the frame rather than claim the day is empty
  }

  function draw(auto) {
    request += 1;
    const generation = request;
    const spec = IMAGERY.layers[state.layer];
    const requested = state.day;
    let day = requested;
    const oldest = oldestDay();

    function settle(found, blank) {
      if (generation !== request) return;
      state.day = found;
      base.src = gibsUrl(bounds, found, spec.id, 'image/jpeg');
      base.alt = `Satellite view of ${zone.name} on ${found}`;
      heat.src = gibsUrl(bounds, found, IMAGERY.heat, 'image/png');
      dayLabel.textContent = `${found} · ${spec.label}`;
      let message = `Latest pass for this spot on ${found}.`;
      if (blank)
        message = `No usable pass on ${requested} or in the ${IMAGERY.days} days before. Try the daily layer, or come back after the next pass.`;
      else if (found !== requested)
        message = `Newest usable pass: ${found} (${requested} and later days had none).`;
      note.textContent = `${message} A satellite sees this point once or twice a day and cloud can hide the ground; step back a day if the frame is blank. The yellow line is the official perimeter.`;
      previous.disabled = found <= oldest;
      next.disabled = found >= todayUtc();
      heat.hidden = !heatBox.checked;
    }

    function step() {
      frameBytes(gibsUrl(bounds, day, spec.id, 'image/jpeg')).then((size) => {
        if (generation !== request) return;
        if (size < 0 || size >= IMAGERY.minFrameBytes) {
          settle(day, false);
          return;
        }
        if (day <= oldest) {
          settle(day, true);
          return;
        }
        day = shiftDay(day, -1);
        step();
      });
    }

    if (auto) step();
    else settle(requested, false);
  }

  previous.addEventListener('click', () => {
    state.day = shiftDay(state.day, -1);
    draw(false);
  });
  next.addEventListener('click', () => {
    state.day = shiftDay(state.day, 1);
    draw(false);
  });
  layer.addEventListener('change', () => {
    state.layer = layer.value;
    draw(true);
  });
  heatBox.addEventListener('change', () => {
    heat.hidden = !heatBox.checked;
  });
  draw(true);

  const cams = make('div', 'cams');
  const camsNote = make(
    'p',
    'cam-note',
    'Looking for live cameras near this fire…',
  );
  body.append(camsNote, cams);
  const refresh = make('button', '', 'Refresh camera frames');
  refresh.type = 'button';
  refresh.addEventListener('click', () =>
    loadCameras().then((list) => renderCameras(zone, list, cams, camsNote)),
  );
  body.appendChild(refresh);
  loadCameras().then((list) => renderCameras(zone, list, cams, camsNote));

  const links = make('div', 'loc-links');
  if (zone.centroid && finite(zone.centroid.lat) && finite(zone.centroid.lon)) {
    const maps = make('a', '', 'Google Maps satellite');
    maps.href = `https://www.google.com/maps/@${zone.centroid.lat.toFixed(4)},${zone.centroid.lon.toFixed(4)},13z/data=!3m1!1e3`;
    maps.target = '_blank';
    maps.rel = 'noopener';
    links.appendChild(maps);
  }
  const alertLink = make('a', '', 'ALERTCalifornia cameras');
  alertLink.href = 'https://cameras.alertcalifornia.org/';
  alertLink.target = '_blank';
  alertLink.rel = 'noopener';
  links.appendChild(alertLink);
  body.appendChild(links);
  host.appendChild(body);
}

/* ------------------------------------------------------------- loading */

async function refreshList() {
  try {
    const response = await fetch(RISK_URL, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (!value || !Array.isArray(value.zones))
      throw new Error('malformed response');
    loadFailed = false;
    // Never pull the list out from under someone reading an open fire.
    if (payload && el.results.querySelector('details[open]')) {
      waiting = value;
      drawStatus();
      return;
    }
    payload = value;
    waiting = null;
    render();
  } catch {
    if (!payload) loadFailed = true;
    render();
  }
}

/** Start the page. Exported so tests can run it against a fake fetch. */
export function start() {
  setUpControls();
  wireControls();
  el.globeHome.href = globeLink(
    { lat: 39, lon: -98 },
    { altitudeM: 5_500_000 },
  );
  render();
  refreshList();
  if (criteria.goal === 'near' && criteria.place) loadWeather(criteria.place);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshList();
  });
  window.addEventListener('hashchange', () => {
    hashOpened = false;
    openFromHash();
  });
  setInterval(() => {
    if (!document.hidden) refreshList();
  }, REFRESH_MS);
}

if (!globalThis.__WILDFIRE_FINDER_NO_AUTOSTART__) start();
