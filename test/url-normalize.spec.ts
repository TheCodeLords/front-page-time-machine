import { expect } from 'chai';
import { findDuplicateUrls, normalizeArticleUrl } from '../src/schema/url-normalize.js';

const BASE = 'https://www.bbc.com/news';

describe('normalizeArticleUrl', () => {
  it('resolves a relative href against the homepage', () => {
    expect(normalizeArticleUrl('/news/world-12345', BASE)).to.equal(
      'https://bbc.com/news/world-12345',
    );
  });

  it('collapses www so one article is one story', () => {
    expect(normalizeArticleUrl('https://www.bbc.com/news/a-1')).to.equal(
      'https://bbc.com/news/a-1',
    );
  });

  it('strips campaign params but keeps params that identify content', () => {
    const normalized = normalizeArticleUrl(
      'https://bbc.com/news/a-1?utm_source=twitter&at_medium=rss&ns_campaign=x&page=2',
      BASE,
    );
    expect(normalized).to.equal('https://bbc.com/news/a-1?page=2');
  });

  it('gives the same identity regardless of param order', () => {
    const a = normalizeArticleUrl('https://bbc.com/x?b=2&a=1');
    const b = normalizeArticleUrl('https://bbc.com/x?a=1&b=2');
    expect(a).to.equal(b);
  });

  it('treats hero and sidebar links to one article as one URL', () => {
    const hero = normalizeArticleUrl('/news/a-1?at_medium=hero', BASE);
    const rail = normalizeArticleUrl('https://www.bbc.com/news/a-1/?utm_source=rail#top', BASE);
    expect(hero).to.equal(rail);
  });

  it('drops the fragment', () => {
    expect(normalizeArticleUrl('https://bbc.com/news/a-1#comments')).to.equal(
      'https://bbc.com/news/a-1',
    );
  });

  it('strips a trailing slash but preserves the root path', () => {
    expect(normalizeArticleUrl('https://bbc.com/news/a-1/')).to.equal('https://bbc.com/news/a-1');
    expect(normalizeArticleUrl('https://bbc.com/')).to.equal('https://bbc.com/');
  });

  it('rejects navigation that is not a story link', () => {
    expect(normalizeArticleUrl('mailto:news@bbc.com')).to.equal(null);
    expect(normalizeArticleUrl('javascript:void(0)')).to.equal(null);
    expect(normalizeArticleUrl('#skip-to-content')).to.equal(null);
    expect(normalizeArticleUrl('   ')).to.equal(null);
    expect(normalizeArticleUrl(null)).to.equal(null);
    expect(normalizeArticleUrl(undefined)).to.equal(null);
  });

  it('rejects a relative href when no base is available', () => {
    expect(normalizeArticleUrl('/news/a-1')).to.equal(null);
  });
});

describe('findDuplicateUrls', () => {
  it('reports only URLs seen more than once, with counts', () => {
    const duplicates = findDuplicateUrls(['https://a.com/1', 'https://a.com/1', 'https://a.com/2']);
    expect([...duplicates.entries()]).to.deep.equal([['https://a.com/1', 2]]);
  });

  it('returns nothing for a clean capture', () => {
    expect(findDuplicateUrls(['https://a.com/1', 'https://a.com/2']).size).to.equal(0);
  });
});
