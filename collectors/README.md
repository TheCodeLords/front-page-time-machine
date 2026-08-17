# Collector descriptions — what the AI Flow actually accepts

`homepage-description.txt` is the shared plain-language description passed to
`brightdata scraper create`. It is deliberately short. That is not laziness — it is the result of
running six variants against the live API on 2026-08-17.

## Results

| #   | Description                                                                                          | Chars | AI generation                              | Collector output                                                                         |
| --- | ---------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | Full spec, bullets, field names, exclusions, semantic guidance                                       | 2065  | ✗ `400 description length must be <= 1000` | —                                                                                        |
| 2   | Same, compressed                                                                                     | 958   | ✗ `400 Invalid description`                | —                                                                                        |
| 3   | Same, newlines flattened to one line                                                                 | 958   | ✗ `400 Invalid description`                | —                                                                                        |
| 4   | Prose, field names, exclusions, no parentheses                                                       | 965   | ✗ `400 Invalid description`                | —                                                                                        |
| 5   | Prose with `article_url` style names + exclusions + semantic hint                                    | 427   | ✓ done                                     | **degenerate** — nested `stories: []`, always empty                                      |
| 6   | **"Extract the headline, article URL, section, and position of every news story on this homepage."** | 95    | ✓ done                                     | **34 real stories** with headline, section, publish_date, publish_time, product_page_url |

## Two findings worth carrying forward

**There is an undocumented ceiling well below the stated 1000 characters.** The API advertises a
1000-character limit and enforces it with an explicit length error at 2065. But a 965-character
description that is comfortably under that limit is rejected as `Invalid description` with no
explanation, while 427 and 95 both pass. The practical ceiling sits somewhere between 427 and 530
characters. Budget for the smaller number.

**A more prescriptive description produced a worse scraper.** Variant 5 named every field explicitly
and told the AI to return stories in top-to-bottom order. The generated collector interpreted that as
a nested `stories` array — and then never populated it, returning 31 rows of `{"stories": []}`.
Variant 6 said far less and produced 34 real stories. Past some point, telling the AI Flow more about
the shape you want makes it invent shape rather than find content.

## Consequence: we adapt to the collector, not the other way round

Variant 6 named the link `product_page_url`, not `article_url`, and split the timestamp into
`publish_date` and `publish_time`. It emitted no `position` field at all.

So [`src/schema/field-aliases.ts`](../src/schema/field-aliases.ts) maps collector vocabulary onto our
canonical names before validation, and the normalizer falls back to document order when `position` is
missing. Without that layer every one of those 34 rows would fail as "no usable link", and
`src/health/` would report a total extraction failure for a scraper that was working perfectly.

This is the same problem self-healing solves, one layer up: a heal regenerates the template and can
rename fields again, so the adapter has to be there permanently.

## Live collectors

All six outlets are built from the **same** variant-6 description, byte for byte. That is the point of
the exercise: one plain-language sentence, six unrelated homepage layouts, one canonical schema.

| Outlet     | Collector              | Live result                                 | Status                               |
| ---------- | ---------------------- | ------------------------------------------- | ------------------------------------ |
| NPR        | `c_msx6cy0m2aeyu3sc1z` | 31 stories                                  | **HEALTHY**                          |
| BBC News   | `c_msx92bd12pt6jc6ulk` | 218 raw → 164 stories (nested rows)         | **HEALTHY** — unwrapped in code      |
| Guardian   | `c_msx92eosqyvwc1sdb`  | 123 raw → 105 stories                       | **HEALTHY** — richest raw fields     |
| Fox News   | `c_msx9zyim6j7c97zp4`  | 1911 raw → 638 stories, 66% duplicated      | works; trips the duplicate threshold |
| CNN        | `c_msx92d0stuuf3xkqr`  | 65 raw → 26 stories, 39 still headline-less | **FAILED**; heal added 4 fields      |
| Al Jazeera | `c_msx929n61brflaj7vm` | 34 raw → 0 stories                          | **FAILED**; heal changed nothing     |

Fox News is the awkward one. It extracts headlines and URLs correctly, but its collector emits the
homepage's overlapping section rails as separate rows — 1,911 of them, collapsing to 638 unique URLs.
A 66% duplicate rate is above our `duplicateFailed` threshold, so health calls it FAILED even though
the deduplicated output is fine. That is a **false positive we are choosing not to tune away**: the
threshold is global, and moving it to accommodate one outlet would blind the signal everywhere else.
Per-outlet thresholds are the real fix and are not built.

Variant 6 reproduced cleanly across two accounts and six builds, which is the evidence that the short
description is reliably good rather than a lucky draw. It is not _uniformly_ good: the same sentence
produced a perfect flat extraction on the Guardian, a nested one on the BBC, and two collectors that
forgot to extract headlines at all. That spread is the honest result, and it is why the adapter layer
and the heal loop both have to exist.

### Three output shapes from one description

Building five collectors at once turned the field-vocabulary problem from an NPR anecdote into a
measured pattern. Each of these came back from the identical sentence:

```jsonc
// Guardian — flat, canonical, and generous
{ "headline": "…", "article_url": "…", "section": "Film", "standfirst": "…", "author": "…" }

// BBC — correct data, one level down, wrapper carrying a URL of its own
{ "news_stories": [ { "headline": "…", "article_url": "…", "position": 1 } ],
  "product_page_url": "https://www.bbc.com/news", "input": { … } }

// CNN — a link and a rank, and no name for the thing being linked
{ "position": 0, "product_page_url": "https://edition.cnn.com/2026/08/17/politics/…" }
```

The BBC shape is handled in code, by `flattenNestedRows` in
[`src/collect/brightdata.ts`](../src/collect/brightdata.ts) — the extraction is already correct and
healing it would repair something that was never broken. CNN and Al Jazeera are genuinely broken and
were sent through `scraper heal`. Telling those two cases apart is the whole judgement call, and
getting it wrong in either direction is expensive: heal a working collector and you risk a regression,
adapt around a broken one and you enshrine the damage.

### The unwrap that corrupted an hour of NPR

The first version of `flattenNestedRows` asked "does this row contain stories?" before "is this row a
story?". NPR rows carry a `related_stories: [{headline, url}]` sidebar, so every real story was
discarded and its related link promoted into its place. One capture reached disk that way: 41 records,
29 of them section and podcast landing pages sitting at positions 2–16.

Every field validated. The row count was plausible. What exposed it was the duplicate-URL signal
jumping to 33% against a baseline near zero — and a unit test that asserted on headline _text_ rather
than record count. The capture is withdrawn to
[`snapshots/_quarantine/`](../snapshots/_quarantine/README.md) rather than deleted.

The rule now is that a headline is what makes a row a story, so a row with its own headline is never
unwrapped.

### What the live collector does and does not return

It populates `headline`, `section`, `article_url` and a date. It returns no `summary`, no
`image_url`, no `story_type`, and no `position`, so those normalize to `null` / `unknown` / document
order. The date arrives without a time component, so `published_at` lands at midnight UTC and cannot
order stories within a day. Adding those fields is a legitimate use of `scraper heal` — the fix that
tool exists for — rather than a reason to rewrite the description and risk another degenerate build.

Orphaned empty templates from rejected descriptions and timed-out builds, safe to delete in the web UI
(Bright Data exposes no programmatic delete): `c_msx1ybzn2fn430dkvq`, `c_msx20h0y24mxd8ppib`,
`c_msx5je4t1492iaqeww`, `c_msx5kj221o1kqtztrh`, `c_msx5ltiz1lchynbu26`, `c_msx5oqx32p6u5ix6n8`,
`c_msx67ru42j349tys2z`, `c_msx6c34icxsiw06mv`, `c_msx92gcq1ffh6hv05n` (Fox, generation timed out).

## Two operational limits, both measured

**`scraper create` caps AI Flow at 3 concurrent jobs.** Launching five at once is fine — the CLI
absorbs the `429` and retries with exponential backoff — but the two queued builds waited through four
backoff rounds before starting. Budget wall-clock accordingly, and expect roughly 5–10 minutes per
collector once a slot opens.

**The default 600-second timeout is too short for a real heal.** Healing CNN ran through `planner`,
`code_fixer`, `step_preview_runner` and `request_fulfillment_validator`, reached `agent_picker` — the
last step — and timed out on attempt **600 of 600**. Fifteen minutes of work discarded in sight of the
finish line. `DEFAULT_HEAL_TIMEOUT_SECONDS` in [`src/heal/run-heal.ts`](../src/heal/run-heal.ts) is now 1800.

**A client-side timeout does not cancel the server-side job.** Retrying the CNN heal immediately
returned `409 Another refactor job is still in progress`. So a timeout is not a dead end and a retry is
not a fresh start — the original repair is still working. That is why `isRepairAlreadyRunning` reports
it as its own condition: "wait for it" and "try a sharper prompt" are opposite instructions, and a
generic "heal failed" invites the wrong one.

Both failures were non-destructive, exactly as documented — the CLI's own words: _"the heal did not
complete, but scraper `c_msx92d0stuuf3xkqr` is unchanged and still works as it did before."_ That is
the property the whole gated design rests on, and it held under two consecutive failures.

---

## The heal we actually ran — and why we verify by re-running

On 2026-08-17 we healed `c_msx6cy0m2aeyu3sc1z` with a real, gated
`brightdata scraper heal`, asking it to add `summary`, `image_url` and `story_type` and to include a
time of day alongside the date. Full loop: heal → approval gate → review preview → approve → re-run.

Every mechanical step worked. `heal` ran ~13 minutes through `planner`, `code_fixer`,
`request_fulfillment_validator` and `css_selector_extractor`, then stopped with
`status: "awaiting_approval"` exactly as documented. `approve` completed with `user_approval` in its
step list and `status: "done"`. **The `collector_id` never changed** — the scraper was repaired in
place, which is the premise the schema guarantee rests on.

Then we re-ran it. This is what we found:

| Field          | `preview_result` promised | Committed collector actually returns |
| -------------- | ------------------------- | ------------------------------------ |
| `summary`      | populated                 | **absent**                           |
| `image_url`    | populated                 | **absent**                           |
| `story_type`   | `"article"`               | **absent**                           |
| `publish_date` | `{}` — broken             | **intact**, unchanged string         |
| `author_name`  | renamed to `author`       | renamed to `author`                  |

**`preview_result` did not describe the committed collector.** It showed three fields that never
materialised and one regression that never happened. The only change that actually shipped was a
field rename we had not asked for.

This is the single strongest argument for the verification step in
[`src/heal/run-heal.ts`](../src/heal/run-heal.ts): after approving, it re-runs the collector and
counts what comes back, rather than trusting `status: "done"`. Had we trusted the API — or the
preview — we would have recorded a successful heal, told the demo audience three fields were
restored, and shipped an archive that silently lacked all three.

A heal that reports success and changes nothing observable is not a failure of the tool so much as a
reason the pipeline must never take the tool's word for it.

### Consequence for the collector

`summary`, `image_url` and `story_type` remain unavailable from NPR. They are not worth another
15-minute heal cycle on the evidence above. `published_at` is intact but date-only, so it orders
stories by day and not within a day.

---

## Three heals, three different outcomes

Running the loop against five live collectors rather than one turned a single anecdote into a small
sample. Every one of these reported `status: "done"` with `user_approval` in its step list. The
outcomes were not remotely the same.

| Collector      | Asked for                      | What re-running actually showed                                                  |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| NPR            | add `summary`/`image_url`/type | **nothing changed** — 0/31, plus one unrequested field rename                    |
| **CNN**        | fix 60% missing headlines      | **worked, partly** — gained `summary`, `image_url`, real `published_at` on 26/26 |
| **Al Jazeera** | fix 100% missing headlines     | **nothing changed** — still 32/32 rows with no headline                          |

CNN is the one that pays for the design. Before the heal it returned `{position, product_page_url}`
and nothing else. Afterwards, all 26 surviving records carry a section, a summary, an image and a
genuine timestamp — the richest records in the whole dataset:

```json
{
  "section": "politics",
  "headline": "Blanche declines to pledge independence from White House",
  "summary": "United States Attorney General Todd Blanche said he's \"not going to pledge\"…",
  "image_url": "https://media.cnn.com/api/v1/images/stellar/prod/22902104-blanchemtp-…png",
  "published_at": "2026-08-17T12:13:29.989Z",
  "position": 1
}
```

It did **not** fix the thing we asked for — 39 of 65 rows still arrive without a headline — so the
outlet still reads FAILED. The heal helped and missed at the same time.

**One in three heals delivered.** That number is the argument for the verification step, and it is
worth more than a 3-for-3 would be. `status: "done"` carried exactly the same weight in all three
cases, so nothing short of re-running and counting distinguishes the CNN result from the Al Jazeera
one. A pipeline that trusts the status reports three successes and ships two lies.

### Fresh builds outperformed heals

Four of five new collectors worked first time. One of three heals changed anything. When a collector
is comprehensively broken — Al Jazeera returning zero usable rows — `scraper create` is the better
tool, and the only cost of being wrong is another collector id.

## When NOT to heal

Late in the session Al Jazeera started returning rows like this:

```json
{
  "input": { "url": "https://www.aljazeera.com" },
  "error": "Crawler error: Your account exceeded the allowed rate limits…",
  "error_code": "proxy_error"
}
```

The run "succeeded". Fourteen rows came back. Every one was rejected, and the pipeline reported
**"14/14 rows had an empty headline (100%)"** — a perfect description of the symptom and a completely
misleading account of the cause. Left alone, the debounce would have fired a heal prompt asking the AI
to fix its selectors: 20 minutes and a concurrency slot spent on an account throttle that no collector
change can affect.

So `isUpstreamErrorRow` in [`src/schema/normalize.ts`](../src/schema/normalize.ts) counts these
separately, `computeHealth` raises them as `upstream_error` rather than as extraction damage, and
`isHealable` stops the watcher from healing against them. The debounce asks _is this real?_; this asks
_is this ours?_ Both have to be yes.
