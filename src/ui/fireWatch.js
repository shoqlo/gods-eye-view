/**
 * Wildfire Watch panel (`#fire-watch-panel`) in the left rail.
 *
 * Renders the ranked risk index from `/api/fire-risk`, one row per active
 * incident, with the reasons the engine gives for its score. Clicking FLY TO
 * FIRE frames that incident and turns on the fire-perimeter and wind layers,
 * so the number on the row and the shape on the globe are the same thing.
 *
 * Mounting rules this panel follows (docs/panel-surfaces.md):
 *   - it is a direct `[data-panel-id]` child of `#left-panel-stack`, so the
 *     existing layout owner measures and allocates it;
 *   - it mounts as soon as that rail exists, which can be after the tools phase
 *     of startup has returned, so the entry point waits for the rail instead of
 *     assuming it (see `initFireWatchPanel`);
 *   - it binds its own disclosure through `bindPanelDisclosure` and
 *     `collapsePanelOnEscape`, because `PanelChrome` only binds the panels
 *     present at startup;
 *   - it owns and disposes every listener, timer and DOM node it creates.
 *
 * The panel reads the index; it never computes a score itself. The arithmetic
 * lives in `src/wildfire/risk.js` and the aggregation in
 * `server/providers/fireRisk.js`.
 */

import * as Cesium from 'cesium';

import {
  bindPanelDisclosure,
  collapsePanelOnEscape,
} from './panelDisclosure.js';
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { guardCameraAboveGround } from '../cameraGroundGuard.js';
import { rangeForBoundingSphere } from '../data/cameraFraming.js';
import { formatNumber, msg, t, tn } from '../i18n/index.js';
import {
  BAND_ORDER,
  componentLine,
  evidenceLine,
  formatClock,
  formatCount,
  zoneMeta,
} from '../wildfire/display.js';

const PANEL_ID = 'fire-watch-panel';
const ENDPOINT = '/api/fire-risk';
const WATCH_STORAGE_KEY = 'gev.fire-watch.watched';
const REFRESH_MS = 5 * 60_000;
const REQUEST_LIMIT = 100;
/** One degree of latitude in kilometres; the framing radius uses it. */
const KM_PER_DEGREE = 111;

/** Filter choices, lowest band first. `null` means every band. */
const BAND_FILTERS = Object.freeze([
  { id: 'all', label: msg('All bands'), minBand: null },
  { id: 'watch', label: msg('Watch and above'), minBand: 'watch' },
  { id: 'elevated', label: msg('Elevated and above'), minBand: 'elevated' },
  { id: 'high', label: msg('High and above'), minBand: 'high' },
]);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

function readWatched(storage) {
  try {
    const raw = storage?.getItem(WATCH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id) => typeof id === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeWatched(storage, watched) {
  try {
    storage?.setItem(WATCH_STORAGE_KEY, JSON.stringify([...watched]));
  } catch {
    /* private mode or a full quota: the filter still works for this session */
  }
}

/**
 * Mount the panel into the left rail.
 *
 * The rail is built by the panel chrome, which can finish after the tools
 * phase of startup. Mounting straight into `#left-panel-stack` therefore raced
 * the chrome and, when the chrome was slower, produced no panel at all with no
 * error to show for it. The exported entry point waits for the rail; this
 * function is the one that needs it to exist already.
 *
 * @returns {object|null} controller with `destroy`, or null without a rail.
 */
function mountPanel({
  stack,
  viewer = null,
  dataManager = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  storage = globalThis.localStorage,
  documentRef = globalThis.document,
  intervalMs = REFRESH_MS,
}) {
  if (!stack) return null;
  documentRef.getElementById(PANEL_ID)?.remove();

  const state = {
    payload: null,
    error: null,
    loading: false,
    bandFilter: 'all',
    watchedOnly: false,
    watched: readWatched(storage),
    destroyed: false,
  };

  /* ------------------------------------------------------------------ DOM */

  const panel = el('section', 'panel-collapsible collapsed');
  panel.id = PANEL_ID;
  panel.dataset.panelId = PANEL_ID;

  const glow = el('div', 'panel-glow');

  const inner = el('div', 'fire-watch-inner');

  const header = el('div', 'panel-header');
  const title = el('span', 'panel-title', t('FIRE WATCH'));
  const divider = el('span', 'panel-divider');
  const collapseButton = el('button', 'panel-collapse-btn', '+');
  collapseButton.type = 'button';
  collapseButton.dataset.collapseTarget = PANEL_ID;
  collapseButton.setAttribute('aria-expanded', 'false');
  collapseButton.title = t('Expand Fire Watch');
  collapseButton.setAttribute('aria-label', t('Expand Fire Watch'));
  header.append(title, divider, collapseButton);

  const body = el('div', 'fire-watch-body');
  body.hidden = true;

  const posture = el('p', 'fire-watch-posture', t('Reading the live index…'));
  posture.setAttribute('role', 'status');
  posture.setAttribute('aria-live', 'polite');

  const conditions = el('p', 'fire-watch-conditions', '');

  const controls = el('div', 'fire-watch-controls');
  const bandSelect = el('select', 'fire-watch-select');
  bandSelect.id = 'fire-watch-band';
  bandSelect.setAttribute('aria-label', t('Minimum risk band'));
  for (const filter of BAND_FILTERS) {
    const option = el('option', null, t(filter.label));
    option.value = filter.id;
    bandSelect.append(option);
  }
  const watchedButton = el('button', 'fire-watch-chip', t('WATCHED'));
  watchedButton.type = 'button';
  watchedButton.setAttribute('aria-pressed', 'false');
  const refreshButton = el('button', 'fire-watch-chip', t('REFRESH'));
  refreshButton.type = 'button';
  controls.append(bandSelect, watchedButton, refreshButton);

  const list = el('div', 'fire-watch-list');
  list.setAttribute('aria-label', t('Ranked incidents'));

  const empty = el('p', 'fire-watch-empty', '');
  empty.hidden = true;

  const note = el(
    'p',
    'fire-watch-note',
    t(
      'Scores rank where attention is warranted. Not a spread forecast, and not a life-safety product.',
    ),
  );

  body.append(posture, conditions, controls, list, empty, note);
  inner.append(header, body);
  panel.append(glow, inner);

  // Sit directly under the DATA LAYERS launcher, which is where a fire watch
  // belongs: above the imagery panels, below the layer toggles people use first.
  const dataPanel = documentRef.getElementById('data-panel');
  if (dataPanel?.parentElement === stack) {
    stack.insertBefore(panel, dataPanel.nextSibling);
  } else {
    stack.prepend(panel);
  }

  /* ------------------------------------------------------------- disclosure */

  const setCollapsed = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    body.hidden = collapsed;
    collapseButton.textContent = collapsed ? '+' : '−';
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? t('Expand Fire Watch') : t('Collapse Fire Watch');
    collapseButton.title = label;
    collapseButton.setAttribute('aria-label', label);
  };

  const disclosure = bindPanelDisclosure({
    panel,
    buttons: [collapseButton],
    onChange: (collapsed) => setCollapsed(collapsed),
    onEscape: (event) =>
      collapsePanelOnEscape(event, {
        panel,
        onChange: (collapsed) => setCollapsed(collapsed),
      }),
  });

  /* ---------------------------------------------------------------- render */

  function visibleZones() {
    const zones = state.payload?.zones ?? [];
    const filter = BAND_FILTERS.find((entry) => entry.id === state.bandFilter);
    const floor = filter?.minBand
      ? BAND_ORDER.indexOf(filter.minBand)
      : BAND_ORDER.length - 1;
    return zones.filter((zone) => {
      const rank = BAND_ORDER.indexOf(zone.band);
      if (rank === -1 || rank > floor) return false;
      if (state.watchedOnly && !state.watched.has(zone.id)) return false;
      return true;
    });
  }

  function renderConditions() {
    const payload = state.payload;
    if (!payload) {
      conditions.textContent = '';
      return;
    }
    const wind = payload.conditions?.wind;
    const assets = payload.conditions?.assets;
    const perimeters = payload.conditions?.perimeters;
    const parts = [
      t('Wind {state}', {
        state: wind?.status === 'ok' ? t('live') : t('unavailable'),
      }),
      tn(perimeters?.rows ?? 0, '{count} perimeter', '{count} perimeters', {
        count: formatNumber(perimeters?.rows ?? 0),
      }),
      tn(assets?.total ?? 0, '{count} asset', '{count} assets', {
        count: formatNumber(assets?.total ?? 0),
      }),
      t('updated {time}', { time: formatClock(payload.generatedAt) }),
    ];
    if (payload.stale) parts.push(t('served from cache'));
    conditions.textContent = parts.join(' · ');
  }

  function renderPosture() {
    const payload = state.payload;
    if (!payload) {
      posture.textContent = state.error
        ? t('Risk index unavailable.')
        : t('Reading the live index…');
      return;
    }
    const counts = payload.counts ?? {};
    const atRisk =
      (counts.critical ?? 0) + (counts.high ?? 0) + (counts.elevated ?? 0);
    const scored = counts.scored ?? counts.returned ?? 0;
    const acres = counts.acres ?? 0;
    const parts = [
      // `count` in the values is the display text, so a grouped total still
      // picks the plural form the raw number calls for.
      tn(scored, '{count} incident', '{count} incidents', {
        count: formatNumber(scored),
      }),
      t('{count} at ELEVATED or above', { count: formatNumber(atRisk) }),
      tn(acres, '{count} acre', '{count} acres', {
        count: formatNumber(acres),
      }),
    ];
    const shown = visibleZones().length;
    if (shown !== (payload.zones?.length ?? 0)) {
      parts.push(t('{count} shown', { count: formatNumber(shown) }));
    }
    posture.textContent = parts.join(' · ');
  }

  function renderRow(zone) {
    const row = el('details', 'fire-watch-row');
    row.dataset.zoneId = zone.id ?? '';
    row.dataset.band = zone.band ?? 'low';

    const summary = el('summary', 'fire-watch-summary');
    // Band labels come from the engine as data, so they are translated here.
    const band = el('span', 'fire-watch-band', t(zone.bandLabel ?? '—'));
    band.style.setProperty('--band-colour', zone.bandColour ?? '#7c8b94');
    const score = el('span', 'fire-watch-score', formatCount(zone.score));
    const main = el('span', 'fire-watch-main');
    const name = el(
      'span',
      'fire-watch-name',
      zone.name ?? t('Unnamed incident'),
    );
    const meta = el('span', 'fire-watch-meta', zoneMeta(zone));
    main.append(name, meta);
    if (state.watched.has(zone.id)) {
      const star = el('span', 'fire-watch-star', '★');
      star.title = t('On your watch list');
      star.setAttribute('aria-label', t('On your watch list'));
      main.append(star);
    }
    summary.append(band, score, main);
    row.append(summary);

    const detail = el('div', 'fire-watch-detail');

    const reasons = el('ul', 'fire-watch-reasons');
    for (const reason of zone.reasons ?? [])
      reasons.append(el('li', null, reason));
    detail.append(reasons);

    detail.append(
      el('p', 'fire-watch-components', componentLine(zone.components)),
    );

    detail.append(el('p', 'fire-watch-evidence', evidenceLine(zone)));

    const actions = el('div', 'fire-watch-actions');
    const flyButton = el('button', 'fire-watch-chip', t('FLY TO FIRE'));
    flyButton.type = 'button';
    flyButton.disabled = !viewer || (!zone.centroid && !zone.bounds);
    flyButton.addEventListener('click', () => flyToZone(zone));

    const watchButton = el(
      'button',
      'fire-watch-chip',
      state.watched.has(zone.id)
        ? t('UNWATCH', { context: 'action' })
        : t('WATCH', { context: 'action' }),
    );
    watchButton.type = 'button';
    watchButton.setAttribute(
      'aria-pressed',
      String(state.watched.has(zone.id)),
    );
    watchButton.addEventListener('click', () => {
      if (!zone.id) return;
      if (state.watched.has(zone.id)) state.watched.delete(zone.id);
      else state.watched.add(zone.id);
      writeWatched(storage, state.watched);
      render();
    });

    actions.append(flyButton, watchButton);
    detail.append(actions);
    row.append(detail);
    return row;
  }

  function render() {
    if (state.destroyed) return;
    renderPosture();
    renderConditions();
    const zones = visibleZones();
    list.replaceChildren(...zones.map(renderRow));

    // One message area: a failure, an empty filter, or nothing at all.
    let message = null;
    if (state.error) message = state.error;
    else if (state.payload && !zones.length) {
      message = state.payload.zones?.length
        ? t('No incident meets this filter.')
        : t('No active incident in the current perimeter feed.');
    }
    empty.hidden = message === null;
    if (message !== null) empty.textContent = message;

    watchedButton.setAttribute('aria-pressed', String(state.watchedOnly));
    watchedButton.classList.toggle('is-active', state.watchedOnly);
    refreshButton.disabled = state.loading;
  }

  /* ----------------------------------------------------------------- flyTo */

  /**
   * Frame an incident the way the rest of the application flies: cancel any
   * outstanding arrival correction, orbit the target rather than falling
   * straight down onto it, and hand the camera to the ground guard once the
   * flight lands. A bare `Camera.flyTo` to a height leaves the pitch wherever
   * it was, which points at the horizon and shows the sky instead of the fire.
   */
  function flyToZone(zone) {
    if (!viewer) return;
    const bounds = zone.bounds ?? null;
    const centre = bounds
      ? {
          lat: (bounds.south + bounds.north) / 2,
          lon: (bounds.west + bounds.east) / 2,
        }
      : zone.centroid;
    if (!centre) return;

    cancelCameraArrival(viewer);
    // A fire's footprint is what has to fit in the viewport, so the sphere is
    // built from the outline and the range follows from its radius. Acres
    // stand in when the outline is missing, as an equivalent square.
    const radiusM = bounds
      ? Math.max(
          400,
          (Math.max(bounds.north - bounds.south, bounds.east - bounds.west) *
            KM_PER_DEGREE *
            1000) /
            2,
        )
      : Math.max(400, Math.sqrt(Math.max(1, zone.acres ?? 1) * 4046.86) / 2);
    let rangeM = radiusM * 3;
    try {
      const framed = rangeForBoundingSphere(viewer, radiusM);
      if (Number.isFinite(framed) && framed > 0)
        rangeM = Math.max(framed, radiusM * 1.5);
    } catch {
      /* keep the fallback range */
    }
    const offset = new Cesium.HeadingPitchRange(
      viewer.camera.heading || 0,
      Cesium.Math.toRadians(-55),
      Math.min(1_400_000, rangeM),
    );
    const target = Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0);
    try {
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(target, radiusM),
        {
          offset,
          duration: 2.2,
          complete: () => {
            try {
              guardCameraAboveGround(viewer, centre);
            } catch {
              /* the view is already set; a guard failure is not a blocker */
            }
          },
        },
      );
    } catch {
      return;
    }
    // The shape and the wind field are what make the score legible.
    for (const layerId of ['fire-perimeters', 'wind']) {
      try {
        Promise.resolve(dataManager?.setEnabled?.(layerId, true)).catch(
          () => {},
        );
      } catch {
        /* a layer the build does not ship must not block the fly-to */
      }
    }
  }

  /* ----------------------------------------------------------------- fetch */

  async function refresh() {
    if (state.destroyed || state.loading) return;
    state.loading = true;
    refreshButton.disabled = true;
    try {
      const response = await fetchImpl(`${ENDPOINT}?limit=${REQUEST_LIMIT}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.zones))
        throw new Error(t('malformed response'));
      if (state.destroyed) return;
      state.payload = payload;
      state.error = null;
    } catch (error) {
      if (state.destroyed) return;
      // Keep the last good index on screen: a dropped refresh should not blank
      // a picture the user is reading. The posture line says it is stale.
      const reason = error?.message || t('network error');
      state.error = state.payload
        ? t('Refresh failed ({reason}). Showing the last index.', { reason })
        : t('Risk index unavailable ({reason}).', { reason });
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      render();
    }
  }

  /* -------------------------------------------------------------- listeners */

  const onBandChange = () => {
    state.bandFilter = bandSelect.value;
    render();
  };
  bandSelect.addEventListener('change', onBandChange);

  const onWatchedToggle = () => {
    state.watchedOnly = !state.watchedOnly;
    render();
  };
  watchedButton.addEventListener('click', onWatchedToggle);

  const onRefresh = () => {
    void refresh();
  };
  refreshButton.addEventListener('click', onRefresh);

  const view = documentRef.defaultView;
  const onVisibility = () => {
    if (documentRef.hidden || !state.payload) return;
    const age = Date.now() - (state.payload.generatedAt ?? 0);
    if (age >= intervalMs) void refresh();
  };
  documentRef.addEventListener?.('visibilitychange', onVisibility);

  const timer = view?.setInterval
    ? view.setInterval(() => {
        if (!documentRef.hidden) void refresh();
      }, intervalMs)
    : null;

  setCollapsed(true);
  render();
  void refresh();

  return {
    panel,
    refresh,
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      if (timer !== null) view?.clearInterval?.(timer);
      documentRef.removeEventListener?.('visibilitychange', onVisibility);
      bandSelect.removeEventListener('change', onBandChange);
      watchedButton.removeEventListener('click', onWatchedToggle);
      refreshButton.removeEventListener('click', onRefresh);
      disclosure.destroy();
      panel.remove();
    },
  };
}

/**
 * Mount the Wildfire Watch panel once the left rail exists.
 *
 * @returns {{destroy: Function, refresh: Function, panel: HTMLElement|null}}
 *   a controller whose `destroy` also cancels a mount that has not happened
 *   yet, so an application that shuts down mid-startup leaves nothing behind.
 */
export function initFireWatchPanel(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  if (typeof documentRef?.getElementById !== 'function') return null;

  const findRail = () => documentRef.getElementById('left-panel-stack');
  const rail = findRail();
  if (rail) return mountPanel({ ...options, documentRef, stack: rail });

  // No rail yet: the chrome has not finished building it. Watch for it rather
  // than giving up, because giving up is what used to happen here.
  const Observer =
    documentRef.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const root = documentRef.body;
  if (!Observer || !root) return null;

  let controller = null;
  let observer = null;

  const settle = () => {
    const found = findRail();
    if (!found) return;
    observer?.disconnect();
    observer = null;
    controller = mountPanel({ ...options, documentRef, stack: found });
  };

  observer = new Observer(settle);
  observer.observe(root, { childList: true, subtree: true });
  // The rail may have appeared between the lookup above and the observe call.
  settle();

  return {
    get panel() {
      return controller?.panel ?? null;
    },
    refresh: (...args) => controller?.refresh?.(...args),
    destroy() {
      observer?.disconnect();
      observer = null;
      controller?.destroy();
      controller = null;
    },
  };
}
