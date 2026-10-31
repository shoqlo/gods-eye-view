# Wildfire Watch — user guide

You have a login to a shared God's Eye View instance. This guide covers the one
panel that was added for wildfires: **FIRE WATCH**, first in the left rail.

It is short on purpose. There are five controls and one list. If you read this
page once, you will not need it again.

---

## 1. What the list is

Every fire that the live incident feed reports as burning right now, ranked by
**how much attention it warrants**.

Not by size, and not by where it is. By a 0–100 score that weighs four things:
how the fire is behaving, what is near it, what the wind is doing, and how
current the report is. The score is the order of the list.

The panel says it on every render and it is worth repeating: this ranks where
attention is warranted. It is not a forecast of where a fire will go, and it is
not a life-safety product.

## 2. What you see on arrival

The panel opens expanded, at the top of the left rail, and reads:

```
70 incidents · 408,728 acres
```

That line is the whole picture: how many fires are scored, and their combined
size. If some fall outside the filters you have set, it also says
`N shown`. Below it is the list, one row per fire.

On a first visit there is a small card explaining the list in one sentence.
Press **GOT IT** and it goes away for good.

## 3. Finding the fire you care about

Four controls, in the order you will reach for them.

**Search.** One field, above the list. Type any part of a fire's **name**, its
**state** (`CA`, `Oregon`, `US-OR`), or its **ID**. It searches as you type, so
`si` already narrows the list. Case does not matter.

**Band.** The first dropdown sets the minimum band:
`All bands — 70`, `Watch and up — 1`, `Elevated and up — 0`, `High and up — 0`.

The number after the dash is the live count for that choice, and it is the most
useful thing in the panel. It tells you what kind of day it is before you read a
single row. A `0` next to *High and up* is not a broken filter; it is a quiet
day, and it says so.

**Sort.** The second dropdown orders the list:

| Order | What it puts first |
| --- | --- |
| `Risk first` | Highest score. The default, and usually what you want. |
| `Largest first` | Most acres. |
| `Newest first` | Most recently updated perimeter. |

**WATCHED.** Shows only the fires you have starred, and nothing else.

**CLEAR.** Appears as soon as anything is narrowed, and puts the list back the
way it was: search empty, every band, not watched-only.

If a filter matches nothing you get one sentence telling you so and what to do
about it — *"No incident meets this filter. Clear the search or widen the band."*

## 4. Reading a row

A row has three things on one line:

```
[WATCH]  27   Sisi
              OR · 1,200 ac · 40% contained · wind-driven behaviour · updated 6 h ago
```

- **Band chip** — the colour and name of the band (section 5).
- **Score** — the number that ordered the list.
- **Name**, and under it whatever the feed actually knows: state, acres,
  percentage contained, behaviour, and how long since the perimeter was updated.
  A field the feed does not carry is left out rather than shown as "unknown".

Click the row to open it. Inside:

- **The reasons**, in plain sentences: what pushed the score up, and what held
  it down. This is the part worth reading — the score is a summary, the reasons
  are the evidence.
- **The four components**, as numbers: `hazard 41 · exposure 18 · wind 55 ·
  recency 90`.
- **The evidence line**: the engine version, how well evidenced the score is
  (`well evidenced`, `partly evidenced`, `poorly evidenced`) and every input
  that was missing: `no wind field`, `containment not published`,
  `perimeter stale`.
- **FLY TO FIRE** — frames that fire on the globe, with its perimeter outline
  and the wind field switched on, so the number and the shape are the same
  object.
- **WATCH** — puts it on your list.

*"What the score means"* at the bottom of the panel repeats the four components
if you forget which is which.

## 5. The five bands

| Band | Score | Means |
| --- | --- | --- |
| **CRITICAL** | 75–100 | Several strong signals at once: active behaviour, little containment, an asset close by, wind pushing it. |
| **HIGH** | 60–74 | Serious, and short of critical on one or two of those. |
| **ELEVATED** | 45–59 | Worth tracking today. |
| **WATCH** | 30–44 | On the list, not urgent. |
| **LOW** | 0–29 | Burning, but nothing in the data says it warrants attention. |

Two things to understand about the scale.

It is **absolute, not relative**. A fire does not become CRITICAL because it is
the worst of a quiet day. If nothing in the feed is severe, nothing scores high,
and the list will be mostly LOW. That is the honest answer, not a failure.

It is **capped by the evidence**. The score is built from inputs that are
sometimes missing — behaviour not published, no wind field, cost unknown. Each
gap is recorded, and the evidence line tells you how much of the record the
score actually had. A well-evidenced 40 and a poorly-evidenced 40 are not the
same claim.

## 6. Keeping a fire

Press **WATCH** on any row. A ★ appears, and **WATCHED** filters the list down to
just those. Press **UNWATCH** to remove it.

The list lives in **this browser on this machine**. It is not attached to your
login, so it will not follow you to another computer, and nobody else can see
it. Clearing your browser data clears it.

## 7. What it cannot do

- **It does not predict spread.** No fire growth, no rate of spread, no
  projected perimeter. It ranks fires as they are reported.
- **It is not a life-safety tool.** It does not replace an evacuation order or
  an official warning. Follow your local authority.
- **Exposure means assets, not people.** It counts critical facilities near a
  fire — datacenters, dams — not homes, population or power. A fire heading for
  a town with no datacenter in it will not score as highly as it should.
- **The wind is coarse.** A 1° global grid cannot see a valley or a slope flow.
- **Perimeters lag.** The published outline can be hours behind the fire front.
  The row shows the age, and the engine marks a stale perimeter rather than
  pretending.
- **The reasons are in English** even when the interface is in another
  language.

## 8. If something looks wrong

| What you see | What it is |
| --- | --- |
| The list is empty and the map works | The live fire feed needs a NASA FIRMS key on the server. Ask whoever runs the instance. |
| `served from cache` at the bottom | The upstream feed did not answer this time, so the last good index is on screen. It is labelled rather than silently passed off as current. |
| `Refresh failed (…). Showing the last index.` | The refresh did not land. The list you are reading is the previous one. |
| Everything is LOW | Normal on a quiet day. Check the counts on the band menu. |
| A fire you expect is missing | It may be reported as contained: contained incidents are left out of the ranking by default. |

The panel refreshes every five minutes, and again when you come back to the tab.
**REFRESH** does it now. Press Escape to fold the panel away when you want the
rail for something else.
