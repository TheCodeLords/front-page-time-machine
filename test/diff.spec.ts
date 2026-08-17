import { expect } from 'chai';
import { diffCaptures, isQuiet } from '../src/analyze/diff.js';
import { makeCapture } from './helpers/capture.js';

const AT_10 = '2026-08-17T10:00:00.000Z';
const AT_11 = '2026-08-17T11:00:00.000Z';

const story = (headline: string, slug: string) => ({
  headline,
  article_url: `/story/${slug}`,
});

describe('diffCaptures', () => {
  it('classifies added, removed, promoted, demoted and unchanged', () => {
    const previous = makeCapture(
      [story('Rate cut', 'rate-cut'), story('Storm', 'storm'), story('Election', 'election')],
      { capturedAt: AT_10 },
    ).snapshot;
    const current = makeCapture(
      [story('Storm', 'storm'), story('Rate cut', 'rate-cut'), story('Wildfire', 'wildfire')],
      { capturedAt: AT_11 },
    ).snapshot;

    const diff = diffCaptures(previous, current);

    expect(diff.added.map((c) => c.headline)).to.deep.equal(['Wildfire']);
    expect(diff.removed.map((c) => c.headline)).to.deep.equal(['Election']);
    expect(diff.moved_up.map((c) => c.headline)).to.deep.equal(['Storm']);
    expect(diff.moved_down.map((c) => c.headline)).to.deep.equal(['Rate cut']);
    expect(diff.unchanged).to.deep.equal([]);
  });

  it('treats a lower rank number as a promotion', () => {
    const previous = makeCapture(
      [...Array.from({ length: 7 }, (_, i) => story(`Filler ${i}`, `f${i}`)), story('Riser', 'r')],
      { capturedAt: AT_10 },
    ).snapshot;
    const current = makeCapture(
      [story('Riser', 'r'), ...Array.from({ length: 7 }, (_, i) => story(`Filler ${i}`, `f${i}`))],
      { capturedAt: AT_11 },
    ).snapshot;

    const diff = diffCaptures(previous, current);
    const riser = diff.moved_up.find((c) => c.headline === 'Riser');
    expect(riser?.previous_position).to.equal(8);
    expect(riser?.current_position).to.equal(1);
  });

  it('records a headline rewrite on a fixed URL as its own signal', () => {
    // The live-blog case. Same story, same URL, new title — attention, not a new story.
    const previous = makeCapture([story('Talks begin', 'live-1')], { capturedAt: AT_10 }).snapshot;
    const current = makeCapture([story('Deal reached', 'live-1')], { capturedAt: AT_11 }).snapshot;

    const diff = diffCaptures(previous, current);
    expect(diff.added).to.deep.equal([]);
    expect(diff.removed).to.deep.equal([]);
    expect(diff.headline_rewrites).to.have.length(1);
    expect(diff.headline_rewrites[0]?.previous_headline).to.equal('Talks begin');
    expect(diff.headline_rewrites[0]?.current_headline).to.equal('Deal reached');
  });

  it('does not count a rewritten headline as a position change', () => {
    const previous = makeCapture([story('Talks begin', 'live-1')], { capturedAt: AT_10 }).snapshot;
    const current = makeCapture([story('Deal reached', 'live-1')], { capturedAt: AT_11 }).snapshot;
    const diff = diffCaptures(previous, current);
    expect(diff.unchanged).to.have.length(1);
  });

  it('sorts movers by how far they travelled', () => {
    const previous = makeCapture(
      [story('A', 'a'), story('B', 'b'), story('C', 'c'), story('D', 'd')],
      { capturedAt: AT_10 },
    ).snapshot;
    const current = makeCapture(
      [story('D', 'd'), story('B', 'b'), story('C', 'c'), story('A', 'a')],
      { capturedAt: AT_11 },
    ).snapshot;

    const diff = diffCaptures(previous, current);
    expect(diff.moved_up[0]?.headline).to.equal('D');
  });

  it('refuses to diff two different outlets', () => {
    const bbc = makeCapture([story('X', 'x')], { source: 'bbc', capturedAt: AT_10 }).snapshot;
    const npr = makeCapture([story('X', 'x')], { source: 'npr', capturedAt: AT_11 }).snapshot;
    expect(() => diffCaptures(bbc, npr)).to.throw(/different sources/);
  });

  it('handles a front page that emptied out entirely', () => {
    const previous = makeCapture([story('A', 'a'), story('B', 'b')], {
      capturedAt: AT_10,
    }).snapshot;
    const current = makeCapture([], { capturedAt: AT_11 }).snapshot;
    const diff = diffCaptures(previous, current);
    expect(diff.removed).to.have.length(2);
    expect(diff.added).to.deep.equal([]);
  });
});

describe('isQuiet', () => {
  it('is true when a front page did not move at all', () => {
    const records = [story('A', 'a'), story('B', 'b')];
    const previous = makeCapture(records, { capturedAt: AT_10 }).snapshot;
    const current = makeCapture(records, { capturedAt: AT_11 }).snapshot;
    expect(isQuiet(diffCaptures(previous, current))).to.equal(true);
  });

  it('is false when only a headline was rewritten', () => {
    const previous = makeCapture([story('Talks begin', 'live-1')], { capturedAt: AT_10 }).snapshot;
    const current = makeCapture([story('Deal reached', 'live-1')], { capturedAt: AT_11 }).snapshot;
    expect(isQuiet(diffCaptures(previous, current))).to.equal(false);
  });
});
