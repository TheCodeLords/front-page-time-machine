# The Meridian Dispatch — a homepage built to break

Two versions of one synthetic front page — a fixture you can _grade_ the self-healing loop against,
instead of waiting for a real publisher to redesign on your schedule.

- [`homepage-v1.html`](homepage-v1.html) — semantic layout: `article.story-card > h3 > a.headline-link`,
  honest `<time>` elements, section tags in class-named spans.
- [`homepage-v2.html`](homepage-v2.html) — **the redesign.** Identical stories, identical visible
  page; the DOM is restructured (cards become anchor-wrapped rows), every class is renamed to
  build-hash gibberish (`.story-card` → `.cl-6b`), the nav becomes JS-only `<span data-nav>`,
  timestamps become relative text. This is what a collector built against v1 wakes up to.

Both pages label themselves as fiction in a banner and the footer. Every place, masthead and story
is invented — the fixture must never be mistakable for a real publication.

## The drill

1. Host v1 at a stable public URL. Build a collector against it with the same one-sentence
   description used for the six real outlets. Capture until a baseline exists.
2. Replace the content at that URL with v2. **Do not touch the collector.**
3. Watch the pipeline do its job with no hints: health degrades, the debounce fills, the generated
   heal prompt quotes the actual failure counts, the gated heal proposes a fix, approval commits it,
   and the re-run proves recovery — or honestly fails to.

The value over `fptm demo` (which simulates the break with a scripted runner and says so on screen)
is that every step is real: real fetch, real collector, real AI repair against a page whose "before"
and "after" you can diff character by character.

## Hosting — what we measured, and what is left

The constraint: Scraper Studio collectors execute in Bright Data's cloud, so the mock page must be
publicly reachable. `localhost` can never work, and this machine cannot deploy or push until the
final day.

**Claude Artifact hosting was tested and does not work.** We published v1 as an artifact and fetched
it through `brightdata scrape -f markdown`: 80 bytes came back — the artifact viewer's chrome, none
of the fixture's stories. Artifacts are private by default and render content through a scripted
sandbox, so the collector sees the wrapper, not the page. Recorded here so nobody re-burns an
afternoon on it.

Workable options for the demo day, in order of preference:

1. **Any drag-and-drop static host** usable from a browser (no git, no CLI) — upload v1, run the
   drill, re-upload v2 over it. Same URL throughout is the requirement.
2. **GitHub Pages** once the repo goes public on the final day — commit v1 as `index.html`, run the
   drill, commit v2 over it. Slowest (Pages cache), but zero new accounts.
3. If neither is reachable from the demo network: fall back to `fptm demo`'s scripted break —
   **disclosed as simulated, on stage, every time.** A staged break presented as real is the one
   way this feature can lose points; the three real heal episodes in
   [`collectors/README.md`](../collectors/README.md) are the receipts that the loop works on live
   publishers, and the simulation only exists to compress fifteen minutes into thirty seconds.
