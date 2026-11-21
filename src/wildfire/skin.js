/**
 * The wildfire skin.
 *
 * `/fire` is the same God's Eye View console, not a second application: one
 * scene, one camera, one set of panels. The skin only narrows the console to
 * the fire watch - a fire-only layer list, the fire layers already running, and
 * the rail panels this job does not need hidden.
 *
 * This module is deliberately pure. It answers "is this the skin?" and "is this
 * a layer the skin keeps?" without reading the document, the network or Cesium,
 * so the rules can be tested on their own. `src/app/wildfireSkin.js` applies
 * them to the live console.
 */

/** The one path that boots the skin. `/fire/` and `/fire` are the same entry. */
export const WILDFIRE_SKIN_PATH = '/fire';

/**
 * Layers the skin keeps available.
 *
 * Fires and their perimeters are the subject; wind is what the score reads and
 * what a reader needs to interpret direction; the two bundled asset packs are
 * the exposure the index actually counts. Everything else - aircraft, vessels,
 * satellites, traffic, CCTV, street level - is a different job.
 */
export const WILDFIRE_LAYER_IDS = Object.freeze([
  'fire-perimeters',
  'local-firms',
  'wind',
  'local-datacenters',
  'local-dams',
]);

/**
 * Layers the skin switches on by itself. The asset packs stay in the list for
 * context, but a national fire view is cleaner without 5,000 exposure points
 * drawn over it; the reader turns them on when the question is exposure.
 */
export const WILDFIRE_DEFAULT_LAYER_IDS = Object.freeze([
  'fire-perimeters',
  'local-firms',
  'wind',
]);

/** True for `/fire` and `/fire/` only. A deeper path is not the console. */
export function isWildfireSkin(pathname) {
  if (typeof pathname !== 'string') return false;
  const path = pathname.replace(/\/+$/, '') || '/';
  return path === WILDFIRE_SKIN_PATH;
}

/** True when a layer belongs in the wildfire layer list. */
export function isWildfireLayer(layerId) {
  return WILDFIRE_LAYER_IDS.includes(layerId);
}
