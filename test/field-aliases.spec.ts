import { expect } from 'chai';
import { toRawRecords } from '../src/collect/brightdata.js';
import { mapFieldAliases } from '../src/schema/field-aliases.js';
import { normalizeCapture } from '../src/schema/normalize.js';
import type { CaptureContext } from '../src/schema/normalize.js';

/**
 * These fixtures are REAL rows returned by Scraper Studio collector `c_msx5l3eh6ahgb3ys5` running
 * against https://www.npr.org on 2026-08-17. Keeping them verbatim is the point: the field names
 * below are not what we asked for, and every future collector will surprise us differently.
 */
const REAL_NPR_ROWS = [
  {
    headline:
      "'What are we going to do?' The mom of a trans teen grapples with Trump's Medicaid move",
    section: 'Healthcare',
    publish_date: 'August 16, 2026',
    publish_time: '7:54 AM ET',
    author_name: 'Selena Simmons-Duffin',
    author_url: 'https://www.npr.org/people/349308023/selena-simmons-duffin',
    related_stories: [
      {
        headline: 'In just a few years, half of all states passed bans',
        url: 'https://www.npr.org/sections/health-shots/',
      },
    ],
    product_page_url:
      'https://www.npr.org/2026/08/16/nx-s1-5932491/transgender-health-care-medicaid-trump-oz',
    input: { url: 'https://www.npr.org' },
  },
  {
    headline: 'Jason Arday, Cambridge professor accused of plagiarism, is found dead',
    section: 'Europe',
    publish_date: 'August 15, 2026',
    publish_time: '1:04 PM ET',
    author_name: 'The Associated Press',
    product_page_url: 'https://www.npr.org/2026/08/15/nx-s1-5932488/jason-arday-dead',
    input: { url: 'https://www.npr.org' },
  },
];

const CONTEXT: CaptureContext = {
  source: 'npr',
  source_name: 'NPR',
  homepage_url: 'https://www.npr.org',
  captured_at: '2026-08-17T11:40:00.000Z',
  capture_id: '11111111-2222-4333-8444-555555555555',
};

describe('mapFieldAliases', () => {
  it('maps the link name the live NPR collector actually chose', () => {
    const mapped = mapFieldAliases(REAL_NPR_ROWS[0]!);
    expect(mapped['article_url']).to.equal(
      'https://www.npr.org/2026/08/16/nx-s1-5932491/transgender-health-care-medicaid-trump-oz',
    );
  });

  it('rejoins a timestamp the collector split into date and time', () => {
    // Apart, the date parses to midnight and every story in a day collapses to one instant.
    expect(mapFieldAliases(REAL_NPR_ROWS[0]!)['published_at']).to.equal(
      'August 16, 2026 7:54 AM ET',
    );
  });

  it('does not append a time to a value that already carries one', () => {
    const mapped = mapFieldAliases({
      published_at: '2026-08-16T07:54:00Z',
      publish_time: '7:54 AM',
    });
    expect(mapped['published_at']).to.equal('2026-08-16T07:54:00Z');
  });

  it('keeps the original keys as evidence of what the collector emitted', () => {
    // "Extraction renamed a field" and "extraction broke" need different responses.
    const mapped = mapFieldAliases(REAL_NPR_ROWS[0]!);
    expect(mapped['product_page_url']).to.be.a('string');
    expect(mapped['author_name']).to.equal('Selena Simmons-Duffin');
  });

  it('prefers the canonical name when a collector emits both', () => {
    const mapped = mapFieldAliases({
      article_url: 'https://a.com/right',
      url: 'https://a.com/wrong',
    });
    expect(mapped['article_url']).to.equal('https://a.com/right');
  });

  it('unwraps a nested url object rather than stringifying it', () => {
    expect(mapFieldAliases({ link: { url: 'https://a.com/x' } })['article_url']).to.equal(
      'https://a.com/x',
    );
  });

  it('ignores an array field instead of mangling it into a string', () => {
    // `related_stories` is an array of objects; naive coercion yields "[object Object]".
    const mapped = mapFieldAliases(REAL_NPR_ROWS[0]!);
    expect(mapped['headline']).to.be.a('string');
    expect(mapped['headline']).to.not.contain('[object');
  });

  it('survives a field a heal turned into an empty object', () => {
    // Verbatim from the real gated heal of c_msx6cy0m2aeyu3sc1z: asked to add summary, image_url and
    // story_type, the regenerated template delivered all three AND replaced the string date with
    // `{}`. A naive coercion yields "[object Object]", which parses to a garbage timestamp; null is
    // the honest answer, and `field_lost:published_at` is what should raise the alarm.
    const mapped = mapFieldAliases({
      headline: 'Meta heads to court',
      product_page_url: 'https://www.npr.org/2026/08/17/nx-s1-5930701/meta-trial',
      publish_date: {},
      summary: 'Four states are suing the parent company.',
      image_url: 'https://npr.brightspotcdn.com/x.jpg',
      story_type: 'article',
    });

    expect(mapped['published_at']).to.equal(undefined);
    expect(mapped['summary']).to.equal('Four states are suing the parent company.');
    expect(mapped['image_url']).to.equal('https://npr.brightspotcdn.com/x.jpg');
    expect(mapped['story_type']).to.equal('article');
  });

  it('normalizes that healed row to a null timestamp rather than a fabricated one', () => {
    const { records } = normalizeCapture(
      toRawRecords([
        {
          headline: 'Meta heads to court',
          product_page_url: 'https://www.npr.org/2026/08/17/nx-s1-5930701/meta-trial',
          publish_date: {},
          image_url: 'https://npr.brightspotcdn.com/x.jpg',
        },
      ]),
      CONTEXT,
    );

    expect(records).to.have.length(1);
    expect(records[0]?.published_at).to.equal(null);
    expect(records[0]?.image_url).to.equal('https://npr.brightspotcdn.com/x.jpg');
  });

  it('maps the common vocabularies other collectors are likely to pick', () => {
    const mapped = mapFieldAliases({
      title: 'A headline',
      permalink: 'https://a.com/x',
      category: 'World',
      teaser: 'A summary',
      thumbnail: 'https://a.com/i.jpg',
      rank: 4,
    });
    expect(mapped['headline']).to.equal('A headline');
    expect(mapped['article_url']).to.equal('https://a.com/x');
    expect(mapped['section']).to.equal('World');
    expect(mapped['summary']).to.equal('A summary');
    expect(mapped['image_url']).to.equal('https://a.com/i.jpg');
    expect(mapped['position']).to.equal(4);
  });
});

describe('upstream errors are not extraction failures', () => {
  /** Verbatim from a live Al Jazeera run on 2026-08-17, after hammering the account all afternoon. */
  const RATE_LIMITED_ROW = {
    input: { url: 'https://www.aljazeera.com' },
    error:
      'Crawler error: Your account exceeded the allowed rate limits. Reduce requests rate and try again or complete the [verification process] to remove rate limits. You will not be charged for this request.',
    error_code: 'proxy_error',
  };

  it('counts a throttled row as upstream, not as a missing headline', () => {
    // Reported as "14/14 rows had an empty headline" this sends a heal prompt asking the AI to fix
    // selectors — 20 minutes spent on something no collector change can fix.
    const { records, diagnostics } = normalizeCapture(
      toRawRecords([RATE_LIMITED_ROW, RATE_LIMITED_ROW]),
      CONTEXT,
    );

    expect(records).to.have.length(0);
    expect(diagnostics.rejected_upstream_error).to.equal(2);
    expect(diagnostics.rejected_no_headline).to.equal(0);
  });

  it('keeps a real story that merely carries an error field alongside it', () => {
    const { records } = normalizeCapture(
      toRawRecords([
        {
          headline: 'A real story',
          product_page_url: 'https://www.npr.org/2026/08/17/story',
          error_code: 'partial_image_failure',
        },
      ]),
      CONTEXT,
    );

    expect(records).to.have.length(1);
    expect(records[0]?.headline).to.equal('A real story');
  });
});

describe('real collector output survives the pipeline', () => {
  it('keeps every real row instead of discarding it as linkless', () => {
    // Without alias mapping all of these fail as "no usable article_url" and health reports a total
    // extraction failure — a scraper working perfectly, misread as a dead one.
    const records = toRawRecords(REAL_NPR_ROWS);
    expect(records).to.have.length(2);
  });

  it('normalizes real rows into valid canonical records', () => {
    const { records, diagnostics } = normalizeCapture(toRawRecords(REAL_NPR_ROWS), CONTEXT);

    expect(records).to.have.length(2);
    expect(diagnostics.rejected_no_url).to.equal(0);
    expect(diagnostics.rejected_no_headline).to.equal(0);
    expect(records[0]?.headline).to.contain('trans teen');
    expect(records[0]?.section).to.equal('Healthcare');
    // "7:54 AM ET" is 11:54 UTC in August. `new Date()` cannot parse "ET" at all, so without the
    // timezone table the publisher's own timestamp is lost entirely.
    expect(records[0]?.published_at).to.equal('2026-08-16T11:54:00.000Z');
  });

  it('assigns prominence from document order when the collector omits position', () => {
    // The live collector returned no rank at all. Document order is the honest fallback.
    const { records } = normalizeCapture(toRawRecords(REAL_NPR_ROWS), CONTEXT);
    expect(records.map((r) => r.position)).to.deep.equal([1, 2]);
    expect(records[0]?.is_lead).to.equal(true);
    expect(records[0]?.prominence_tier).to.equal('lead');
  });
});
