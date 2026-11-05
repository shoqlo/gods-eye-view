# Wildfire Watch — v1 build plan

The plan for turning the pieces in this folder into one simple tool that a small
group of people can log into and use without training. Read this first; the
other documents are the detail behind it.

| Document | What it holds |
| --- | --- |
| `BUILD-PLAN.md` | This plan: what v1 is, the order it is built in, what is left out |
| `PROJECT-BRIEF.md` | What the index is for and what it is not |
| `DATA-AND-METHOD.md` | The index arithmetic and the data behind it |
| `USER-GUIDE.md` | What a person with a login reads |
| `MONETISATION.md` | The commercial plan and what must be true before charging |
| `../../deploy/RUNBOOK.md` | How it is put on a server |

## 1. The goal

A person given a link and a login can answer, within a minute and without help:

> *Is anything burning near the place I care about, how much attention does it
> need, and why?*

and can then open it on the live map. Everything in v1 serves that sentence.
Anything that does not is left out (section 8).

## 2. Who v1 is for

- **The operator and research collaborators** — people who want a reproducible,
  explainable ranking they can argue with and export.
- **Early evaluators** — analysts at insurers, utilities and infrastructure
  owners trying the index before any commercial offer exists.

Not v1: the general public, self-service sign-up, and anyone who needs a
life-safety or evacuation tool. The tool says on every screen that it is not one.

## 3. One front door: the Finder at `/wildfire`

The page opens with one question, **What are you looking for?**, and five
answers. Each answer sets sensible filters and an order, and the page says in a
plain sentence what it is showing.

| Goal | Shows | Order |
| --- | --- | --- |
| **Fires that need attention** (default) | Every burning US fire in the incident feed | Risk score, highest first |
| **Fires near a place** | Fire-weather danger for the place, then fires within a chosen distance | Nearest first |
| **Fires near infrastructure** | Fires with a datacenter or dam within 25 km, or wind blowing toward one | Exposure, highest first |
| **New fires** | Fires discovered in the last 3 days | Newest first |
| **My watchlist** | Fires starred in this browser — the same list the globe panel keeps | Risk score |

**Refine** (folded away until wanted): text search, state, minimum band, minimum
size, hide mostly-contained fires, and sort order. Every control says what it
does to fires with missing data, because half the feed's rows lack containment.

**Always visible:** one sentence — *"6 of 77 fires · within 100 km of Redding,
California · High or above"* — and a **Clear** button.

**Each fire** shows its band and score, name, place, size, containment, distance
when a place is set, and the top reasons. Four actions: **Details** (the score in
plain words and what data was missing), **View location** (satellite frame and
nearby cameras), **Open on 3D map**, and **Watch**.

**Share and export:** **Copy link** carries the goal, place and filters, so a
colleague opens the same view. **Download CSV** saves the current list with the
index version and time, for research and reports.

**Help, on the page:** how to use it in three steps, what the score means, the
difference between the two scales (below), a short glossary, what the tool
cannot tell you, and the sources.

### Two scales, kept apart on purpose

- **Fire risk score and band** (Low → Critical): how much attention a fire that is
  *already burning* needs.
- **Fire-weather danger** (Low → Extreme): how easily a fire could start and
  spread at a *place* over the next 24 hours, from weather alone.

They answer different questions and are never mixed into one number in v1. The
page labels them differently and explains the difference where both appear.

## 4. The map

The live map is the existing 3D globe, opened in **fire mode**: a link that
switches on only active fires, fire perimeters and wind, at the fire or place,
with every other layer off (`/#v=2&lat=…&lon=…&alt=…&l=w.2.k`). v1 adds no new
map code. The globe's Fire Watch panel stays for power users and links back to
the Finder. An overview map inside the Finder is a Phase 3 candidate, decided by
what users ask for.

## 5. The multi-user model

- **One named login per person**, checked by Caddy before anything is served.
  The operator adds and removes people with `node deploy/make-users.mjs <name>`.
- **Everybody sees the same live data.** Watchlists live in each browser in v1;
  collaboration is by share link.
- **The whole site is behind the login in v1.** The earlier public `/wildfire`
  exemption is off by default; reopening it is one block in `deploy/Caddyfile`
  (see the runbook).
- **Sized for tens of users.** The ranked list is the same for everyone and is
  cached, and a cached answer no longer counts against the rate limits, so one
  busy user cannot lock the others out.

## 6. Hardening before anyone else logs in

- **Serve the built app**, not the development server. The development server
  serves files from the checkout, and the keys live in that checkout's `.env`.
  The hosted stack builds once on start and serves only the build output.
- **Vite 6.4.4 → 6.4.5**, which fixes advisory GHSA-8g5g-mxqh-grgj
  (`server.fs.deny` bypassed with queries).
- **Only Caddy publishes ports**, and provider spend is capped at the provider
  (both already in the runbook).

## 7. Phases

| Phase | What | Who |
| --- | --- | --- |
| **0. Foundation** | Combine the wildfire branch with current upstream and the fire-weather tool; translations; Vite upgrade; built serving; cache-first limits; login-only by default | Claude |
| **1. Finder** | The five goals, refine, place search with fire weather, shared watchlist, copy link, CSV, on-page help | Claude |
| **2. Go live, privately** | Server and domain; first deploy against real data; 3–5 invited users; fix what they hit | Operator, with Claude |
| **3. After feedback** | Choose from: overview map, watchlists that follow the login, email alerts for watched places, fire weather inside the index (computed from public-domain GFS), population exposure, Europe via EFFIS | Decided by Phase 2 |

Phases 0 and 1 are built and tested against sample data. Phase 2 is the first
time the tool meets the live feeds on a server.

## 8. Deliberately not in v1

Self-service sign-up, payments, alerts, history and trends, PDF reports,
fire-spread forecasts, ranking fires outside the US, and more map layers. Each is
a reasonable later step; none is needed to answer the sentence in section 1.

## 9. Decisions taken (all reversible)

1. The Finder is the front door; the globe is the power view.
2. The whole site sits behind the login.
3. Ranked fires stay US-only, because that is what the incident feed covers.
   Fire weather for a place works anywhere.
4. Watchlists stay in the browser until users ask for them to follow the login.

## 10. Decisions still open

1. Which server and domain.
2. Who the first 3–5 users are. Their questions decide Phase 3.
3. Whether UK or European coverage matters to them.
4. Whether to reopen a public, no-login page later.

## 11. Known risks

- **No live data has passed through this build yet.** The build environment
  cannot reach the feeds, so everything is tested on sample data until Phase 2.
- **The index weights are judgement**, not calibrated against outcomes. Fine for
  ranking attention; not yet defensible as a priced risk score.
- **The wider app carries non-commercial data sources** (`DATA_SOURCES.md`).
  They must be removed or licensed before anyone is charged.
- **Translations are machine-made** and need a native review before
  non-English users rely on them.
