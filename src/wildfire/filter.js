/**
 * Finding an incident in the Wildfire Watch list.
 *
 * The engine already decides the order: zones arrive ranked by score. This
 * module answers the other question a reader asks — "where is the one I care
 * about, and what is near it?" — with three narrow operations: a free-text
 * search, a band floor, and a re-sort.
 *
 * Everything here is pure: no DOM, no clock, no network, and no import of the
 * presentation layer. The band order is supplied by the caller so this file
 * cannot drift from the engine's own band list.
 */

/**
 * Sort modes offered in the panel, in menu order.
 *
 * Ids only: the label is presentation, so it lives with the panel where it can
 * be marked for translation. This module stays free of the i18n layer.
 */
export const SORT_MODES = Object.freeze(['risk', 'size', 'newest']);

export const DEFAULT_SORT = 'risk';

/**
 * Fold case, strip accents and collapse runs of whitespace, so "Québec",
 * "QUEBEC" and " quebec " all match the same text.
 */
export function normalizeSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does one incident match a free-text query?
 *
 * Name, state code and the incident ID are the three things a reader actually
 * knows. Complexity ("Type 1") is deliberately excluded: it is not a place and
 * not a name, and including it makes "1" match half the list.
 */
export function matchesSearch(zone, query) {
  const needle = normalizeSearch(query);
  if (!needle) return true;
  return [zone?.name, zone?.state, zone?.id]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .some((part) => normalizeSearch(part).includes(needle));
}

/**
 * Apply the reader's narrowing to the ranked list.
 *
 * @param {Array<object>} zones Ranked zones from `/api/fire-risk`.
 * @param {{query?: string, minBand?: string|null, watchedOnly?: boolean,
 *   watched?: Set<string>}} criteria
 * @param {{bandOrder?: string[]}} options Band ids, most severe first.
 * @returns {Array<object>} The zones that survive, in their original order.
 */
export function filterZones(zones, criteria = {}, options = {}) {
  const list = Array.isArray(zones) ? zones : [];
  const order = Array.isArray(options.bandOrder) ? options.bandOrder : [];
  const watched = criteria.watched ?? new Set();
  const floor = criteria.minBand ? order.indexOf(criteria.minBand) : -1;

  return list.filter((zone) => {
    if (!matchesSearch(zone, criteria.query)) return false;
    if (criteria.minBand) {
      const rank = order.indexOf(zone.band);
      // A band the order does not know is never shown by a band filter;
      // pretending it ranks last would quietly hide an engine change.
      if (rank === -1 || rank > floor) return false;
    }
    if (criteria.watchedOnly && !watched.has(zone.id)) return false;
    return true;
  });
}

/**
 * Re-order the surviving zones. `risk` returns them untouched, because that is
 * the engine's ranking and re-sorting it on a tie would be a lie about the
 * score.
 */
export function sortZones(zones, mode = DEFAULT_SORT) {
  const list = Array.isArray(zones) ? [...zones] : [];
  if (mode === 'size') {
    list.sort((a, b) => numberOf(b?.acres, -1) - numberOf(a?.acres, -1));
  } else if (mode === 'newest') {
    // ageHours is null when the feed carries no update time; unknown age sorts
    // last rather than first, so it cannot push a current fire down the list.
    list.sort(
      (a, b) =>
        numberOf(a?.ageHours, Infinity) - numberOf(b?.ageHours, Infinity),
    );
  }
  return list;
}

function numberOf(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** True when anything narrows the list, so the panel can offer to clear it. */
export function hasFilters(criteria = {}) {
  return Boolean(
    normalizeSearch(criteria.query) || criteria.minBand || criteria.watchedOnly,
  );
}
