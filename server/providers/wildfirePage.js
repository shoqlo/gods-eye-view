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
 * Where the location view gets its pictures.
 *
 * Both are public, keyless and fetched by the reader's browser, so the page
 * gains no server route and the deployment's public exemption stays at two
 * paths. It also means their availability is theirs, not ours: if NASA or
 * ALERTCalifornia is down, the list still works and the view says so.
 */
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
  .loc-open {
    font: inherit;
    font-size: .75rem;
    letter-spacing: .08em;
    font-weight: 700;
    color: var(--accent);
    background: none;
    border: 1px solid var(--line);
    border-radius: .375rem;
    padding: .375rem .625rem;
    margin: 0 0 .5rem;
    cursor: pointer;
  }
  .loc-open:hover, .loc-open:focus-visible { border-color: var(--accent); }
  .loc { border-top: 1px dashed var(--line); padding-top: .75rem; margin-top: .5rem; }
  .loc-head { display: flex; flex-wrap: wrap; gap: .25rem .75rem; align-items: baseline; margin-bottom: .5rem; }
  .loc-title { font-weight: 600; }
  .loc-sub, .sat-note, .cam-note { color: var(--dim); font-size: .75rem; }
  .sat {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: .5rem;
    background: #05080b;
    aspect-ratio: 800 / 560;
  }
  .sat img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .sat svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .sat-note { margin: .375rem 0 .5rem; }
  .sat-controls { display: flex; flex-wrap: wrap; gap: .375rem; align-items: center; margin: 0 0 .5rem; }
  .sat-controls button, .sat-controls select {
    font: inherit;
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: .375rem;
    padding: .25rem .5rem;
  }
  .sat-controls button { cursor: pointer; }
  .sat-controls button:disabled { color: var(--line); cursor: default; }
  .sat-date { font-size: .8125rem; font-variant-numeric: tabular-nums; }
  .sat-controls label { display: flex; gap: .25rem; align-items: center; font-size: .8125rem; color: var(--dim); }
  .cams { display: grid; gap: .5rem; margin: .5rem 0; }
  .cam { margin: 0; border: 1px solid var(--line); border-radius: .5rem; overflow: hidden; background: #0d141a; }
  .cam img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #05080b; }
  .cam figcaption { padding: .375rem .5rem; font-size: .75rem; color: var(--dim); }
  .cam figcaption strong { color: var(--ink); }
  .loc-links { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: .25rem; font-size: .8125rem; }
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
    <p>The location view loads satellite frames from NASA GIBS and live camera frames from ALERTCalifornia directly in your browser. Neither needs a key, and neither is proxied by this server. Satellite passes are hours to days old and cloud can hide the ground; cameras are live but cover California only and may be pointed elsewhere.</p>
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
  var IMAGERY = ${JSON.stringify(IMAGERY)};

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

  function isoDay(date) {
    return date.toISOString().slice(0, 10);
  }

  function todayUtc() {
    return isoDay(new Date());
  }

  function shiftDay(day, delta) {
    var date = new Date(day + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + delta);
    return isoDay(date);
  }

  function paddedBounds(zone) {
    var box = zone.bounds;
    if (!box) return null;
    var span = Math.max(box.east - box.west, box.north - box.south);
    var pad = Math.max(0.02, span * 0.35);
    return {
      west: box.west - pad,
      south: box.south - pad,
      east: box.east + pad,
      north: box.north + pad,
    };
  }

  function gibsUrl(bounds, day, layerId, format) {
    var box = [bounds.west, bounds.south, bounds.east, bounds.north]
      .map(function (value) {
        return value.toFixed(5);
      })
      .join(',');
    var params = [
      'SERVICE=WMS',
      'VERSION=1.1.1',
      'REQUEST=GetMap',
      'LAYERS=' + encodeURIComponent(layerId),
      'SRS=EPSG:4326',
      'BBOX=' + box,
      'WIDTH=' + IMAGERY.width,
      'HEIGHT=' + IMAGERY.height,
      'FORMAT=' + encodeURIComponent(format),
      'TIME=' + encodeURIComponent(day),
    ];
    if (format === 'image/png') params.push('TRANSPARENT=TRUE');
    return IMAGERY.gibs + '?' + params.join('&');
  }

  function outlinePoints(zone, bounds) {
    var ring = zone.outline;
    if (!ring || ring.length < 3) return '';
    var points = [];
    for (var index = 0; index < ring.length; index += 1) {
      var x =
        ((ring[index][0] - bounds.west) / (bounds.east - bounds.west)) *
        IMAGERY.width;
      var y =
        ((bounds.north - ring[index][1]) / (bounds.north - bounds.south)) *
        IMAGERY.height;
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return points.join(' ');
  }

  function distanceKm(a, b) {
    var radians = Math.PI / 180;
    var dLat = (b.lat - a.lat) * radians;
    var dLon = (b.lon - a.lon) * radians;
    var s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * radians) *
        Math.cos(b.lat * radians) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function frameAge(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds)) return 'age unknown';
    var minutes = Math.max(0, Date.now() / 1000 - seconds) / 60;
    if (minutes < 2) return 'just now';
    if (minutes < 60) return Math.round(minutes) + ' min ago';
    return Math.round(minutes / 60) + ' h ago';
  }

  var cameraList = null;
  var cameraListRequest = null;

  function loadCameras() {
    if (cameraList) return Promise.resolve(cameraList);
    if (cameraListRequest) return cameraListRequest;
    cameraListRequest = fetch(IMAGERY.cameras, {
      headers: { accept: 'application/json' },
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (value) {
        var features = value && Array.isArray(value.features) ? value.features : [];
        var list = [];
        for (var index = 0; index < features.length; index += 1) {
          var feature = features[index];
          var props = feature && feature.properties;
          var coords = feature && feature.geometry && feature.geometry.coordinates;
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
      .catch(function () {
        cameraListRequest = null;
        return null;
      });
    return cameraListRequest;
  }

  function renderCameras(zone, list, host, note) {
    host.textContent = '';
    if (!zone.centroid) {
      note.textContent =
        'This incident has no published position, so nearby cameras cannot be found.';
      return;
    }
    if (!list) {
      note.textContent =
        'Live cameras are unavailable right now: the ALERTCalifornia camera list could not be read.';
      return;
    }
    var near = [];
    for (var index = 0; index < list.length; index += 1) {
      var km = distanceKm(zone.centroid, list[index]);
      if (km <= IMAGERY.radiusKm) near.push({ camera: list[index], km: km });
    }
    near.sort(function (a, b) {
      return a.km - b.km;
    });
    near = near.slice(0, IMAGERY.maxCameras);
    if (!near.length) {
      note.textContent =
        'No ALERTCalifornia camera within ' +
        IMAGERY.radiusKm +
        ' km. The live camera network covers California only.';
      return;
    }
    note.textContent =
      'Live cameras near this fire. A camera points wherever its operator last left it, so it may not be looking at the fire. Frames updated about every 15 seconds; \u00a9 ALERTCalifornia, UC San Diego.';
    for (var entry = 0; entry < near.length; entry += 1) {
      var camera = near[entry].camera;
      var figure = document.createElement('figure');
      figure.className = 'cam';
      var img = document.createElement('img');
      img.alt =
        'Live camera ' +
        text(camera.name) +
        ', ' +
        Math.round(near[entry].km) +
        ' km from the fire';
      img.loading = 'lazy';
      img.src =
        IMAGERY.frames +
        encodeURIComponent(camera.stream) +
        '/latest-frame.jpg?t=' +
        Date.now();
      var caption = document.createElement('figcaption');
      var name = document.createElement('strong');
      name.textContent = text(camera.name);
      var line = document.createElement('span');
      line.textContent =
        ' \u00b7 ' +
        Math.round(near[entry].km) +
        ' km \u00b7 ' +
        frameAge(camera.lastFrame);
      caption.appendChild(name);
      caption.appendChild(line);
      figure.appendChild(img);
      figure.appendChild(caption);
      host.appendChild(figure);
    }
  }

  function locationView(zone, host) {
    var bounds = paddedBounds(zone);
    var body = document.createElement('div');
    body.className = 'loc';

    var head = document.createElement('div');
    head.className = 'loc-head';
    var title = document.createElement('span');
    title.className = 'loc-title';
    title.textContent = 'Look at the ground';
    var sub = document.createElement('span');
    sub.className = 'loc-sub';
    sub.textContent = 'Satellite is the last pass, not live video.';
    head.appendChild(title);
    head.appendChild(sub);
    body.appendChild(head);

    if (!bounds) {
      var none = document.createElement('p');
      none.className = 'sat-note';
      none.textContent =
        'This incident has no published perimeter, so there is nothing to frame.';
      body.appendChild(none);
      host.appendChild(body);
      return;
    }

    var sat = document.createElement('div');
    sat.className = 'sat';
    var base = document.createElement('img');
    base.alt = '';
    base.loading = 'lazy';
    var heat = document.createElement('img');
    heat.alt = '';
    heat.hidden = true;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + IMAGERY.width + ' ' + IMAGERY.height);
    svg.setAttribute('preserveAspectRatio', 'none');
    var polygon = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'polygon',
    );
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', '#ffd166');
    polygon.setAttribute('stroke-width', '2');
    polygon.setAttribute('vector-effect', 'non-scaling-stroke');
    var points = outlinePoints(zone, bounds);
    if (points) {
      polygon.setAttribute('points', points);
      svg.appendChild(polygon);
    }

    sat.appendChild(base);
    sat.appendChild(heat);
    sat.appendChild(svg);
    body.appendChild(sat);

    var note = document.createElement('p');
    note.className = 'sat-note';
    body.appendChild(note);

    var controls = document.createElement('div');
    controls.className = 'sat-controls';
    var previous = document.createElement('button');
    previous.type = 'button';
    previous.textContent = '\u2190';
    previous.setAttribute('aria-label', 'Previous day');
    var dayLabel = document.createElement('span');
    dayLabel.className = 'sat-date';
    var next = document.createElement('button');
    next.type = 'button';
    next.textContent = '\u2192';
    next.setAttribute('aria-label', 'Next day');
    var layer = document.createElement('select');
    layer.setAttribute('aria-label', 'Satellite layer');
    Object.keys(IMAGERY.layers).forEach(function (id) {
      var option = document.createElement('option');
      option.value = id;
      option.textContent = IMAGERY.layers[id].label;
      layer.appendChild(option);
    });
    var heatLabel = document.createElement('label');
    var heatBox = document.createElement('input');
    heatBox.type = 'checkbox';
    var heatText = document.createElement('span');
    heatText.textContent = 'Heat detections';
    heatLabel.appendChild(heatBox);
    heatLabel.appendChild(heatText);

    controls.appendChild(previous);
    controls.appendChild(dayLabel);
    controls.appendChild(next);
    controls.appendChild(layer);
    controls.appendChild(heatLabel);
    body.appendChild(controls);

    var state = { day: shiftDay(todayUtc(), -1), layer: 'hls' };
    var request = 0;

    function oldestDay() {
      return shiftDay(todayUtc(), -IMAGERY.days);
    }

    // A blank GIBS frame is a tiny uniform image (a few kilobytes); a frame
    // with ground in it is tens or hundreds. The size is therefore a cheap,
    // reliable "did a pass happen" test, and CORS lets the page read it.
    function frameBytes(url) {
      return fetch(url, { cache: 'force-cache' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.blob();
        })
        .then(function (blob) {
          return blob.size;
        })
        .catch(function () {
          // If the check itself fails, show the frame rather than claiming the
          // day is empty.
          return -1;
        });
    }

    function draw(auto) {
      request += 1;
      var generation = request;
      var spec = IMAGERY.layers[state.layer];
      var requested = state.day;
      var day = requested;
      var oldest = oldestDay();

      function settle(found, blank) {
        if (generation !== request) return;
        state.day = found;
        base.src = gibsUrl(bounds, found, spec.id, 'image/jpeg');
        base.alt = 'Satellite view of ' + text(zone.name) + ' on ' + found;
        heat.src = gibsUrl(bounds, found, IMAGERY.heat, 'image/png');
        dayLabel.textContent = found + ' \u00b7 ' + spec.label;

        var message = 'Latest pass for this spot on ' + found + '.';
        if (blank) {
          message =
            'No usable pass on ' +
            requested +
            ' in the last ' +
            IMAGERY.days +
            ' days. Try the daily layer, or come back after the next pass.';
        } else if (found !== requested) {
          message =
            'Newest usable pass: ' +
            found +
            ' (' +
            requested +
            ' and later days had none).';
        }
        note.textContent =
          message +
          ' A satellite sees this point once or twice a day and cloud can hide the ground; step back a day if the frame is blank.';

        previous.disabled = found <= oldest;
        next.disabled = found >= todayUtc();
        heat.hidden = !heatBox.checked;
      }

      function step() {
        var url = gibsUrl(bounds, day, spec.id, 'image/jpeg');
        frameBytes(url).then(function (size) {
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

    previous.addEventListener('click', function () {
      state.day = shiftDay(state.day, -1);
      draw(false);
    });
    next.addEventListener('click', function () {
      state.day = shiftDay(state.day, 1);
      draw(false);
    });
    layer.addEventListener('change', function () {
      state.layer = layer.value;
      draw(true);
    });
    heatBox.addEventListener('change', function () {
      heat.hidden = !heatBox.checked;
    });
    draw(true);

    var cams = document.createElement('div');
    cams.className = 'cams';
    var camsNote = document.createElement('p');
    camsNote.className = 'cam-note';
    camsNote.textContent = 'Looking for live cameras near this fire\u2026';
    body.appendChild(camsNote);
    body.appendChild(cams);

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'loc-open';
    refresh.textContent = 'Refresh frames';
    refresh.addEventListener('click', function () {
      loadCameras().then(function (list) {
        renderCameras(zone, list, cams, camsNote);
      });
    });
    body.appendChild(refresh);

    loadCameras().then(function (list) {
      renderCameras(zone, list, cams, camsNote);
    });

    var links = document.createElement('div');
    links.className = 'loc-links';
    if (
      zone.centroid &&
      isFinite(zone.centroid.lat) &&
      isFinite(zone.centroid.lon)
    ) {
      var maps = document.createElement('a');
      maps.href =
        'https://www.google.com/maps/@' +
        zone.centroid.lat.toFixed(4) +
        ',' +
        zone.centroid.lon.toFixed(4) +
        ',13z/data=!3m1!1e3';
      maps.target = '_blank';
      maps.rel = 'noopener';
      maps.textContent = 'Google Maps satellite';
      links.appendChild(maps);
    }
    var alertLink = document.createElement('a');
    alertLink.href = 'https://cameras.alertcalifornia.org/';
    alertLink.target = '_blank';
    alertLink.rel = 'noopener';
    alertLink.textContent = 'ALERTCalifornia cameras';
    links.appendChild(alertLink);
    body.appendChild(links);

    host.appendChild(body);
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
    item.dataset.id = text(zone.id);

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

    var locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'loc-open';
    locate.textContent = 'View location';
    locate.addEventListener('click', function () {
      locate.hidden = true;
      locationView(zone, detail);
    });
    detail.appendChild(locate);

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

  var hashOpened = false;

  function openFromHash() {
    if (hashOpened) return;
    var id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (!id) return;
    var items = list.querySelectorAll('li.row');
    for (var index = 0; index < items.length; index += 1) {
      if (items[index].dataset.id !== id) continue;
      hashOpened = true;
      var details = items[index].querySelector('details');
      if (details) details.open = true;
      // Changing the hash to a fire that is already open should scroll to it,
      // not build a second copy of the view.
      if (!items[index].querySelector('.loc')) {
        var button = items[index].querySelector('.loc-open');
        if (button) button.click();
      }
      items[index].scrollIntoView({ block: 'center' });
      return;
    }
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

    openFromHash();
  }

  function refresh() {
    fetch(ENDPOINT + '?limit=' + LIMIT + '&outline=1', {
      headers: { accept: 'application/json' },
    })
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
  window.addEventListener('hashchange', function () {
    hashOpened = false;
    openFromHash();
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
