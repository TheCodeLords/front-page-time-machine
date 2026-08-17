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
  });

  it('reports a heal that succeeded on paper but recovered nothing', async () => {
    const { runner } = scriptedRunner({
      heal: '{"collector_id":"c_test","status":"done"}',
      run: rows(2),
    });
    const episode = await healOutlet(OUTLET, trigger(), { mode: 'autonomous', runner });
    expect(episode.stories_after).to.equal(2);
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
    expect(DEFAULT_OUTLETS).to.have.length(6);
    expect(readyOutlets(DEFAULT_OUTLETS)).to.deep.equal([]);
  });

  it('pins an edition on every homepage URL', () => {
    // bbc.com vs bbc.co.uk, CNN US vs International — different front pages.
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
