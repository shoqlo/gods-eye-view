# Wildfire Watch — project brief

Wildfire Watch is a wildfire research and live-monitoring surface built on top of
God's Eye View. It answers one question that neither the public incident feed nor
a general-purpose globe answers on its own: **of every fire burning right now,
which ones deserve attention first, and why.**

The answer is a ranked index, not a map. Each row carries a 0–100 score, a band,
the four component scores that produced it, plain-language reasons, and an
explicit statement of what the record does *not* contain. Every row can be flown
to, and the fire's outline and the wind field switch on so the number and the
shape on the globe are the same object.

This document is the scope. `DATA-AND-METHOD.md` is the arithmetic and the data
provenance. `MONETISATION.md` is the commercial plan and what it requires.
`USER-GUIDE.md` is what a person with a login reads. `../../deploy/RUNBOOK.md`
is how it is put on a server.

## What it is for

1. **Research.** A reproducible, explainable ranking that can be published,
   argued with and improved. The scoring engine is a pure function with no DOM,
   no network and no clock reads, so a paper or a blog post can cite exact
   numbers and a reader can re-run them.
2. **Live watch.** A weekend operator can leave the panel open and see the
   picture move as the incident feed updates, without reading a spreadsheet.
3. **Risk-area product.** The same index is the input to per-area risk reports
   and to an API, which is where the revenue sits.

## What it is not

- Not a fire-spread forecast. Nothing here models where a fire will go next.
- Not a life-safety product. It does not replace an evacuation order, and the
  panel says so on every render.
- Not a complete exposure model. It counts bundled datacenters and dams, not
  homes, people, power or ecology.

Those three sentences are in the panel copy and in the API's `limitations[]`
array. They are load-bearing: the product's credibility depends on not being
mistaken for any of them.

## Where it sits

| Layer | File | Owner of |
| --- | --- | --- |
| Scoring engine | `src/wildfire/risk.js` | The arithmetic, the bands, the reasons, the confidence |
| Presentation helpers | `src/wildfire/display.js` | Formatting and translation of every number and label |
| Search, filter, sort | `src/wildfire/filter.js` | The pure predicate and ordering behind the panel's controls |
| API aggregator | `server/providers/fireRisk.js` | `/api/fire-risk`, caching, rate limits, payload shape |
| Panel | `src/ui/fireWatch.js` | The rail panel, the filters, the watchlist, the fly-to |
| Styling | `src/ui/styles/fire-watch.css` | Panel appearance, using the app's existing tokens |

The engine and the aggregator are importable on their own. A future report
generator or a public API does not need the globe, and does not need to
duplicate a line of scoring code.

## Data it reads

Everything comes from feeds the application already ingests, so the product adds
no new upstream dependency and no new API key:

- **Incidents and perimeters** — NIFC WFIGS, through the app's own
  `/api/fire-perimeters` cache.
- **Wind** — NOAA GFS 10 m wind on a 1° grid, through `/api/wind`, sampled at
  each incident's centroid.
- **Exposure** — bundled OpenStreetMap-derived datacenter and dam packs
  (ODbL 1.0, attribution shown in the panel's evidence line).

`DATA-AND-METHOD.md` records the exact schema quirks and the gaps in the live
feed that the engine has to survive.

## What is built

- 63 unit tests across the engine, the display helpers, the filter module and
  the API aggregator.
- A panel that leads the left rail (the rail keeps its first expanded panel, so
  a list mounted further down was folded away on arrival), filters by band with
  live counts per option, sorts by risk, size or recency, searches one field for
  name, state or ID, keeps a local watchlist, refreshes every five minutes and
  on tab focus, and flies the camera to an incident using the application's own
  framing rules.
- A guided first run — one-sentence intro card, live counts on every band, a
  single CLEAR that resets every filter, and a "what the score means" disclosure
  — because the difference between a usable index and a wall of numbers is
  explanation, not features.
- Copy translated into Spanish, Russian and Simplified Chinese, with the
  catalogue kept in step by `npm run i18n`.
- A hosted deployment: Docker Compose plus Caddy, TLS, one named login per
  person, keys on the server, nothing but the edge published. See
  `../../deploy/RUNBOOK.md`.

## How it is delivered

One shared instance on one server, reached at one domain. Caddy terminates TLS
and holds a bcrypt hash per person, so visiting the site asks for a username and
password before a single byte of the application is served. The app itself has
no accounts: everybody who logs in sees the same live data and the same map.

The consequences are worth stating, because they are design choices rather than
gaps:

- **Watchlists do not follow the person.** They live in the browser, so they are
  private, and they are gone on another machine.
- **Keys stay on the server.** Provider Settings is switched off on a hosted
  instance, so no visitor can read or change a key.
- **Removing somebody is one line and a Caddy reload.** No reindexing, no data
  migration, no session store to expire.

Per-person data — saved views, shared watchlists, an API key of one's own —
is what a real account system would buy, and it is deliberately deferred until
there is a reason to pay for it. See `MONETISATION.md`.

## Known limits, stated plainly

- **Reason text is English.** The engine emits reasons as data; the panel
  translates labels and formatting, but the sentences in `reasons[]` are still
  English until the engine carries message keys. A non-English reader gets a
  translated frame around English evidence.
- **Population is not scored.** The bundled counties pack has no population
  field, so "exposure" means critical assets, not people. This is the single
  biggest gap between the current index and a risk product a buyer would pay
  for.
- **Wind is coarse.** 1° GFS at 10 m cannot see a valley or a slope flow.
- **Perimeters lag.** The published outline can be hours behind the fire front;
  the engine degrades recency and flags the staleness rather than pretending.
- **Translations need a native review** before any non-English release.

## Next

1. Population and built-environment exposure from a census pack, weighted by
   distance and downwind position.
2. Message keys in the engine so `reasons[]` translates.
3. A per-area risk report generator that consumes the same JSON the panel does.
4. Persistence: a database of scored history, so trend becomes a product
   ("this area's index rose 18 points in six hours").
