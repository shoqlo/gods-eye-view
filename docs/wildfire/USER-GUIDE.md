# Wildfire Watch — user guide

You have a login to a shared Wildfire Watch site. Start at
**`https://<your site>/wildfire`**: the finder. It is one page, and the page
explains itself (see *How to use* at the bottom of it). This guide is the same
thing at more length.

---

## 1. Start with what you are looking for

The page opens with **What are you looking for?** and five answers. Each sets a
filter and an order, and shows how many fires it would list.

| Choose | You get | In this order |
| --- | --- | --- |
| **Fires that need attention** | Every burning US fire in the national incident feed | Highest risk score first |
| **Fires near a place** | The fire weather for that place, then the fires within the distance you pick | Nearest first |
| **Fires near infrastructure** | Fires with a datacenter or dam within 25 km, or downwind | Most exposed first |
| **New fires** | Fires discovered in the last 3 days | Newest first |
| **My watchlist** | The fires you starred | Highest risk first |

The bold line above the list always says what you are looking at, for example
*"2 of 12 fires · within 100 km of Redding, Shasta County, California · nearest
first"*. If it is not what you meant, change the choice or press **Clear filters**.

## 2. Checking a place

Choose **Fires near a place**, then type a town or an address and press
**Find**. You can also type coordinates (`40.59, -122.39`) or press **Use my
location**. Pick the distance under **Show fires within**.

If the place search guessed wrong, the other matches appear under the box; press
the right one.

You then see two separate things:

- **Fire weather near the place, next 24 hours** — Low, Moderate, High, Very high
  or Extreme, the worst hour, and why (humidity, wind, heat, recent rain). This
  is about how easily a fire *could* start and spread there. It works anywhere in
  the world.
- **The list** — fires actually burning within your distance, nearest first. It
  covers the US only, because that is what the incident feed covers.

A place can have Extreme fire weather and no fire, or a fire on a calm, damp day.
The two are never added together.

## 3. Narrowing the list

Open **Refine the list** for: a search (fire name, county or ID), a state, a
minimum risk band, a minimum size, hiding mostly-contained fires, and the order.

Missing data is common, so the rules are fixed and stated on the page:

- A **size** filter hides fires that report no size.
- The **containment** filter keeps fires that report no containment. About half
  of them do not report it.

## 4. Reading a fire

Each row shows the **band** (Critical, High, Elevated, Watch, Low), the **score**
out of 100, the name, where it is, its size, how contained it is, how far it is
from your place, and the two main reasons for its score.

Open a row to see:

- **Why this score** — the reasons in plain words. Read these; the number is a
  summary.
- **How the score is built** — four parts, each out of 100: fire behaviour (35%),
  infrastructure nearby (30%), wind (20%) and how fresh the report is (15%).
- What infrastructure is close or downwind, the wind at the fire, how well
  evidenced the score is, and which data was missing.

And three actions:

- **Watch** — keep it on your watchlist (a ★ appears).
- **View location** — the newest satellite frame with the official perimeter
  drawn on it, a date stepper, heat detections, and the nearest live cameras in
  California. A satellite frame is a day or more old and cloud can hide the
  ground; a camera may be pointing elsewhere.
- **Open on the 3D map** — the globe, on that fire, with only active fires, fire
  perimeters and wind switched on.

## 5. The bands

| Band | Score | Means |
| --- | --- | --- |
| **Critical** | 75–100 | Several strong signals at once: active behaviour, little containment, infrastructure close by, wind pushing toward it |
| **High** | 60–74 | Serious, short of critical on one or two of those |
| **Elevated** | 45–59 | Worth tracking today |
| **Watch** | 30–44 | On the list, not urgent |
| **Low** | 0–29 | Burning, but nothing in the data says it warrants attention |

The scale is absolute. On a quiet day most fires are Low, and that is the honest
answer, not a fault.

## 6. Sharing and saving

- **Copy link to this view** copies a link with your choice, place and filters.
  Anyone else with a login who opens it sees the same view.
- **Download CSV** saves the fires on screen, in the same order, with the index
  version and the time on every row — ready for a spreadsheet or a report.
- **Your watchlist** lives in this browser. It is the same list the Fire Watch
  panel keeps on the 3D map, but it does not follow your login to another
  computer, and nobody else can see it.

The list refreshes every five minutes. If new data arrives while you have a fire
open, the list waits; the line at the top says *newer data is ready* and offers
**Update the list**.

## 7. What it cannot do

- **It does not forecast spread.** It ranks fires as they are reported.
- **It is not a life-safety tool.** Follow official warnings and evacuation
  orders.
- **Infrastructure means datacenters and dams**, not homes or people.
- **The fire list is US-only.** Fire weather works anywhere.
- **The wind in the score is coarse** (a global 1° grid).
- **Perimeters lag** the real fire edge, sometimes by hours.
- **The page is in English.** The 3D map's Fire Watch panel follows your
  language setting, but the reasons it shows are English.

## 8. If something looks wrong

| You see | It means |
| --- | --- |
| *The live fire list is unavailable* | The server could not reach the incident feed. It retries every five minutes. |
| *showing the last good list* in the top line | The feed did not answer this time; you are reading the previous list, labelled as such. |
| *Fire weather is unavailable right now* | The forecast service did not answer. The fire list is unaffected. |
| *Place search is unavailable* | Type coordinates instead, or use your location. |
| Everything is Low | Normal on a quiet day. |
| A fire you expect is missing | 100% contained fires are left out. Also check the filters in the top line. |

## 9. On the 3D map

The globe at `/` has a **FIRE WATCH** panel at the top of the left rail with the
same ranking, a search, a band filter and **FLY TO FIRE**. It is for people who
want the full map. Its last line, *Open the finder*, brings you back here.
