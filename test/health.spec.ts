import { expect } from 'chai';
import {
  DEFAULT_THRESHOLDS,
  computeHealth,
  failingSignals,
  isHealable,
  median,
  shouldHeal,
} from '../src/health/health.js';
import type { HealthStatus } from '../src/health/health.js';
import { buildHealPrompt } from '../src/heal/heal-prompt.js';
import { healthyStories, makeCapture } from './helpers/capture.js';

function signal(report: ReturnType<typeof computeHealth>, name: string) {
  return report.signals.find((s) => s.name === name);
}

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).to.equal(2);
    expect(median([4, 1, 3, 2])).to.equal(2.5);
  });

  it('returns null with nothing to average', () => {
    expect(median([])).to.equal(null);
  });
});

describe('computeHealth', () => {
  const baseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(42)).snapshot);

  it('reports HEALTHY when a capture matches its trailing norm', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(41));
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(report.status).to.equal('HEALTHY');
    expect(report.baseline_median).to.equal(42);
    expect(failingSignals(report)).to.deep.equal([]);
  });

  it('does not mistake normal news volatility for damage', () => {
    // 42 -> 30 is a quiet afternoon, not a redesign. A naive "any drop" rule would fire here.
    const { snapshot, diagnostics } = makeCapture(healthyStories(30));
    expect(computeHealth({ snapshot, diagnostics, baseline }).status).to.equal('HEALTHY');
  });

  it('reports DEGRADED when story count collapses against the norm', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(3));
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(report.status).to.equal('DEGRADED');
    expect(signal(report, 'story_count')?.detail).to.contain('trailing median of 42');
  });

  it('reports FAILED on an empty capture', () => {
    const { snapshot, diagnostics } = makeCapture([]);
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(report.status).to.equal('FAILED');
    expect(signal(report, 'empty_capture')?.severity).to.equal('failed');
  });

  it('distinguishes "no rows" from "rows that all failed normalization"', () => {
    const junk = Array.from({ length: 20 }, () => ({ headline: '', article_url: '/x' }));
    const { snapshot, diagnostics } = makeCapture(junk);
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(signal(report, 'empty_capture')?.detail).to.contain('20 rows');
  });

  it('identifies WHICH part of extraction broke', () => {
    // The anchor survived; only the headline text node moved. That distinction is the heal prompt.
    const damaged = [
      ...healthyStories(3),
      ...Array.from({ length: 38 }, (_, i) => ({ headline: '', article_url: `/story/x-${i}` })),
    ];
    const { snapshot, diagnostics } = makeCapture(damaged);
    const report = computeHealth({ snapshot, diagnostics, baseline });

    expect(report.status).to.equal('FAILED');
    expect(signal(report, 'headline_extraction')?.severity).to.equal('failed');
    expect(signal(report, 'headline_extraction')?.detail).to.contain('38/41');
    expect(signal(report, 'url_extraction')?.severity).to.equal('ok');
  });

  it('flags a duplicate-URL spike, which means extraction collapsed onto one node', () => {
    const collapsed = Array.from({ length: 10 }, (_, i) => ({
      headline: `Story ${i}`,
      article_url: '/story/the-same-one',
    }));
    const { snapshot, diagnostics } = makeCapture(collapsed);
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(signal(report, 'duplicate_urls')?.severity).to.equal('failed');
  });

  it('tolerates the ordinary duplicate of a hero story also linked in a rail', () => {
    const raw = [
      ...healthyStories(20),
      { headline: 'Story 1 again', article_url: '/story/story-1' },
    ];
    const { snapshot, diagnostics } = makeCapture(raw);
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(signal(report, 'duplicate_urls')?.severity).to.equal('ok');
  });

  it('never lets a broken run drift the baseline toward zero', () => {
    // If three broken hours counted, the median would slide to 0 and declare the outage normal —
    // the detector would heal itself into blindness. Empty captures are excluded from the baseline.
    const pollutedBaseline = [
      ...Array.from({ length: 3 }, () => makeCapture(healthyStories(40)).snapshot),
      ...Array.from({ length: 3 }, () => makeCapture([]).snapshot),
    ];
    const { snapshot, diagnostics } = makeCapture(healthyStories(2));
    const report = computeHealth({ snapshot, diagnostics, baseline: pollutedBaseline });
    expect(report.baseline_median).to.equal(40);
    expect(report.status).to.equal('DEGRADED');
  });

  it('treats a tiny first-ever capture as suspicious even with no baseline', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(1));
    const report = computeHealth({ snapshot, diagnostics, baseline: [] });
    expect(report.status).to.equal('DEGRADED');
    expect(signal(report, 'story_count')?.detail).to.contain('no baseline');
  });

  it('accepts a healthy first-ever capture with no baseline', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(40));
    expect(computeHealth({ snapshot, diagnostics, baseline: [] }).status).to.equal('HEALTHY');
  });

  it('confirms rank contiguity as a structural invariant', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(6));
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(signal(report, 'position_integrity')?.severity).to.equal('ok');
  });

  it('honours custom thresholds', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(30));
    const strict = computeHealth(
      { snapshot, diagnostics, baseline },
      { ...DEFAULT_THRESHOLDS, storyCountDegradedRatio: 0.9 },
    );
    expect(strict.status).to.equal('DEGRADED');
  });
});

describe('detecting a field that silently disappeared', () => {
  // The scenario a heal creates: the AI regenerates the template, reports success, and drops an
  // output field. Every record stays schema-valid because the field is nullable, so without this
  // signal the dataset loses a column with every other check green.
  const withImages = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      headline: `Story ${i + 1}`,
      article_url: `/story/${i + 1}`,
      image_url: `https://npr.example/img/${i + 1}.jpg`,
    }));

  const baselineWithImages = Array.from({ length: 5 }, () => makeCapture(withImages(20)).snapshot);

  it('flags a field that was reliably present and is now absent everywhere', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(20));
    const report = computeHealth({ snapshot, diagnostics, baseline: baselineWithImages });

    expect(report.status).to.equal('DEGRADED');
    expect(signal(report, 'field_lost:image_url')?.detail).to.contain('100%');
  });

  it('stays quiet when the field is still arriving', () => {
    const { snapshot, diagnostics } = makeCapture(withImages(20));
    const report = computeHealth({ snapshot, diagnostics, baseline: baselineWithImages });
    expect(report.status).to.equal('HEALTHY');
  });

  it('does not flag a field the collector never returned in the first place', () => {
    // NPR's live collector returns no summary at all. That is a known limitation, not a regression,
    // and reporting it every hour would train everyone to ignore the detector.
    const baseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(20)).snapshot);
    const { snapshot, diagnostics } = makeCapture(healthyStories(20));
    const report = computeHealth({ snapshot, diagnostics, baseline });

    expect(report.signals.some((s) => s.name.startsWith('field_lost:'))).to.equal(false);
    expect(report.status).to.equal('HEALTHY');
  });

  it('ignores a field that was only sporadically present', () => {
    // Half the stories on a real homepage legitimately have no image.
    const sporadic = Array.from(
      { length: 5 },
      () => makeCapture([...withImages(4), ...healthyStories(16, 'Plain')]).snapshot,
    );
    const { snapshot, diagnostics } = makeCapture(healthyStories(20));
    const report = computeHealth({ snapshot, diagnostics, baseline: sporadic });
    expect(report.signals.some((s) => s.name.startsWith('field_lost:'))).to.equal(false);
  });
});

describe('over-extraction', () => {
  const baseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(42)).snapshot);

  it('flags a count implausible for any front page, even with no baseline', () => {
    // The live case: Fox News, 1,911 raw rows, 499 surviving "stories", all validating. Nothing
    // fired. The ratio check alone cannot catch this — a collector that over-extracts from its
    // FIRST capture poisons its own baseline, and the median settles at the inflated number.
    const { snapshot, diagnostics } = makeCapture(healthyStories(499));
    const report = computeHealth({ snapshot, diagnostics, baseline: [] });

    const signal = report.signals.find((s) => s.name === 'over_extraction');
    expect(signal?.severity).to.equal('degraded');
    expect(signal?.detail).to.contain('navigation');
    expect(report.status).to.equal('DEGRADED');
  });

  it('flags a sudden widening against an established baseline', () => {
    // 42 → 140 is not a busy news day; it is the collector escaping its container.
    const { snapshot, diagnostics } = makeCapture(healthyStories(140));
    const report = computeHealth({ snapshot, diagnostics, baseline });

    expect(report.signals.some((s) => s.name === 'over_extraction')).to.equal(true);
  });

  it('does not fire on normal news-volume swings', () => {
    // 42 → 60 must stay quiet, or every busy morning reads as damage.
    const { snapshot, diagnostics } = makeCapture(healthyStories(60));
    const report = computeHealth({ snapshot, diagnostics, baseline });

    expect(report.signals.some((s) => s.name === 'over_extraction')).to.equal(false);
    expect(report.status).to.equal('HEALTHY');
  });

  it('bars over-extracted captures from defining the baseline', () => {
    // Without this, the ratio check self-silences: Fox over-extracts 499 from capture one, three
    // captures later the trailing median IS 499, and 499 reads as normal forever after.
    const poisoned = Array.from({ length: 5 }, () => makeCapture(healthyStories(499)).snapshot);
    const { snapshot, diagnostics } = makeCapture(healthyStories(499));
    const report = computeHealth({ snapshot, diagnostics, baseline: poisoned });

    expect(report.baseline_median).to.equal(null);
    expect(report.signals.some((s) => s.name === 'over_extraction')).to.equal(true);
  });

  it('routes the over-extraction verdict into a precision heal prompt, not a recall one', () => {
    // The default prompt says "every story card must yield…" — recall framing, the exact wrong
    // medicine for a collector already reading too much of the page.
    const { snapshot, diagnostics } = makeCapture(healthyStories(499));
    const report = computeHealth({ snapshot, diagnostics, baseline: [] });
    const prompt = buildHealPrompt(report, 'https://www.foxnews.com');

    expect(prompt).to.contain('extracting too much');
    expect(prompt).to.contain('exclude navigation');
    expect(prompt).to.not.contain('every story card');
    // And `story_count` graded ok (the count is not LOW) — it must not be cited as "still working"
    // in the same prompt that complains there are too many rows.
    expect(prompt).to.not.match(/Still working:[^.]*story_count/);
    expect(prompt.length).to.be.at.most(1000);
  });

  it('leaves a dense but plausible homepage healthy when it IS the baseline', () => {
    // BBC legitimately runs ~164 stories. Against its own history that is normal, and the absolute
    // ceiling sits above it — the ceiling exists for 499, not 164.
    const bbcBaseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(164)).snapshot);
    const { snapshot, diagnostics } = makeCapture(healthyStories(170));
    const report = computeHealth({ snapshot, diagnostics, baseline: bbcBaseline });

    expect(report.signals.some((s) => s.name === 'over_extraction')).to.equal(false);
  });
});

describe('raw vocabulary drift', () => {
  // The alias layer absorbs renames — which also HIDES them. This signal is the early warning.
  const withField = (extra: Record<string, unknown>) =>
    Array.from({ length: 10 }, (_, i) => ({
      headline: `Story ${i}`,
      article_url: `/story/${i}`,
      ...extra,
    }));

  it('grades a lost field as degraded when it was feeding canonical data', () => {
    // `publish_date` is alias-known: it fed published_at. Its disappearance is data loss in waiting.
    const baseline = [makeCapture(withField({ publish_date: 'August 16, 2026' })).snapshot];
    const { snapshot, diagnostics } = makeCapture(withField({}));
    const report = computeHealth({ snapshot, diagnostics, baseline });

    const drift = signal(report, 'raw_shape_drift');
    expect(drift?.severity).to.equal('degraded');
    expect(drift?.detail).to.contain('publish_date');
  });

  it('records but does not alarm on cosmetic drift', () => {
    // `author_url` never fed a canonical field — exactly the rename a real heal shipped unasked.
    const baseline = [makeCapture(withField({ author_url: 'https://x.example/a' })).snapshot];
    const { snapshot, diagnostics } = makeCapture(withField({}));
    const report = computeHealth({ snapshot, diagnostics, baseline });

    const drift = signal(report, 'raw_shape_drift');
    expect(drift?.severity).to.equal('ok');
    expect(drift?.detail).to.contain('cosmetic');
    expect(report.status).to.equal('HEALTHY');
  });

  it('stays silent when the vocabulary is stable', () => {
    const baseline = [makeCapture(withField({})).snapshot];
    const { snapshot, diagnostics } = makeCapture(withField({}));
    const report = computeHealth({ snapshot, diagnostics, baseline });
    expect(signal(report, 'raw_shape_drift')).to.equal(undefined);
  });

  it('never fires against captures that predate vocabulary recording', () => {
    // Legacy captures read back with raw_fields=[]; comparing against nothing proves nothing.
    const legacy = makeCapture(withField({})).snapshot;
    const stripped = { ...legacy, diagnostics: null };
    const { snapshot, diagnostics } = makeCapture(withField({}));
    const report = computeHealth({ snapshot, diagnostics, baseline: [stripped] });
    expect(signal(report, 'raw_shape_drift')).to.equal(undefined);
  });
});

describe('upstream errors', () => {
  const withUpstream = (upstream: number, total: number): ReturnType<typeof computeHealth> =>
    computeHealth({
      snapshot: makeCapture([]).snapshot,
      diagnostics: {
        raw_count: total,
        rejected_no_headline: 0,
        rejected_no_url: 0,
        collapsed_duplicates: 0,
        rejected_self_link: 0,
        rejected_upstream_error: upstream,
        raw_fields: [],
      },
      baseline: [],
    });

  it('names the cause instead of blaming extraction', () => {
    const report = withUpstream(14, 14);
    const signal = report.signals.find((s) => s.name === 'upstream_error');
    expect(signal?.severity).to.equal('failed');
    expect(signal?.detail).to.contain('healing will not help');
  });

  it('refuses to spend a heal on something a heal cannot fix', () => {
    // 15–30 minutes of AI Flow and a concurrency slot other outlets are queueing for.
    expect(isHealable(withUpstream(14, 14))).to.equal(false);
  });

  it('still allows healing when only some rows failed upstream', () => {
    // A partial outage can coexist with real extraction damage; refusing to heal would hide it.
    expect(isHealable(withUpstream(3, 40))).to.equal(true);
  });

  it('leaves an ordinary broken collector healable', () => {
    expect(isHealable(withUpstream(0, 40))).to.equal(true);
  });
});

describe('shouldHeal', () => {
  const run = (...statuses: HealthStatus[]) => shouldHeal(statuses);

  it('does not fire on a single bad capture', () => {
    expect(run('HEALTHY', 'DEGRADED')).to.equal(false);
  });

  it('fires on two consecutive bad captures', () => {
    expect(run('HEALTHY', 'DEGRADED', 'DEGRADED')).to.equal(true);
    expect(run('FAILED', 'FAILED')).to.equal(true);
  });

  it('resets on recovery, so an old outage cannot trigger a heal later', () => {
    expect(run('DEGRADED', 'DEGRADED', 'HEALTHY')).to.equal(false);
    expect(run('FAILED', 'FAILED', 'HEALTHY', 'DEGRADED')).to.equal(false);
  });

  it('does not fire before enough history exists', () => {
    expect(run('FAILED')).to.equal(false);
    expect(run()).to.equal(false);
  });
});
