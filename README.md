# Front Page Time Machine

**A memory of what the public web cared about.**

Built for [Into the Scrape-Verse](https://www.wemakedevs.org/hackathons/scrape-verse) (Bright Data ×
WeMakeDevs, Aug 17–23 2026).

We capture the **front pages** of major public news homepages every hour and reconstruct how the news
cycle moved: what appeared, what was buried, what led for nine hours, and what one outlet never ran
at all.

```
npm run demo        # the whole product on synthetic data — no account needed
npm run watch       # the hourly collector: capture on the hour, heal what stays broken
npm run capture     # one real capture of every outlet that has a collector
npm run diff -- npr # what changed on that front page since the previous capture
npm run story       # cluster everything captured and trace how stories spread
npm run timeline    # render the archive into one self-contained HTML page
npm run heal -- npr # detect, repair and verify one collector
```

---

## 1. What this is

Not a news aggregator. **We are not scraping articles — we are scraping placement.**

The atomic unit of the dataset is:

> at 14:00, Outlet X had story Y at rank 3, above the fold, with a photo.

Once the unit is placement rather than content, the interesting questions become arithmetic:

- What did the front pages lead with at 10:00, and what changed by 14:00?
- Which outlet ran a story first, and how long did the others take to pick it up?
- Which outlets never carried it at all?
- If you joined the news cycle at 6pm, what did you miss?

## 2. Why homepage data is useful

An article is a fact about the world. A **homepage is a fact about an editor** — a ranked, timestamped
statement of what one newsroom thought mattered most, replaced every few hours and preserved nowhere.
Article archives are everywhere. Front-page archives essentially do not exist, because the page
overwrites itself.

## 3. Why traditional scrapers fail here

Homepages are the most redesigned, most A/B-tested pages on the web. `.css-1vxca1d > h2` survives
until the next deploy. Twenty outlets means twenty layouts, all drifting independently, and two
visitors can be served different homepages at the same moment.

So self-healing is not a contrived demo requirement for this project. It is Tuesday.

## 4. How Bright Data Scraper Studio is used

Scraper Studio **is** the extraction layer. There is no Puppeteer, no Playwright, no Cheerio, and no
hand-rolled parser anywhere in this repository — [`src/collect/brightdata.ts`](src/collect/brightdata.ts)
is the only module that touches the network, and all it does is shell out to the CLI and carry the
result across.

| Command                           | Used for                                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| `brightdata scraper create`       | Build one collector per outlet from a plain-language description |
| `brightdata scraper run`          | The hourly capture                                               |
| `brightdata scraper heal`         | Repair after a redesign — stops at an approval gate              |
| `brightdata scraper approve`      | Commit the repair                                                |
| `brightdata scrape -f screenshot` | Full-page homepage screenshot (Unlocker, 1 credit)               |

Screenshots deliberately use the **Unlocker** path rather than the Browser API: Unlocker is covered by
the free/promo credit pool and still captures the entire scrollable page (verified: NPR's homepage
came back as a 1265 × 14191 PNG). The Browser API bills separately for the same picture.

## 5. How the custom collector works

`scraper create` takes **one URL and one description**, and `--urls` batching only works across pages
of the same shape — so twenty homepages cannot share one collector. The architecture that falls out of
that is the interesting one:

> **One collector per outlet. One identical plain-language description across all of them.**

That shared description is [`collectors/homepage-description.txt`](collectors/homepage-description.txt),
and it is one sentence long:

> Extract the headline, article URL, section, and position of every news story on this homepage.

**Ninety-five characters, and that is the finding.** We ran six variants against the live API. The
detailed one — 958 characters of field names, exclusions and semantic guidance, comfortably inside the
advertised 1000-character limit — was rejected outright as `Invalid description`. A 427-character
version was accepted and produced a _degenerate_ collector: a nested `stories` array it then never
populated, 31 rows of `{"stories": []}`. The one-sentence version produced 34 real stories.

Past some point, telling the AI Flow more about the shape you want makes it invent shape rather than
find content. A description this short also survives a redesign in a way no selector can, because it
names intent and nothing structural. Full experiment, including the undocumented length ceiling around
427–530 characters, in [`collectors/README.md`](collectors/README.md).

Six outlets are configured in [`src/config/outlets.ts`](src/config/outlets.ts), chosen for structural
difference rather than editorial balance — proving one schema over six look-alike layouts would prove
nothing. That choice paid: the identical sentence produced a flat canonical extraction on the
Guardian, a nested one on the BBC, and two collectors that omitted headlines entirely.

## 6. How self-healing works

**Bright Data never decides a scraper is broken. We do.** That detector is the substance of this
project, and it lives in [`src/health/health.ts`](src/health/health.ts).

Health is computed against a **trailing median of the last five good captures for that outlet**, so a
front page swinging from 38 to 44 stories over a morning reads as a quiet news hour, not as damage:

| Signal                          | Degraded                         | Failed    |
| ------------------------------- | -------------------------------- | --------- |
| story count vs trailing median  | < 50%                            | 0 records |
| over-extraction                 | > 2.5× median, or > 300 absolute | —         |
| headline extraction failures    | ≥ 10% of rows                    | ≥ 50%     |
| article_url extraction failures | ≥ 5% of rows                     | ≥ 50%     |
| duplicate-URL rate              | ≥ 30%                            | ≥ 60%     |
| a field that used to arrive     | now 0%                           | —         |
| raw vocabulary drift            | a lost field fed canonical data  | —         |
| upstream error rows             | any                              | all rows  |
| rank contiguity                 | —                                | not 1..N  |

The over-extraction row is the newest and exists because the live Fox News collector proved the
gap: 1,911 raw rows collapsing to 499 "stories", every one validating, no signal firing. Too many
stories is the quieter failure — nav links and footer rails all have a headline and a URL, so the
archive corrupts without a single schema violation, and rank 1 stops meaning "the lead". The
absolute ceiling matters as much as the ratio: a collector that over-extracts from its _first_
capture poisons its own baseline, so "2.5× the median" alone would call 499 normal by tomorrow.

Two details that make it a real detector rather than a threshold table:

**Rejection reasons are counted at the point of rejection.** The strict schema makes the evidence
unrecoverable afterwards — a record with no headline never becomes a record — so a finished capture
cannot tell you whether it holds three stories because the news was quiet or because headline
extraction collapsed. [`CaptureDiagnostics`](src/schema/normalize.ts) counts as it drops.

**The baseline excludes empty captures.** If an outlet breaks for three hours, a naive median slides
toward zero and declares the outage normal — the detector would heal itself into blindness.

**Every heal is a record, not a log line.** Episodes persist append-only to `episodes/<source>.ndjson`
with the generated prompt, the outcome counts, and **phase marks** — timestamps for AI generation,
approval and the verification re-run, so "the heal took 24 minutes" decomposes into "21 of them were
AI generation". The timeline renders this ledger beside the news: the collector fleet healing on the
same clock as the front pages it watches.

**And the collector's own vocabulary is watched for drift.** Each capture records the raw field
names it arrived with (`raw_fields` in diagnostics). The alias layer exists to absorb renames — which
also _hides_ them: a heal that renames `author_name` to `author` produces identical canonical records
and a green report, right up until a rename lands on a field the aliases don't know. Vocabulary loss
is graded by consequence — degraded if the lost field fed canonical data, recorded-but-quiet if it
was ballast.

Then the debounce: healing fires only after **two consecutive** non-healthy captures. One bad capture
is a blip; two is a redesign.

The repair prompt is **generated from the health report**, never hand-written:

> The homepage scraper for https://www.npr.org is returning bad data: 18/20 rows had an empty headline
> (90%); 2 stories against a trailing median of 20. Fix the extraction so every story card on the page
> yields all of these fields, with these exact names: headline, article_url, section, summary,
> image_url, published_at, story_type, position. Do not rename, add or drop output fields. Still
> working: url_extraction, duplicate_urls, position_integrity. Locate stories by their semantic role…

Naming what still works is diagnostic gold: if URLs survive and headlines do not, the anchor is intact
and only the text node moved. That narrows the search instead of inviting a rewrite.

The loop, in [`src/heal/run-heal.ts`](src/heal/run-heal.ts):

```
run → health verdict → DEGRADED ×2 → heal (stops at approval gate)
    → approve → RE-RUN AND COUNT → RECOVERED
```

The last step is the one most demos skip — and running a real heal proved why it cannot be skipped.

We healed the live NPR collector on 2026-08-17, asking for three extra fields. Every mechanical step
behaved exactly as documented: the approval gate held, `approve` returned `status: "done"` with
`user_approval` in its step list, and the `collector_id` never changed. The `preview_result` showed
all three new fields populated.

Then we re-ran the collector. **None of the three fields were there.** The preview had also shown a
regression in `publish_date` that likewise never happened. The only change that actually shipped was
a field rename nobody asked for. Full evidence in
[`collectors/README.md`](collectors/README.md#the-heal-we-actually-ran--and-why-we-verify-by-re-running).

So `preview_result` does not reliably describe the committed collector, and `status: "done"` does not
mean the data changed. A pipeline that trusts either one will report a successful repair and quietly
ship an archive missing three columns. Ours re-runs and counts.

**We have now run three heals against three live collectors. One delivered.** All three returned
`status: "done"` with `user_approval` in the step list, and only re-running told them apart:

| Collector      | Asked for                  | What re-running showed                                       |
| -------------- | -------------------------- | ------------------------------------------------------------ |
| NPR            | add summary / image / type | nothing changed, plus an unrequested field rename            |
| **CNN**        | fix 60% missing headlines  | **real gain** — summary, image and a true timestamp on 26/26 |
| **Al Jazeera** | fix 100% missing headlines | nothing changed                                              |

One in three is a better argument for the design than three in three would be. CNN went from
`{position, url}` to the richest records in the dataset; Al Jazeera moved not at all. Nothing in the
API response distinguished them.

### Knowing when not to heal

Healing costs 15–30 minutes of AI Flow and a concurrency slot other outlets are waiting for, so firing
one at a problem it cannot fix is expensive. Late in the build, Al Jazeera began returning rows
carrying `error_code: "proxy_error"` — an account rate limit. The run succeeded, 14 rows arrived, and
the pipeline reported _"14/14 rows had an empty headline"_: an accurate symptom and a badly wrong
cause. The debounce would have asked the AI to fix selectors that were never broken.

`upstream_error` is now its own health signal, and `isHealable` gates the watcher on it. The debounce
asks **is this real?**; this asks **is this ours?**

### Two operational limits, both measured

The CLI's default **600-second heal timeout is too short**: the CNN repair ran through seven
`code_fixer → preview → validator` cycles and was still going when the client gave up at attempt
600/600. `DEFAULT_HEAL_TIMEOUT_SECONDS` is now 1800. And a client-side timeout **does not cancel the
server-side job** — retrying immediately returns `409 Another refactor job is still in progress`, so
`isRepairAlreadyRunning` reports that as its own condition. "Wait for it" and "try a sharper prompt"
are opposite instructions.

Both failures were non-destructive, in the CLI's own words: _"the heal did not complete, but scraper
`c_msx92d0stuuf3xkqr` is unchanged and still works as it did before."_ That property is what the whole
gated design rests on, and it held under two consecutive failures.

## 6b. The hourly collector

`npm run watch` is what turns this from five files someone ran by hand into an archive. Each tick it
captures every configured outlet, judges each one, and heals the ones that have stayed broken —
unattended, which is the only condition under which self-healing is worth anything.

```
npm run watch                      # on the hour, forever, gated heals
npm run watch -- --now --ticks 3   # three captures starting immediately
npm run watch -- --interval 15     # quarter-hourly
npm run watch -- --autonomous      # commit heals without waiting for approval
npm run watch -- --no-heal         # observe and report only
```

Four decisions in [`src/schedule/`](src/schedule/) that are not obvious until you run it overnight:

**Ticks land on wall-clock boundaries, not now-plus-an-hour.** A capture that takes 90 seconds would
push the next to :01:30, then :03:00, and by tomorrow the series is 20 minutes out of phase. That
quietly ruins both things the project exists to do — cross-outlet comparison needs every outlet
sampled at the same instant, and "what changed in an hour" must not silently become 68 minutes.
Aligning makes a late run lose its lateness instead of accumulating it.

**Missed ticks are counted, never backfilled.** When a laptop sleeps through four captures, running
them late would file the _current_ front page under a past hour. The gap is reported as a gap. An
honest hole in the archive is worth more than a plausible fabrication.

**The debounce is primed from disk at startup.** Otherwise restarting the watcher forgets that a
collector has been broken for five hours and grants it another two hours of grace, every restart.

**A gated heal latches.** It is waiting on a human; re-requesting it at 03:00, 04:00 and 05:00 burns
the AI-flow concurrency cap and buries the one notification that mattered. It re-arms when the outlet
recovers.

**And it declines to heal what a heal cannot fix.** `isHealable` blocks the repair when the failure is
upstream — a rate limit, a blocked request — because the collector was never the problem. See §6.

A tick that throws is caught and counted. Losing one capture is a hole; losing the loop loses every
hour after it, and unattended is exactly when nobody notices.

All of it is tested against a **fake clock** — a full day of captures, drift, sleep gaps and aborts,
asserted in milliseconds instead of hours.

## 6c. Proving the loop on demand — the fixture drill

Real publishers redesign on their schedule, not the demo's. [`mock/`](mock/README.md) holds **The
Meridian Dispatch** — one clearly-labeled synthetic front page in two layouts: v1 (semantic, the
page a collector is built against) and v2 (the hostile redesign: same stories, restructured DOM,
build-hash class names). Host v1 publicly, build a collector, swap in v2, and the entire
detect → debounce → heal → approve → verify loop runs for real against a break you control.
Artifact-hosting the fixture was tested and does not work (details in the mock README); the fallback
is `fptm demo`'s scripted break, which is always disclosed as simulated.

## 6d. The timeline UI

`npm run timeline` renders the whole archive into **one self-contained HTML file** — inline CSS and
JS, data embedded as JSON, zero network requests, works from a double-click on a machine with no
internet. A time scrubber moves across capture moments (grouped by gap, not by a wall-clock grid,
so six serially-fetched outlets read as one editorial moment); each outlet renders as a front-page
card with rank badges and ▲▼/NEW movement against its previous capture; a divergence strip shows
the hours the outlets disagreed most, clickable to jump; clicking any story highlights the same
story everywhere it appeared and shows its propagation table.

Clustering and entropy are computed at build time by the same tested functions `fptm story` uses —
the embedded JavaScript only selects and displays, so the page can never disagree with the CLI about
what a story is. Headlines are escaped as hostile input everywhere they land, including inside the
JSON island, where a headline containing `</script>` would otherwise end the data block and execute
the rest of the page.

## 7. Schema preservation — the guarantee

The extraction implementation may change. **The schema may not.**

`StorySnapshotRecord` is the contract everything downstream depends on. When a publisher redesigns,
the healed collector returns a _different raw shape_ — absolute URLs where they were relative,
positions as strings, extra fields the new template emits — and the timeline engine must not be able
to tell.

That is an executable test, not a claim:
[`test/story-snapshot.spec.ts`](test/story-snapshot.spec.ts) feeds both raw shapes through
normalization and asserts **byte-identical** canonical records. If self-healing ever becomes a
breaking change, the suite goes red.

## 8. How output is normalized

```
source · source_name · captured_at · capture_id · section · headline · article_url
summary · image_url · published_at · position · story_type · is_lead · prominence_tier
```

Three rules do the heavy lifting:

**Dedupe by URL, never by headline.** Live blogs rewrite their headline hourly against a fixed URL.
Headline-keyed identity would either destroy that churn or explode one story into twelve. Instead the
churn is captured as its own signal (`headline_rewrites` in the diff) — a story being actively
reworked is editorial attention made visible.

**Prominence is ordinal, never visual.** `lead` (rank 1) / `above_fold` (2–5) / `below`. Font sizes and
hero modules are not comparable across outlets, so any pixel-weight score turns the methodology into
the argument. Rank within one outlet's own page is a fact.

**Ranks are re-ranked contiguous after dedupe.** A homepage links its lead from both the hero and a
sidebar rail, so raw positions have holes once deduped — and a hole is exactly what the
position-integrity check reads as damage.

## 9. How snapshots are stored

Append-only NDJSON at `snapshots/<source>/<YYYY-MM-DD>.ndjson`, one line per capture. A filesystem,
not a database: a week of six outlets hourly is ~1,000 captures, a scale where a database buys nothing
and costs a service to run mid-demo. One capture is one append and is never rewritten, so a crash
costs at most the line in flight — and the history behind it is irreplaceable, because a homepage
cannot be re-fetched as it was an hour ago.

A malformed line is skipped rather than thrown, for the same reason.

## 10. How story propagation is derived

Clustering ([`src/analyze/cluster.ts`](src/analyze/cluster.ts)) runs **downstream of scraping** and is
deterministic — single-link agglomerative over headline token containment, plus same-URL forcing so a
retitled live blog stays one story. Containment rather than Jaccard because one outlet writes six words
and another writes eighteen, and Jaccard punishes the length gap.

A model would cluster better on hard cases, but a demo whose grouping changes between two runs of the
same data cannot be tested and cannot be trusted on stage. The seam for an embedding pass is the
similarity function; everything downstream is unchanged.

Propagation then reports, per outlet: first seen, last seen, peak rank, captures spent as lead — and
`never_covered`, the outlets that never carried it at all.

### The bias discipline

**We measure attention, not alignment.** No tone analysis, no sentiment, no left/right score, no
ranking of outlets. Placement, duration and timing are facts:

> Outlet A led with this for 8 hours. Outlet D never placed it above the fold.

That sentence contains no opinion and needs no defending — and it is more damning than any score. We
hold up the x-ray; the reader draws the conclusion. Headlines are quoted **verbatim** with timestamps;
the moment you paraphrase a headline you have editorialised it.

## 11. Running it

```bash
npm install
npm run verify          # typecheck + lint + format + tests + coverage
npx tsx src/cli/fptm.ts demo
```

`demo` needs no Bright Data account — it runs the whole pipeline on clearly-labelled synthetic data.

For real captures:

```bash
npm install -g @brightdata/cli
brightdata login --api-key <key>       # also auto-creates the cli_unlocker zone

brightdata scraper create https://www.npr.org "$(cat collectors/homepage-description.txt)" \
    --name fptm-npr -o collectors/create-npr.json

# put the returned collector_id in .env — one entry per outlet
echo 'FPTM_COLLECTORS=npr:c_xxxxxxxx,bbc:c_yyyyyyyy' >> .env

npm run capture                    # once, to check it works
npm run watch                      # then leave it running
```

Generation takes 5–10 minutes per collector and Bright Data caps AI Flow at **3 concurrent jobs** —
launching five at once is fine (the CLI backs off and retries through the 429), but budget the
wall-clock. One of our five exhausted the 600-second polling timeout and had to be rebuilt, leaving a
half-built template behind; `--timeout 1500` avoids that.

**Collecting history on a machine that cannot stay running:** the archive design tolerates this
honestly — gaps are counted, never backfilled. When the machine is available, run a dense burst so
the timeline has movement to show:

```bash
npm run watch -- --now --interval 15 --ticks 8   # two hours of quarter-hourly captures
```

Bursts at 15-minute cadence catch real editorial movement (we measured a story climbing 25→6 inside
nine minutes); the hourly cadence is the steady-state target, not a requirement for the analysis to
work.

Nothing here needs a `.env` to run `demo`, and no key is ever read outside
[`src/collect/brightdata.ts`](src/collect/brightdata.ts).

## 12. Example structured output

One real line from `snapshots/cnn/2026-08-17.ndjson`, trimmed to a single record. Nothing here is
illustrative — this is a capture of CNN's front page taken at 14:27 UTC, from the collector that was
repaired by `scraper heal` earlier the same afternoon:

```json
{
  "capture_id": "60f0c42b-c87d-4b02-9754-444f937a5d75",
  "source": "cnn",
  "source_name": "CNN",
  "homepage_url": "https://edition.cnn.com",
  "captured_at": "2026-08-17T14:27:29.192Z",
  "collector_id": "c_msx92d0stuuf3xkqr",
  "screenshot_path": null,
  "diagnostics": {
    "raw_count": 66,
    "rejected_no_headline": 40,
    "rejected_no_url": 0,
    "collapsed_duplicates": 0,
    "rejected_self_link": 0,
    "rejected_upstream_error": 0
  },
  "records": [
    {
      "source": "cnn",
      "source_name": "CNN",
      "captured_at": "2026-08-17T14:27:29.192Z",
      "capture_id": "60f0c42b-c87d-4b02-9754-444f937a5d75",
      "section": "health",
      "headline": "Influencer explains why he promotes steroids",
      "article_url": "https://cnn.com/2026/08/16/health/video/influencer-explains-why-he-promotes-steroids-digvid-vrtc",
      "summary": "Fitness influencer Ryan Johnson use his mantra \"Tan. Jacked. Handsome\" to promote testosterone use to his followers…",
      "image_url": "https://media.cnn.com/api/v1/images/stellar/prod/vertical-2-thumbnail-clean.jpg?c=9x16",
      "published_at": "2026-08-16T10:26:33.965Z",
      "position": 1,
      "story_type": "unknown",
      "is_lead": true,
      "prominence_tier": "lead"
    }
  ]
}
```

Note that `diagnostics` is telling on the collector: 40 of 66 rows arrived with no headline. The
record above is real and usable, and the capture it belongs to is classified **FAILED** — those two
facts coexisting is exactly what the diagnostics block exists to make visible.

### What the archive can already answer

From 1,496 records across six outlets, `npm run story` reconstructs propagation with no model in the
loop and no editorialising — placement and timing only:

```
"Ebola outbreak in DR Congo becomes deadliest in its history"
  first seen: BBC News at 13:25
  BBC News     13:25-14:27  peak rank 75 (below)      3 capture(s), led 0
  CNN          13:26-14:27  peak rank 4 (above_fold)  3 capture(s), led 0
  The Guardian 13:31-14:02  peak rank 15 (below)      2 capture(s), led 0
  never carried it: aljazeera, foxnews, npr

"Kushner meets with Hamas on the Gaza road map ahead of talks with Netanyahu"
  first seen: NPR at 11:58
  NPR          11:58-14:26  peak rank 2 (above_fold)  7 capture(s), led 0
  BBC News     13:25-14:27  peak rank 3 (above_fold)  3 capture(s), led 0
  The Guardian 13:31-14:02  peak rank 43 (below)      2 capture(s), led 0
  Al Jazeera   14:32-14:32  peak rank 1 (lead)        1 capture(s), led 1
  never carried it: cnn, foxnews
```

The same story sat at rank 4 on CNN and rank 75 on the BBC. Al Jazeera led with a story CNN and Fox
never ran. Those sentences contain no opinion and need no defending — which is the entire design.

## 13. Architecture

```
src/collect/    Bright Data ONLY. Knows about collectors. Knows nothing about stories.
src/schema/     zod contracts, URL normalization, diagnostics. The stable boundary.
src/store/      Append-only NDJSON: snapshots AND the heal-episode ledger. No database.
src/health/     Deterministic classification. Pure functions. No AI, no network.
src/heal/       Report → generated prompt → heal → approve → verify.
src/schedule/   Cadence (pure time math) + the per-tick capture/heal orchestration.
src/analyze/    Diff, clustering, propagation. The only place interpretation happens.
src/report/     Rendering. Takes finished values, returns strings.
src/cli/        Entry point.
```

The rule that keeps it honest: **`health/` and `analyze/` never import from `collect/`.** Health is
arithmetic over records; clustering is interpretation over records. Neither may know that a publisher
redesigned anything.

The whole pipeline above `collect/` is pure and offline, which is why the entire suite runs with no
network and no API key. `src/schedule/tick.ts` holds the time arithmetic and `src/schedule/watch.ts`
the orchestration, split for the same reason — the cadence is provable without waiting for it.

## 14. Technical decisions and trade-offs

| Decision                    | Why                                            | Cost                                           |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| One collector per outlet    | `scraper create` is single-URL; layouts differ | 5–10 min generation each, 3 concurrent cap     |
| Filesystem NDJSON, not a DB | ~1,000 captures/week; nothing to run on stage  | No concurrent writers                          |
| Deterministic clustering    | Reproducible, testable, demoable               | Weaker than embeddings on hard cases           |
| Ordinal prominence tiers    | Honest and comparable                          | Loses within-page visual weight                |
| Unlocker screenshots        | Covered by credits, full-page                  | No interaction (cookie walls need Browser API) |
| Debounce of 2 captures      | Kills false alarms                             | One hour slower to react                       |
| In-process loop, not cron   | Keeps the debounce in memory; runs anywhere    | Dies with the terminal; no restart supervision |
| Boundary-aligned ticks      | Comparable across outlets, even spacing        | A slow capture is stamped to its boundary      |
| Gaps counted, never filled  | A late capture would misfile the current page  | Holes in the archive, honestly labelled        |
| Gated heals by default      | A human sees the fix before it commits         | Nothing repairs itself overnight unless asked  |

**Known limitations.** The dataset is only as old as the hackathon. Clustering is token-based and
merges templated boilerplate headlines (found while building the demo fixture, documented in
[`src/demo/seed.ts`](src/demo/seed.ts)). Regional editions are pinned per outlet, so we observe one
edition and not the reader's. A/B-tested homepages are logged, not resolved. The live NPR collector
returns no `summary`, `image_url` or `story_type`, and its date has no time component — see
[`collectors/README.md`](collectors/README.md) for why a heal did not fix that. Captures written
before diagnostics were persisted read back with `diagnostics: null`, so a heal prompt built from one
of those is necessarily vaguer.

Two more found by running six live collectors rather than one. **Promotional cards are extracted as
stories**: the Guardian's rank-1 slot came back as "Sign up to The Hotspot", a newsletter signup that
genuinely occupies that position on the page — so `is_lead` is currently "the top thing on the page",
not "the top story". **One capture was corrupted by our own normalizer** and has been withdrawn to
[`snapshots/_quarantine/`](snapshots/_quarantine/README.md) rather than deleted; the cause and the
signal that exposed it are written up there.

## 15. AI coding tools used

Built with **Claude Code** (Claude Opus 5). Bright Data's own AI Flow generates the collectors from the
plain-language description, and its Self-Healing flow performs the repairs. The detection logic,
thresholds, debounce, prompt generation and the entire pipeline above the collector are deterministic
code with tests.

---

## Test results

```
227 passing
Statements  94.28%   Branches  86.42%   Functions  92.88%   Lines  94.28%
typecheck ✓   lint ✓   format ✓
```

No network, no API key, no Bright Data account. `src/cli/**` is excluded from coverage — it is the I/O
shell, and everything it orchestrates is tested directly.
