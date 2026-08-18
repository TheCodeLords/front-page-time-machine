import { expect } from 'chai';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureOutlet, screenshotPathFor } from '../src/collect/capture.js';
import type { CommandRunner } from '../src/collect/brightdata.js';
import { DEFAULT_OUTLETS, applyCollectorEnv, readyOutlets } from '../src/config/outlets.js';
import type { Outlet } from '../src/config/outlets.js';
import { computeHealth } from '../src/health/health.js';
import { healOutlet, isRepairAlreadyRunning } from '../src/heal/run-heal.js';
import { readCapturesForDate } from '../src/store/snapshot-store.js';
import type { StoreOptions } from '../src/store/snapshot-store.js';
import { healthyStories, makeCapture } from './helpers/capture.js';

const OUTLET: Outlet & { collector_id: string } = {
  source: 'npr',
  source_name: 'NPR',
  homepage_url: 'https://www.npr.org',
  collector_id: 'c_test',
  synthetic: false,
};

let store: StoreOptions;

beforeEach(async () => {
  store = { rootDir: await mkdtemp(path.join(tmpdir(), 'fptm-pipe-')) };
});
afterEach(async () => {
  await rm(store.rootDir, { recursive: true, force: true });
});

/** Routes by subcommand so one fake can serve `scraper run`, `scrape`, `heal` and `approve`. */
function scriptedRunner(script: {
  run?: string | (() => string);
  scrape?: () => string;
  heal?: string;
  approve?: string;
}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (bin, args) => {
    calls.push([...args]);
    const [first, second] = args;
    if (first === 'scrape') return { stdout: script.scrape?.() ?? '', stderr: '' };
    if (first === 'scraper' && second === 'run') {
      const out = typeof script.run === 'function' ? script.run() : (script.run ?? '[]');
      return { stdout: out, stderr: '' };
    }
    if (first === 'scraper' && second === 'heal')
      return { stdout: script.heal ?? '{}', stderr: '' };
    if (first === 'scraper' && second === 'approve') {
      return { stdout: script.approve ?? '{}', stderr: '' };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { runner, calls };
}

const rows = (count: number) =>
  JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      headline: `Story ${i + 1}`,
      article_url: `/story/${i + 1}`,
    })),
  );

describe('captureOutlet', () => {
  it('stores a capture and classifies it', async () => {
    const { runner } = scriptedRunner({ run: rows(40) });
    const result = await captureOutlet(OUTLET, {
      store,
      screenshotDir: null,
      runner,
      now: () => '2026-08-17T10:00:00.000Z',
      newCaptureId: () => '11111111-2222-4333-8444-555555555555',
    });

    expect(result.snapshot.records).to.have.length(40);
    expect(result.health.status).to.equal('HEALTHY');

    const stored = await readCapturesForDate('npr', '2026-08-17', store);
    expect(stored).to.have.length(1);
    expect(stored[0]?.collector_id).to.equal('c_test');
  });

  it('never compares a capture against itself', async () => {
    // The baseline must be read before the append, or the first bad capture becomes its own normal.
    const { runner } = scriptedRunner({ run: rows(40) });
    const first = await captureOutlet(OUTLET, {
      store,
      screenshotDir: null,
      runner,
      now: () => '2026-08-17T10:00:00.000Z',
    });
    expect(first.health.baseline_median).to.equal(null);
  });

  it('detects collapse against the stored trailing window', async () => {
    const healthy = scriptedRunner({ run: rows(40) });
    for (const hour of ['10', '11', '12']) {
      await captureOutlet(OUTLET, {
        store,
        screenshotDir: null,
        runner: healthy.runner,
        now: () => `2026-08-17T${hour}:00:00.000Z`,
      });
    }

    const broken = scriptedRunner({ run: rows(2) });
    const result = await captureOutlet(OUTLET, {
      store,
      screenshotDir: null,
      runner: broken.runner,
      now: () => '2026-08-17T13:00:00.000Z',
    });

    expect(result.health.baseline_median).to.equal(40);
    expect(result.health.status).to.equal('DEGRADED');
  });

  it('keeps the capture when the screenshot fails', async () => {
    // Losing an hour of irreplaceable history over a PNG would be an absurd trade.
    const calls: string[][] = [];
    const runner: CommandRunner = async (_bin, args) => {
      calls.push([...args]);
      if (args[0] === 'scrape') throw new Error('unlocker timeout');
      return { stdout: rows(12), stderr: '' };
    };

    const result = await captureOutlet(OUTLET, {
      store,
      screenshotDir: path.join(store.rootDir, 'shots'),
      runner,
      now: () => '2026-08-17T10:00:00.000Z',
    });

    expect(result.snapshot.records).to.have.length(12);
    expect(result.snapshot.screenshot_path).to.equal(null);
    expect(result.screenshotError).to.contain('unlocker timeout');
    expect(await readCapturesForDate('npr', '2026-08-17', store)).to.have.length(1);
  });

  it('records the screenshot path when it succeeds', async () => {
    const { runner } = scriptedRunner({ run: rows(5), scrape: () => '' });
    const result = await captureOutlet(OUTLET, {
      store,
      screenshotDir: path.join(store.rootDir, 'shots'),
      runner,
      now: () => '2026-08-17T10:00:00.000Z',
    });

    expect(result.snapshot.screenshot_path).to.be.a('string');
    expect(await readdir(path.join(store.rootDir, 'shots'))).to.deep.equal(['npr']);
    // The stored path is DATA in a cross-platform archive: forward slashes, never backslashes.
    expect(result.snapshot.screenshot_path).to.not.contain('\\');
    expect(result.snapshot.screenshot_path).to.contain('/');
  });

  it('records the capture window: tick boundary, fetch start, fetch end', async () => {
    // Six outlets are fetched serially, so "the 14:00 capture" is a window, not an instant.
    // Persisting all three timestamps is what lets the product say "first observed" honestly.
    const times = ['2026-08-17T14:00:03.000Z', '2026-08-17T14:00:41.000Z'];
    const { runner } = scriptedRunner({ run: rows(10) });
    const result = await captureOutlet(OUTLET, {
      store,
      screenshotDir: null,
      runner,
      scheduledFor: '2026-08-17T14:00:00.000Z',
      now: () => times.shift() ?? '2026-08-17T14:01:00.000Z',
    });

    expect(result.snapshot.scheduled_for).to.equal('2026-08-17T14:00:00.000Z');
    expect(result.snapshot.captured_at).to.equal('2026-08-17T14:00:03.000Z');
    expect(result.snapshot.capture_completed_at).to.equal('2026-08-17T14:00:41.000Z');

    const stored = await readCapturesForDate('npr', '2026-08-17', store);
    expect(stored[0]?.scheduled_for).to.equal('2026-08-17T14:00:00.000Z');
  });

  it('stores an empty capture as FAILED rather than throwing it away', async () => {
    const { runner } = scriptedRunner({ run: '[]' });
    const result = await captureOutlet(OUTLET, {
      store,
      screenshotDir: null,
      runner,
      now: () => '2026-08-17T10:00:00.000Z',
    });

    expect(result.health.status).to.equal('FAILED');
    expect(await readCapturesForDate('npr', '2026-08-17', store)).to.have.length(1);
  });
});

describe('screenshotPathFor', () => {
  it('produces a filename legal on Windows', () => {
    const target = screenshotPathFor('shots', 'npr', '2026-08-17T10:00:00.000Z');
    expect(path.basename(target)).to.equal('2026-08-17T10-00-00-000Z.png');
    expect(path.basename(target)).to.not.contain(':');
  });
});

describe('healOutlet', () => {
  const baseline = Array.from({ length: 5 }, () => makeCapture(healthyStories(42)).snapshot);
  const trigger = () => {
    const { snapshot, diagnostics } = makeCapture(healthyStories(2));
    return computeHealth({ snapshot, diagnostics, baseline });
  };

  it('stops at the approval gate by default and calls that a success', async () => {
    const { runner, calls } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"awaiting_approval"}',
    });
    const episode = await healOutlet(OUTLET, trigger(), {
      runner,
      now: () => '2026-08-17T11:00:00.000Z',
    });

    expect(episode.state).to.equal('HEALING');
    expect(episode.error).to.equal(null);
    expect(calls.some((c) => c[1] === 'approve')).to.equal(false);
  });

  it('proves recovery by re-running the collector, not by trusting the status', async () => {
    const { runner, calls } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"done"}',
      run: rows(41),
    });
    const episode = await healOutlet(OUTLET, trigger(), {
      mode: 'autonomous',
      runner,
      now: () => '2026-08-17T11:00:00.000Z',
    });

    expect(episode.state).to.equal('RECOVERED');
    expect(episode.stories_before).to.equal(2);
    expect(episode.stories_after).to.equal(41);
    expect(calls.some((c) => c[1] === 'run')).to.equal(true);
    // RECOVERED is the health engine's word, not the API's: the rerun was judged and passed.
    expect(episode.health_after?.status).to.equal('HEALTHY');
    expect(episode.health_after?.failing).to.deep.equal([]);
  });

  it('refuses to call a committed-but-still-broken heal RECOVERED', async () => {
    // Bright Data reports "done"; the rerun still returns 2 stories. Counting rows would have
    // shipped this as a success. The health engine on the rerun is what says otherwise.
    const { runner } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"done"}',
      run: rows(2),
    });
    const episode = await healOutlet(OUTLET, trigger(), { mode: 'autonomous', runner });

    expect(episode.stories_after).to.equal(2);
    expect(episode.state).to.equal('DEGRADED'); // not RECOVERED
    expect(episode.approved).to.equal(true); // the fix WAS committed â€” that part is honest too
    expect(episode.health_after?.status).to.not.equal('HEALTHY');
    expect(episode.health_after?.failing ?? []).to.have.length.greaterThan(0);
  });

  it('judges the rerun against the last HEALTHY baseline, not the outage-poisoned tail', async () => {
    // The adversarial panel executed both failure directions against the naive version of this:
    // with 5×40 healthy then 3×8 broken captures on disk, the trailing window [40,40,8,8,8] has
    // median 8 — so a STILL-BROKEN rerun of 8 verified "HEALTHY" (8/8 = 1.0), and a genuinely
    // FIXED rerun of 40 "failed" as over-extraction (40 > 8×2.5). The healthy-baseline walk
    // restores both verdicts.
    for (let i = 0; i < 5; i += 1) {
      const { runner } = scriptedRunner({ run: rows(40) });
      await captureOutlet(OUTLET, {
        store,
        screenshotDir: null,
        runner,
        now: () => `2026-08-17T0${i}:00:00.000Z`,
      });
    }
    for (let i = 5; i < 8; i += 1) {
      const { runner } = scriptedRunner({ run: rows(8) });
      await captureOutlet(OUTLET, {
        store,
        screenshotDir: null,
        runner,
        now: () => `2026-08-17T0${i}:00:00.000Z`,
      });
    }

    const stillBroken = await healOutlet(OUTLET, trigger(), {
      mode: 'autonomous',
      runner: scriptedRunner({ heal: '{"collector_id":"c_test","status":"done"}', run: rows(8) })
        .runner,
      store,
      now: () => '2026-08-17T09:00:00.000Z',
    });
    expect(stillBroken.state).to.equal('DEGRADED');
    expect(stillBroken.health_after?.failing).to.include('story_count');

    const genuinelyFixed = await healOutlet(OUTLET, trigger(), {
      mode: 'autonomous',
      runner: scriptedRunner({ heal: '{"collector_id":"c_test","status":"done"}', run: rows(40) })
        .runner,
      store,
      now: () => '2026-08-17T09:30:00.000Z',
    });
    expect(genuinelyFixed.state).to.equal('RECOVERED');
    expect(genuinelyFixed.health_after?.status).to.equal('HEALTHY');
  });

  it('refuses to verify a rerun whose count is plausible but whose failure signal persists', async () => {
    // The Fox shape: a "repaired" collector could return a believable 30 stories that are still
    // 50% duplicate rail links. Story count alone would wave it through; the health engine judges
    // every dimension, so the ORIGINAL failure signal keeps the episode unverified.
    for (let i = 0; i < 5; i += 1) {
      const { runner } = scriptedRunner({ run: rows(42) });
      await captureOutlet(OUTLET, {
        store,
        screenshotDir: null,
        runner,
        now: () => `2026-08-17T0${i}:00:00.000Z`,
      });
    }
    const duplicateHeavy = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({
        headline: `Story ${i % 30}`,
        article_url: `/story/${i % 30}`,
      })),
    );
    const episode = await healOutlet(OUTLET, trigger(), {
      mode: 'autonomous',
      runner: scriptedRunner({
        heal: '{"collector_id":"c_test","status":"done"}',
        run: duplicateHeavy,
      }).runner,
      store,
      now: () => '2026-08-17T09:00:00.000Z',
    });

    expect(episode.stories_after).to.equal(30); // plausible against a median of 42
    expect(episode.state).to.equal('DEGRADED'); // and still not RECOVERED
    expect(episode.health_after?.failing).to.include('duplicate_urls');
  });

  it('resolves a post-commit verification crash as committed-but-unverified, never heal_failed', async () => {
    // Once approve/auto-approve returned "done" the collector HAS been replaced. If the proof run
    // then throws, saying "heal failed, the old collector still works" would send a triaging human
    // to the wrong incident — and a 409 in that error must not be rewritten into "a repair is
    // already running, wait for it".
    const runner: CommandRunner = async (_bin, args) => {
      if (args[0] === 'scraper' && args[1] === 'heal') {
        return { stdout: '{"collector_id":"c_test","status":"done"}', stderr: '' };
      }
      throw new Error('run failed: HTTP 409 from the collector endpoint');
    };
    const episode = await healOutlet(OUTLET, trigger(), { mode: 'autonomous', runner });

    expect(episode.approved).to.equal(true);
    expect(episode.state).to.equal('DEGRADED');
    expect(episode.error).to.contain('committed, but the verification rerun failed');
    expect(episode.error).to.not.contain('already running');
  });

  it('judges the verification rerun against the stored baseline, not in a vacuum', async () => {
    // 10 stories is fine in isolation â€” but this outlet normally produces 42, and the whole point
    // of wiring the store in is that the verification inherits that context.
    for (let i = 0; i < 5; i += 1) {
      const { runner } = scriptedRunner({ run: rows(42) });
      await captureOutlet(OUTLET, {
        store,
        screenshotDir: null,
        runner,
        now: () => `2026-08-17T0${i}:00:00.000Z`,
      });
    }
    const { runner } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"done"}',
      run: rows(10),
    });
    const episode = await healOutlet(OUTLET, trigger(), { mode: 'autonomous', runner, store });

    expect(episode.state).to.equal('DEGRADED');
    expect(episode.health_after?.failing).to.include('story_count');
  });

  it('sends a prompt built from the health report, not a canned string', async () => {
    const { runner, calls } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"awaiting_approval"}',
    });
    await healOutlet(OUTLET, trigger(), { runner });

    const healCall = calls.find((c) => c[1] === 'heal');
    expect(healCall?.[3]).to.contain('trailing median of 42');
    expect(healCall?.[3]).to.contain('Do not rename, add or drop output fields');
  });

  it('treats a failed heal as non-destructive', async () => {
    const { runner } = scriptedRunner({ heal: '{"collector_id":"c_test","status":"failed"}' });
    const episode = await healOutlet(OUTLET, trigger(), {
      mode: 'autonomous',
      runner,
      now: () => '2026-08-17T11:00:00.000Z',
    });

    expect(episode.state).to.equal('DEGRADED');
    expect(episode.stories_after).to.equal(null);
    expect(episode.error).to.contain('failed');
  });

  it('survives the CLI throwing outright', async () => {
    const runner: CommandRunner = async () => {
      throw new Error('429 concurrent-job cap exhausted');
    };
    const episode = await healOutlet(OUTLET, trigger(), { runner });
    expect(episode.state).to.equal('DEGRADED');
    expect(episode.error).to.contain('concurrent-job cap');
  });

  it('never persists the local home directory inside an error message', async () => {
    // A spawn failure quotes the full command line, home directory included â€” and the episode
    // ledger is part of the public archive. Found live: two real 409 errors carried the path.
    const runner: CommandRunner = async () => {
      throw new Error(String.raw`Command failed: C:\Users\someone\AppData\Roaming\npm\bd.cmd heal`);
    };
    const episode = await healOutlet(OUTLET, trigger(), { runner });
    expect(episode.error).to.not.contain('Users\\someone');
    expect(episode.error).to.contain('~\\AppData');
  });

  it('asks for far more than the CLI default timeout', async () => {
    // The CLI's 600s budget expired on the LAST step of a real CNN heal. Fifteen minutes of work
    // discarded in sight of the finish line is the expensive failure; a generous ceiling is not.
    const { runner, calls } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"awaiting_approval"}',
    });
    await healOutlet(OUTLET, trigger(), { runner });

    const healCall = calls.find((c) => c[1] === 'heal');
    expect(healCall).to.include('--timeout');
    expect(Number(healCall?.[healCall.indexOf('--timeout') + 1])).to.be.at.least(1800);
  });

  it('distinguishes "a repair is already running" from "the repair failed"', async () => {
    // They call for opposite actions: wait, versus try a sharper prompt. A client-side timeout does
    // not cancel the server-side job, so this is what an impatient retry actually hits.
    const runner: CommandRunner = async () => {
      throw new Error('Failed to start self-healing: Another refactor job is still in progress');
    };
    const episode = await healOutlet(OUTLET, trigger(), { runner });

    expect(episode.state).to.equal('DEGRADED');
    expect(episode.error).to.contain('already running');
    expect(episode.error).to.contain('wait for it rather than retrying');
  });
});

describe('isRepairAlreadyRunning', () => {
  it('recognises the 409 both by its text and by its status code', () => {
    expect(isRepairAlreadyRunning('Another refactor job is still in progress')).to.equal(true);
    expect(isRepairAlreadyRunning('Status: 409')).to.equal(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isRepairAlreadyRunning('429 concurrent-job cap exhausted')).to.equal(false);
    expect(isRepairAlreadyRunning('Timeout after 600 seconds')).to.equal(false);
  });
});

describe('outlet registry', () => {
  it('ships six structurally different outlets, all without collectors yet', () => {
    // Six real outlets plus the clearly-flagged redesign-drill fixture.
    expect(DEFAULT_OUTLETS).to.have.length(7);
    expect(DEFAULT_OUTLETS.filter((o) => !o.synthetic)).to.have.length(6);
    expect(readyOutlets(DEFAULT_OUTLETS)).to.deep.equal([]);
  });

  it('pins an edition on every homepage URL', () => {
    // bbc.com vs bbc.co.uk, CNN US vs International â€” different front pages.
    for (const outlet of DEFAULT_OUTLETS) {
      expect(outlet.homepage_url).to.match(/^https:\/\//);
    }
  });

  it('overlays collector ids from the environment', () => {
    const outlets = applyCollectorEnv(DEFAULT_OUTLETS, 'npr:c_abc, bbc:c_def');
    expect(outlets.find((o) => o.source === 'npr')?.collector_id).to.equal('c_abc');
    expect(outlets.find((o) => o.source === 'cnn')?.collector_id).to.equal(null);
    expect(readyOutlets(outlets)).to.have.length(2);
  });

  it('ignores an empty or malformed override', () => {
    expect(applyCollectorEnv(DEFAULT_OUTLETS, '')).to.deep.equal(DEFAULT_OUTLETS);
    expect(applyCollectorEnv(DEFAULT_OUTLETS, 'garbage')).to.deep.equal(DEFAULT_OUTLETS);
  });
});
