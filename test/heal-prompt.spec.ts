import { expect } from 'chai';
import { computeHealth } from '../src/health/health.js';
import { HEAL_PROMPT_MAX, buildHealPrompt } from '../src/heal/heal-prompt.js';
import { healthyStories, makeCapture } from './helpers/capture.js';

const HOMEPAGE = 'https://www.npr.org';
const baseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(42)).snapshot);

function reportForHeadlineFailure() {
  const damaged = [
    ...healthyStories(3),
    ...Array.from({ length: 38 }, (_, i) => ({ headline: '', article_url: `/story/x-${i}` })),
  ];
  const { snapshot, diagnostics } = makeCapture(damaged);
  return computeHealth({ snapshot, diagnostics, baseline });
}

describe('buildHealPrompt', () => {
  it('carries the real numbers from the real failure', () => {
    const prompt = buildHealPrompt(reportForHeadlineFailure(), HOMEPAGE);
    expect(prompt).to.contain('38/41');
    expect(prompt).to.contain(HOMEPAGE);
  });

  it('names what still works, to narrow the search instead of inviting a rewrite', () => {
    const prompt = buildHealPrompt(reportForHeadlineFailure(), HOMEPAGE);
    expect(prompt).to.contain('Still working:');
    expect(prompt).to.contain('url_extraction');
  });

  it('always pins the output contract so a heal cannot silently change the schema', () => {
    const prompt = buildHealPrompt(reportForHeadlineFailure(), HOMEPAGE);
    for (const field of [
      'headline',
      'article_url',
      'section',
      'summary',
      'image_url',
      'published_at',
      'story_type',
      'position',
    ]) {
      expect(prompt).to.contain(field);
    }
    expect(prompt).to.contain('Do not rename, add or drop output fields');
  });

  it('never exceeds the API limit', () => {
    // Learned the hard way: `scraper create` 400s at 1001 chars, and so does `scraper heal`.
    const prompt = buildHealPrompt(reportForHeadlineFailure(), HOMEPAGE);
    expect(prompt.length).to.be.at.most(HEAL_PROMPT_MAX);
  });

  it('stays within the limit even for an absurdly long homepage URL', () => {
    const longUrl = `https://example.com/${'very-long-path-segment/'.repeat(40)}`;
    const prompt = buildHealPrompt(reportForHeadlineFailure(), longUrl);
    expect(prompt.length).to.be.at.most(HEAL_PROMPT_MAX);
  });

  it('sheds advice before it sheds the instruction', () => {
    const longUrl = `https://example.com/${'x'.repeat(600)}`;
    const prompt = buildHealPrompt(reportForHeadlineFailure(), longUrl);
    expect(prompt).to.contain('exact names');
    expect(prompt).to.not.contain('semantic role');
  });

  it('still produces a usable prompt when the report has no failing signals', () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(42));
    const prompt = buildHealPrompt(computeHealth({ snapshot, diagnostics, baseline }), HOMEPAGE);
    expect(prompt).to.contain('42 stories');
    expect(prompt.length).to.be.at.most(HEAL_PROMPT_MAX);
  });
});
