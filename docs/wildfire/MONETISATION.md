# Monetisation

A proposal, not a commitment. Every number here is an assumption to be tested;
the mechanics are the part that has to be right first.

## The product

Three things can be sold from one index, in increasing order of effort:

1. **Watch access** — the panel and the map, as a paid tier of the app.
2. **Risk-area reports** — a per-area document (PDF or DOCX) built from the same
   JSON, issued to a client on a schedule or on demand.
3. **API access** — `/api/fire-risk` as a metered endpoint for someone else's
   product.

They share one engine, so the marginal cost of the second and third is
integration and support, not new science.

## Who buys

The index is interesting to anyone whose job changes when a fire appears near
something they own.

| Buyer | What they do with it | What they would pay for |
| --- | --- | --- |
| Insurer / reinsurer risk teams | Screen accumulations of insured property against live fire | A defensible, versioned score with an audit trail |
| Utility and telecom resilience | Decide where to pre-position crews and generators | Downwind asset exposure at 25–40 km |
| Data-centre operators | Site-level watch across a portfolio | Per-site alerting and history |
| Infrastructure funds / asset managers | Quarterly risk commentary for holdings | A scheduled report, not a live map |
| Local government / emergency planning | Situational awareness above the public feed | Population exposure (not yet built) |
| Researchers and journalists | Reproducible ranking for publication | Citable numbers and a free tier |

The strongest near-term fit is the one whose exposure the index already models:
**datacenter and dam proximity**. That is 5,048 assets today and it is exactly the
question a datacentre operator or an infrastructure fund asks.

## Tiers

| Tier | Price (assumption) | Includes |
| --- | --- | --- |
| Free | £0 | The panel, public bands, 5-minute refresh, no history, no export |
| Watch | £25–40 / month | Alerts on watched areas, email digests, 30-day history |
| Analyst | £150–300 / month | API key, 10,000 calls/month, CSV export, per-area summaries |
| Enterprise | £800–2,000 / month | Portfolio watchlist, scheduled PDF reports, SLA on data freshness |
| Report (one-off) | £400–1,200 per area | A written risk-area assessment with the index as its quantitative spine |

The one-off report is the cheapest thing to sell and the fastest way to learn what
buyers actually value: it prices a document, not a subscription, so it can be
sold before any billing infrastructure exists.

## The report product

The index already produces everything a short report needs: score, band, the four
components, reasons, confidence, flags and the limitations. A generator that
renders that into a branded PDF for one area is a day of work on top of the API,
and it is the deliverable that turns a research toy into an invoice.

Minimum contents: the area and its assets, the score with its component
breakdown, the evidence and its gaps, the method in one page, and the limitation
statement in the buyer's language — *ranking, not forecast; not life-safety*.

## What has to be true before charging

1. **Population exposure.** Selling "risk" while scoring only datacenters and dams
   is a credibility problem, not a product gap. A census pack with population per
   tract, weighted by distance and downwind position, is the first build.
2. **History.** A single score is a data point; a trend is a product. Needs a
   store and a scheduler, and it is what makes alerts meaningful.
3. **Alerting.** "Tell me when a watched area crosses ELEVATED" is the feature
   people pay for; the panel's local watchlist is the seed of it, not the thing.
4. **Licensing review.** The bundled asset packs are ODbL 1.0: attribution is
   required and share-alike applies to derived databases. Incident data (WFIGS)
   and wind (GFS) are public domain. Attribution is already shown in the panel's
   evidence line; a commercial report needs the same in its footer, and the
   share-alike question needs a lawyer's answer before any derived database is
   sold.
5. **Liability framing.** The product must not read as an evacuation or
   life-safety tool. That language is already in the panel and in
   `limitations[]`; contracts need it too.
6. **A native translation review** for any non-English release.

## Costs

- No upstream API keys or fees: every feed is public and already ingested.
- Hosting is the main line item: a tile-and-globe app plus a scheduled scorer.
- The real cost is data curation — population, verified infrastructure, and the
  QA that makes a number defensible.

## Sequencing

1. Sell one-off reports by hand, using the panel as the analysis tool. No billing,
   no infra. Learn what the buyer asks for.
2. Add history and alerting; move the watchlist into an account.
3. Open the API to the first two or three Analyst customers under a manual key.
4. Only then build the tier machinery.

The failure mode to avoid is building a subscription product before knowing which
sentence in the report the buyer actually acted on.

## Alternatives considered

- **Advertising or sponsorship on a free map.** Rejected: the audience is small and
  professional, and the credibility cost is high.
- **Selling the raw fire feed.** No moat: the feed is public.
- **Consultancy only.** Works, but does not compound; the index is the asset.
- **Per-asset risk scores as a data product.** The most valuable long-term option,
  but it needs the exposure model first.
