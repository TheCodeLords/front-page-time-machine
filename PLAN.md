# Front Page Time Machine — Implementation Plan (Phase 1 deliverable)

## 1. Repository decision — a fresh, standalone, public repo

This project is built from scratch in a standalone repo of its own, because the hackathon requires
a public repository link and public web data only — so nothing here may depend on, or sit inside,
anything private or work-related.

### Conventions adopted from the start

| Convention                                                                     | Why                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------- |
| Node ESM (`"type": "module"`), Node >= 18                                      | matches the Bright Data CLI's requirements   |
| **zod** for schema validation                                                  | the schema IS the product's stable contract  |
| mocha + chai, c8 coverage                                                      | fast, dependency-light, no framework lock-in |
| ESLint 9 flat config + prettier, `format:check` in CI                          | one style, enforced, never discussed         |
| A single `npm run verify` that runs every gate and is green on a fresh clone   | red must always mean a real regression       |
| Secrets via env/`.env`, never committed; `.gitignore` calls out "NEVER commit" | keys were provided in chat and must not leak |

### What we explicitly do NOT use

No Puppeteer, no Cheerio, no hand-rolled DOM parsing anywhere — however tempting a local
repeated-structure detector would be, using one as the extraction layer would directly violate the
hackathon rule "do not replace Scraper Studio with Puppeteer/Cheerio/custom scraper." Scraper Studio
**is** the scraping layer. No exceptions.

---

## 2. Account status — RESOLVED, pipeline is live

The earlier "create a Web Unlocker zone by hand" guidance was wrong. CLI README line 148: _"On first
login the CLI checks for required zones (`cli_unlocker`, `cli_browser`) and creates them
automatically if missing."_ Running `brightdata login --api-key <key>` (non-interactive) did exactly
that — no control-panel work was needed.

```
Logged in successfully. Key: 783b****ebdc
Checking for required zones...
Zone "cli_unlocker" created successfully.
Zone "cli_browser" created successfully.
```

**Verified working end to end:**

| Check                                                 | Result                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `brightdata zones`                                    | `cli_unlocker` (unblocker), `cli_browser` (browser_api) |
| `brightdata scrape https://example.com -f markdown`   | real content returned                                   |
| `brightdata scrape https://www.npr.org -f screenshot` | valid PNG, **1265 × 14191** — full-page, not viewport   |

The screenshot result matters: `-f screenshot` captures the **entire scrollable homepage** by default,
through the Unlocker zone at 1 credit. That is the demo's visual backbone at ~$5 for the week, with no
Browser API spend.

**One remaining gap, non-blocking:** `brightdata budget` still returns `403 — API key lacks the
required permissions`. The _user account_ is Admin, but the **API key itself** is scoped `User`
(these are two separate rows in the control panel). This gates only balance/finance reads — not
scraping, screenshots, or Scraper Studio.

Worth fixing anyway: over a week of hourly collection we want to watch credit burn.
**https://brightdata.com/cp/setting/users → API keys row → ⋯ → Edit → Permissions: `User` → `Admin` → Save.**
If the key value changes on save, update `.env`.

---

## 3. Proposed schema — the contract everything downstream depends on

One zod schema, `StorySnapshotRecord`. Stable across every publisher. No publisher-specific names.

```ts
source            string     // stable slug: "bbc" | "cnn" | "foxnews" | ...
source_name       string     // display: "BBC News"
captured_at       ISO-8601   // when WE observed the homepage (ours, authoritative)
section           string?    // "Top Stories" | "World" | "Business" | ... | null
headline          string     // verbatim, never paraphrased
article_url       URL        // absolute, normalized — the dedupe identity
summary           string?
image_url         URL?
published_at      ISO-8601?  // publisher's own timestamp when exposed
position          int >= 1   // ordinal prominence within this capture
story_type        enum       // article | video | live | update | unknown
```

Three additions that materially improve the product:

| Field                                                | Why                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `is_lead` boolean                                    | the single most prominent story — the scrubber's per-outlet card renders exactly this                   |
| `prominence_tier` enum `lead \| above_fold \| below` | ordinal bucketing; avoids cross-outlet pixel-weight scoring, which is a methodology fight we don't need |
| `capture_id` uuid                                    | groups all records from one homepage fetch; makes snapshot diffing a set operation                      |

**Normalization rules baked into the loader, not the collector:**

- Dedupe by **normalized `article_url`**, never by headline text. Live blogs rewrite headlines hourly
  against a fixed URL — that churn is _data_, not duplication.
- URL normalization: strip tracking params (`utm_*`, `ito`, `at_*`), resolve relative → absolute,
  drop fragments, lowercase host.
- `position` is ordinal within the capture. Never compared across outlets as a raw number.

---

## 4. Target sites — 6 to start

Chosen for _structural_ difference, not editorial balance. All homepages are public, no auth, no paywall.

| Slug        | URL (edition pinned)                        | Layout character                   |
| ----------- | ------------------------------------------- | ---------------------------------- |
| `bbc`       | `https://www.bbc.com/news`                  | dense card grid, semantic markup   |
| `cnn`       | `https://edition.cnn.com`                   | heavy JS zones, container-based    |
| `foxnews`   | `https://www.foxnews.com`                   | big lead + classic list            |
| `npr`       | `https://www.npr.org`                       | clean semantic HTML, simplest case |
| `aljazeera` | `https://www.aljazeera.com`                 | international, different DOM idiom |
| `guardian`  | `https://www.theguardian.com/international` | very dense grid, many sections     |

**Edition pinning matters** — `bbc.com/news` vs `bbc.co.uk/news` and CNN US vs International serve
different front pages. Pin one per outlet or the time series silently drifts.

Before first capture: check each `robots.txt` and record the result in the repo. Homepages are public,
but we should be able to show we checked.

Scale to 10–20 only after the diff engine works. Breadth is a multiplier, not a foundation.

---

## 5. Module layout — strict separation of concerns

```
src/
  collect/      Bright Data ONLY. scraper create/run wrappers, screenshot capture.
                Knows about collectors. Knows nothing about stories.
  schema/       zod contracts + URL normalization. The stable boundary.
  store/        append-only NDJSON snapshots on disk, one file per capture.
                No database. Filesystem is enough for a week of history.
  health/       deterministic validation → HEALTHY|DEGRADED|FAILED|HEALING|RECOVERED.
                Pure functions over records. No AI. No network.
  heal/         reads a health verdict, invokes `scraper heal` → approve → verify.
  analyze/      snapshot diff (new/removed/moved/persisted), story clustering.
                The only place AI is allowed.
  report/       CLI output + the timeline UI feed.
```

The rule that keeps this honest: **`health/` and `analyze/` never import from `collect/`.** Health is
arithmetic over records; clustering is interpretation over records. Neither may know a publisher
redesigned anything.

---

## 6. Self-healing design — thresholds, not hair-triggers

Health is computed against a **trailing median of the last 5 successful captures for that outlet**, so
normal news volatility never reads as failure.

| Signal                     | DEGRADED threshold        | FAILED threshold |
| -------------------------- | ------------------------- | ---------------- |
| story count                | < 50% of trailing median  | 0 records        |
| `headline` completeness    | < 90% non-empty           | < 50%            |
| `article_url` completeness | < 95% valid absolute URLs | < 50%            |
| duplicate-URL ratio        | > 30%                     | > 60%            |
| `position` integrity       | gaps/non-monotonic        | all null         |
| fetch itself               | —                         | error / timeout  |

**Debounce:** healing fires only after **2 consecutive** non-HEALTHY captures for the same outlet.
One bad capture is a blip; two is a redesign. This is the difference between a real reliability
system and a demo that fires on noise.

**Healing loop** (all CLI-scriptable — verified in the v0.3.4 README):

```
run → health verdict DEGRADED×2
  → scraper heal <id> "<generated diagnosis>"      # stops at approval gate
  → inspect preview_result against the zod schema  # schema-preserving check
  → scraper approve <id>                           # commit
  → scraper run <id> → re-validate → RECOVERED
```

The diagnosis prompt is **generated from the health report**, not hand-written — e.g. _"headline field
is empty on 38 of 41 records; article_url still populated; the headline element moved."_ That is the
part judges will recognise as engineering rather than a demo script.

Critically: `heal` preserves `collector_id`, and a failed heal is non-destructive. The downstream
contract (`§3` schema) is asserted before and after healing by the same zod parse. **The schema is the
thing that must not change; the extraction is free to.**

---

## 7. Build order

| Stage | Deliverable                                                                | Gate                                  |
| ----- | -------------------------------------------------------------------------- | ------------------------------------- |
| 0     | repo scaffold, `npm run verify` green on empty repo                        | lint+format+test pass                 |
| 1     | zod schema + URL normalization + tests                                     | tests pass, no network                |
| 2     | one collector (NPR — simplest) via `scraper create`, real output validated | real JSON parses against schema       |
| 3     | remaining 5 collectors, `collectors.json` registry                         | 6 collectors, all validated           |
| 4     | hourly capture loop + NDJSON store + screenshots                           | **starts the clock — history begins** |
| 5     | health module + tests                                                      | fixtures for every threshold          |
| 6     | snapshot diff (new/removed/moved/persisted)                                | the first real product output         |
| 7     | heal integration + observability report                                    | recorded RECOVERED transition         |
| 8     | story clustering (AI layer, isolated)                                      | cross-publisher propagation           |
| 9     | timeline UI                                                                | scrubber + heatmap                    |

**Stage 4 is the one with a deadline attached.** Every hour it isn't running is history we cannot
backfill. It should land today, even against 2 outlets, and widen afterwards.

---

## 8. Open question for you

Story clustering (Stage 8) needs an LLM or an embedding model. Options: Claude API, a local
embedding model, or batch-prompting through an existing key. This is the only external dependency
beyond Bright Data — flagging it now so it isn't a surprise at Stage 8.
