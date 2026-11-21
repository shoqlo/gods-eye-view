/**
 * Apply the wildfire skin to the live console.
 *
 * The console is the original God's Eye View scene. This module only narrows
 * it: the fire layers are switched on, the unrelated ones off, the layer list
 * is filtered (in `ui/layerPanel.js`), and the panels this job does not need are
 * hidden by `ui/styles/wildfire-skin.css`. Nothing here builds a second UI.
 *
 * Kept out of `src/wildfire/skin.js` so the path and layer rules stay pure and
 * testable without Cesium or a document.
 */

import { t } from '../i18n/index.js';

import {
  WILDFIRE_DEFAULT_LAYER_IDS,
  isWildfireSkin,
} from '../wildfire/skin.js';

const NATIONAL_VIEW = Object.freeze({
  lon: -98,
  lat: 39,
  heightM: 4_500_000,
});

let installed = false;

/**
 * @param {{viewer?: object, dataManager?: object, styleManager?: object}} input
 * @returns {boolean} whether this page load is the wildfire skin
 */
export function installWildfireSkin({
  viewer,
  dataManager,
  styleManager,
} = {}) {
  if (installed) return true;
  if (!isWildfireSkin(globalThis.location?.pathname)) return false;
  installed = true;

  document.body.classList.add('skin-wildfire');
  document.documentElement.dataset.skin = 'wildfire';
  document.title = t("Wildfire Watch · God's Eye View");
  brandTheChrome();
  hideFirstRun();
  applyLayers(dataManager);

  // The state restore can re-enable saved layers and move the camera after
  // this runs. Re-apply once it settles, and once more after the loading
  // transition, so the skin wins without waiting on one fragile signal.
  const settle = () => {
    try {
      applyLayers(dataManager);
    } catch {
      /* Layer enforcement is best-effort; the camera still gets its move. */
    }
    setNationalView(viewer);
  };
  Promise.resolve(styleManager?.initialRestorePromise)
    .catch(() => null)
    .then(settle);
  setTimeout(settle, 4000);

  return true;
}

function brandTheChrome() {
  const brand = document.querySelector('#title-bar h1 span[translate="no"]');
  if (brand) {
    // Keep the two-tone title in any language: the phrase is translated as a
    // whole, and its last word takes the accent.
    const words = t('WILDFIRE WATCH').trim().split(/\s+/);
    const accentWord = words.pop() || '';
    brand.textContent = words.length ? `${words.join(' ')} ` : '';
    const accent = document.createElement('span');
    accent.className = 'title-accent';
    accent.textContent = accentWord;
    brand.appendChild(accent);
  }
  const subtitle = document.querySelector('#title-bar .subtitle');
  if (subtitle) {
    // This line belongs to the skin, not to the document translator: a locale
    // change must not paint the original subtitle back.
    subtitle.removeAttribute('data-i18n');
    subtitle.textContent = t('LIVE FIRE INTELLIGENCE');
  }
}

function hideFirstRun() {
  // The launcher offers aircraft, space and earthquakes. This console has one
  // job, and the fire layers are already on; showing it would be a menu of the
  // wrong things. `shouldShowFirstRun` also refuses on this path.
  const launcher = document.getElementById('first-run-launcher');
  if (launcher) launcher.hidden = true;
}

function applyLayers(dataManager) {
  const layers = dataManager?.layers;
  if (!layers?.keys || typeof dataManager?.setEnabled !== 'function') return;
  for (const id of layers.keys()) {
    const wanted = WILDFIRE_DEFAULT_LAYER_IDS.includes(id);
    const current = dataManager.isEnabled?.(id);
    if (current === wanted) continue;
    try {
      // A passive origin applies the skin's set without treating it as a
      // durable user choice, so visiting /fire does not rewrite the saved
      // layer state that the full console at `/` restores.
      void Promise.resolve(
        dataManager.setEnabled(id, wanted, { origin: 'skin' }),
      ).catch(() => null);
    } catch {
      /* A layer that cannot be switched is not a reason to fail the page. */
    }
  }
}

function setNationalView(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return;
  // Plain WGS84 geodetic-to-ECEF, so the skin does not depend on a particular
  // Cesium helper surviving a version bump. The camera only needs a position.
  const lon = (NATIONAL_VIEW.lon * Math.PI) / 180;
  const lat = (NATIONAL_VIEW.lat * Math.PI) / 180;
  const height = NATIONAL_VIEW.heightM;
  const e2 = 0.00669437999014;
  const n = 6378137 / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
  const x = (n + height) * Math.cos(lat) * Math.cos(lon);
  const y = (n + height) * Math.cos(lat) * Math.sin(lon);
  const z = (n * (1 - e2) + height) * Math.sin(lat);
  try {
    // A restore flight still in progress would overwrite this on its next
    // frame; the skin's framing is the destination, so end the flight first.
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: { x, y, z },
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  } catch {
    /* Cesium refusing a camera move leaves the scene usable. */
  }
}
