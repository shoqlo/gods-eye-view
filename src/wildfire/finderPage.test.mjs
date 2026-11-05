// The finder page end to end over happy-dom: the real markup from the server
// route, the real page script, and a fake fetch standing in for the APIs.
import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WILDFIRE_PAGE_HTML } from '../../server/providers/wildfirePage.js';
import { RISK_BANDS } from './risk.js';

const NOW = Date.now();
const DAY = 86_400_000;

const band = (id) => RISK_BANDS.find((entry) => entry.id === id);
const zone = (fields) => ({
  bandLabel: band(fields.band).label,
  bandColour: band(fields.band).colour,
  ageHours: 3,
  riskVersion: '1.0.0',
  confidence: 'medium',
  flags: [],
  components: { hazard: 40, exposure: 10, wind: 45, recency: 85 },
  ...fields,
});

const PAYLOAD = {
  generatedAt: NOW - 180_000,
  riskVersion: '1.0.0',
  bands: RISK_BANDS.map(({ id, label, min, colour }) => ({ id, label, min, colour })),
  counts: { scored: 3, returned: 3, truncated: false },
  conditions: { perimeters: { status: 'ok', fetchedAt: NOW - 120_000 }, wind: { status: 'ok' } },
  zones: [
    zone({
      id: 'park',
      name: 'Park Fire',
      state: 'US-CA',
      county: 'Butte',
      score: 81,
      band: 'critical',
      acres: 120000,
      containedPct: 12,
      discoveredAt: NOW - DAY,
      centroid: { lat: 39.95, lon: -121.8 },
      bounds: { west: -122.1, east: -121.5, south: 39.7, north: 40.2 },
      exposureDetail: { withinRadius: 2, downwind: 1, nearestKm: 9.4 },
      reasons: ['extreme behaviour', 'wind aimed at 1 asset'],
    }),
    zone({
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
      exposureDetail: { withinRadius: 0, downwind: 0, nearestKm: null },
      reasons: ['little containment'],
    }),
    zone({
      id: 'evil',
      name: '<img src=x onerror="globalThis.__pwned=1">',
      state: 'US-OR',
      county: 'Lane',
      score: 20,
      band: 'low',
      acres: 40,
      containedPct: 5,
      discoveredAt: NOW - 2 * DAY,
      centroid: { lat: 43.9, lon: -122.6 },
      exposureDetail: { withinRadius: 0, downwind: 0, nearestKm: null },
      reasons: ['no acute signal in the current record'],
    }),
  ],
};

const requests = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  requests.push(url);
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('/api/fire-risk')) return reply(PAYLOAD);
  if (url.startsWith('/api/fire-weather'))
    return reply({
      status: 'ready',
      assessment: {
        danger: 'very_high',
        peak_24h: { time: '2026-08-14T22:00:00.000Z', ffwi: 58.3 },
        red_flag_hours_24h: 3,
        drivers: ['humidity down to 11%', 'wind 38 km/h'],
      },
    });
  if (url.startsWith('/api/geocode'))
    return reply({
      status: 'ok',
      results: [
        {
          geometry: { location: { lat: 40.5865, lng: -122.3917 } },
          formatted_address: 'Redding, Shasta County, California, United States',
        },
        {
          geometry: { location: { lat: 38.1, lng: -122.1 } },
          formatted_address: 'Redding Street, Somewhere, California, United States',
        },
      ],
    });
  return reply({ error: 'not found' }, 404);
};
// The page refreshes on an interval; the test drives refreshes itself.
globalThis.setInterval = () => 0;

const body = WILDFIRE_PAGE_HTML.slice(
  WILDFIRE_PAGE_HTML.indexOf('<body>') + '<body>'.length,
  WILDFIRE_PAGE_HTML.indexOf('<script type="module"'),
);
document.body.innerHTML = body;
history.replaceState(null, '', '/wildfire?goal=near&place=Somewhere&lat=40.5865&lon=-122.3917&r=250');
localStorage.setItem('gev.fire-watch.watched', JSON.stringify(['smith']));

async function settle(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const text = (id) => document.getElementById(id).textContent;
const rows = () => [...document.querySelectorAll('#results li.row')];

await import('./finderPage.js');
await settle(() => rows().length > 0, 'the first list');

test('a shared "near a place" link opens on that place, nearest first, with its fire weather', async () => {
  assert.match(text('status'), /^3 fires ranked · list updated 3 min ago · incident feed read 2 min ago/);
  assert.equal(text('summary'), '2 of 3 fires · within 250 km of Somewhere · nearest first');
  assert.deepEqual(rows().map((row) => row.dataset.id), ['park', 'smith']);
  assert.equal(document.getElementById('place-panel').hidden, false);
  await settle(() => /Very high/.test(text('weather')), 'the weather card');
  assert.match(text('weather'), /Fire weather near Somewhere, next 24 hours/);
  assert.match(text('weather'), /Worst hour: 22:00 UTC/);
  assert.match(text('weather'), /3 of the next 24 hours meet red-flag-style/);
  assert.ok(requests.some((url) => url.startsWith('/api/fire-weather?latitude=40.5865&longitude=-122.3917')));
  assert.match(document.getElementById('open-globe').getAttribute('href'), /^\/#v=2&lat=40\.5865&lon=-122\.3917&.*&l=w\.2\.k$/);
});

test('each goal shows its count, and choosing one updates the list, the sentence and the link', () => {
  const count = (goal) => document.querySelector(`[data-count="${goal}"]`).textContent;
  assert.equal(count('attention'), '3 fires');
  assert.equal(count('assets'), '1 fire');
  assert.equal(count('new'), '2 fires');
  assert.equal(count('watched'), '1 fire');

  document.querySelector('[data-goal="assets"]').click();
  assert.deepEqual(rows().map((row) => row.dataset.id), ['park']);
  assert.equal(document.querySelector('[data-goal="assets"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.getElementById('place-panel').hidden, true);
  assert.match(location.search, /goal=assets/);

  document.querySelector('[data-goal="attention"]').click();
  assert.deepEqual(rows().map((row) => row.dataset.id), ['park', 'smith', 'evil']);
});

test('refining by state is reflected in the controls, the sentence and Clear', () => {
  const state = document.getElementById('state');
  assert.deepEqual([...state.options].map((option) => option.textContent), [
    'All states',
    'California (2)',
    'Oregon (1)',
  ]);
  state.value = 'OR';
  state.dispatchEvent(new Event('change'));
  assert.match(text('summary'), /^1 of 3 fires · Oregon/);
  assert.equal(document.getElementById('clear').hidden, false);
  assert.equal(text('refine-count'), '(1 active)');
  document.getElementById('clear').click();
  assert.equal(rows().length, 3);
  assert.equal(document.getElementById('clear').hidden, true);
});

test('fire names from the feed are shown as text, never run as markup', () => {
  const evil = rows().find((row) => row.dataset.id === 'evil');
  assert.equal(evil.querySelector('img'), null);
  assert.match(evil.querySelector('.name').textContent, /<img src=x/);
  assert.equal(globalThis.__pwned, undefined);
});

test('opening a fire explains the score and Watch updates the shared watchlist', () => {
  const park = rows().find((row) => row.dataset.id === 'park');
  const details = park.querySelector('details');
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  const detail = park.querySelector('.detail').textContent;
  assert.match(detail, /Why this score/);
  assert.match(detail, /extreme behaviour/);
  assert.match(detail, /Fire behaviour · weight 35%/);
  assert.match(detail, /2 datacenter or dam sites within 25 km · nearest 9\.4 km · 1 downwind/);
  assert.match(park.querySelector('.row-actions a').getAttribute('href'), /^\/#v=2&lat=39\.9500&lon=-121\.8000/);

  const watch = [...park.querySelectorAll('.row-actions button')].find((button) => button.textContent === 'Watch');
  watch.click();
  assert.deepEqual(JSON.parse(localStorage.getItem('gev.fire-watch.watched')).sort(), ['park', 'smith']);
  assert.equal(park.querySelector('.star').hidden, false);
  assert.equal(document.querySelector('[data-count="watched"]').textContent, '2 fires');
});

test('a background refresh never pulls the list out from under an open fire', async () => {
  // A fire is open from the previous test.
  const before = rows().length;
  document.dispatchEvent(new Event('visibilitychange'));
  await settle(() => /newer data is ready/.test(text('status')), 'the deferred refresh');
  assert.equal(rows().length, before);
  const button = document.querySelector('#status button');
  button.click();
  assert.doesNotMatch(text('status'), /newer data is ready/);
});

test('place search uses the first match and offers the others', async () => {
  document.querySelector('[data-goal="near"]').click();
  const input = document.getElementById('place-input');
  input.value = 'Redding';
  document.getElementById('place-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle(() => /Redding, Shasta County, California/.test(text('summary')), 'the geocoded place');
  assert.match(text('place-choices'), /Not the right place\? Other matches:Redding Street, Somewhere, California/);
  assert.match(location.search, /place=Redding%2C\+Shasta\+County%2C\+California/);

  input.value = '41.85, -123.9';
  document.getElementById('place-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle(() => /41\.850, -123\.900/.test(text('summary')), 'typed coordinates');
  assert.equal(rows()[0].dataset.id, 'smith');
});

test('Download CSV saves the list on screen', async () => {
  let saved = null;
  URL.createObjectURL = (blob) => {
    saved = blob;
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  document.querySelector('[data-goal="attention"]').click();
  document.getElementById('download').click();
  assert.ok(saved, 'a file was produced');
  const csv = await saved.text();
  assert.match(csv, /^﻿?rank,name,state/);
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(text('flash'), /Saved 3 fires/);
});
