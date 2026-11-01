/**
 * Public, read-only Wildfire Watch page at `/wildfire`.
 *
 * The panel in `src/ui/fireWatch.js` lives inside the application, which is a
 * key broker: every `/api/*` route behind it can spend a configured provider
 * key. Sharing "the fire list" therefore cannot mean sharing the app. This is
 * the smallest thing that can be shared instead - one self-contained HTML
 * document that reads the same public index from `/api/fire-risk` and nothing
 * else.
 *
 * Deliberate limits, so the page stays a share and not a second product:
 *
 *   - One view: the ranking as the server returns it. No sort control, no
 *     watchlist, no globe, no fly-to.
 *   - Two controls only: a search field and a minimum band, because those are
 *     the two questions a reader with a fire in mind actually asks.
 *   - No imports and no build step. It is a string served as-is, so it cannot
 *     drag a Cesium chunk or a locale bundle onto a shared link.
 *   - Band thresholds are not duplicated here. The page counts and filters by
 *     band id, which is the engine's own vocabulary, and it asks the endpoint
 *     for a minimum band rather than inventing cut-offs.
 *
 * The page is only reachable without a login because the deployment says so:
 * `deploy/Caddyfile` exempts exactly `/wildfire` and `/api/fire-risk` from
 * basic_auth and requires it for everything else. Served by the app directly it
 * is simply another route.
 */

/** Band ids, most severe first. Ordering only: the thresholds live in risk.js. */
const BAND_IDS = Object.freeze([
  'critical',
  'high',
  'elevated',
  'watch',
  'low',
]);

/** Minimum-band choices. `null` means every band. */
const BAND_CHOICES = Object.freeze([
  { id: 'all', label: 'All bands', minBand: null },
  { id: 'watch', label: 'Watch and up', minBand: 'watch' },
  { id: 'elevated', label: 'Elevated and up', minBand: 'elevated' },
  { id: 'high', label: 'High and up', minBand: 'high' },
]);

const PAGE_PATH = '/wildfire';
const ENDPOINT = '/api/fire-risk';
const REQUEST_LIMIT = 100;
const REFRESH_MS = 5 * 60_000;

/**
 * The document. Everything dynamic is written by the script below with
 * `textContent`, so no upstream string is ever parsed as markup.
 */
export const WILDFIRE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wildfire Watch - every fire burning now</title>
<meta name="description" content="Every fire the live incident feed reports as burning now, ranked by how much attention it warrants." />
<meta name="robots" content="index, follow" />
<!-- Inline: a shared page that asks the server for a favicon would be the one
     request outside the public allowlist, and would show a broken icon plus a
     401 in the log for every visitor. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230b1015'/%3E%3Cpath d='M16 6c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z' fill='%234aa8ff'/%3E%3C/svg%3E" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1015;
    --ink: #e8eef4;
    --dim: #93a4b3;
    --line: #1e2a35;
    --card: #121a22;
    --accent: #4aa8ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 1.5rem 1rem 3rem;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 46rem; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; font-size: 1.4rem; letter-spacing: .01em; }
  .lede { margin: 0 0 .75rem; color: var(--dim); }
  .posture { margin: 0 0 1rem; font-variant-numeric: tabular-nums; }
  .controls { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  .controls input, .controls select {
    font: inherit;
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: .375rem;
    padding: .5rem .625rem;
  }
  .controls input { flex: 1 1 14rem; min-width: 0; }
  .controls select { flex: 0 1 auto; }
  .list { list-style: none; margin: 0; padding: 0; }
  .row { border: 1px solid var(--line); border-radius: .5rem; background: var(--card); }
  .row + .row { margin-top: .5rem; }
  .row summary {
    display: flex;
    align-items: baseline;
    gap: .625rem;
    padding: .625rem .75rem;
    cursor: pointer;
    list-style: none;
  }
  .row summary::-webkit-details-marker { display: none; }
  .row summary::marker { content: ""; }
  .band {
    flex: 0 0 auto;
    font-size: .6875rem;
    letter-spacing: .08em;
    font-weight: 700;
    color: var(--band, var(--dim));
  }
  .score {
    flex: 0 0 2rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .main { min-width: 0; }
  .name { display: block; font-weight: 600; }
  .meta { display: block; color: var(--dim); font-size: .8125rem; }
  .detail { border-top: 1px solid var(--line); padding: .625rem .75rem .75rem; }
  .detail ul { margin: 0 0 .5rem; padding-left: 1.1rem; }
  .detail li { margin-bottom: .25rem; }
  .detail p { margin: 0 0 .25rem; color: var(--dim); font-size: .8125rem; }
  .empty { color: var(--dim); }
  footer {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
    color: var(--dim);
    font-size: .8125rem;
  }
  footer p { margin: 0 0 .5rem; }
  a { color: var(--accent); }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Wildfire Watch</h1>
    <p class="lede">Every fire the live incident feed reports as burning now, ranked by how much attention it warrants. Read-only.</p>
    <p class="posture" id="posture" role="status" aria-live="polite">Reading the live index&hellip;</p>
  </header>

  <main>
    <div class="controls" role="search">
      <label class="sr-only" for="q">Search a fire, a state or an ID</label>
      <input id="q" type="search" autocomplete="off" placeholder="Search a fire, a state or an ID" />
      <label class="sr-only" for="band">Minimum risk band</label>
      <select id="band">
${BAND_CHOICES.map(
  (choice) => `        <option value="${choice.id}">${choice.label}</option>`,
).join('\n')}
      </select>
    </div>
    <p class="empty" id="empty" hidden></p>
    <ul class="list" id="list" aria-label="Ranked incidents"></ul>
  </main>

  <footer>
    <p>The score weighs four things: how the fire behaves and how much is uncontained, what critical assets are near it, what the wind is doing, and how current the perimeter is. Missing inputs are named on each row and lower its confidence.</p>
    <p>This is not a fire-spread forecast and not a life-safety product. It does not replace an evacuation order or an official warning.</p>
    <p>Sources: NIFC WFIGS current perimeters, NOAA GFS 10&nbsp;m wind, and OpenStreetMap contributors (ODbL 1.0) for the bundled datacenter and dam packs. Refreshes every five minutes.</p>
    <p><a href="/">Open the live globe</a> &mdash; sign-in required.</p>
  </footer>
</div>

<script>
(function () {
  'use strict';

  var ENDPOINT = ${JSON.stringify(ENDPOINT)};
  var LIMIT = ${REQUEST_LIMIT};
  var REFRESH_MS = ${REFRESH_MS};
  var BAND_IDS = ${JSON.stringify(BAND_IDS)};
  var BAND_CHOICES = ${JSON.stringify(
    BAND_CHOICES.map((choice) => ({
      id: choice.id,
      label: choice.label,
      minBand: choice.minBand,
    })),
  )};

  var list = document.getElementById('list');
  var posture = document.getElementById('posture');
  var empty = document.getElementById('empty');
  var search = document.getElementById('q');
  var band = document.getElementById('band');

  var payload = null;
  var error = null;

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function count(value) {
    return typeof value === 'number' && isFinite(value)
      ? Math.round(value).toLocaleString()
      : '\\u2014';
  }

  function acres(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    return (
      value.toLocaleString(undefined, {
        minimumFractionDigits: value < 10 ? 1 : 0,
        maximumFractionDigits: value < 10 ? 1 : 0,
      }) + ' ac'
    );
  }

  function age(hours) {
    if (typeof hours !== 'number' || !isFinite(hours)) return 'age unknown';
    if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' min';
    if (hours < 48) return Math.round(hours) + ' h';
    return Math.round(hours / 24) + ' d';
  }

  function meta(zone) {
    var parts = [];
    if (zone.state) parts.push(text(zone.state).replace('US-', ''));
    if (typeof zone.acres === 'number') parts.push(acres(zone.acres));
    if (typeof zone.containedPct === 'number')
      parts.push(Math.round(zone.containedPct) + '% contained');
    if (zone.behaviour) parts.push(zone.behaviour + ' behaviour');
    parts.push('updated ' + age(zone.ageHours) + ' ago');
    return parts.join(' \\u00b7 ');
  }

  function components(values) {
    var v = values || {};
    var dash = '\\u2014';
    return (
      'hazard ' + (v.hazard === undefined ? dash : v.hazard) +
      ' \\u00b7 exposure ' + (v.exposure === undefined ? dash : v.exposure) +
      ' \\u00b7 wind ' + (v.wind === undefined ? dash : v.wind) +
      ' \\u00b7 recency ' + (v.recency === undefined ? dash : v.recency)
    );
  }

  function evidence(zone) {
    var parts = ['Risk index v' + text(zone.riskVersion || '\\u2014')];
    parts.push(
      zone.confidence === 'high'
        ? 'well evidenced'
        : zone.confidence === 'medium'
          ? 'partly evidenced'
          : 'poorly evidenced',
    );
    (zone.flags || []).forEach(function (flag) {
      parts.push(String(flag).replace(/-/g, ' '));
    });
    return parts.join(' \\u00b7 ');
  }

  function minimumBand() {
    for (var i = 0; i < BAND_CHOICES.length; i += 1) {
      if (BAND_CHOICES[i].id === band.value) return BAND_CHOICES[i].minBand;
    }
    return null;
  }

  function visible() {
    var zones = payload && payload.zones ? payload.zones : [];
    var query = search.value.trim().toLowerCase();
    var floor = BAND_IDS.length - 1;
    var min = minimumBand();
    if (min) floor = BAND_IDS.indexOf(min);
    return zones.filter(function (zone) {
      var rank = BAND_IDS.indexOf(zone.band);
      if (rank === -1 || rank > floor) return false;
      if (!query) return true;
      var hay = [zone.name, zone.state, zone.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.indexOf(query) !== -1;
    });
  }

  function row(zone) {
    var item = document.createElement('li');
    item.className = 'row';

    var details = document.createElement('details');
    var summary = document.createElement('summary');

    var bandLabel = document.createElement('span');
    bandLabel.className = 'band';
    bandLabel.textContent = text(zone.bandLabel || '\\u2014');
    bandLabel.style.setProperty('--band', zone.bandColour || '#93a4b3');

    var score = document.createElement('span');
    score.className = 'score';
    score.textContent = count(zone.score);

    var main = document.createElement('span');
    main.className = 'main';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = text(zone.name || 'Unnamed incident');
    var line = document.createElement('span');
    line.className = 'meta';
    line.textContent = meta(zone);
    main.appendChild(name);
    main.appendChild(line);

    summary.appendChild(bandLabel);
    summary.appendChild(score);
    summary.appendChild(main);
    details.appendChild(summary);

    var detail = document.createElement('div');
    detail.className = 'detail';
    var reasons = document.createElement('ul');
    (zone.reasons || []).forEach(function (reason) {
      var entry = document.createElement('li');
      entry.textContent = text(reason);
      reasons.appendChild(entry);
    });
    detail.appendChild(reasons);

    var math = document.createElement('p');
    math.textContent = components(zone.components);
    detail.appendChild(math);

    var flags = document.createElement('p');
    flags.textContent = evidence(zone);
    detail.appendChild(flags);

    details.appendChild(detail);
    item.appendChild(details);
    return item;
  }

  function render() {
    var zones = visible();
    list.textContent = '';

    if (payload && payload.zones) {
      var counted = payload.counts && payload.counts.scored;
      var total = typeof counted === 'number' ? counted : payload.zones.length;
      var parts = [count(total) + (total === 1 ? ' incident' : ' incidents')];
      if (typeof payload.counts.acres === 'number')
        parts.push(count(payload.counts.acres) + ' acres');
      if (zones.length !== payload.zones.length)
        parts.push(count(zones.length) + ' shown');
      if (payload.stale) parts.push('served from cache');
      posture.textContent = parts.join(' \\u00b7 ');
    } else if (error) {
      posture.textContent = 'The live index is unavailable. Reload to try again.';
    }

    BAND_CHOICES.forEach(function (choice, index) {
      var option = band.options[index];
      if (!option) return;
      if (!payload || !payload.zones) {
        option.textContent = choice.label;
        return;
      }
      var floor = BAND_IDS.length - 1;
      if (choice.minBand) floor = BAND_IDS.indexOf(choice.minBand);
      var n = payload.zones.filter(function (zone) {
        var rank = BAND_IDS.indexOf(zone.band);
        return rank !== -1 && rank <= floor;
      }).length;
      option.textContent = choice.label + ' \\u2014 ' + count(n);
    });

    var message = '';
    if (error) message = error;
    else if (payload && payload.zones && !zones.length) {
      message = payload.zones.length
        ? 'No incident meets this filter. Clear the search or widen the band.'
        : 'No active incident in the current perimeter feed.';
    }
    empty.textContent = message;
    empty.hidden = !message;

    zones.forEach(function (zone) {
      list.appendChild(row(zone));
    });
  }

  function refresh() {
    fetch(ENDPOINT + '?limit=' + LIMIT, { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (value) {
        if (!value || !Array.isArray(value.zones))
          throw new Error('malformed response');
        payload = value;
        error = null;
        render();
      })
      .catch(function () {
        error = payload
          ? 'Refresh failed. Showing the last index.'
          : 'The live index is unavailable (the server could not reach the incident feed).';
        render();
      });
  }

  search.addEventListener('input', render);
  band.addEventListener('change', render);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });
  setInterval(function () {
    if (!document.hidden) refresh();
  }, REFRESH_MS);

  render();
  refresh();
})();
</script>
</body>
</html>
`;

/** The page, with the no-store and framing headers a shared link needs. */
export function wildfirePage() {
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

function handler(req, res) {
  // `use('/wildfire')` also catches `/wildfire/anything`; only the page itself
  // is served, so a deep path is a 404 rather than the same document.
  const path = (req.url || '/').split('?')[0];
  if (path !== '/' && path !== '') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET',
    });
    res.end('Method not allowed');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // The document is static but the deployment may change under a shared link,
    // and a stale copy would point at an endpoint that moved.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(req.method === 'HEAD' ? undefined : WILDFIRE_PAGE_HTML);
}

export const WILDFIRE_PAGE_PATH = PAGE_PATH;
