/**
 * Presentation helpers for the wildfire risk index.
 *
 * Kept away from `src/ui/fireWatch.js` on purpose: that module imports Cesium
 * for the fly-to, and these are the rules a test should be able to check
 * without a scene. Nothing here reads the DOM, the network or the clock.
 *
 * Copy is translated here rather than in the panel, because the panel would
 * otherwise have to rebuild whole sentences out of fragments. `t()` runs at
 * call time, never at module load, so the reader's locale is the one that is
 * already active when the row is drawn.
 */

import { formatDate, formatNumber, msg, t, tn } from '../i18n/index.js';

/**
 * Keys for the engine's `flags`. The English is the message key, marked with
 * `msg()`; `evidenceLine` translates it at render.
 */
export const FLAG_LABELS = Object.freeze({
  'wind-unavailable': msg('no wind field'),
  'assets-unavailable': msg('asset pack unavailable'),
  'behaviour-unknown': msg('behaviour not published'),
  'containment-unknown': msg('containment not published'),
  'cost-unknown': msg('cost not published'),
  'stale-perimeter': msg('perimeter stale'),
  'no-geometry': msg('no perimeter outline'),
});

/** Keys for the engine's `confidence`, translated by `evidenceLine`. */
export const CONFIDENCE_LABELS = Object.freeze({
  high: msg('well evidenced'),
  medium: msg('partly evidenced'),
  low: msg('poorly evidenced'),
});

/** Bands from most to least severe; the order the filter compares against. */
export const BAND_ORDER = Object.freeze([
  'critical',
  'high',
  'elevated',
  'watch',
  'low',
]);

/** Thousands-separated integer, or an em dash for anything not finite. */
export function formatCount(value) {
  return Number.isFinite(value) ? formatNumber(Math.round(value)) : '—';
}

/**
 * A single incident's size. Small fires keep one decimal: the feed carries
 * incidents well under an acre, and rounding 0.48 to "0 ac" would read as no
 * fire at all. Totals use `formatCount` instead, where the rounding is noise.
 */
export function formatAcres(acres) {
  if (!Number.isFinite(acres)) return '—';
  // Both the grouping and the decimal mark follow the active locale: "1,200"
  // reads as one and a fifth to a Spanish reader.
  return formatNumber(
    acres,
    acres < 10
      ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
      : { maximumFractionDigits: 0 },
  );
}

/**
 * Compact age from hours: "20 min", "6 h", "4 d".
 *
 * The unit is translated, the number is not: Spanish and Chinese write the
 * same count with a different word, and leaving "d" in an otherwise Spanish
 * line reads as a bug rather than as data.
 */
export function formatAge(hours) {
  if (!Number.isFinite(hours)) return t('age unknown');
  if (hours < 1) {
    return t('{value} min', { value: Math.max(1, Math.round(hours * 60)) });
  }
  if (hours < 48) return t('{value} h', { value: Math.round(hours) });
  return t('{value} d', { value: Math.round(hours / 24) });
}

/** Local clock time for an epoch value, or a neutral phrase. */
export function formatClock(epochMs) {
  if (!Number.isFinite(epochMs)) return t('unknown time');
  try {
    // The application's locale, not the browser's: a reader who chose Spanish
    // should not get a time formatted by whatever the OS is set to.
    return formatDate(epochMs, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return t('unknown time');
  }
}

/**
 * One line describing an incident, built only from the fields that are
 * present. A missing field is omitted rather than shown as "unknown", because
 * four "unknown"s in a row tell the reader less than three real facts.
 */
export function zoneMeta(zone) {
  if (!zone) return '';
  const parts = [];
  if (zone.state) parts.push(String(zone.state).replace('US-', ''));
  if (Number.isFinite(zone.acres)) {
    // The perimeter card already owns the "{acres} ac" message; reusing it
    // keeps one translation for one unit rather than two.
    parts.push(
      tn(zone.acres, '{acres} ac', '{acres} ac', {
        acres: formatAcres(zone.acres),
      }),
    );
  }
  if (Number.isFinite(zone.containedPct)) {
    parts.push(
      t('{percent}% contained', { percent: Math.round(zone.containedPct) }),
    );
  }
  if (zone.behaviour) {
    parts.push(t('{behaviour} behaviour', { behaviour: zone.behaviour }));
  }
  parts.push(t('updated {age} ago', { age: formatAge(zone.ageHours) }));
  return parts.join(' · ');
}

/** The four component scores as one line. */
export function componentLine(components) {
  const value = components ?? {};
  return [
    t('hazard {value}', { value: value.hazard ?? '—' }),
    t('exposure {value}', { value: value.exposure ?? '—' }),
    t('wind {value}', { value: value.wind ?? '—' }),
    t('recency {value}', { value: value.recency ?? '—' }),
  ].join(' · ');
}

/** Engine version, evidence confidence and every missing-input flag. */
export function evidenceLine(zone) {
  const flags = (zone?.flags ?? []).map((flag) => t(FLAG_LABELS[flag] ?? flag));
  const confidence = confidenceLabel(zone?.confidence) ?? t('unknown evidence');
  return [
    t('Risk index v{version}', { version: zone?.riskVersion ?? '—' }),
    confidence,
    ...flags,
  ].join(' · ');
}

/** Translate a confidence level; null when the level is not one the engine emits. */
function confidenceLabel(level) {
  const key = CONFIDENCE_LABELS[level];
  return key ? t(key) : null;
}
