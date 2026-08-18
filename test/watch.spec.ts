import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReadyOutlet } from '../src/config/outlets.js';
import { runWatchTick, seedWatchState } from '../src/schedule/watch.js';
import type { WatchOptions, WatchState } from '../src/schedule/watch.js';
import type { TickContext } from '../src/schedule/scheduler.js';
import { appendCapture } from '../src/store/snapshot-store.js';
import type { StoreOptions } from '../src/store/snapshot-store.js';
import { buildCapture, buildCaptureSnapshot } from '../src/schema/normalize.js';
import type { CommandRunner } from '../src/collect/brightdata.js';
import { appendEpisode } from '../src/store/episode-store.js';
import { beginEpisode } from '../src/heal/episode.js';
import { computeHealth } from '../src/health/health.js';

const NPR: ReadyOutlet = {
  source: 'npr',
  source_name: 'NPR',
  homepage_url: 'https://www.npr.org',
  collector_id: 'c_npr',
  synthetic: false,
};

const BBC: ReadyOutlet = {
  source: 'bbc',
  source_name: 'BBC News',
  homepage_url: 'https://www.bbc.com/news',
  collector_id: 'c_bbc',
  synthetic: false,
};

let store: StoreOptions;
let uuid = 0;

beforeEach(async () => {
  store = { rootDir: await mkdtemp(path.join(tmpdir(), 'fptm-watch-')) };
  uuid = 0;
});

afterEach(async () => {
  await rm(store.rootDir, { recursive: true, force: true });
});

function nextId(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
}

function rows(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      headline: `Story ${index}`,
      article_url: `https://www.npr.org/story-${index}`,
    })),
  );
}

/**
 * A fake Bright Data CLI. Story counts are scripted per call, so a collector "breaking" is a number
 * in a list rather than a network condition nobody can reproduce.
 */
function fakeRunner(
  script: number[],
  log: string[] = [],
): { runner: CommandRunner; calls: string[] } {
  let index = 0;
  const calls: string[] = [];
  const runner: CommandRunner = (_bin, args) => {
    calls.push(args.join(' '));
    log.push(args[1] ?? '');
    if (args[0] === 'scrape') return Promise.resolve({ stdout: '', stderr: '' });
    if (args[1] === 'heal') {
      return Promise.resolve({
        stdout: JSON.stringify({ collector_id: 'c_npr', status: 'awaiting_approval' }),
        stderr: '',
      });
    }
    const count = script[Math.min(index, script.length - 1)] ?? 0;
    index += 1;
    return Promise.resolve({ stdout: rows(count), stderr: '' });
  };
  return { runner, calls };
}

function context(index: number): TickContext {
  const hour = String(8 + index).padStart(2, '0');
  return {
    index,
    scheduled_for: `2026-08-17T${hour}:00:00.000Z`,
    started_at: `2026-08-17T${hour}:00:00.000Z`,
    missed: 0,
  };
}

function optionsFor(outlets: ReadyOutlet[], runner: CommandRunner): WatchOptions {
  return {
    outlets,
    store,
    screenshotDir: null,
    runner,
    autoHeal: true,
    // Tests must never write the real episodes/ ledger — same isolation as the snapshot store.
    episodeStore: { rootDir: path.join(store.rootDir, 'episodes') },
  };
}

describe('runWatchTick', () => {
  it('captures every outlet and records each status', async () => {
    const { runner } = fakeRunner([40]);
    const state: WatchState = new Map();
    const result = await runWatchTick(context(1), state, optionsFor([NPR, BBC], runner));

    expect(result.outlets.map((o) => o.source)).to.deep.equal(['npr', 'bbc']);
    expect(result.outlets.every((o) => o.status === 'HEALTHY')).to.equal(true);
  });

  it('does not heal on a single bad capture', async () => {
    // One empty capture is a blip. Healing here would fire on every transient network hiccup.
    const { runner, calls } = fakeRunner([0]);
    const state: WatchState = new Map();
    const result = await runWatchTick(context(1), state, optionsFor([NPR], runner));

    expect(result.outlets[0]?.status).to.equal('FAILED');
    expect(result.outlets[0]?.heal).to.equal(null);
    expect(calls.some((c) => c.includes('heal'))).to.equal(false);
  });

  it('heals once the debounce is satisfied', async () => {
    const { runner, calls } = fakeRunner([0]);
    const state: WatchState = new Map();
    const options = optionsFor([NPR], runner);

    await runWatchTick(context(1), state, options);
    const second = await runWatchTick(context(2), state, options);

    expect(second.outlets[0]?.heal).to.not.equal(null);
    expect(calls.some((c) => c.startsWith('scraper heal'))).to.equal(true);
  });

  it('does not re-request the same gated heal every hour', async () => {
    // A gated heal is waiting on a human. Asking again at 03:00, 04:00 and 05:00 burns the AI-flow
    // cap and buries the one notification that mattered.
    const { runner, calls } = fakeRunner([0]);
    const state: WatchState = new Map();
    const options = optionsFor([NPR], runner);

    for (let tick = 1; tick <= 5; tick += 1) await runWatchTick(context(tick), state, options);

    expect(calls.filter((c) => c.startsWith('scraper heal'))).to.have.length(1);
  });

  /** Captures scripted per run; heals fail fast so they never consume a capture slot. */
  function failFastHealRunner(script: number[]): { runner: CommandRunner; heals: () => number } {
    let index = 0;
    let heals = 0;
    const runner: CommandRunner = (_bin, args) => {
      if (args[1] === 'heal') {
        heals += 1;
        return Promise.resolve({
          stdout: JSON.stringify({ collector_id: 'c_npr', status: 'failed' }),
          stderr: '',
        });
      }
      const count = script[Math.min(index, script.length - 1)] ?? 0;
      index += 1;
      return Promise.resolve({ stdout: rows(count), stderr: '' });
    };
    return { runner, heals: () => heals };
  }

  it('autonomous mode retries a failed heal, but only up to the per-outage budget', async () => {
    // A permanently broken outlet re-satisfies the debounce every capture. Unbounded, that is
    // 20 minutes of AI Flow per hour spent re-attempting a repair that has already proven useless.
    const { runner, heals } = failFastHealRunner([0]);
    const state: WatchState = new Map();
    const options: WatchOptions = { ...optionsFor([NPR], runner), healMode: 'autonomous' };

    for (let tick = 1; tick <= 10; tick += 1) await runWatchTick(context(tick), state, options);

    expect(heals()).to.equal(3);
  });

  it('recovery re-arms the heal budget', async () => {
    // Broke (budget spent) → recovered → broke again: the new outage gets its own budget.
    const script = [0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0];
    const { runner, heals } = failFastHealRunner(script);
    const state: WatchState = new Map();
    const options: WatchOptions = { ...optionsFor([NPR], runner), healMode: 'autonomous' };

    for (let tick = 1; tick <= script.length; tick += 1) {
      await runWatchTick(context(tick), state, options);
    }

    expect(heals()).to.be.greaterThan(3);
  });

  it('re-arms healing after the outlet recovers', async () => {
    const { runner, calls } = fakeRunner([0, 0, 40, 0, 0]);
    const state: WatchState = new Map();
    const options = optionsFor([NPR], runner);

    for (let tick = 1; tick <= 5; tick += 1) await runWatchTick(context(tick), state, options);

    // Broke, healed, recovered, broke again — the second outage deserves its own heal.
    expect(calls.filter((c) => c.startsWith('scraper heal'))).to.have.length(2);
  });

  it('never heals when healing is switched off', async () => {
    const { runner, calls } = fakeRunner([0]);
    const state: WatchState = new Map();
    const options: WatchOptions = { ...optionsFor([NPR], runner), autoHeal: false };

    for (let tick = 1; tick <= 4; tick += 1) await runWatchTick(context(tick), state, options);

    expect(calls.some((c) => c.includes('heal'))).to.equal(false);
  });

  it("one outlet's outage does not cost the others their capture", async () => {
    const failing: CommandRunner = (_bin, args) => {
      if (args.includes('c_npr')) return Promise.reject(new Error('collector timed out'));
      return Promise.resolve({ stdout: rows(30), stderr: '' });
    };
    const state: WatchState = new Map();
    const result = await runWatchTick(context(1), state, optionsFor([NPR, BBC], failing));

    expect(result.outlets[0]?.error).to.contain('collector timed out');
    expect(result.outlets[1]?.status).to.equal('HEALTHY');
    expect(result.outlets[1]?.story_count).to.equal(30);
  });

  it('bounds the status history instead of growing it forever', async () => {
    const { runner } = fakeRunner([40]);
    const state: WatchState = new Map();
    const options = optionsFor([NPR], runner);

    for (let tick = 1; tick <= 30; tick += 1) await runWatchTick(context(tick), state, options);

    expect(state.get('npr')?.statuses.length).to.be.at.most(6);
  });
});

describe('seedWatchState', () => {
  it("carries a broken collector's history across a restart", async () => {
    // Without this the watcher forgets, and a collector broken for five hours gets another two hours
    // of grace every time the process is restarted.
    for (const at of ['2026-08-17T08:00:00.000Z', '2026-08-17T09:00:00.000Z']) {
      await appendCapture(
        buildCaptureSnapshot(
          [],
          {
            source: 'npr',
            source_name: 'NPR',
            homepage_url: 'https://www.npr.org',
            captured_at: at,
            capture_id: nextId(),
          },
          { collector_id: 'c_npr', screenshot_path: null },
        ),
        store,
      );
    }

    const { runner, calls } = fakeRunner([0]);
    const options = optionsFor([NPR], runner);
    const state = await seedWatchState(options);

    expect(state.get('npr')?.statuses).to.deep.equal(['FAILED', 'FAILED']);

    // The very next capture should heal, not wait out a fresh debounce.
    const result = await runWatchTick(context(1), state, options);
    expect(result.outlets[0]?.heal).to.not.equal(null);
    expect(calls.some((c) => c.startsWith('scraper heal'))).to.equal(true);
  });

  it('starts empty for an outlet with no history', async () => {
    const { runner } = fakeRunner([40]);
    const state = await seedWatchState(optionsFor([NPR], runner));
    expect(state.get('npr')?.statuses).to.deep.equal([]);
  });

  it('restores the heal budget and gated latch from the episode ledger', async () => {
    // Without this, every restart handed a permanently-broken outlet a fresh budget — three more
    // 20-minute heals against the same wall, per restart — and re-requested a gated fix a human
    // had already been asked to review.
    for (const at of ['2026-08-17T08:00:00.000Z', '2026-08-17T09:00:00.000Z']) {
      await appendCapture(
        buildCaptureSnapshot(
          [],
          {
            source: 'npr',
            source_name: 'NPR',
            homepage_url: 'https://www.npr.org',
            captured_at: at,
            capture_id: nextId(),
          },
          { collector_id: 'c_npr', screenshot_path: null },
        ),
        store,
      );
    }
    const episodeStore = { rootDir: path.join(store.rootDir, 'episodes') };
    const broken = buildCapture(
      [],
      {
        source: 'npr',
        source_name: 'NPR',
        homepage_url: 'https://www.npr.org',
        captured_at: '2026-08-17T09:00:00.000Z',
        capture_id: nextId(),
      },
      { collector_id: 'c_npr', screenshot_path: null },
    );
    const trigger = computeHealth({ ...broken, baseline: [] });
    for (const detectedAt of [
      '2026-08-17T08:10:00.000Z',
      '2026-08-17T08:40:00.000Z',
      '2026-08-17T09:10:00.000Z',
    ]) {
      await appendEpisode(beginEpisode(trigger, 'fix it', detectedAt), episodeStore);
    }

    const { runner, calls } = fakeRunner([0]);
    const options = { ...optionsFor([NPR], runner), episodeStore };
    const state = await seedWatchState(options);

    expect(state.get('npr')?.healsThisOutage).to.equal(3);
    expect(state.get('npr')?.healPending).to.equal(true);

    // Budget spent and a fix already awaiting a human: the restarted watcher must not heal again.
    await runWatchTick(context(1), state, options);
    expect(calls.some((c) => c.startsWith('scraper heal'))).to.equal(false);
  });
});
