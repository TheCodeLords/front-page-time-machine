import { expect } from 'chai';
import { normalizeRecord, normalizeRecords } from '../src/schema/normalize.js';
import type { CaptureContext } from '../src/schema/normalize.js';
import type { RawStoryRecord } from '../src/schema/story-snapshot.js';

const CONTEXT: CaptureContext = {
  source: 'bbc',
  source_name: 'BBC News',
  homepage_url: 'https://www.bbc.com/news',
  captured_at: '2026-08-17T10:00:00.000Z',
  capture_id: '11111111-2222-4333-8444-555555555555',
};

describe('normalizeRecord', () => {
  it('drops a record with no usable headline', () => {
    expect(normalizeRecord({ headline: '   ', article_url: '/a' }, CONTEXT, 1)).to.equal(null);
    expect(normalizeRecord({ article_url: '/a' }, CONTEXT, 1)).to.equal(null);
  });

  it('drops a record with no usable link', () => {
    expect(normalizeRecord({ headline: 'Real story', article_url: '#nav' }, CONTEXT, 1)).to.equal(
      null,
    );
  });

  it('drops a masthead link back to the homepage itself', () => {
    // Caught in review: `new URL('#main', base)` resolves to the base, so before the fragment guard
    // every "skip to content" link became a phantom lead story at position 1.
    expect(normalizeRecord({ headline: 'Home', article_url: '/news' }, CONTEXT, 1)).to.equal(null);
    expect(
      normalizeRecord({ headline: 'BBC News', article_url: 'https://bbc.com/news/' }, CONTEXT, 1),
    ).to.equal(null);
  });

  it('collapses soft-wrapped markup whitespace in a headline', () => {
    const record = normalizeRecord(
      { headline: '  Rate cut\n   announced  ', article_url: '/news/a-1' },
      CONTEXT,
      1,
    );
    expect(record?.headline).to.equal('Rate cut announced');
  });

  it('quotes the headline verbatim rather than trimming its content', () => {
    const headline = 'Markets fall 3% as "shock" ruling lands';
    expect(normalizeRecord({ headline, article_url: '/news/a-1' }, CONTEXT, 1)?.headline).to.equal(
      headline,
    );
  });

  it('accepts a position the collector reports as a string', () => {
    const record = normalizeRecord({ headline: 'A', article_url: '/a', position: '4' }, CONTEXT, 9);
    expect(record?.position).to.equal(4);
  });

  it('falls back to document order when position is missing or nonsense', () => {
    expect(normalizeRecord({ headline: 'A', article_url: '/a' }, CONTEXT, 7)?.position).to.equal(7);
    expect(
      normalizeRecord({ headline: 'A', article_url: '/a', position: 0 }, CONTEXT, 7)?.position,
    ).to.equal(7);
  });

  it('reports unknown rather than guessing a story type', () => {
    expect(normalizeRecord({ headline: 'A', article_url: '/a' }, CONTEXT, 1)?.story_type).to.equal(
      'unknown',
    );
  });

  it('maps story types loosely across publisher vocabularies', () => {
    const typeOf = (value: string) =>
      normalizeRecord({ headline: 'A', article_url: '/a', story_type: value }, CONTEXT, 1)
        ?.story_type;
    expect(typeOf('Watch')).to.equal('video');
    expect(typeOf('LIVE blog')).to.equal('live');
    expect(typeOf('Updated')).to.equal('update');
    expect(typeOf('news story')).to.equal('article');
  });

  it('nulls an unparseable publisher timestamp instead of inventing one', () => {
    const record = normalizeRecord(
      { headline: 'A', article_url: '/a', published_at: 'just now' },
      CONTEXT,
      1,
    );
    expect(record?.published_at).to.equal(null);
  });

  it('parses newsroom timezone abbreviations that Date rejects outright', () => {
    const at = (published_at: string) =>
      normalizeRecord({ headline: 'A', article_url: '/a', published_at }, CONTEXT, 1)?.published_at;
    expect(at('August 16, 2026 7:54 AM ET')).to.equal('2026-08-16T11:54:00.000Z');
    expect(at('August 16, 2026 7:54 AM PT')).to.equal('2026-08-16T14:54:00.000Z');
    expect(at('August 16, 2026 7:54 AM GMT')).to.equal('2026-08-16T07:54:00.000Z');
  });

  it('still nulls an unknown timezone rather than guessing an offset', () => {
    const record = normalizeRecord(
      { headline: 'A', article_url: '/a', published_at: 'August 16, 2026 7:54 AM XYZ' },
      CONTEXT,
      1,
    );
    expect(record?.published_at).to.equal(null);
  });

  it('normalizes a parseable publisher timestamp to ISO', () => {
    const record = normalizeRecord(
      { headline: 'A', article_url: '/a', published_at: '2026-08-17T09:30:00Z' },
      CONTEXT,
      1,
    );
    expect(record?.published_at).to.equal('2026-08-17T09:30:00.000Z');
  });
});

describe('normalizeRecords', () => {
  it('keeps the most prominent appearance of a duplicated story', () => {
    const raw: RawStoryRecord[] = [
      { headline: 'Sidebar copy', article_url: '/news/a-1?at_medium=rail', position: 8 },
      { headline: 'Hero copy', article_url: '/news/a-1', position: 1 },
    ];
    const records = normalizeRecords(raw, CONTEXT);
    expect(records).to.have.length(1);
    expect(records[0]?.headline).to.equal('Hero copy');
  });

  it('re-ranks contiguously so dedupe leaves no positional holes', () => {
    const raw: RawStoryRecord[] = [
      { headline: 'One', article_url: '/a', position: 1 },
      { headline: 'One again', article_url: '/a?utm_source=x', position: 2 },
      { headline: 'Two', article_url: '/b', position: 3 },
      { headline: 'Three', article_url: '/c', position: 4 },
    ];
    const records = normalizeRecords(raw, CONTEXT);
    expect(records.map((r) => r.position)).to.deep.equal([1, 2, 3]);
  });

  it('marks exactly one lead per capture', () => {
    const raw: RawStoryRecord[] = [
      { headline: 'One', article_url: '/a' },
      { headline: 'Two', article_url: '/b' },
      { headline: 'Three', article_url: '/c' },
    ];
    const records = normalizeRecords(raw, CONTEXT);
    expect(records.filter((r) => r.is_lead)).to.have.length(1);
    expect(records[0]?.is_lead).to.equal(true);
  });

  it('buckets prominence by ordinal rank, not by pixels', () => {
    const raw: RawStoryRecord[] = Array.from({ length: 7 }, (_, i) => ({
      headline: `Story ${i}`,
      article_url: `/news/${i}`,
    }));
    const tiers = normalizeRecords(raw, CONTEXT).map((r) => r.prominence_tier);
    expect(tiers).to.deep.equal([
      'lead',
      'above_fold',
      'above_fold',
      'above_fold',
      'above_fold',
      'below',
      'below',
    ]);
  });

  it('preserves headline churn on a fixed URL across captures', () => {
    // A live blog rewrites its headline hourly against one URL. Two captures, one story, two
    // headlines — that churn is the signal, so it must survive as data.
    const at10 = normalizeRecords([{ headline: 'Talks begin', article_url: '/live/1' }], CONTEXT);
    const at11 = normalizeRecords([{ headline: 'Deal reached', article_url: '/live/1' }], {
      ...CONTEXT,
      captured_at: '2026-08-17T11:00:00.000Z',
    });
    expect(at10[0]?.article_url).to.equal(at11[0]?.article_url);
    expect(at10[0]?.headline).to.not.equal(at11[0]?.headline);
  });

  it('survives a capture that is entirely navigation junk', () => {
    const raw: RawStoryRecord[] = [
      { headline: 'Home', article_url: '#main' },
      { headline: '', article_url: '/news/a' },
    ];
    expect(normalizeRecords(raw, CONTEXT)).to.deep.equal([]);
  });
});
