# Data and method

The Wildfire Watch Risk Index (WWRI) scores one active wildfire incident. This
document records the arithmetic exactly as implemented in
`src/wildfire/risk.js`, the inputs as they actually arrive from the live feeds,
and the reasoning behind the choices that would otherwise look arbitrary.

The index is an indicator of where attention is warranted. It is not a
fire-spread forecast and not a life-safety product.

## 1. Inputs

### 1.1 Incidents and perimeters — NIFC WFIGS

Read through the application's own `/api/fire-perimeters` route, not from NIFC
directly. That route already owns its TTL, single-flight, stale-serving and rate
limiting; a second upstream fetch would duplicate all four and could disagree
with the layer drawn on the globe.

Fields consumed: `id`, `name`, `state`, `acres`, `containedPct`, `behaviour`,
`complexity`, `costToDate`, `discoveredAt`, `updatedAt`, `polygons`.

Live-feed gaps measured on a full pull (111 rows):

| Field | Rows missing | Consequence |
| --- | --- | --- |
| `behaviour` | 61 of 87 scored | Half of hazard's 50% weight is uncreditable |
| `containedPct` | 59 of 87 | Containment deficit scores zero |
| `costToDate` | 59 of 87 | Economic exposure scores zero |

Geometry is `polygons[part][ring][vertex]` with **numeric** `[lon, lat]` pairs.
`parseVertex` also accepts `"lon lat"` strings because some producers emit them.
Area and centroid come from the largest ring, using that ring's own mean latitude
for the longitude scale; if the ring is degenerate the centroid falls back to the
centre of its bounding box. A zone with no usable geometry is still scored and
flagged `no-geometry`, never dropped.

### 1.2 Wind — NOAA GFS

`/api/wind` returns a manifest only; the field itself is a `Float32Array` at
`gridUrl`, u-then-v, on a grid of `{nx: 360, ny: 181, lo1: 0, la1: 90, dx: 1, dy: 1}`.
The engine samples at each incident centroid and derives speed and the direction
the wind blows *towards*; wind is never interpolated across a cell boundary.

### 1.3 Exposure — bundled asset packs

OpenStreetMap-derived packs shipped with the build, ODbL 1.0:

- `src/data/local_data/datacenters/datacenters.geojsonl` — 4,351 features
- `src/data/local_data/dams/dams.geojsonl` — 704 features

5,048 features survive into the index (a handful sit outside the loader's usable
geometry test). The packs are read once per server process. A missing pack yields
`assets-unavailable` and zero exposure credit — never an assumed average.

There is no population layer. `us_census_counties/counties.json` carries no
population field, so people are not in the score. This is the largest gap between
the present index and a commercial risk product, and it is stated in the panel
and in the API's `limitations[]`.

## 2. The score

```
score = clamp( 0.35·hazard + 0.30·exposure + 0.20·wind + 0.15·recency , 0, 100 ) × modifiers
```

Weights are **absolute**. A component whose inputs are absent contributes zero.
They are not renormalised over the parts that happen to be present — that is the
deliberate design decision that motivated the whole engine (see §4).

### 2.1 Hazard (35%)

```
hazard = 0.50·behaviour + 0.30·containmentDeficit + 0.20·size
```

- `behaviour` — a lookup on the published behaviour word (e.g. *Extreme* high,
  *Minimal* low). Unknown behaviour scores 0.
- `containmentDeficit = 100 − containedPct`, clamped to 0–100. Unknown scores 0.
- `size = clamp(log10(acres) / log10(500 000) × 100, 0, 100)` — 500,000 acres
  saturates the term. Logarithmic because the difference between 100 and 1,000
  acres matters more than between 100,000 and 100,900.

### 2.2 Exposure (30%)

```
exposure = 0.65·assets + 0.35·economic
assets   = 100 · (1 − e^(−withinRadius / 1.5))     # 4 assets saturate
economic = clamp((costToDate / acres) / 2000 × 100, 0, 100)
```

`withinRadius` counts assets within 25 km of the centroid. Suppression spend per
acre is a published intensity signal: an incident that has already cost $2,000 an
acre is a different event from one that has cost $20 an acre. No published cost
means no credit.

### 2.3 Wind (20%)

```
wind = clamp(speedMs / 12 × 100, 0, 100)
     + 10 + min(15, downwind × 4)          # only when assets lie downwind
```

`downwind` counts assets inside a 35° cone extending 40 km from the centroid,
along the direction the wind blows towards. Moving air aimed at infrastructure is
the difference between a fire in a valley and a fire with a consequence.

When no wind is available the component is held at a **neutral 45** and flagged
`wind-unavailable`. Treating unknown wind as calm would understate every incident
in the catalogue at once.

### 2.4 Recency (15%)

Age of the published perimeter update, stepped: ≤2 h → 100, ≤6 h → 85, ≤12 h → 70,
≤24 h → 55, ≤48 h → 35, older → 15. No update time → 50 (neutral).

### 2.5 Modifiers

One only. An incident running more than 14 days takes ×0.93 (`long-running`).
Containment deliberately does **not** apply a second multiplier: it already enters
through the hazard deficit, and applying it twice double-counted one fact.

### 2.6 Bands

| Band | Score | Colour |
| --- | --- | --- |
| CRITICAL | ≥ 75 | `#ff3b30` |
| HIGH | ≥ 60 | `#ff7a18` |
| ELEVATED | ≥ 45 | `#ffc53d` |
| WATCH | ≥ 30 | `#4aa8ff` |
| LOW | < 30 | `#7c8b94` |

## 3. Confidence and flags

Confidence counts four evidence signals: behaviour known, wind known, at least one
asset inside the radius, perimeter updated within 24 hours. Three or more → `high`,
two → `medium`, fewer → `low`.

It is then **capped by gaps in the inputs the score actually consumes**: two or
more missing among {wind, assets, behaviour, containment} → `low`; one missing and
the signal count said `high` → `medium`. A score built on half a record can never
be advertised as well evidenced.

Flags emitted: `wind-unavailable`, `assets-unavailable`, `behaviour-unknown`,
`containment-unknown`, `cost-unknown`, `stale-perimeter` (older than 48 h),
`no-geometry`.

## 4. Why the score works this way

An early version renormalised the weights over present inputs and applied
containment as a multiplier. It ranked a 40-acre fire with no published behaviour,
no containment, no cost and a 1-day-old perimeter **above** a 67,000-acre Type 1
incident at 90% containment with a current perimeter. The micro-fire was scoring
~100 on the two components it had; the large fire was averaging down over four.

Two changes fixed it, and both are now load-bearing:

1. **Absolute weights.** Absence earns nothing. A sparse record cannot win by
   having few things to be bad at.
2. **No double-counting containment.** It is a hazard input, not a multiplier.

The cost is that a genuinely severe fire with a thin record scores lower than its
severity warrants. That is the right trade: the panel shows *why* the number is
what it is, and the confidence cap and flags make the thinness visible instead of
hiding it inside an optimistic score.

## 5. API

`GET /api/fire-risk`

| Parameter | Values | Default |
| --- | --- | --- |
| `limit` | 1–200 ranked zones returned | 40 |
| `minBand` | `critical` \| `high` \| `elevated` \| `watch` \| `low` | none |
| `includeContained` | `1` \| `true` \| `yes` | off |

Response: `generatedAt`, `riskVersion`, `conditions` (wind status, perimeter row
count, asset total), `counts` (per band, per confidence, acres, scored), `zones[]`,
`limitations[]`. Every zone carries `score`, `band`, `bandLabel`, `bandColour`,
`confidence`, `components`, `reasons[]`, `flags[]`, `modifiers[]`,
`exposureDetail`, `centroid`, `bounds`, `acres`, `ageHours`.

Behaviour:

- TTL cache of 300 s, single-flight, stale-on-failure with the `X-Data-Stale`
  header. A dropped upstream does not blank a picture the operator is reading.
- Rate limited to 60 requests per minute per client, 600 global.
- Incidents at 100% containment are excluded unless `includeContained` is set.
- The aggregator calls its sibling routes on loopback (`localhost` → `127.0.0.1`
  → `[::1]`, because Vite may bind only one) so the existing caches stay the only
  owner of upstream traffic.

## 6. Verification

- `src/wildfire/risk.test.mjs` — 24 tests: vertex parsing both shapes, area and
  centroid, wind sampling, absolute-weight behaviour, confidence caps, banding,
  ranking and counting.
- `src/wildfire/display.test.mjs` — 10 tests: formatting under `en` and `es`,
  including decimal marks and grouping.
- `server/providers/fireRisk.test.mjs` — 12 tests: option parsing (including the
  absent-parameter case that once clamped the default limit to 1), cache TTL,
  stale serving, contained filtering, payload shape.

Live verification: 85–89 zones scored from a 111-row feed, 5,048 assets, all
wind-sampled, confidence distributed 1 high / 23 medium / 63 low — the low
majority is the live feed's documented behaviour and containment gaps showing up
exactly where the method says they should.

## 7. Reproducing a number

`scoreZone` is a pure function. Given the same zone record, wind sample and asset
list it returns the same score, with no reliance on wall-clock time (`now` is
passed in), no network and no DOM. A published figure can therefore be re-derived
by anyone with the feed snapshot, which is the point.
