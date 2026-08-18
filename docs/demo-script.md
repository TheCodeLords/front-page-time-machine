# The 2-minute demo — three acts, one story

The scraper is the machinery. The demo sells the product: **the web forgets, and this remembers.**
Every line below is backed by something in the repo — nothing is claimed that a judge cannot click.

---

## Act 1 — The disappearing web (~30s)

Open the live timeline: <https://thecodelords.github.io/front-page-time-machine/timeline.html>

1. Scrub to the earliest stop. _"This is what six front pages said mattered at this hour."_
2. Scrub to the latest. _"Same six pages, hours later. The earlier state no longer exists anywhere —
   these homepages overwrote themselves. Except here."_
3. Point at the "what changed" strip: arrivals, departures, rank moves — the news cycle as data.

> **The line:** "Articles have archives. The front page — the ranked statement of what a newsroom
> thought mattered — has none. We built that missing layer."

## Act 2 — Break it, heal it, prove it (~60s)

This is the money shot, and it runs on a **controlled real-world redesign** (see §6c of the README):
The Meridian Dispatch fixture, hosted on GitHub Pages, collector built against v1.

1. Show a HEALTHY capture in the terminal (`fptm capture`).
2. Commit v2's markup over the same URL — a hostile redesign: same stories, obliterated DOM.
3. Capture twice: health flags it, names WHICH signals broke, debounce satisfies.
4. `fptm heal meridian` — the prompt is **generated from the health report**, sent to Bright Data
   Self-Healing, stops at the approval gate. Approve.
5. The rerun goes back through the **same health engine that detected the break** — and only a
   HEALTHY verdict prints RECOVERED.

> **The line:** "Bright Data told us a heal succeeded once when it hadn't. We stopped trusting
> `done`. Our system reruns the collector and judges it with the same detector that caught the
> break — of three real heals against live publishers, exactly one passed that bar, and the ledger
> shows which."

Then flash the Repairs panel on the timeline: the episode, its prompt, its per-phase timing, its
verification verdict — the collector fleet healing on the same clock as the news it watches.

## Act 3 — What did the web care about? (~30s)

Back on the timeline:

1. Click one story that spread. The trail table appears: **first observed** on one outlet, picked
   up by others with timestamps, peak rank per outlet — and the outlets that **never carried it**.
2. Point at the divergence strip: _"Tall bars are the hours the front pages disagreed about what
   mattered most. That's Shannon entropy over lead stories — arithmetic, not opinion."_

> **The line:** "We don't tell you what to think about the news. We preserve what happened to it —
> placement, timing, silence. Headlines verbatim, no tone, no ranking of outlets. We hold up the
> x-ray; you draw the conclusion."

---

## Judge Q&A — the answers, pre-verified

- **Why not Google News / RSS?** They index what publishers _published_. We preserve what publishers
  _chose to place_, where, for how long, and when that changed. RSS has no ranks and no removals.
- **What exactly self-heals?** The extraction implementation. Never the schema — an executable test
  asserts a healed collector produces byte-identical canonical records.
- **How do you know a repair worked?** We rerun the collector and put the result through
  `computeHealth` against the outlet's stored baseline. RECOVERED is our health engine's word, not
  the API's. (`heal_unverified` exists precisely because the two disagree in practice.)
- **Isn't gated approval "not autonomous"?** Detection, diagnosis, prompt generation and repair are
  autonomous; committing a mutation to production extraction is policy. `--autonomous` flips the
  policy; the default keeps a human at the gate. That is a feature, and it is Bright Data's own
  recommended workflow shape.
- **Is rank 3 really the third most prominent story?** It is the third story in the observed
  sequence — publisher-supplied order when the collector returns it (recorded per capture), document
  order otherwise. We deliberately claim ordinal placement, never pixel prominence.
- **Same instant across outlets?** A capture _window_ — serial fetches, three timestamps stored
  per capture, and all timing language is "first observed", never "first published".
- **Six outlets — can it scale?** Each outlet is one isolated collector sharing one canonical
  contract; scaling is horizontal. Six were chosen for structural diversity — six different layouts
  prove more than twenty similar ones, and the AI Flow's 3-concurrent generation cap prices 20+ in
  hours, not minutes.
- **Bias?** We measure attention, not alignment: placement, duration, timing. No sentiment, no
  left/right scores, headlines quoted verbatim.
