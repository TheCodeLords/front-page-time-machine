import { expect } from 'chai';
import { buildCaptureSnapshot } from '../src/schema/normalize.js';
import type { CaptureSnapshot } from '../src/schema/story-snapshot.js';
import { clusterTicks, buildTimelinePayload, renderTimeline } from '../src/report/timeline.js';

let uuid = 0;
function nextId(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
}

function makeCapture(
  source: string,
  name: string,
  at: string,
  headlines: string[],
): CaptureSnapshot {
  return buildCaptureSnapshot(
    headlines.map((headline, index) => ({
      headline,
      article_url: `https://${source}.example/story/${encodeURIComponent(headline)}-${index}`,
    })),
    {
      source,
      source_name: name,
      homepage_url: `https://${source}.example`,
      captured_at: at,
      capture_id: nextId(),
    },
    { collector_id: 'c_test', screenshot_path: null },
  );
}

const NOW = (): string => '2026-08-17T15:00:00.000Z';

describe('clusterTicks', () => {
  it('folds the serial-fetch spread back into one editorial moment', () => {
    // Six outlets fetched one after another land at 14:26..14:32 — ONE front-page moment, not six
    // scrubber stops. This spread straddles the 14:30 grid line, which is exactly why a fixed-grid
    // bucketing failed: any grid has a seam somewhere, and the real archive found it first try.
    const ticks = clusterTicks([
      '2026-08-17T14:26:05.000Z',
      '2026-08-17T14:27:10.000Z',
      '2026-08-17T14:29:44.000Z',
      '2026-08-17T14:32:41.000Z',
    ]);
    expect(ticks).to.deep.equal(['2026-08-17T14:26:05.000Z']);
  });

  it('keeps genuinely different hours apart', () => {
    const ticks = clusterTicks(['2026-08-17T13:00:00.000Z', '2026-08-17T14:00:00.000Z']);
    expect(ticks).to.have.length(2);
  });

  it('is empty for an empty archive', () => {
    expect(clusterTicks([])).to.deep.equal([]);
  });
});

describe('buildTimelinePayload', () => {
  it('produces one tick per capture moment, oldest first', () => {
    const payload = buildTimelinePayload(
      [
        makeCapture('npr', 'NPR', '2026-08-17T13:00:10.000Z', ['A story']),
        makeCapture('bbc', 'BBC', '2026-08-17T13:01:20.000Z', ['A story']),
        makeCapture('npr', 'NPR', '2026-08-17T14:00:05.000Z', ['A story']),
      ],
      [],
      NOW,
    );

    expect(payload.ticks).to.have.length(2);
    expect(payload.outlets.map((o) => o.src)).to.have.members(['npr', 'bbc']);
    expect(payload.divergence).to.have.length(payload.ticks.length);
  });

  it('gives the same story the same cluster id across outlets', () => {
    // This is what lets the page highlight one story everywhere it appeared: the ids come from the
    // SAME clustering function `fptm story` uses, computed at build time, not re-derived in JS.
    const payload = buildTimelinePayload(
      [
        makeCapture('npr', 'NPR', '2026-08-17T13:00:00.000Z', ['Volcano erupts near capital city']),
        makeCapture('bbc', 'BBC', '2026-08-17T13:01:00.000Z', ['Volcano erupts near capital city']),
      ],
      [],
      NOW,
    );

    const [nprRec] = payload.captures.find((c) => c.src === 'npr')?.records ?? [];
    const [bbcRec] = payload.captures.find((c) => c.src === 'bbc')?.records ?? [];
    expect(nprRec?.c).to.be.a('number');
    expect(nprRec?.c).to.equal(bbcRec?.c);
  });

  it('handles an empty archive without inventing ticks', () => {
    const payload = buildTimelinePayload([], [], NOW);
    expect(payload.ticks).to.deep.equal([]);
    expect(payload.captures).to.deep.equal([]);
  });

  it('carries the lead flag explicitly, so a rank-1 promo is not the lead', () => {
    // The Guardian case: a newsletter card held rank 1. The page must highlight the first
    // EDITORIAL story as the lead, and the divergence math must count that story, not the promo.
    const payload = buildTimelinePayload(
      [
        makeCapture('guardian', 'Guardian', '2026-08-17T13:00:00.000Z', [
          'Sign up for The Hotspot',
          'Ceasefire talks resume in Geneva',
        ]),
      ],
      [],
      NOW,
    );

    const records = payload.captures[0]?.records ?? [];
    expect(records[0]?.p).to.equal(1);
    expect(records[0]?.l).to.equal(0);
    expect(records[1]?.l).to.equal(1);
  });
});

describe('renderTimeline', () => {
  const payload = buildTimelinePayload(
    [makeCapture('npr', 'NPR', '2026-08-17T13:00:00.000Z', ['Plain headline'])],
    [],
    NOW,
  );

  it('is fully self-contained — no external scripts, styles or images', () => {
    const html = renderTimeline(payload);
    // Article links are the page's purpose; loading ASSETS from the network is what must not happen.
    expect(html).to.not.match(/<script[^>]+src=/);
    expect(html).to.not.match(/<link[^>]+href=/);
    expect(html).to.not.match(/<img/);
    expect(html).to.not.contain('cdn.');
  });

  it('escapes hostile headline text in both the markup and the JSON island', () => {
    // Headlines are scraped text from six publishers. One containing "</script>" must not be able
    // to terminate the data block and run the rest of the page as markup.
    const hostile = buildTimelinePayload(
      [
        makeCapture('npr', 'NPR', '2026-08-17T13:00:00.000Z', [
          '</script><img src=x onerror=alert(1)>',
        ]),
      ],
      [],
      NOW,
    );
    const html = renderTimeline(hostile);
    expect(html).to.not.contain('</script><img');
    expect(html).to.contain('\\u003c');
  });

  it('embeds a JSON payload the page can parse back', () => {
    const html = renderTimeline(payload);
    const match = /<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html);
    expect(match).to.not.equal(null);
    const parsed = JSON.parse(match![1]!) as { captures: unknown[]; ticks: string[] };
    expect(parsed.captures).to.have.length(1);
    expect(parsed.ticks).to.have.length(1);
  });

  it('renders repair episodes on the same page as the news, escaped like everything else', () => {
    const withRepairs = buildTimelinePayload(
      [makeCapture('npr', 'NPR', '2026-08-17T13:00:00.000Z', ['Plain headline'])],
      [
        {
          source: 'npr',
          source_name: 'NPR',
          collector_id: 'c_x',
          detected_at: '2026-08-17T12:40:00.000Z',
          state: 'RECOVERED',
          prompt: 'fix <script>alert(1)</script> extraction',
          stories_before: 2,
          stories_after: 31,
          approved: true,
          health_after: { status: 'HEALTHY', failing: [] },
          resolved_at: '2026-08-17T13:04:00.000Z',
          error: null,
          phase_marks: [
            { phase: 'heal_requested', at: '2026-08-17T12:40:00.000Z' },
            { phase: 'ai_generation_finished', at: '2026-08-17T13:01:00.000Z' },
            { phase: 'verified_by_rerun', at: '2026-08-17T13:04:00.000Z' },
          ],
        },
      ],
      NOW,
    );
    const html = renderTimeline(withRepairs);

    expect(html).to.contain('Repairs');
    expect(html).to.contain('2 → 31 stories');
    // Where the 24 minutes went: 21m of AI generation, 3m to verify.
    expect(html).to.contain('ai_generation_finished 21m');
    expect(html).to.contain('verified_by_rerun 3m');
    // Prompts quote scraped failure details — hostile input, escaped like headlines.
    expect(html).to.not.contain('<script>alert');
    // The health engine's verdict on the rerun is the claim that matters — it must be on the page.
    expect(html).to.contain('rerun verified HEALTHY');
  });

  it('shows a committed-but-unverified heal for what it is', () => {
    const unverified = buildTimelinePayload(
      [makeCapture('npr', 'NPR', '2026-08-17T13:00:00.000Z', ['Plain headline'])],
      [
        {
          source: 'npr',
          source_name: 'NPR',
          collector_id: 'c_x',
          detected_at: '2026-08-17T12:40:00.000Z',
          state: 'DEGRADED',
          prompt: 'fix extraction',
          stories_before: 2,
          stories_after: 3,
          approved: true,
          health_after: { status: 'DEGRADED', failing: ['story_count'] },
          resolved_at: '2026-08-17T13:04:00.000Z',
          error: null,
          phase_marks: [],
        },
      ],
      NOW,
    );
    expect(renderTimeline(unverified)).to.contain('rerun still DEGRADED');
  });

  it('gives the page a what-changed strip fed by the same capture lookup as the cards', () => {
    const html = renderTimeline(payload);
    expect(html).to.contain('id="delta"');
    expect(html).to.contain('renderDelta');
  });

  it('shows one row per repair — an approve resolution supersedes its pending line', () => {
    // `fptm approve` appends a resolution with the same source and detected_at. The ledger keeps
    // both lines (append-only history); the page must show only the outcome.
    const base = {
      source: 'npr',
      source_name: 'NPR',
      collector_id: 'c_x',
      detected_at: '2026-08-17T12:40:00.000Z',
      prompt: 'fix extraction',
      stories_before: 2,
      resolved_at: null,
      error: null,
      phase_marks: [],
      health_after: null,
    };
    const superseded = buildTimelinePayload(
      [makeCapture('npr', 'NPR', '2026-08-17T13:00:00.000Z', ['Plain headline'])],
      [
        { ...base, state: 'HEALING', approved: false, stories_after: null },
        {
          ...base,
          state: 'RECOVERED',
          approved: true,
          stories_after: 31,
          health_after: { status: 'HEALTHY', failing: [] },
          resolved_at: '2026-08-17T13:20:00.000Z',
        },
      ],
      NOW,
    );

    expect(superseded.episodes).to.have.length(1);
    expect(superseded.episodes[0]?.state).to.equal('RECOVERED');
    expect(superseded.episodes[0]?.verified).to.equal('HEALTHY');
  });

  it('says plainly when there is nothing to show', () => {
    const html = renderTimeline(buildTimelinePayload([], [], NOW));
    expect(html).to.contain('No captures stored yet');
  });

  it('renders theme tokens for both light and dark', () => {
    const html = renderTimeline(payload);
    expect(html).to.contain('prefers-color-scheme: dark');
    expect(html).to.contain('data-theme="dark"');
  });
});
