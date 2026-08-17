# Quarantine

Captures withdrawn from the archive, kept rather than deleted so the incident stays inspectable.

Nothing here is a record of what a front page showed. Each file holds captures produced by a defect
in our own pipeline, not by the publisher — so leaving them in `snapshots/` would not be preserving
history, it would be asserting something false about a moment that can never be re-observed.

## npr/2026-08-17.ndjson — one capture, `2026-08-17T13:24:37.470Z`

Written while `flattenNestedRows` unwrapped nested arrays before checking whether the row was itself
a story. Real NPR rows carry a `related_stories: [{headline, url}]` sidebar, so each genuine story was
discarded and its "related" link promoted in its place. The capture recorded 41 stories, of which 29
were section and podcast landing pages — `/sections/climate`, `/podcasts/510351/short-wave` — sitting
at positions 2 through 16 as though NPR had led with them.

The row count looked plausible and every field validated. What gave it away was the duplicate rate
jumping to 33% against a baseline near zero, and a unit test asserting on headline *text* rather than
record count.

Fixed in `src/collect/brightdata.ts`: a row with its own headline is never unwrapped.
