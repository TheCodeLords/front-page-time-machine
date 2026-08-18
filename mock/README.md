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

The fixture is a first-class outlet in the registry (`source: meridian`, flagged `synthetic: true`),
inert until `FPTM_COLLECTORS` assigns it a collector, and excluded from `story`/`timeline` analysis
so its invented stories can never blend into the real archive. Its repair episode does appear in the
timeline's Repairs panel, clearly named as the fixture — that episode is the drill's evidence.

1. Host v1 at a stable public URL. With GitHub Pages enabled on this repo it already is:
   `https://thecodelords.github.io/front-page-time-machine/mock/homepage-v1.html`. Build a collector
   against it with the same one-sentence description used for the six real outlets
   (`brightdata scraper create <url> "$(cat collectors/homepage-description.txt)"`), add
   `meridian:c_xxx` to `FPTM_COLLECTORS`, and capture until a baseline exists.
2. Replace the content at that URL with v2 — commit v2's markup over `homepage-v1.html` (same path,
   same URL; Pages redeploys in about a minute). **Do not touch the collector.**
3. Watch the pipeline do its job with no hints: health degrades, the debounce fills, the generated
   heal prompt quotes the actual failure counts, the gated heal (`fptm heal meridian`) proposes a
   fix, approval commits it — and the rerun goes back through the health engine, which alone decides
   RECOVERED, or honestly declines to.

The value over `fptm demo` (which simulates the break with a scripted runner and says so on screen)
is that every step is real: real fetch, real collector, real AI repair against a page whose "before"
and "after" you can diff character by character.

## Hosting — what we measured, and what is left

The constraint: Scraper Studio collectors execute in Bright Data's cloud, so the mock page must be
publicly reachable. `localhost` can never work.

**Claude Artifact hosting was tested and does not work.** We published v1 as an artifact and fetched
it through `brightdata scrape -f markdown`: 80 bytes came back — the artifact viewer's chrome, none
of the fixture's stories. Artifacts are private by default and render content through a scripted
sandbox, so the collector sees the wrapper, not the page. Recorded here so nobody re-burns an
afternoon on it.

**RESOLVED: the repo is public and GitHub Pages is enabled**, so the fixture serves at
`https://thecodelords.github.io/front-page-time-machine/mock/homepage-v1.html` — verified reachable.
The fallback ladder below is kept for the record:

1. **Any drag-and-drop static host** usable from a browser (no git, no CLI) — upload v1, run the
   drill, re-upload v2 over it. Same URL throughout is the requirement.
2. **GitHub Pages** — commit v1, run the drill, commit v2 over it. This is the path now live.
3. If neither is reachable from the demo network: fall back to `fptm demo`'s scripted break —
   **disclosed as simulated, on stage, every time.** A staged break presented as real is the one
   way this feature can lose points; the three real heal episodes in
   [`collectors/README.md`](../collectors/README.md) are the receipts that the loop works on live
   publishers, and the simulation only exists to compress fifteen minutes into thirty seconds.
