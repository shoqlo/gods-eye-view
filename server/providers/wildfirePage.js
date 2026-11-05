/**
 * Wildfire Watch finder at `/wildfire`: the front door of the hosted tool.
 *
 * One page that asks "what are you looking for?" and answers with a ranked,
 * explained list of fires, a fire-weather check for any place, a link to the
 * same view on the 3D globe, a shareable link and a CSV export. The globe at
 * `/` stays the power view; this page is where a person finds what to look at.
 *
 * Three documents are served from this route and nothing else:
 *
 *   /wildfire           the page (markup and styles, below)
 *   /wildfire/app.js    the page script, `src/wildfire/finderPage.js`
 *   /wildfire/finder.js the pure find-and-filter logic, `src/wildfire/finder.js`
 *
 * The scripts are real files served as ES modules, so the page runs under a
 * strict Content-Security-Policy (no inline script) and its logic is unit
 * tested in `src/wildfire/finder.test.mjs`. No build step: the files are read
 * once at startup and served as they are, in the dev and preview servers alike.
 *
 * What the page reads: `/api/fire-risk` (the ranked list), `/api/fire-weather`
 * and `/api/geocode` (the place check), and, in the reader's browser, NASA GIBS
 * satellite frames and ALERTCalifornia camera frames for the location view.
 * On the hosted stack all of it sits behind the login (`deploy/Caddyfile`).
 */

import { readFileSync } from 'node:fs';

const PAGE_PATH = '/wildfire';

const SCRIPTS = Object.freeze({
  '/app.js': new URL('../../src/wildfire/finderPage.js', import.meta.url),
  '/finder.js': new URL('../../src/wildfire/finder.js', import.meta.url),
});

/** The outside origins the location view loads imagery from. */
export const IMAGERY_ORIGINS = Object.freeze([
  'https://gibs.earthdata.nasa.gov',
  'https://cameras.alertcalifornia.org',
]);

/**
 * The page's own policy: scripts from this origin only, data from this origin
 * plus the two imagery hosts, no framing. Styles stay inline in the document.
 */
export const WILDFIRE_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${IMAGERY_ORIGINS.join(' ')}`,
  `connect-src 'self' ${IMAGERY_ORIGINS.join(' ')}`,
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const BAND_OPTIONS = [
  ['', 'Any band'],
  ['watch', 'Watch or above'],
  ['elevated', 'Elevated or above'],
  ['high', 'High or above'],
  ['critical', 'Critical only'],
];

const option = ([value, label]) => `<option value="${value}">${label}</option>`;

/**
 * The document. Everything dynamic is written by the script with
 * `textContent`, so no upstream string is ever parsed as markup.
 */
export const WILDFIRE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wildfire Watch</title>
<meta name="description" content="Find the wildfires that matter to you: ranked by how much attention they need, with fire weather for any place." />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230b1015'/%3E%3Cpath d='M16 6c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z' fill='%23ff8a3d'/%3E%3C/svg%3E" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1015;
    --ink: #e8eef4;
    --dim: #9aabba;
    --line: #223140;
    --card: #121a22;
    --card-2: #17212b;
    --accent: #5fb0ff;
    --fire: #ff8a3d;
    --ok: #6fcf97;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 1.25rem 1rem 3rem;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 54rem; margin: 0 auto; }
  a { color: var(--accent); }
  h1 { margin: 0; font-size: 1.5rem; letter-spacing: .01em; }
  h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
  h3 { margin: .75rem 0 .25rem; font-size: .9rem; }
  button, select, input { font: inherit; color: var(--ink); }
  .skip { position: absolute; left: -999px; }
  .skip:focus { left: 1rem; top: .5rem; background: var(--card); padding: .25rem .5rem; }
  .top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem 1rem; align-items: flex-end; }
  .lede { margin: .25rem 0 0; color: var(--dim); max-width: 38rem; }
  .top-links { display: flex; gap: .875rem; font-size: .875rem; }
  .status { margin: .75rem 0 1.25rem; color: var(--dim); font-size: .8125rem; font-variant-numeric: tabular-nums; }
  .status button { margin-left: .5rem; }
  section, .refine { margin-bottom: 1rem; }
  .goal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .5rem; }
  .goal {
    display: flex; flex-direction: column; align-items: flex-start; gap: .125rem;
    text-align: left; padding: .625rem .75rem; min-height: 5.25rem;
    background: var(--card); border: 1px solid var(--line); border-radius: .625rem; cursor: pointer;
  }
  .goal:hover { border-color: #35506a; }
  .goal[aria-pressed="true"] { border-color: var(--fire); background: #1d1610; box-shadow: inset 0 0 0 1px var(--fire); }
  .goal-title { font-weight: 650; line-height: 1.25; }
  .goal-hint { color: var(--dim); font-size: .75rem; line-height: 1.3; }
  .goal-count { margin-top: auto; font-size: .75rem; font-variant-numeric: tabular-nums; color: var(--fire); }
  .panel { padding: .875rem; background: var(--card); border: 1px solid var(--line); border-radius: .625rem; }
  .place-form label { display: block; font-size: .8125rem; color: var(--dim); margin-bottom: .25rem; }
  .place-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
  .place-row input { flex: 1 1 15rem; min-width: 0; }
  .place-row label { display: inline; margin: 0; }
  input, select { background: var(--card-2); border: 1px solid var(--line); border-radius: .375rem; padding: .5rem .625rem; }
  button {
    background: var(--card-2); border: 1px solid var(--line); border-radius: .375rem;
    padding: .45rem .75rem; cursor: pointer;
  }
  button:hover, button:focus-visible { border-color: var(--accent); }
  button.primary { background: #1c3550; border-color: #2d5b86; }
  .choices { display: flex; flex-wrap: wrap; gap: .375rem; margin: .25rem 0 .5rem; font-size: .8125rem; }
  .choices span { color: var(--dim); }
  .note { color: var(--dim); font-size: .8125rem; margin: .375rem 0 0; }
  .weather { margin-top: .75rem; padding: .75rem; border-radius: .5rem; background: var(--card-2); border-left: 4px solid var(--wx, var(--dim)); }
  .weather h3 { margin-top: 0; }
  .weather p { margin: .2rem 0; }
  .wx-level { display: flex; align-items: center; gap: .5rem; font-size: 1.05rem; }
  .wx-gauge { display: inline-flex; gap: 3px; }
  .wx-gauge i { width: 1.1rem; height: .5rem; border-radius: 2px; background: var(--line); }
  .wx-gauge i.on { background: var(--wx, var(--dim)); }
  .refine { border: 1px solid var(--line); border-radius: .625rem; background: var(--card); }
  .refine > summary { padding: .625rem .875rem; cursor: pointer; font-weight: 600; }
  .refine-count { color: var(--fire); font-weight: 600; }
  .refine-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .625rem .875rem; padding: 0 .875rem .25rem; }
  .refine-grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8125rem; color: var(--dim); }
  .refine .note { padding: 0 .875rem .75rem; }
  .bar { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; justify-content: space-between; margin: 1.25rem 0 .5rem; }
  .summary { margin: 0; font-weight: 600; }
  .actions { display: flex; flex-wrap: wrap; gap: .375rem; align-items: center; font-size: .875rem; }
  .actions a { padding: .45rem .25rem; }
  .flash { color: var(--ok); font-size: .8125rem; }
  .empty { color: var(--dim); padding: .75rem; border: 1px dashed var(--line); border-radius: .5rem; }
  .list { list-style: none; margin: 0; padding: 0; }
  .row { border: 1px solid var(--line); border-radius: .5rem; background: var(--card); }
  .row + .row { margin-top: .5rem; }
  .row summary { display: flex; align-items: baseline; gap: .625rem; padding: .625rem .75rem; cursor: pointer; list-style: none; }
  .row summary::-webkit-details-marker { display: none; }
  .row summary::marker { content: ""; }
  .row[open] summary, .row details[open] > summary { border-bottom: 1px solid var(--line); }
  .band { flex: 0 0 4.75rem; font-size: .6875rem; letter-spacing: .08em; font-weight: 700; color: var(--band, var(--dim)); }
  .score { flex: 0 0 1.75rem; text-align: right; font-variant-numeric: tabular-nums; font-weight: 650; }
  .main { min-width: 0; flex: 1; }
  .name { display: block; font-weight: 600; }
  .star { color: var(--fire); margin-left: .25rem; }
  .meta, .why { display: block; color: var(--dim); font-size: .8125rem; }
  .why { color: #c2cfda; }
  .detail { padding: .5rem .75rem .75rem; }
  .detail ul { margin: 0 0 .5rem; padding-left: 1.1rem; }
  .detail p { margin: 0 0 .3rem; font-size: .8125rem; color: var(--dim); }
  .row-actions { display: flex; flex-wrap: wrap; gap: .375rem; align-items: center; margin: .25rem 0 .5rem; font-size: .875rem; }
  .parts { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .375rem; margin: .25rem 0 .5rem; }
  .part { background: var(--card-2); border-radius: .375rem; padding: .375rem .5rem; font-size: .75rem; color: var(--dim); }
  .part strong { display: block; font-size: .95rem; color: var(--ink); font-variant-numeric: tabular-nums; }
  .loc { border-top: 1px dashed var(--line); padding-top: .75rem; margin-top: .5rem; }
  .loc-head { display: flex; flex-wrap: wrap; gap: .25rem .75rem; align-items: baseline; margin-bottom: .5rem; }
  .loc-title { font-weight: 600; }
  .loc-sub, .sat-note, .cam-note { color: var(--dim); font-size: .75rem; }
  .sat { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: .5rem; background: #05080b; aspect-ratio: 800 / 560; }
  .sat img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .sat svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .sat-note { margin: .375rem 0 .5rem; }
  .sat-controls { display: flex; flex-wrap: wrap; gap: .375rem; align-items: center; margin: 0 0 .5rem; }
  .sat-controls button, .sat-controls select { padding: .25rem .5rem; }
  .sat-controls button:disabled { color: var(--line); cursor: default; }
  .sat-date { font-size: .8125rem; font-variant-numeric: tabular-nums; }
  .sat-controls label { display: flex; gap: .25rem; align-items: center; font-size: .8125rem; color: var(--dim); }
  .cams { display: grid; gap: .5rem; margin: .5rem 0; }
  .cam { margin: 0; border: 1px solid var(--line); border-radius: .5rem; overflow: hidden; background: #0d141a; }
  .cam img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #05080b; }
  .cam figcaption { padding: .375rem .5rem; font-size: .75rem; color: var(--dim); }
  .cam figcaption strong { color: var(--ink); }
  .loc-links { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: .25rem; font-size: .8125rem; }
  .help { margin-top: 2.25rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .help ol { padding-left: 1.25rem; margin: 0 0 .75rem; }
  .help li { margin-bottom: .375rem; }
  .help details { border: 1px solid var(--line); border-radius: .5rem; background: var(--card); margin-bottom: .5rem; }
  .help summary { padding: .5rem .75rem; cursor: pointer; font-weight: 600; }
  .help details > div { padding: 0 .75rem .75rem; color: #c2cfda; font-size: .875rem; }
  .help table { border-collapse: collapse; width: 100%; font-size: .8125rem; }
  .help th, .help td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  .help dt { font-weight: 600; color: var(--ink); margin-top: .5rem; }
  .help dd { margin: .1rem 0 0; }
  footer { margin-top: 1.5rem; color: var(--dim); font-size: .8125rem; }
  footer p { margin: 0 0 .5rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  @media (max-width: 30rem) {
    body { padding: 1rem .75rem 2.5rem; }
    .band { flex-basis: 4rem; }
    .goal { min-height: 4.5rem; }
  }
</style>
</head>
<body>
<a class="skip" href="#results">Skip to the fire list</a>
<div class="wrap">
  <header class="top">
    <div>
      <h1>Wildfire Watch</h1>
      <p class="lede">Live US wildfires, ranked by how much attention they need, with a fire-weather check for any place you care about.</p>
    </div>
    <nav class="top-links" aria-label="Wildfire Watch">
      <a href="#help">How to use</a>
      <a id="globe-home" href="/">3D map</a>
    </nav>
  </header>
  <p class="status" id="status" role="status" aria-live="polite">Loading the live fire list&hellip;</p>

  <section aria-labelledby="goals-title">
    <h2 id="goals-title">What are you looking for?</h2>
    <div class="goal-grid" role="group" aria-labelledby="goals-title">
      <button type="button" class="goal" data-goal="attention" aria-pressed="true"><span class="goal-title">Fires that need attention</span><span class="goal-hint">Every burning fire, highest risk first</span><span class="goal-count" data-count="attention"></span></button>
      <button type="button" class="goal" data-goal="near" aria-pressed="false"><span class="goal-title">Fires near a place</span><span class="goal-hint">A town, an address or coordinates, with its fire weather</span><span class="goal-count" data-count="near"></span></button>
      <button type="button" class="goal" data-goal="assets" aria-pressed="false"><span class="goal-title">Fires near infrastructure</span><span class="goal-hint">A datacenter or dam within 25 km, or downwind</span><span class="goal-count" data-count="assets"></span></button>
      <button type="button" class="goal" data-goal="new" aria-pressed="false"><span class="goal-title">New fires</span><span class="goal-hint">Discovered in the last 3 days</span><span class="goal-count" data-count="new"></span></button>
      <button type="button" class="goal" data-goal="watched" aria-pressed="false"><span class="goal-title">My watchlist</span><span class="goal-hint">Fires you starred here or on the 3D map</span><span class="goal-count" data-count="watched"></span></button>
    </div>
  </section>

  <section class="panel" id="place-panel" aria-labelledby="place-title" hidden>
    <h2 id="place-title">Which place?</h2>
    <form id="place-form" class="place-form" role="search">
      <label for="place-input">A town, an address, or coordinates as latitude, longitude</label>
      <div class="place-row">
        <input id="place-input" type="search" autocomplete="off" maxlength="120" placeholder="e.g. Redding, CA   or   40.59, -122.39" />
        <button type="submit" class="primary">Find</button>
        <button type="button" id="use-location">Use my location</button>
      </div>
      <div class="place-row">
        <label for="radius">Show fires within</label>
        <select id="radius"></select>
      </div>
    </form>
    <div id="place-choices" class="choices" hidden></div>
    <p id="place-note" class="note" hidden></p>
    <article id="weather" class="weather" aria-live="polite" hidden></article>
  </section>

  <details class="refine" id="refine">
    <summary>Refine the list <span class="refine-count" id="refine-count"></span></summary>
    <div class="refine-grid">
      <label>Search a name, county or ID<input id="q" type="search" autocomplete="off" maxlength="80" placeholder="e.g. Park, Butte, CA-BTU" /></label>
      <label>State<select id="state"><option value="">All states</option></select></label>
      <label>Risk band<select id="band">${BAND_OPTIONS.map(option).join('')}</select></label>
      <label>Size<select id="acres"></select></label>
      <label>Containment<select id="cont"></select></label>
      <label>Order<select id="sort"></select></label>
    </div>
    <p class="note">How missing data is treated: a size filter hides fires with no reported size. The containment filter keeps fires that have no containment report, which is about half of them.</p>
  </details>

  <div class="bar">
    <p id="summary" class="summary" aria-live="polite"></p>
    <div class="actions">
      <button type="button" id="clear" hidden>Clear filters</button>
      <button type="button" id="copy-link">Copy link to this view</button>
      <button type="button" id="download">Download CSV</button>
      <a id="open-globe" href="/">Open on the 3D map</a>
      <span id="flash" class="flash" role="status"></span>
    </div>
  </div>
  <p id="empty" class="empty" hidden></p>
  <ul id="results" class="list" aria-label="Fires"></ul>

  <section id="help" class="help" aria-labelledby="help-title">
    <h2 id="help-title">How to use Wildfire Watch</h2>
    <ol>
      <li><strong>Pick what you are looking for</strong> at the top. Each choice sets a sensible filter and order, and the line above the list says exactly what you are seeing.</li>
      <li><strong>Narrow it down</strong> with <em>Refine the list</em> if you need to: a state, a risk band, a minimum size, or a name.</li>
      <li><strong>Open a fire</strong> to see why it scored as it did. From there you can watch it, look at the latest satellite frame and nearby cameras, or open it on the 3D map with its perimeter and the wind.</li>
    </ol>
    <p>The list refreshes every five minutes. <em>Copy link to this view</em> gives a colleague exactly what you see; <em>Download CSV</em> saves the list for a report or for analysis.</p>

    <details><summary>What the score means</summary><div>
      <p>Each burning fire gets a score from 0 to 100 for how much attention it warrants. It is built from four parts, each scored 0 to 100:</p>
      <table>
        <tr><th>Part</th><th>Weight</th><th>What it looks at</th></tr>
        <tr><td>Fire behaviour</td><td>35%</td><td>Reported behaviour, how much is still uncontained, and size</td></tr>
        <tr><td>Infrastructure</td><td>30%</td><td>Datacenters and dams within 25 km, and suppression cost per acre</td></tr>
        <tr><td>Wind</td><td>20%</td><td>Wind speed at the fire, and whether it blows toward infrastructure</td></tr>
        <tr><td>Report freshness</td><td>15%</td><td>How recently the perimeter was updated</td></tr>
      </table>
      <p>The bands: <strong>Critical</strong> 75 and above, <strong>High</strong> 60&ndash;74, <strong>Elevated</strong> 45&ndash;59, <strong>Watch</strong> 30&ndash;44, <strong>Low</strong> below 30. The scale is absolute: on a quiet day most fires are Low, and that is the honest answer. A part with no data scores zero, and each fire says which data was missing.</p>
    </div></details>

    <details><summary>Fire risk and fire weather: two different scales</summary><div>
      <p><strong>Fire risk</strong> (the bands on each fire, Low to Critical) is about a fire that is <em>already burning</em>: how much attention it needs now.</p>
      <p><strong>Fire weather</strong> (the card under a place, Low to Extreme) is about a <em>place</em>: how easily a fire could start and spread there in the next 24 hours, from humidity, temperature, wind and recent rain. It says nothing about whether anything is burning.</p>
      <p>They answer different questions and are never added together. A place can have Extreme fire weather and no fire at all.</p>
    </div></details>

    <details><summary>Glossary</summary><div><dl>
      <dt>Acres</dt><dd>The burned area reported for the fire. One acre is about 0.4 hectares; 1,000 acres is about 4 km&sup2;.</dd>
      <dt>Contained</dt><dd>The share of the fire's edge that crews have controlled. 100% contained fires are left out of the list.</dd>
      <dt>Perimeter</dt><dd>The mapped outline of the fire. It can be hours behind the real fire edge.</dd>
      <dt>Infrastructure nearby / downwind</dt><dd>Datacenters and dams within 25 km of the fire's centre, and those within 40 km in the direction the wind is blowing.</dd>
      <dt>Evidence</dt><dd>How much of the fire's record the score could use: well, partly or poorly evidenced. Two fires with the same score are not the same claim if one is poorly evidenced.</dd>
      <dt>Fire weather index</dt><dd>The Fosberg Fire Weather Index, 0 to 100, from temperature, humidity and wind.</dd>
      <dt>Red-flag-style hours</dt><dd>Hours with humidity at or below 15% and strong wind or gusts. Similar to the thresholds behind official Red Flag Warnings, but not an official warning.</dd>
    </dl></div></details>

    <details><summary>What this tool cannot tell you</summary><div>
      <ul>
        <li>It does not forecast where a fire will spread.</li>
        <li>It is not a life-safety tool. It does not replace an evacuation order or an official warning; follow your local authorities.</li>
        <li>The fire list covers US fires in the national incident feed only. Fire weather works anywhere.</li>
        <li>Infrastructure means datacenters and dams, not homes or people. A fire heading for a town with neither will score lower than it should.</li>
        <li>The wind comes from a coarse global model and cannot see valleys or slopes.</li>
      </ul>
    </div></details>

    <details><summary>Sharing, exporting and your watchlist</summary><div>
      <p><strong>Copy link to this view</strong> copies a link that opens the same choice, place and filters for anyone with a login. <strong>Download CSV</strong> saves the fires on screen, in screen order, with the index version and time on every row.</p>
      <p>Your <strong>watchlist</strong> is kept in this browser and is shared with the Fire Watch panel on the 3D map. It does not follow your login to another computer, and nobody else can see it.</p>
    </div></details>

    <details><summary>Where the data comes from</summary><div>
      <ul>
        <li>Fires and perimeters: National Interagency Fire Center (WFIGS), public domain.</li>
        <li>Wind for the score: NOAA GFS, public domain.</li>
        <li>Infrastructure: OpenStreetMap contributors (ODbL 1.0).</li>
        <li>Fire weather for a place: Open-Meteo (CC BY 4.0).</li>
        <li>Place search: OpenStreetMap Nominatim.</li>
        <li>Location view: NASA GIBS satellite frames and ALERTCalifornia cameras (UC San Diego), loaded directly by your browser.</li>
      </ul>
    </div></details>
  </section>

  <footer>
    <p>Wildfire Watch ranks where attention is warranted. It is not a fire-spread forecast and not a life-safety product. Follow official warnings and evacuation orders.</p>
  </footer>
</div>
<script type="module" src="/wildfire/app.js"></script>
</body>
</html>
`;

const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  // The document is static but the deployment may change under a saved link.
  'Cache-Control': 'no-store',
  'Content-Security-Policy': WILDFIRE_PAGE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
});

const SCRIPT_HEADERS = Object.freeze({
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
});

/** The page and its two scripts, on the dev and preview servers alike. */
export function wildfirePage({
  readScript = (url) => readFileSync(url, 'utf8'),
} = {}) {
  const scripts = Object.fromEntries(
    Object.entries(SCRIPTS).map(([path, url]) => [path, readScript(url)]),
  );

  function handler(req, res) {
    // `use('/wildfire')` also catches deeper paths; only the page and its two
    // scripts are served, everything else is a 404.
    const path = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET',
      });
      res.end('Method not allowed');
      return;
    }
    const head = req.method === 'HEAD';
    if (path === '/' || path === '') {
      res.writeHead(200, PAGE_HEADERS);
      res.end(head ? undefined : WILDFIRE_PAGE_HTML);
      return;
    }
    if (Object.hasOwn(scripts, path)) {
      res.writeHead(200, SCRIPT_HEADERS);
      res.end(head ? undefined : scripts[path]);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  return {
    name: 'wildfire-page',
    configureServer({ middlewares }) {
      middlewares.use(PAGE_PATH, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(PAGE_PATH, handler);
    },
  };
}

export const WILDFIRE_PAGE_PATH = PAGE_PATH;
