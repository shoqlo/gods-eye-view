/**
 * Wildfire Watch Risk Index (WWRI).
 *
 * A deterministic, explainable score for an active wildfire incident, built
 * only from data the app already ingests: NIFC WFIGS perimeters, NOAA GFS
 * wind, and the bundled critical-asset packs (datacenters, dams).
 *
 * Design rules
 * ------------
 * 1. Pure. No DOM, no network, no Cesium, no clock reads. The caller passes
 *    `now`. This module runs identically in the browser, in the dev server and
 *    in the unit suite, which is what makes it testable and reusable as a
 *    product surface.
 * 2. Explainable. Every zone carries its four component scores, the inputs
 *    that produced them, and plain-language reasons. A score nobody can
 *    interrogate is not research-grade and cannot be sold to a risk buyer.
 * 3. Honest about absence. Missing wind, missing assets or a stale incident
 *    degrade the confidence and say so. They never silently read as "safe".
 *
 * The index is an indicator of where attention is warranted. It is not a
 * forecast of fire spread and not a life-safety product.
 */

import { msg } from '../i18n/marker.js';

export const RISK_VERSION = '1.0.0';

/**
 * Bands, highest first. `min` is inclusive.
 *
 * `label` is product data, not panel copy: the API returns it and the panel
 * passes it through `t()` in the reader's language. `msg()` marks it as such,
 * so this module carries no locale of its own.
 */
export const RISK_BANDS = Object.freeze([
  { id: 'critical', min: 75, label: msg('CRITICAL'), colour: '#ff3b30' },
  { id: 'high', min: 60, label: msg('HIGH'), colour: '#ff7a18' },
  { id: 'elevated', min: 45, label: msg('ELEVATED'), colour: '#ffc53d' },
  { id: 'watch', min: 30, label: msg('WATCH'), colour: '#4aa8ff' },
  { id: 'low', min: 0, label: msg('LOW'), colour: '#7c8b94' },
]);

/** Component weights. They sum to 1. */
export const WEIGHTS = Object.freeze({
  hazard: 0.35,
  exposure: 0.3,
  wind: 0.2,
  recency: 0.15,
});

const BEHAVIOUR_SCORE = Object.freeze({
  Extreme: 100,
  High: 78,
  Moderate: 52,
  Minimal: 26,
});

/** Assets counted inside this radius of the incident centroid. */
export const ASSET_RADIUS_KM = 25;
/** Assets downwind are counted separately as directional exposure. */
export const DOWNWIND_RADIUS_KM = 40;
/** Wind bearing must fall within this cone to count as aimed at an asset. */
export const DOWNWIND_CONE_DEG = 35;
/** Wind speed that scores 100 on the wind component. */
export const WIND_SCALE_MS = 12;

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(value, 0, 1);
const finite = (value) => Number.isFinite(value);

/** Band for a 0–100 score. Always returns a band. */
export function bandForScore(score) {
  const value = finite(score) ? score : 0;
  return RISK_BANDS.find((band) => value >= band.min) ?? RISK_BANDS.at(-1);
}

/** Great-circle distance in km between two { lat, lon } points. */
export function distanceKm(a, b) {
  if (
    !a ||
    !b ||
    !finite(a.lat) ||
    !finite(a.lon) ||
    !finite(b.lat) ||
    !finite(b.lon)
  ) {
    return Infinity;
  }
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from `a` to `b`, degrees clockwise from north. */
export function bearingDeg(a, b) {
  if (!a || !b) return 0;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Smallest absolute angle between two bearings, 0–180. */
export function angleBetweenDeg(a, b) {
  const diff = Math.abs((((a - b) % 360) + 360) % 360);
  return diff > 180 ? 360 - diff : diff;
}

/**
 * The direction the wind is blowing *toward*, in compass degrees.
 * `u` is eastward and `v` northward (the GFS convention this app already uses).
 */
export function windTowardDeg(u, v) {
  if (!finite(u) || !finite(v)) return null;
  if (Math.hypot(u, v) < 0.05) return null;
  return (Math.atan2(u, v) / DEG + 360) % 360;
}

/**
 * Parse a WFIGS vertex. The normalized row carries `[lon, lat]` numeric pairs;
 * the `"lon lat"` string form is still accepted because upstream field reports
 * and older snapshots use it. Returns null for anything malformed.
 */
export function parseVertex(value) {
  let lon;
  let lat;
  if (Array.isArray(value) && value.length >= 2) {
    lon = Number(value[0]);
    lat = Number(value[1]);
  } else if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    lon = Number(parts[0]);
    lat = Number(parts[1]);
  } else return null;
  if (!finite(lon) || !finite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

/**
 * Geometry summary for a WFIGS `polygons` field: the perimeter shape is
 * `[part][ring][vertex]`, every ring open, every vertex `"lon lat"`.
 * Uses the largest part's outer ring for centroid and area, and every vertex
 * for the bounding box.
 */
export function zoneGeometry(polygons) {
  const empty = {
    centroid: null,
    bounds: null,
    areaKm2: null,
    vertices: 0,
  };
  if (!Array.isArray(polygons) || !polygons.length) return empty;

  let bounds = null;
  let vertices = 0;
  /** @type {Array<{lon:number,lat:number}>} */
  let largest = [];

  const growBox = (box, point) =>
    box
      ? {
          west: Math.min(box.west, point.lon),
          south: Math.min(box.south, point.lat),
          east: Math.max(box.east, point.lon),
          north: Math.max(box.north, point.lat),
        }
      : {
          west: point.lon,
          south: point.lat,
          east: point.lon,
          north: point.lat,
        };

  for (const part of polygons) {
    const ring = Array.isArray(part) ? part[0] : null;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    /** @type {Array<{lon:number,lat:number}>} */
    const points = [];
    for (const raw of ring) {
      const point = parseVertex(raw);
      if (!point) continue;
      points.push(point);
      vertices += 1;
      bounds = growBox(bounds, point);
    }
    if (points.length > largest.length) largest = points;
  }

  if (!bounds || largest.length < 3) return { ...empty, vertices };

  // The area and centroid are projected from the main ring's own latitude, not
  // from the extent of every part: a single stray vertex a few degrees away
  // would otherwise stretch the longitude scale and inflate the area.
  let shapeBounds = null;
  let latSum = 0;
  for (const point of largest) {
    shapeBounds = growBox(shapeBounds, point);
    latSum += point.lat;
  }
  const latMean = latSum / largest.length;
  const kmPerLon = 111.32 * Math.cos(latMean * DEG);
  const kmPerLat = 110.57;

  // Shoelace on a local equirectangular projection: accurate enough at the
  // scale of an incident, and stable for the concave shapes fire perimeters
  // actually are.
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < largest.length; index += 1) {
    const current = largest[index];
    const next = largest[(index + 1) % largest.length];
    const x1 = current.lon * kmPerLon;
    const y1 = current.lat * kmPerLat;
    const x2 = next.lon * kmPerLon;
    const y2 = next.lat * kmPerLat;
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  const areaKm2 = Math.abs(twiceArea) / 2;
  if (twiceArea === 0) {
    return {
      centroid: {
        lat: (shapeBounds.south + shapeBounds.north) / 2,
        lon: (shapeBounds.west + shapeBounds.east) / 2,
      },
      bounds,
      areaKm2: 0,
      vertices,
    };
  }
  const centroid = {
    lat: cy / (3 * twiceArea) / kmPerLat,
    lon: cx / (3 * twiceArea) / kmPerLon,
  };
  // A degenerate or mirrored ring can push the centroid outside its own
  // outline; fall back to the main ring's box centre when it does.
  const inside =
    finite(centroid.lat) &&
    finite(centroid.lon) &&
    centroid.lat >= shapeBounds.south &&
    centroid.lat <= shapeBounds.north &&
    centroid.lon >= shapeBounds.west &&
    centroid.lon <= shapeBounds.east;
  return {
    centroid: inside
      ? centroid
      : {
          lat: (shapeBounds.south + shapeBounds.north) / 2,
          lon: (shapeBounds.west + shapeBounds.east) / 2,
        },
    bounds,
    areaKm2,
    vertices,
  };
}

/**
 * Prepare one WFIGS row as a scored-ready zone.
 * @param {object} row A normalized perimeter row from `normalizeFirePerimeterSnapshot`.
 */
export function buildZone(row) {
  const geometry = zoneGeometry(row?.polygons);
  return {
    id: row?.stableId ?? null,
    name: row?.name ?? 'Unnamed incident',
    state: row?.state ?? null,
    county: row?.county ?? null,
    category: row?.category ?? null,
    acres: finite(row?.acres) ? row.acres : null,
    containedPct: finite(row?.containedPct) ? row.containedPct : null,
    behaviour: row?.behavior ?? null,
    complexity: row?.complexity ?? null,
    cause: row?.cause ?? null,
    personnel: finite(row?.personnel) ? row.personnel : null,
    costToDate: finite(row?.costToDate) ? row.costToDate : null,
    discoveredAt: finite(row?.discoveredTime) ? row.discoveredTime : null,
    updatedAt: finite(row?.updatedTime) ? row.updatedTime : null,
    centroid: geometry.centroid,
    bounds: geometry.bounds,
    areaKm2: geometry.areaKm2,
    vertices: geometry.vertices,
  };
}

/**
 * Assets near a zone: counted, nearest, and how many the wind is pushing toward.
 * @param {{centroid: {lat:number,lon:number}|null}} zone
 * @param {Array<{kind:string,name?:string,lat:number,lon:number}>} assets
 * @param {{towardDeg: number|null}} wind
 */
export function assetExposure(zone, assets, wind) {
  const result = {
    withinRadius: 0,
    nearestKm: null,
    nearest: null,
    downwind: 0,
    downwindNearestKm: null,
    downwindNearest: null,
    byKind: {},
  };
  if (!zone?.centroid || !Array.isArray(assets) || !assets.length)
    return result;

  const bearing = wind?.towardDeg ?? null;
  for (const asset of assets) {
    // Cheap prune before the haversine: half a degree of latitude is ~55 km,
    // wider than the downwind radius, so anything beyond it cannot qualify.
    const dLat = Math.abs(asset.lat - zone.centroid.lat);
    if (!finite(dLat) || dLat > 0.5) continue;
    const km = distanceKm(zone.centroid, asset);
    if (!finite(km) || km > DOWNWIND_RADIUS_KM) continue;
    if (km <= ASSET_RADIUS_KM) {
      result.withinRadius += 1;
      result.byKind[asset.kind] = (result.byKind[asset.kind] ?? 0) + 1;
      if (result.nearestKm === null || km < result.nearestKm) {
        result.nearestKm = km;
        result.nearest = { kind: asset.kind, name: asset.name ?? null, km };
      }
    }
    if (bearing !== null) {
      const aimed = angleBetweenDeg(bearing, bearingDeg(zone.centroid, asset));
      if (aimed <= DOWNWIND_CONE_DEG) {
        result.downwind += 1;
        if (
          result.downwindNearestKm === null ||
          km < result.downwindNearestKm
        ) {
          result.downwindNearestKm = km;
          result.downwindNearest = {
            kind: asset.kind,
            name: asset.name ?? null,
            km,
          };
        }
      }
    }
  }
  return result;
}

/**
 * Score one zone.
 *
 * @param {object} zone Output of `buildZone`.
 * @param {object} context
 * @param {{speedMs:number,u:number,v:number,towardDeg:number|null,validIso?:string}|null} context.wind
 * @param {Array<{kind:string,name?:string,lat:number,lon:number}>} [context.assets]
 * @param {number} context.now Epoch ms.
 */
export function scoreZone(zone, context = {}) {
  const now = finite(context.now) ? context.now : Date.now();
  const wind = context.wind ?? null;
  const assets = context.assets ?? null;

  /* ---------------------------------------------------------------- hazard */
  const behaviourScore = BEHAVIOUR_SCORE[zone.behaviour] ?? null;
  const behaviourKnown = behaviourScore !== null;
  const containmentDeficit = finite(zone.containedPct)
    ? clamp(100 - zone.containedPct, 0, 100)
    : null;
  const acres = finite(zone.acres) && zone.acres > 0 ? zone.acres : null;
  // 500,000 acres saturates the size term.
  const sizeScore =
    acres === null
      ? null
      : clamp((Math.log10(acres) / Math.log10(500_000)) * 100, 0, 100);
  // Absolute weights, not renormalised: a part the record does not carry
  // contributes nothing. Absence of a containment figure must not read as
  // either "contained" or "uncontained", so it simply is not credited. This
  // keeps a data-poor incident from outranking a well-documented one, and it
  // is why `confidence` and `missingInputs` matter as much as the score.
  const hazard = clamp(
    0.5 * (behaviourScore ?? 0) +
      0.3 * (containmentDeficit ?? 0) +
      0.2 * (sizeScore ?? 0),
    0,
    100,
  );

  /* -------------------------------------------------------------- exposure */
  const exposureDetail = assetExposure(zone, assets ?? [], wind);
  // Four assets inside the radius saturates the count term.
  const assetScore = 100 * (1 - Math.exp(-exposureDetail.withinRadius / 1.5));
  // Suppression spend per acre is a real, published intensity signal. No
  // published figure means no credit, not an average.
  const costPerAcre =
    finite(zone.costToDate) && acres !== null ? zone.costToDate / acres : null;
  const economicScore =
    costPerAcre === null ? null : clamp((costPerAcre / 2000) * 100, 0, 100);
  const exposureKnown = assets !== null && assets !== undefined;
  const exposure = clamp(
    0.65 * (exposureKnown ? assetScore : 0) + 0.35 * (economicScore ?? 0),
    0,
    100,
  );

  /* ------------------------------------------------------------------ wind */
  let windScore;
  let windKnown = false;
  if (wind && finite(wind.speedMs)) {
    windKnown = true;
    windScore = clamp((wind.speedMs / WIND_SCALE_MS) * 100, 0, 100);
    if (exposureDetail.downwind > 0) {
      // Moving air aimed at infrastructure is the difference between a fire
      // in a valley and a fire with a consequence.
      windScore = clamp(
        windScore + 10 + Math.min(15, exposureDetail.downwind * 4),
        0,
        100,
      );
    }
  } else {
    // Neutral, and flagged. Treating unknown wind as calm would understate
    // every incident in the catalogue.
    windScore = 45;
  }

  /* --------------------------------------------------------------- recency */
  let recencyScore = 50;
  let ageHours = null;
  if (finite(zone.updatedAt)) {
    ageHours = Math.max(0, (now - zone.updatedAt) / 3_600_000);
    if (ageHours <= 2) recencyScore = 100;
    else if (ageHours <= 6) recencyScore = 85;
    else if (ageHours <= 12) recencyScore = 70;
    else if (ageHours <= 24) recencyScore = 55;
    else if (ageHours <= 48) recencyScore = 35;
    else recencyScore = 15;
  }

  const raw =
    WEIGHTS.hazard * hazard +
    WEIGHTS.exposure * exposure +
    WEIGHTS.wind * windScore +
    WEIGHTS.recency * recencyScore;

  /* ------------------------------------------------------------ modifiers */
  const modifiers = [];
  let multiplier = 1;
  // Containment already enters through the hazard deficit. Applying it a
  // second time as a multiplier double-counted the same fact.
  if (finite(zone.discoveredAt)) {
    const runningDays = (now - zone.discoveredAt) / 86_400_000;
    if (runningDays > 14) {
      multiplier *= 0.93;
      modifiers.push({
        id: 'long-running',
        factor: 0.93,
        label: msg('running more than 14 days'),
      });
    }
  }

  const score = Math.round(clamp(raw * multiplier, 0, 100));
  const band = bandForScore(score);

  /* ------------------------------------------------------------ confidence */
  const signals = [
    behaviourKnown,
    windKnown,
    exposureKnown && exposureDetail.withinRadius > 0,
    ageHours !== null && ageHours <= 24,
  ];
  const signalCount = signals.filter(Boolean).length;
  let confidence =
    signalCount >= 3 ? 'high' : signalCount === 2 ? 'medium' : 'low';

  // A gap in an input the score consumes means part of the evidence is simply
  // absent. That can never be reported as high confidence, however many of the
  // other signals are present.
  const missingInputs = [];
  if (!windKnown && zone.centroid !== null) missingInputs.push('wind');
  if (!exposureKnown) missingInputs.push('assets');
  if (!behaviourKnown) missingInputs.push('behaviour');
  if (containmentDeficit === null) missingInputs.push('containment');
  if (costPerAcre === null) missingInputs.push('cost');
  const scoredGaps = missingInputs.filter((id) =>
    ['wind', 'assets', 'behaviour', 'containment'].includes(id),
  );
  if (scoredGaps.length >= 2) confidence = 'low';
  else if (scoredGaps.length === 1 && confidence === 'high')
    confidence = 'medium';

  /* --------------------------------------------------------------- reasons */
  const reasons = [];
  if (behaviourKnown && behaviourScore >= 78)
    reasons.push(`${zone.behaviour} fire behaviour`);
  if (finite(zone.containedPct) && zone.containedPct < 50) {
    reasons.push(`only ${Math.round(zone.containedPct)}% contained`);
  }
  if (acres !== null && acres >= 10_000)
    reasons.push(`${formatAcres(acres)} acres`);
  if (zone.complexity && /Type 1|Type 2/.test(zone.complexity)) {
    reasons.push(`${zone.complexity} (highest national resourcing)`);
  }
  if (exposureDetail.withinRadius > 0) {
    const kinds = Object.entries(exposureDetail.byKind)
      .map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`)
      .join(', ');
    reasons.push(`${kinds} within ${ASSET_RADIUS_KM} km`);
  }
  if (exposureDetail.downwind > 0) {
    reasons.push(
      `wind aimed at ${exposureDetail.downwind} asset${exposureDetail.downwind === 1 ? '' : 's'}`,
    );
  }
  if (windKnown && wind.speedMs >= 8) {
    reasons.push(`wind ${wind.speedMs.toFixed(1)} m/s`);
  }
  if (ageHours !== null && ageHours > 24) {
    reasons.push(`perimeter not updated for ${Math.round(ageHours)} h`);
  }
  if (!reasons.length) reasons.push('no acute signal in the current record');

  const flags = [];
  if (!windKnown && zone.centroid !== null) flags.push('wind-unavailable');
  if (!exposureKnown) flags.push('assets-unavailable');
  if (!behaviourKnown) flags.push('behaviour-unknown');
  if (containmentDeficit === null) flags.push('containment-unknown');
  if (costPerAcre === null) flags.push('cost-unknown');
  if (ageHours !== null && ageHours > 48) flags.push('stale-perimeter');
  if (zone.centroid === null) flags.push('no-geometry');

  return {
    ...zone,
    score,
    band: band.id,
    bandLabel: band.label,
    bandColour: band.colour,
    confidence,
    components: {
      hazard: round1(hazard),
      exposure: round1(exposure),
      wind: round1(windScore),
      recency: round1(recencyScore),
    },
    modifiers,
    exposureDetail: {
      withinRadius: exposureDetail.withinRadius,
      nearestKm:
        exposureDetail.nearestKm === null
          ? null
          : round1(exposureDetail.nearestKm),
      nearest: exposureDetail.nearest,
      downwind: exposureDetail.downwind,
      downwindNearest: exposureDetail.downwindNearest,
      byKind: exposureDetail.byKind,
      costPerAcre: costPerAcre === null ? null : Math.round(costPerAcre),
    },
    wind: wind
      ? {
          speedMs: round1(wind.speedMs),
          towardDeg: wind.towardDeg ?? null,
          validIso: wind.validIso ?? null,
        }
      : null,
    ageHours: ageHours === null ? null : round1(ageHours),
    reasons,
    flags,
    missingInputs,
    riskVersion: RISK_VERSION,
  };
}

/**
 * Score and rank a batch of perimeter rows.
 *
 * Contained incidents are kept out of the ranking by default: at 100% they
 * are over, and including them buries the live picture. `includeContained`
 * keeps them for research and post-season analysis.
 *
 * @param {Array<object>} rows Normalized perimeter rows.
 * @param {object} [options]
 * @param {{speedMs:number,u:number,v:number,towardDeg:number|null,validIso?:string}|null} [options.wind]
 * @param {(zone: object) => ({speedMs:number,u:number,v:number,towardDeg:number|null,validIso?:string}|null)} [options.windAt]
 *   Per-zone wind, for callers that sample a field at each centroid. Takes
 *   precedence over `options.wind`.
 * @param {Array<object>|null} [options.assets]
 * @param {number} [options.now]
 * @param {number} [options.limit]
 * @param {string} [options.minBand] One of the band ids.
 * @param {boolean} [options.includeContained]
 */
export function rankZones(rows, options = {}) {
  const now = finite(options.now) ? options.now : Date.now();
  const limit = finite(options.limit)
    ? clamp(Math.round(options.limit), 1, 500)
    : 25;
  const minBand =
    RISK_BANDS.find((band) => band.id === options.minBand) ?? null;
  const includeContained = options.includeContained === true;
  const windAt =
    typeof options.windAt === 'function'
      ? options.windAt
      : () => options.wind ?? null;

  const scored = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const zone = buildZone(row);
    if (
      !includeContained &&
      finite(zone.containedPct) &&
      zone.containedPct >= 100
    )
      continue;
    const result = scoreZone(zone, {
      now,
      wind: windAt(zone),
      assets: options.assets ?? null,
    });
    if (minBand && result.score < minBand.min) continue;
    scored.push(result);
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.acres ?? 0) - (a.acres ?? 0);
  });

  return {
    total: scored.length,
    returned: Math.min(limit, scored.length),
    truncated: scored.length > limit,
    // Counts describe every scored zone, before `limit` trims the list.
    counts: { ...bandCounts(scored), confidence: confidenceCounts(scored) },
    zones: scored.slice(0, limit),
  };
}

/** Counts by band for a scored set. Used by the panel posture line and the API. */
export function bandCounts(zones) {
  const counts = Object.fromEntries(RISK_BANDS.map((band) => [band.id, 0]));
  let acres = 0;
  for (const zone of Array.isArray(zones) ? zones : []) {
    if (counts[zone.band] !== undefined) counts[zone.band] += 1;
    if (finite(zone.acres)) acres += zone.acres;
  }
  return { ...counts, acres: Math.round(acres) };
}

/** How many scored zones carry each confidence level. */
export function confidenceCounts(zones) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const zone of Array.isArray(zones) ? zones : []) {
    if (counts[zone.confidence] !== undefined) counts[zone.confidence] += 1;
  }
  return counts;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function formatAcres(acres) {
  // The live feed carries incidents under an acre; rounding them to "0 acres"
  // would describe a real fire as no fire.
  if (acres < 10) return acres.toFixed(1);
  return Math.round(acres).toLocaleString('en-US');
}
