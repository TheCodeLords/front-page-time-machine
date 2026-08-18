import { expect } from 'chai';
import { clusterStories } from '../src/analyze/cluster.js';
import { diffCaptures } from '../src/analyze/diff.js';
import { buildPropagation } from '../src/analyze/propagation.js';
import { computeHealth, shouldHeal } from '../src/health/health.js';
import type { HealthStatus } from '../src/health/health.js';
import {
  DEMO_FEATURED_SLUG,
  DEMO_HOURS,
  DEMO_OUTLETS,
  buildDemoCaptures,
} from '../src/demo/seed.js';

/**
 * The demo fixture is scripted, so the script itself is worth asserting. If the seed stops producing
 * a detectable break, or the featured story stops having a blind spot, the demo silently stops
 * demonstrating anything — and that is exactly the kind of rot nobody notices until they are on stage.
 */

describe('demo seed', () => {
  const captures = buildDemoCaptures();

  it('produces a capture per outlet per hour', () => {
    expect(captures).to.have.length(DEMO_HOURS.length * DEMO_OUTLETS.length);
  });

  it('never shows the same headline as both NEW and REMOVED in one diff', () => {
    // Found on stage, or nearly: rotating filler drew from the standing pool, so a headline could
    // exit one URL and re-enter under another in the same hour — and Scene 2, the scene whose whole
    // job is to demonstrate the diff, printed a contradiction. URL-keyed identity was behaving
    // correctly; the fixture was lying about the input.
    for (const outlet of DEMO_OUTLETS) {
      const series = captures
        .filter((c) => c.snapshot.source === outlet.source)
        .map((c) => c.snapshot)
        .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
      for (let i = 1; i < series.length; i += 1) {
        const previous = series[i - 1];
        const current = series[i];
        if (previous === undefined || current === undefined) continue;
        const diff = diffCaptures(previous, current);
        const added = new Set(diff.added.map((change) => change.headline));
        const contradictions = diff.removed.filter((change) => added.has(change.headline));
        expect(
          contradictions,
          `${outlet.source} ${previous.captured_at} → ${current.captured_at}`,
        ).to.deep.equal([]);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildDemoCaptures())).to.equal(JSON.stringify(captures));
  });

  it('gives every front page realistic depth', () => {
    // The scripted NPR outage spans 13:00 AND 14:00 — both are meant to be thin.
    const healthy = captures.filter(
      (c) => !['T13:', 'T14:'].some((hour) => c.snapshot.captured_at.includes(hour)),
    );
    for (const { snapshot } of healthy) {
      expect(snapshot.records.length).to.be.greaterThan(5);
    }
  });

  it('scripts a break that the detector actually catches, twice in a row', () => {
    const npr = captures.filter((c) => c.snapshot.source === 'npr');
    const statuses: HealthStatus[] = [];
    const seen = [];

    for (const { snapshot, diagnostics } of npr) {
      statuses.push(computeHealth({ snapshot, diagnostics, baseline: seen.slice(-5) }).status);
      seen.push(snapshot);
    }

    expect(statuses.filter((s) => s !== 'HEALTHY')).to.have.length(2);
    expect(shouldHeal(statuses.slice(0, 7))).to.equal(true);
  });

  it('breaks headlines while leaving links intact, as a real redesign does', () => {
    const broken = captures.find(
      (c) => c.snapshot.source === 'npr' && c.snapshot.captured_at.includes('T13:'),
    );
    expect(broken?.diagnostics.rejected_no_headline).to.be.greaterThan(10);
    expect(broken?.diagnostics.rejected_no_url).to.equal(0);
  });

  it('recovers on its own after the scripted outage', () => {
    const after = captures.find(
      (c) => c.snapshot.source === 'npr' && c.snapshot.captured_at.includes('T15:'),
    );
    expect(after?.snapshot.records.length).to.be.greaterThan(15);
  });

  it('gives the featured story a genuine blind spot', () => {
    const records = captures.flatMap((c) => c.snapshot.records);
    const known = [...new Set(records.map((r) => r.source))].sort();
    const featured = clusterStories(records).find((cluster) =>
      cluster.records.some((r) => r.article_url.includes(DEMO_FEATURED_SLUG)),
    );

    expect(featured, 'featured cluster must exist').to.not.equal(undefined);
    const propagation = buildPropagation(featured!, known);

    // Three outlets carried it, one never did — the comparison the product exists to make.
    expect(propagation.outlets.length).to.be.greaterThan(2);
    expect(propagation.never_covered).to.deep.equal(['foxnews']);
  });

  it('spreads the featured story over time rather than all at once', () => {
    const records = captures.flatMap((c) => c.snapshot.records);
    const featured = clusterStories(records).find((cluster) =>
      cluster.records.some((r) => r.article_url.includes(DEMO_FEATURED_SLUG)),
    );
    const timeline = buildPropagation(featured!, []).coverage_timeline;

    expect(timeline[0]?.outlet_count).to.equal(1);
    expect(Math.max(...timeline.map((p) => p.outlet_count))).to.be.greaterThan(1);
  });
});
