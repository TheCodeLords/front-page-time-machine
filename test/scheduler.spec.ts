import { expect } from 'chai';
import { alignToBoundary, formatDuration, runScheduler } from '../src/schedule/scheduler.js';
import type { TickContext } from '../src/schedule/scheduler.js';

/**
 * A fake clock that advances only when the scheduler sleeps.
 *
 * This is what makes an hourly system testable at all: a full day of captures is asserted in a
 * millisecond, and "does it drift" becomes a unit test instead of a thing you find out on Friday.
 */
function fakeClock(startIso: string): {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('runScheduler', () => {
  it('fires on aligned boundaries even when ticks take time', async () => {
    const clock = fakeClock('2026-08-17T09:12:00.000Z');
    const fired: string[] = [];

    await runScheduler(
      (context) => {
        fired.push(context.scheduled_for);
        // Every capture takes 90 seconds. Unaligned scheduling would smear the series.
        clock.advance(90_000);
        return Promise.resolve();
      },
      { intervalMinutes: 60, maxTicks: 3, now: clock.now, sleep: clock.sleep },
    );

    expect(fired).to.deep.equal([
      '2026-08-17T10:00:00.000Z',
      '2026-08-17T11:00:00.000Z',
      '2026-08-17T12:00:00.000Z',
    ]);
  });

  it('runs immediately when asked, then rejoins the boundary', async () => {
    const clock = fakeClock('2026-08-17T09:12:00.000Z');
    const fired: string[] = [];

    await runScheduler(
      (context) => {
        fired.push(context.scheduled_for);
        return Promise.resolve();
      },
      {
        intervalMinutes: 60,
        maxTicks: 2,
        runImmediately: true,
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(fired[0]).to.equal('2026-08-17T09:12:00.000Z');
    expect(fired[1]).to.equal('2026-08-17T10:00:00.000Z');
  });

  it('keeps running after a tick throws', async () => {
    // Unattended is exactly when nobody notices the loop died. One bad capture is a hole; a dead
    // scheduler is every hour after it.
    const clock = fakeClock('2026-08-17T09:00:00.000Z');
    let calls = 0;

    const summary = await runScheduler(
      () => {
        calls += 1;
        if (calls === 2) throw new Error('collector timed out');
        return Promise.resolve();
      },
      { intervalMinutes: 60, maxTicks: 4, now: clock.now, sleep: clock.sleep },
    );

    expect(calls).to.equal(4);
    expect(summary.ticks_run).to.equal(4);
    expect(summary.ticks_failed).to.equal(1);
  });

  it('counts a sleep gap without backfilling it', async () => {
    const clock = fakeClock('2026-08-17T09:00:00.000Z');
    const fired: TickContext[] = [];

    await runScheduler(
      (context) => {
        fired.push(context);
        // The laptop is closed for four hours during the first tick.
        if (context.index === 1) clock.advance(4 * 3_600_000);
        return Promise.resolve();
      },
      { intervalMinutes: 60, maxTicks: 2, now: clock.now, sleep: clock.sleep },
    );

    // Tick 1 ran at 10:00, the clock jumped to 14:00, and the next boundary is 15:00 — so 11, 12, 13
    // and 14 all elapsed unattended. Two ticks ran, not six: the missing pages are gone and are
    // reported as gone rather than filled in with whatever the homepage says now.
    expect(fired).to.have.length(2);
    expect(fired[1]?.missed).to.equal(4);
  });

  it('reports the gap in its summary', async () => {
    const clock = fakeClock('2026-08-17T09:00:00.000Z');
    const summary = await runScheduler(
      (context) => {
        if (context.index === 1) clock.advance(3 * 3_600_000);
        return Promise.resolve();
      },
      { intervalMinutes: 60, maxTicks: 2, now: clock.now, sleep: clock.sleep },
    );

    // Ran 10:00, slept to 13:00, resumed 14:00 — 11, 12 and 13 lost.
    expect(summary.ticks_run).to.equal(2);
    expect(summary.ticks_missed).to.equal(3);
    expect(summary.stopped_because).to.equal('max_ticks');
  });

  it('stops cleanly when aborted mid-flight', async () => {
    const clock = fakeClock('2026-08-17T09:00:00.000Z');
    const controller = new AbortController();

    const summary = await runScheduler(
      (context) => {
        if (context.index === 2) controller.abort();
        return Promise.resolve();
      },
      {
        intervalMinutes: 60,
        maxTicks: 10,
        now: clock.now,
        sleep: clock.sleep,
        signal: controller.signal,
      },
    );

    expect(summary.ticks_run).to.equal(2);
    expect(summary.stopped_because).to.equal('aborted');
  });

  it('does not run at all when aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const summary = await runScheduler(
      () => {
        calls += 1;
        return Promise.resolve();
      },
      { intervalMinutes: 60, maxTicks: 5, signal: controller.signal },
    );

    expect(calls).to.equal(0);
    expect(summary.stopped_because).to.equal('aborted');
  });

  it('emits a countdown line before each wait', async () => {
    const clock = fakeClock('2026-08-17T09:30:00.000Z');
    const lines: string[] = [];

    await runScheduler(() => Promise.resolve(), {
      intervalMinutes: 60,
      maxTicks: 1,
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => lines.push(line),
    });

    expect(lines[0]).to.contain('10:00');
    expect(lines[0]).to.contain('30m 00s');
  });
});

describe('alignToBoundary', () => {
  it('files a moment under the boundary it belongs to', () => {
    // A tick that wakes 300ms late must still be stamped 11:00, not 11:00:00.300.
    expect(alignToBoundary(new Date('2026-08-17T11:00:00.300Z'), 60).toISOString()).to.equal(
      '2026-08-17T11:00:00.000Z',
    );
    expect(alignToBoundary(new Date('2026-08-17T11:59:59.000Z'), 60).toISOString()).to.equal(
      '2026-08-17T11:00:00.000Z',
    );
  });
});

describe('formatDuration', () => {
  it('reads as a countdown a human can check against a clock', () => {
    expect(formatDuration(45_000)).to.equal('45s');
    expect(formatDuration(3_600_000)).to.equal('60m 00s');
    expect(formatDuration(90_000)).to.equal('1m 30s');
  });

  it('never shows a negative wait', () => {
    expect(formatDuration(-5000)).to.equal('0s');
  });
});
