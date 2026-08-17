import { expect } from 'chai';
import { buildCaptureSnapshot, normalizeRecords } from '../src/schema/normalize.js';
import type { CaptureContext } from '../src/schema/normalize.js';
import type { RawStoryRecord } from '../src/schema/story-snapshot.js';
import {
  CaptureSnapshotSchema,
  StorySnapshotRecordSchema,
  prominenceTierForPosition,
} from '../src/schema/story-snapshot.js';

const CONTEXT: CaptureContext = {
  source: 'bbc',
  source_name: 'BBC News',
  homepage_url: 'https://www.bbc.com/news',
  captured_at: '2026-08-17T10:00:00.000Z',
  capture_id: '11111111-2222-4333-8444-555555555555',
};

const VALID_RECORD = {
  source: 'bbc',
  source_name: 'BBC News',
  captured_at: '2026-08-17T10:00:00.000Z',
  capture_id: '11111111-2222-4333-8444-555555555555',
  section: 'Top Stories',
  headline: 'Rate cut announced',
  article_url: 'https://bbc.com/news/a-1',
  summary: null,
  image_url: null,
  published_at: null,
  position: 1,
  story_type: 'article',
  is_lead: true,
  prominence_tier: 'lead',
};

describe('StorySnapshotRecordSchema', () => {
  it('accepts a canonical record', () => {
    expect(() => StorySnapshotRecordSchema.parse(VALID_RECORD)).to.not.throw();
  });

  it('rejects a relative article_url — identity must be absolute', () => {
    expect(() =>
      StorySnapshotRecordSchema.parse({ ...VALID_RECORD, article_url: '/news/a-1' }),
    ).to.throw();
  });

  it('rejects a non-slug source, which would break the outlet key', () => {
    expect(() =>
      StorySnapshotRecordSchema.parse({ ...VALID_RECORD, source: 'BBC News' }),
    ).to.throw();
  });

  it('rejects a non-positive position', () => {
    expect(() => StorySnapshotRecordSchema.parse({ ...VALID_RECORD, position: 0 })).to.throw();
  });

  it('rejects an empty headline', () => {
    expect(() => StorySnapshotRecordSchema.parse({ ...VALID_RECORD, headline: '' })).to.throw();
  });

  it('requires an explicit null rather than an absent optional field', () => {
    const { summary: _summary, ...withoutSummary } = VALID_RECORD;
    expect(() => StorySnapshotRecordSchema.parse(withoutSummary)).to.throw();
  });
});

describe('prominenceTierForPosition', () => {
  it('buckets lead, above-fold and tail', () => {
    expect(prominenceTierForPosition(1)).to.equal('lead');
    expect(prominenceTierForPosition(5)).to.equal('above_fold');
    expect(prominenceTierForPosition(6)).to.equal('below');
  });
});

describe('the schema contract survives a heal (Phase 7 invariant)', () => {
  // This is the assertion the whole project rests on. When a publisher redesigns its homepage, the
  // healed Scraper Studio collector returns a DIFFERENT raw shape — absolute URLs where they were
  // relative, positions as strings, extra fields the new template happens to emit. Downstream must
  // not be able to tell. If this test ever fails, self-healing has become a breaking change.
  const beforeRedesign: RawStoryRecord[] = [
    { headline: 'Rate cut announced', article_url: '/news/a-1', position: 1, section: 'Top' },
    { headline: 'Storm warning', article_url: '/news/a-2', position: 2, section: 'Top' },
  ];

  const afterHeal: RawStoryRecord[] = [
    {
      headline: '  Rate cut announced ',
      article_url: 'https://www.bbc.com/news/a-1?utm_source=homepage',
      position: '1',
      section: 'Top',
      // The regenerated template emits fields our contract never asked for.
      data_testid: 'card-hero',
      css_class: 'sc-9f2a1b',
    },
    {
      headline: 'Storm warning',
      article_url: 'https://www.bbc.com/news/a-2/#lead',
      position: '2',
      section: 'Top',
      data_testid: 'card-2',
    },
  ];

  it('produces byte-identical canonical records from both raw shapes', () => {
    expect(normalizeRecords(afterHeal, CONTEXT)).to.deep.equal(
      normalizeRecords(beforeRedesign, CONTEXT),
    );
  });

  it('keeps every record valid against the unchanged schema', () => {
    for (const record of normalizeRecords(afterHeal, CONTEXT)) {
      expect(() => StorySnapshotRecordSchema.parse(record)).to.not.throw();
    }
  });
});

describe('buildCaptureSnapshot', () => {
  it('wraps records in a snapshot that traces back to its collector', () => {
    const snapshot = buildCaptureSnapshot(
      [{ headline: 'Rate cut announced', article_url: '/news/a-1' }],
      CONTEXT,
      { collector_id: 'c_test123', screenshot_path: 'screenshots/bbc/2026-08-17T10.png' },
    );
    expect(() => CaptureSnapshotSchema.parse(snapshot)).to.not.throw();
    expect(snapshot.collector_id).to.equal('c_test123');
    expect(snapshot.records).to.have.length(1);
  });

  it('accepts an empty capture so health can classify it rather than crashing', () => {
    // An empty homepage result is the single loudest failure signal we have. It must reach
    // src/health/ as data, not as an exception thrown in the collector.
    const snapshot = buildCaptureSnapshot([], CONTEXT, {
      collector_id: 'c_test123',
      screenshot_path: null,
    });
    expect(snapshot.records).to.deep.equal([]);
  });
});
