import { expect } from 'chai';
import { beginEpisode, resolveEpisode, statusForCapture, transition } from '../src/heal/episode.js';
import { computeHealth } from '../src/health/health.js';
import { buildHealPrompt } from '../src/heal/heal-prompt.js';
import { healthyStories, makeCapture } from './helpers/capture.js';

const baseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(42)).snapshot);

function degradedReport() {
  const { snapshot, diagnostics } = makeCapture(healthyStories(2));
  return computeHealth({ snapshot, diagnostics, baseline });
}

describe('transition', () => {
  it('only enters HEALING from a broken state', () => {
    expect(transition('DEGRADED', 'heal_started')).to.equal('HEALING');
    expect(transition('FAILED', 'heal_started')).to.equal('HEALING');
    expect(transition('HEALTHY', 'heal_started')).to.equal('HEALTHY');
  });

  it('reaches RECOVERED only through a heal', () => {
    expect(transition('HEALING', 'heal_approved')).to.equal('RECOVERED');
    // A clean capture mid-heal is also proof the repair landed.
    expect(transition('HEALING', 'capture_healthy')).to.equal('RECOVERED');
    expect(transition('DEGRADED', 'capture_healthy')).to.equal('HEALTHY');
  });

  it('falls back to DEGRADED, not worse, when a heal fails', () => {
    // A failed heal is non-destructive — the previous collector is still live and still working.
    expect(transition('HEALING', 'heal_failed')).to.equal('DEGRADED');
    expect(transition('HEALING', 'heal_rejected')).to.equal('DEGRADED');
  });

  it('retires the RECOVERED badge after the next clean capture', () => {
    // Otherwise the badge lingers and overstates the claim.
    expect(transition('RECOVERED', 'capture_healthy')).to.equal('HEALTHY');
  });

  it('stays in HEALING while a repair is still in flight', () => {
    expect(transition('HEALING', 'capture_degraded')).to.equal('HEALING');
    expect(transition('HEALING', 'capture_failed')).to.equal('HEALING');
  });
});

describe('statusForCapture', () => {
  it('maps a health verdict onto the machine event', () => {
    const { snapshot, diagnostics } = makeCapture([]);
    expect(statusForCapture(computeHealth({ snapshot, diagnostics, baseline }))).to.equal(
      'capture_failed',
    );
    expect(statusForCapture(degradedReport())).to.equal('capture_degraded');
  });
});

describe('heal episode lifecycle', () => {
  it('records detection, the generated prompt, and the outcome', () => {
    const trigger = degradedReport();
    const prompt = buildHealPrompt(trigger, 'https://www.npr.org');
    const episode = beginEpisode(trigger, prompt, '2026-08-17T11:00:00.000Z');

    expect(episode.state).to.equal('HEALING');
    expect(episode.stories_before).to.equal(2);
    expect(episode.prompt).to.equal(prompt);
    expect(episode.resolved_at).to.equal(null);

    const resolved = resolveEpisode(episode, 'heal_approved', {
      stories_after: 41,
      resolved_at: '2026-08-17T11:12:00.000Z',
    });

    expect(resolved.state).to.equal('RECOVERED');
    expect(resolved.approved).to.equal(true);
    expect(resolved.stories_after).to.equal(41);
    expect(resolved.error).to.equal(null);
  });

  it('keeps the collector id stable across a repair', () => {
    // The scraper is improved, not replaced — that is what makes the schema guarantee meaningful.
    const trigger = degradedReport();
    const episode = beginEpisode(trigger, 'fix', '2026-08-17T11:00:00.000Z');
    const resolved = resolveEpisode(episode, 'heal_approved', {
      stories_after: 41,
      resolved_at: '2026-08-17T11:12:00.000Z',
    });
    expect(resolved.collector_id).to.equal(trigger.collector_id);
  });

  it('carries the error and falls back when a heal fails', () => {
    const episode = beginEpisode(degradedReport(), 'fix', '2026-08-17T11:00:00.000Z');
    const resolved = resolveEpisode(episode, 'heal_failed', {
      resolved_at: '2026-08-17T11:12:00.000Z',
      error: 'AI-Flow concurrent-job cap exhausted',
    });

    expect(resolved.state).to.equal('DEGRADED');
    expect(resolved.approved).to.equal(false);
    expect(resolved.stories_after).to.equal(null);
    expect(resolved.error).to.contain('concurrent-job cap');
  });
});
