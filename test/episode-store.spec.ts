import { expect } from 'chai';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginEpisode, markPhase, resolveEpisode } from '../src/heal/episode.js';
import type { HealEpisode } from '../src/heal/episode.js';
import { computeHealth } from '../src/health/health.js';
import {
  appendEpisode,
  episodeFilePath,
  listEpisodeSources,
  readEpisodes,
} from '../src/store/episode-store.js';
import type { EpisodeStoreOptions } from '../src/store/episode-store.js';
import { healthyStories, makeCapture } from './helpers/capture.js';

let options: EpisodeStoreOptions;

beforeEach(async () => {
  options = { rootDir: await mkdtemp(path.join(tmpdir(), 'fptm-episodes-')) };
});

afterEach(async () => {
  await rm(options.rootDir!, { recursive: true, force: true });
});

function makeEpisode(detectedAt: string): HealEpisode {
  const { snapshot, diagnostics } = makeCapture(healthyStories(2));
  const trigger = computeHealth({ snapshot, diagnostics, baseline: [] });
  const begun = beginEpisode(trigger, 'fix the extraction', detectedAt);
  return resolveEpisode(markPhase(begun, 'ai_generation_finished', detectedAt), 'heal_approved', {
    stories_after: 31,
    resolved_at: detectedAt,
  });
}

describe('appendEpisode / readEpisodes', () => {
  it('round-trips an episode, minus the bulky trigger report', async () => {
    await appendEpisode(makeEpisode('2026-08-17T10:00:00.000Z'), options);

    const episodes = await readEpisodes('npr', options);
    expect(episodes).to.have.length(1);
    expect(episodes[0]?.stories_after).to.equal(31);
    expect(episodes[0]?.['trigger']).to.equal(undefined);
    // The phase marks survive the trip — they are the timing evidence.
    expect(episodes[0]?.['phase_marks']).to.be.an('array');
  });

  it('appends rather than overwrites — the ledger is history', async () => {
    await appendEpisode(makeEpisode('2026-08-17T10:00:00.000Z'), options);
    await appendEpisode(makeEpisode('2026-08-17T12:00:00.000Z'), options);

    const contents = await readFile(episodeFilePath('npr', options), 'utf8');
    expect(contents.trim().split('\n')).to.have.length(2);
  });

  it('returns episodes oldest first regardless of append order', async () => {
    await appendEpisode(makeEpisode('2026-08-17T12:00:00.000Z'), options);
    await appendEpisode(makeEpisode('2026-08-17T10:00:00.000Z'), options);

    const episodes = await readEpisodes('npr', options);
    expect(episodes.map((e) => e.detected_at.slice(11, 13))).to.deep.equal(['10', '12']);
  });

  it('survives a truncated line from an interrupted write', async () => {
    const filePath = episodeFilePath('npr', options);
    await mkdir(path.dirname(filePath), { recursive: true });
    const good = JSON.stringify({
      source: 'npr',
      source_name: 'NPR',
      collector_id: 'c_x',
      detected_at: '2026-08-17T10:00:00.000Z',
      state: 'RECOVERED',
      prompt: 'p',
      stories_before: 2,
      stories_after: 31,
      approved: true,
      resolved_at: '2026-08-17T10:20:00.000Z',
      error: null,
    });
    await writeFile(filePath, `${good}\n{"source":"npr","trunc`, 'utf8');

    const episodes = await readEpisodes('npr', options);
    expect(episodes).to.have.length(1);
  });

  it('reads an episode written before phase marks existed', async () => {
    // Same rule as every schema addition: a new field must never delete history.
    const filePath = episodeFilePath('npr', options);
    await mkdir(path.dirname(filePath), { recursive: true });
    const legacy = JSON.stringify({
      source: 'npr',
      source_name: 'NPR',
      collector_id: 'c_x',
      detected_at: '2026-08-17T10:00:00.000Z',
      state: 'DEGRADED',
      prompt: 'p',
      stories_before: 2,
      stories_after: null,
      approved: false,
      resolved_at: null,
      error: 'heal failed',
    });
    await writeFile(filePath, `${legacy}\n`, 'utf8');

    expect(await readEpisodes('npr', options)).to.have.length(1);
  });

  it('is empty for a source that has never healed', async () => {
    expect(await readEpisodes('bbc', options)).to.deep.equal([]);
  });
});

describe('listEpisodeSources', () => {
  it('lists every source with a ledger', async () => {
    await appendEpisode(makeEpisode('2026-08-17T10:00:00.000Z'), options);
    expect(await listEpisodeSources(options)).to.deep.equal(['npr']);
  });

  it('is empty when no heal has ever run', async () => {
    expect(
      await listEpisodeSources({ rootDir: path.join(options.rootDir!, 'nope') }),
    ).to.deep.equal([]);
  });
});
