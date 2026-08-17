# Reliability doctrine

The recurring design decisions in this codebase, stated once with the incident that earned each of
them. Every rule here was adopted because something measurable went wrong without it — in this
project, on live data, during the hackathon week — not because a style guide said so.

## Bound every expensive loop, and make more attempts something recovery earns

`MAX_HEALS_PER_OUTAGE = 3` in [`src/schedule/watch.ts`](../src/schedule/watch.ts). A permanently
broken outlet re-satisfies the heal debounce on every capture, and a heal costs 15–30 minutes of AI
Flow plus a concurrency slot other outlets queue behind. We measured the futility directly: two
heals against the same collector changed nothing observable. So the budget is per-outage, not
per-day — three shots at one problem, reset only by a HEALTHY capture — and the fourth consecutive
failure is routed to a human, which by then it genuinely is.

## Green requires positive proof

An empty capture is FAILED, never "no data, no problem". The story-count baseline excludes captures
that cannot define normal — empty ones (an outage would drag the median toward zero and declare
itself normal) and implausibly large ones (Fox News over-extracted 499 "stories" from its first
capture; unfiltered, the median settles at 499 within three captures and the over-extraction signal
self-silences). `fptm story` says "cross-outlet comparison is not available" with one outlet rather
than rendering a table that looks like a finding. And a heal is never trusted on `status: "done"` —
the collector is re-run and its output counted, which is how we learned that only one of our three
real heals actually changed anything.

## Attribute failure at the point of failure, by cause

`CaptureDiagnostics` counts every rejected row under the reason it was rejected, because the strict
schema makes the evidence unrecoverable afterwards — a record with no headline never becomes a
record. The taxonomy split that matters most is _whose fault it is_: `rejected_no_headline` is the
collector's problem and healable; `rejected_upstream_error` is the account's or network's problem
and healing it is harmful (the heal's own preview would fetch the error page and "repair" the
collector to parse it). We hit exactly this live: a rate-limited account produced rows the pipeline
first reported as "14/14 rows had an empty headline (100%)" — a perfect symptom and a completely
wrong cause, one debounce away from a 20-minute heal that could not have worked. `isHealable` now
gates both the watcher and the CLI on that distinction.

## Different artifacts get different lifecycles, and the durable one is sacred

`snapshots/` is append-only; nothing in this repo rewrites or deletes a line of it, because a
homepage cannot be re-fetched as it was an hour ago. When our own normalizer corrupted a capture
(the `related_stories` unwrap bug), the bad line moved to `snapshots/_quarantine/` with a
post-mortem instead of being deleted — the incident record is itself an artifact. Screenshots are
receipts, not records: losing one costs nothing that matters, so a failed screenshot never fails a
capture.

## Keep a fixture you can grade against

[`mock/`](../mock/README.md) holds one synthetic front page in two layouts — the page a collector is
built against, and the hostile redesign it wakes up to. Real publishers redesign on their own
schedule; a fixture turns "the self-healing loop works" from an assertion into a drill that can be
run on demand, end to end, against a break whose before and after can be diffed character by
character.

## The one-shot check must be idle-safe

`npm run verify` is green on a fresh clone with no collectors, no captures, no API key and no
network — so a red verify always means a real regression, never "you haven't configured the
account". Everything that needs credentials lives behind separate commands. A check that is red by
default carries zero information.

## Noted for later

- **Proactive drift scoring.** Grade the raw field vocabulary each collector returns and flag
  changes between captures even while the alias layer absorbs them — fragility made visible before
  it breaks, instead of after. The diagnostics envelope is where it would land.
- **Stage-attributed heal timing.** Heal episodes record when they started and resolved, but not
  where the 15–30 minutes goes; timing each CLI stage would show it.
- **Persisted heal episodes.** Episodes are currently printed, not stored. An append-only episode
  ledger next to the snapshots would let `fptm timeline` show repairs on the same axis as the news.
