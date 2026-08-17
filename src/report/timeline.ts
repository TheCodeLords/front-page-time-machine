import { clusterStories } from '../analyze/cluster.js';
import { leadDivergence } from '../analyze/propagation.js';
import type { EpisodeRecord } from '../store/episode-store.js';
import type { CaptureSnapshot, StorySnapshotRecord } from '../schema/story-snapshot.js';

/**
 * The timeline UI: one self-contained HTML file rendered from the archive.
 *
 * Self-contained is a hard requirement, not a style choice. The demo machine sits behind a
 * corporate network that blocks CDNs, and a judge opening the submission should need exactly one
 * double-click — so every byte of CSS and JS is inline, the data is embedded as JSON, and the only
 * external URLs on the page are the article links themselves. No framework, because the page has
 * one interaction (a time scrubber) and a framework would be the largest thing on it.
 *
 * This module is a RENDERER in the src/report/ sense: it takes finished values and returns a
 * string. All clustering and divergence math is done here at build time, in TypeScript, by the same
 * tested functions the CLI uses — the embedded JavaScript only selects and displays. Two reasons:
 * the page never disagrees with `fptm story` about what a cluster is, and the inline script stays
 * small enough to read in one sitting.
 */

/** One story, slimmed to what the page renders. Short keys because this is embedded 1,600 times. */
interface SlimRecord {
  /** headline */
  h: string;
  /** article_url */
  u: string;
  /** position */
  p: number;
  /** section */
  s: string | null;
  /** cluster id — the same story carries the same id across outlets and hours */
  c: number;
}

interface SlimCapture {
  src: string;
  name: string;
  /** captured_at, ISO */
  at: string;
  /** Index into `ticks` — assigned at build time so the page never re-derives the grouping. */
  t: number;
  records: SlimRecord[];
}

/** One repair, slimmed for the page. Rendered server-side; never re-derived in the browser. */
export interface SlimEpisode {
  src: string;
  name: string;
  at: string;
  state: string;
  before: number;
  after: number | null;
  error: string | null;
  prompt: string;
  /** phase → minutes since the previous phase, in order. Where the 15–30 minutes went. */
  phases: { phase: string; minutes: number }[];
}

export interface TimelinePayload {
  generated_at: string;
  /** Scrubber stops: distinct capture moments, oldest first, ISO strings. */
  ticks: string[];
  /** Lead-divergence entropy per tick, aligned with `ticks`. */
  divergence: number[];
  outlets: { src: string; name: string }[];
  captures: SlimCapture[];
  episodes: SlimEpisode[];
}

/**
 * Scrubber stops from capture times, grouped by GAP rather than by a fixed grid.
 *
 * Captures land within a few minutes of each other on a tick (six outlets fetched serially), so raw
 * timestamps would give six scrubber stops per hour that each show one outlet updating. The first
 * version floored times to a 15-minute grid — and a test against the real archive killed it: the
 * 14:26–14:32 spread straddles the 14:30 grid line, so one editorial moment split into two stops
 * anyway. Any fixed grid has that seam somewhere. Grouping by gap does not: successive capture
 * times closer than `gapMinutes` belong to one moment, and a stop is labeled by its first capture.
 */
export function clusterTicks(sortedTimes: readonly string[], gapMinutes = 10): string[] {
  const gapMs = gapMinutes * 60_000;
  const ticks: string[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const iso of sortedTimes) {
    const at = new Date(iso).getTime();
    if (at - previous > gapMs) ticks.push(iso);
    previous = at;
  }
  return ticks;
}

/** The tick a capture belongs to: the last tick at or before it. */
function tickIndexFor(ticks: readonly string[], at: string): number {
  let index = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    const tick = ticks[i];
    if (tick !== undefined && tick <= at) index = i;
  }
  return index;
}

function slimEpisode(episode: EpisodeRecord): SlimEpisode {
  const marks = Array.isArray((episode as Record<string, unknown>)['phase_marks'])
    ? ((episode as Record<string, unknown>)['phase_marks'] as { phase?: unknown; at?: unknown }[])
    : [];
  const phases: { phase: string; minutes: number }[] = [];
  let previous = new Date(episode.detected_at).getTime();
  for (const mark of marks) {
    if (typeof mark.phase !== 'string' || typeof mark.at !== 'string') continue;
    const at = new Date(mark.at).getTime();
    if (Number.isNaN(at)) continue;
    if (mark.phase === 'heal_requested') continue; // the zero point, not a duration
    phases.push({ phase: mark.phase, minutes: Math.round(((at - previous) / 60_000) * 10) / 10 });
    previous = at;
  }
  return {
    src: episode.source,
    name: episode.source_name,
    at: episode.detected_at,
    state: episode.state,
    before: episode.stories_before,
    after: episode.stories_after,
    error: episode.error,
    prompt: episode.prompt,
    phases,
  };
}

export function buildTimelinePayload(
  captures: readonly CaptureSnapshot[],
  episodes: readonly EpisodeRecord[] = [],
  now: () => string = () => new Date().toISOString(),
): TimelinePayload {
  const allRecords: StorySnapshotRecord[] = captures.flatMap((c) => c.records);

  // Cluster once, at build time, with the exact function `fptm story` uses.
  const clusterOf = new Map<string, number>();
  for (const cluster of clusterStories(allRecords)) {
    for (const record of cluster.records) {
      clusterOf.set(
        `${record.source}|${record.captured_at}|${record.article_url}`,
        cluster.cluster_id,
      );
    }
  }

  const sorted = [...captures].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const ticks = clusterTicks(sorted.map((c) => c.captured_at));

  const slim: SlimCapture[] = sorted.map((capture) => ({
    src: capture.source,
    name: capture.source_name,
    at: capture.captured_at,
    t: tickIndexFor(ticks, capture.captured_at),
    records: capture.records.map((record) => ({
      h: record.headline,
      u: record.article_url,
      p: record.position,
      s: record.section,
      c: clusterOf.get(`${record.source}|${record.captured_at}|${record.article_url}`) ?? -1,
    })),
  }));

  // Divergence per tick: which cluster each outlet led with, folded to Shannon entropy.
  const divergence = ticks.map((_, tickIndex) => {
    const leads = new Map<string, number>();
    for (const capture of slim) {
      if (capture.t !== tickIndex) continue;
      const lead = capture.records.find((r) => r.p === 1);
      if (lead && lead.c >= 0) leads.set(capture.src, lead.c);
    }
    return leadDivergence(leads);
  });

  const outlets = [...new Map(slim.map((c) => [c.src, { src: c.src, name: c.name }])).values()];

  const slimEpisodes = [...episodes]
    .sort((a, b) => a.detected_at.localeCompare(b.detected_at))
    .map(slimEpisode);

  return {
    generated_at: now(),
    ticks,
    divergence,
    outlets,
    captures: slim,
    episodes: slimEpisodes,
  };
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `JSON.stringify` output is not safe inside a <script> block — a headline containing "</script>"
 * would end the block and execute the rest of the page as markup. Headlines are scraped text from
 * six publishers; treat them as hostile. Escaping `<` closes the hole for both the JSON payload and
 * anything oddly nested inside it.
 */
const embedJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** The repairs panel: every heal episode, rendered at build time as plain expandable rows. */
function renderRepairs(episodes: readonly SlimEpisode[]): string {
  if (episodes.length === 0) return '';
  const rows = episodes
    .map((episode) => {
      const outcome =
        episode.after !== null
          ? `${episode.before} → ${episode.after} stories`
          : `${episode.before} stories at detection`;
      const phases = episode.phases
        .map((p) => `<span class="phase">${escapeHtml(p.phase)} ${p.minutes}m</span>`)
        .join(' ');
      return `<details class="repair">
  <summary>🔧 <strong>${escapeHtml(episode.name)}</strong> ${escapeHtml(episode.at.slice(11, 16))} UTC
    <span class="state">${escapeHtml(episode.state)}</span> <span class="outcome">${escapeHtml(outcome)}</span></summary>
  <p class="prompt-label">Prompt sent (generated from the health report):</p>
  <blockquote>${escapeHtml(episode.prompt)}</blockquote>
  ${phases ? `<p class="phases">${phases}</p>` : ''}
  ${episode.error ? `<p class="err">${escapeHtml(episode.error)}</p>` : ''}
</details>`;
    })
    .join('\n');
  return `<section class="repairs">
  <h2>Repairs — the collector fleet, healing on the same clock as the news</h2>
  ${rows}
</section>`;
}

/** Render the archive into one self-contained HTML page. */
export function renderTimeline(payload: TimelinePayload): string {
  const hasData = payload.captures.length > 0;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Front Page Time Machine</title>
<style>
  :root {
    --bg: #f7f5f0; --panel: #ffffff; --ink: #1a1a1a; --muted: #6b6b6b; --line: #e2ddd2;
    --accent: #b3541e; --lead-bg: #1a1a1a; --lead-ink: #f7f5f0; --up: #1e6e3a; --down: #a12b2b;
    --hl: #f5e3ae;
  }
  :root:not([data-theme="light"]) { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #171512; --panel: #201d19; --ink: #ece7dd; --muted: #9a938a; --line: #35302a;
      --accent: #e08a4e; --lead-bg: #ece7dd; --lead-ink: #171512; --up: #6fbf8a; --down: #e08a8a;
      --hl: #4a3f1e;
    }
  }
  :root[data-theme="dark"] {
    --bg: #171512; --panel: #201d19; --ink: #ece7dd; --muted: #9a938a; --line: #35302a;
    --accent: #e08a4e; --lead-bg: #ece7dd; --lead-ink: #171512; --up: #6fbf8a; --down: #e08a8a;
    --hl: #4a3f1e;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.45 Georgia, 'Times New Roman', serif; padding: 1.2rem clamp(0.8rem, 3vw, 2.4rem); }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.8rem; border-bottom: 3px double var(--ink); padding-bottom: 0.6rem; }
  h1 { font-size: 1.5rem; letter-spacing: 0.02em; }
  header .sub { color: var(--muted); font-style: italic; }
  header .clock { margin-left: auto; font: 700 1.3rem/1 'Courier New', monospace; }
  .controls { display: flex; align-items: center; gap: 0.9rem; margin: 0.9rem 0 0.4rem; flex-wrap: wrap; }
  button { font: inherit; background: var(--panel); color: var(--ink); border: 1px solid var(--ink); padding: 0.25rem 0.8rem; cursor: pointer; }
  button:hover { background: var(--accent); color: var(--panel); border-color: var(--accent); }
  input[type=range] { flex: 1; min-width: 200px; accent-color: var(--accent); }
  .divergence { display: flex; gap: 2px; align-items: flex-end; height: 46px; margin: 0.3rem 0 1rem; }
  .divergence .bar { flex: 1; background: var(--line); min-height: 3px; cursor: pointer; position: relative; }
  .divergence .bar.active { background: var(--accent); }
  .divergence .bar:hover { background: var(--accent); opacity: 0.7; }
  .div-caption { color: var(--muted); font-size: 0.78rem; margin-bottom: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
  .card { background: var(--panel); border: 1px solid var(--line); padding: 0.8rem 0.9rem; }
  .card h2 { font-size: 1.02rem; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid var(--ink); padding-bottom: 0.3rem; display: flex; justify-content: space-between; align-items: baseline; }
  .card h2 .asof { font: italic 0.72rem/1 Georgia, serif; letter-spacing: 0; text-transform: none; color: var(--muted); }
  .story { display: grid; grid-template-columns: 1.6rem 1fr; gap: 0.45rem; padding: 0.34rem 0.15rem; border-bottom: 1px dotted var(--line); cursor: pointer; }
  .story:hover, .story.hl { background: var(--hl); }
  .story .rank { font: 700 0.8rem/1.5 'Courier New', monospace; color: var(--muted); text-align: right; }
  .story.lead .rank { background: var(--lead-bg); color: var(--lead-ink); text-align: center; }
  .story .h { font-size: 0.92rem; }
  .story.lead .h { font-weight: 700; font-size: 1.02rem; }
  .story .meta { font-size: 0.72rem; color: var(--muted); display: flex; gap: 0.5rem; }
  .move { font: 700 0.7rem/1.4 'Courier New', monospace; }
  .move.up { color: var(--up); } .move.down { color: var(--down); } .move.new { color: var(--accent); }
  .empty { color: var(--muted); font-style: italic; padding: 0.6rem 0; }
  #trail { background: var(--panel); border: 1px solid var(--ink); padding: 0.8rem 1rem; margin: 1rem 0; display: none; }
  #trail.open { display: block; }
  #trail h3 { font-size: 0.95rem; margin-bottom: 0.4rem; }
  #trail table { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
  #trail td, #trail th { text-align: left; padding: 0.15rem 0.9rem 0.15rem 0; color: var(--ink); }
  #trail th { color: var(--muted); font-weight: normal; font-style: italic; }
  #trail .never { color: var(--muted); font-style: italic; }
  .repairs { border: 1px solid var(--ink); background: var(--panel); padding: 0.7rem 1rem; margin: 0.4rem 0 1rem; }
  .repairs h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.4rem; }
  .repair { border-top: 1px dotted var(--line); padding: 0.3rem 0; font-size: 0.88rem; }
  .repair summary { cursor: pointer; }
  .repair .state { font: 700 0.72rem/1.4 'Courier New', monospace; color: var(--accent); }
  .repair .outcome { color: var(--muted); font-size: 0.8rem; }
  .repair blockquote { margin: 0.4rem 0 0.4rem 1rem; color: var(--muted); font-size: 0.82rem; border-left: 2px solid var(--line); padding-left: 0.7rem; }
  .repair .prompt-label { font-size: 0.76rem; color: var(--muted); margin-top: 0.4rem; }
  .repair .phase { font: 0.72rem/1.6 'Courier New', monospace; background: var(--hl); padding: 0.1rem 0.4rem; margin-right: 0.3rem; }
  .repair .err { color: var(--down); font-size: 0.82rem; }
  footer { margin-top: 1.4rem; color: var(--muted); font-size: 0.76rem; border-top: 1px solid var(--line); padding-top: 0.5rem; }
  a { color: inherit; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>FRONT PAGE TIME MACHINE</h1>
  <span class="sub">a memory of what the public web cared about</span>
  <span class="clock" id="clock">&nbsp;</span>
</header>
${
  hasData
    ? `<div class="controls">
  <button id="prev" title="earlier (←)">◀</button>
  <button id="play" title="auto-advance">▶ play</button>
  <button id="next" title="later (→)">▶</button>
  <input type="range" id="scrub" min="0" max="${payload.ticks.length - 1}" value="${payload.ticks.length - 1}" step="1">
</div>
<div class="divergence" id="divergence"></div>
<div class="div-caption">Divergence — how much the front pages disagreed about the lead story at each hour (Shannon entropy). Tall bars are where to scrub to. Click a bar to jump.</div>
${renderRepairs(payload.episodes)}
<div id="trail"></div>
<div class="grid" id="grid"></div>`
    : `<p class="empty">No captures stored yet. Run <code>npm run capture</code> (or <code>npm run watch</code>), then re-run <code>npm run timeline</code>.</p>`
}
<footer>
  Generated ${escapeHtml(payload.generated_at)} from ${payload.captures.length} captures ·
  ${payload.outlets.length} outlets · placement and timing only — headlines verbatim, no tone, no ranking of outlets.
  Extraction by Bright Data Scraper Studio; one collector per outlet from one shared description.
</footer>
<script type="application/json" id="data">${embedJson(payload)}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  if (!data.captures.length) return;

  var state = { tick: data.ticks.length - 1, cluster: null, playing: null };

  function hhmm(iso) { return iso.slice(11, 16); }
  function esc(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Latest capture per outlet at-or-before the selected tick: the front page "as of" that moment.
  // Tick membership (c.t) was assigned at build time by the tested grouping code — never re-derived.
  function captureFor(src, tickIdx) {
    var best = null;
    for (var i = 0; i < data.captures.length; i++) {
      var c = data.captures[i];
      if (c.src === src && c.t <= tickIdx) best = c; // captures are sorted oldest-first
    }
    return best;
  }
  function previousCapture(src, current) {
    var prev = null;
    for (var i = 0; i < data.captures.length; i++) {
      var c = data.captures[i];
      if (c.src === src && c.at < current.at) prev = c;
    }
    return prev;
  }

  function movement(record, prev) {
    if (!prev) return '';
    var was = null;
    for (var i = 0; i < prev.records.length; i++) if (prev.records[i].u === record.u) { was = prev.records[i].p; break; }
    if (was === null) return '<span class="move new">NEW</span>';
    if (was > record.p) return '<span class="move up">▲' + (was - record.p) + '</span>';
    if (was < record.p) return '<span class="move down">▼' + (record.p - was) + '</span>';
    return '';
  }

  function renderCards() {
    var tickIso = data.ticks[state.tick];
    var html = '';
    for (var o = 0; o < data.outlets.length; o++) {
      var outlet = data.outlets[o];
      var cap = captureFor(outlet.src, state.tick);
      html += '<div class="card"><h2>' + esc(outlet.name);
      if (cap) html += '<span class="asof">as of ' + hhmm(cap.at) + ' UTC</span>';
      html += '</h2>';
      if (!cap) {
        html += '<div class="empty">not yet captured at this hour</div>';
      } else if (!cap.records.length) {
        html += '<div class="empty">capture returned no stories — that hour is honestly empty</div>';
      } else {
        var prev = previousCapture(outlet.src, cap);
        var top = cap.records.slice(0, 12);
        for (var r = 0; r < top.length; r++) {
          var rec = top[r];
          var cls = 'story' + (rec.p === 1 ? ' lead' : '') + (state.cluster !== null && rec.c === state.cluster ? ' hl' : '');
          html += '<div class="' + cls + '" data-cluster="' + rec.c + '">'
            + '<span class="rank">' + rec.p + '</span>'
            + '<span><span class="h">' + esc(rec.h) + '</span>'
            + '<span class="meta">' + (rec.s ? esc(rec.s) : '') + ' ' + movement(rec, prev) + '</span></span>'
            + '</div>';
        }
        if (cap.records.length > top.length) {
          html += '<div class="empty">+ ' + (cap.records.length - top.length) + ' more below the fold</div>';
        }
      }
      html += '</div>';
    }
    document.getElementById('grid').innerHTML = html;
    document.getElementById('clock').textContent = hhmm(tickIso) + ' UTC · ' + tickIso.slice(0, 10);
    document.getElementById('scrub').value = state.tick;
    var bars = document.querySelectorAll('.divergence .bar');
    for (var b = 0; b < bars.length; b++) bars[b].className = 'bar' + (b === state.tick ? ' active' : '');
  }

  function renderTrail() {
    var el = document.getElementById('trail');
    if (state.cluster === null) { el.className = ''; el.innerHTML = ''; return; }
    var seen = {}; var label = ''; var order = [];
    for (var i = 0; i < data.captures.length; i++) {
      var c = data.captures[i];
      for (var j = 0; j < c.records.length; j++) {
        var rec = c.records[j];
        if (rec.c !== state.cluster) continue;
        if (!label || rec.h.length > label.length) label = rec.h;
        if (!seen[c.src]) { seen[c.src] = { name: c.name, first: c.at, last: c.at, peak: rec.p, leads: 0 }; order.push(c.src); }
        var s = seen[c.src];
        if (c.at < s.first) s.first = c.at;
        if (c.at > s.last) s.last = c.at;
        if (rec.p < s.peak) s.peak = rec.p;
        if (rec.p === 1) s.leads++;
      }
    }
    var rows = '';
    for (var k = 0; k < order.length; k++) {
      var s2 = seen[order[k]];
      rows += '<tr><td>' + esc(s2.name) + '</td><td>' + hhmm(s2.first) + '–' + hhmm(s2.last)
        + '</td><td>peak rank ' + s2.peak + '</td><td>' + (s2.leads ? 'led ' + s2.leads + '×' : '') + '</td></tr>';
    }
    var never = [];
    for (var n = 0; n < data.outlets.length; n++) if (!seen[data.outlets[n].src]) never.push(data.outlets[n].name);
    el.innerHTML = '<h3>“' + esc(label) + '”</h3><table><tr><th>outlet</th><th>on the front page</th><th></th><th></th></tr>'
      + rows + '</table>'
      + (never.length ? '<div class="never">never carried it: ' + esc(never.join(', ')) + '</div>' : '')
      + '<div class="never" style="margin-top:0.3rem">click anywhere in a card to clear</div>';
    el.className = 'open';
  }

  function setTick(t) {
    state.tick = Math.max(0, Math.min(data.ticks.length - 1, t));
    renderCards();
  }

  // Divergence strip
  var strip = document.getElementById('divergence');
  var max = Math.max.apply(null, data.divergence.concat([0.0001]));
  var stripHtml = '';
  for (var d = 0; d < data.divergence.length; d++) {
    var h = Math.max(3, Math.round((data.divergence[d] / max) * 44));
    stripHtml += '<div class="bar" data-t="' + d + '" style="height:' + h + 'px" title="'
      + hhmm(data.ticks[d]) + ' UTC — entropy ' + data.divergence[d].toFixed(2) + '"></div>';
  }
  strip.innerHTML = stripHtml;
  strip.addEventListener('click', function (e) {
    var t = e.target.getAttribute('data-t');
    if (t !== null) setTick(parseInt(t, 10));
  });

  document.getElementById('grid').addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== document.body && !node.getAttribute('data-cluster')) node = node.parentNode;
    var c = node && node.getAttribute && node.getAttribute('data-cluster');
    state.cluster = (c && c !== '-1' && state.cluster !== parseInt(c, 10)) ? parseInt(c, 10) : null;
    renderTrail(); renderCards();
  });

  document.getElementById('scrub').addEventListener('input', function (e) { setTick(parseInt(e.target.value, 10)); });
  document.getElementById('prev').addEventListener('click', function () { setTick(state.tick - 1); });
  document.getElementById('next').addEventListener('click', function () { setTick(state.tick + 1); });
  document.getElementById('play').addEventListener('click', function () {
    var btn = document.getElementById('play');
    if (state.playing) { clearInterval(state.playing); state.playing = null; btn.textContent = '▶ play'; return; }
    if (state.tick >= data.ticks.length - 1) setTick(0);
    btn.textContent = '⏸ pause';
    state.playing = setInterval(function () {
      if (state.tick >= data.ticks.length - 1) { clearInterval(state.playing); state.playing = null; btn.textContent = '▶ play'; return; }
      setTick(state.tick + 1);
    }, 1200);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') setTick(state.tick - 1);
    if (e.key === 'ArrowRight') setTick(state.tick + 1);
  });

  renderCards();
})();
</script>
</body>
</html>
`;
}
