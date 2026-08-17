import { missedTicks, msUntilNextTick, nextTickAfter } from './tick.js';

/**
 * The loop that turns "hourly" from a claim into a fact.
 *
 * It knows nothing about news, collectors or Bright Data — it takes an async function and calls it on
 * aligned boundaries until told to stop. `watch.ts` supplies the part that captures. Keeping the two
 * apart is what lets the cadence be tested exhaustively with a fake clock in a few milliseconds,
 * rather than being provable only by leaving a laptop open overnight.
 */

export interface TickContext {
  /** 1-based. */
  index: number;
  /** The boundary this tick belongs to — the timestamp the data should be filed under. */
  scheduled_for: string;
  /** When the tick actually began. Differs from `scheduled_for` by the wake-up lag. */
  started_at: string;
  /** Scheduled captures that elapsed while we were asleep or stalled. Never backfilled. */
  missed: number;
}

export type StopReason = 'max_ticks' | 'aborted';

export interface SchedulerSummary {
  ticks_run: number;
  ticks_missed: number;
  ticks_failed: number;
  started_at: string;
  ended_at: string;
  stopped_because: StopReason;
}

export interface SchedulerOptions {
  intervalMinutes: number;
  /** Stop after this many ticks. Null runs until aborted. */
  maxTicks?: number | null;
  /** Fire once at startup instead of waiting for the first boundary. */
  runImmediately?: boolean;
  signal?: AbortSignal;
  /** Injected for deterministic tests — a fake clock makes a 24h schedule a 2ms assertion. */
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

/** Resolves early and cleanly when aborted; never rejects, so abort is not an error path. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runScheduler(
  onTick: (context: TickContext) => Promise<void>,
  options: SchedulerOptions,
): Promise<SchedulerSummary> {
  const now = options.now ?? ((): Date => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((): void => {});
  const maxTicks = options.maxTicks ?? null;
  const signal = options.signal;

  const startedAt = now();
  let index = 0;
  let failed = 0;
  let missed = 0;
  let lastTickAt: Date | null = null;
  let stoppedBecause: StopReason = 'max_ticks';

  const aborted = (): boolean => signal?.aborted === true;

  while (!aborted() && (maxTicks === null || index < maxTicks)) {
    const immediate = index === 0 && options.runImmediately === true;

    if (!immediate) {
      const current = now();
      const waitMs = msUntilNextTick(current, options.intervalMinutes);
      log(
        `next capture at ${nextTickAfter(current, options.intervalMinutes).toISOString().slice(11, 16)}Z ` +
          `(in ${formatDuration(waitMs)})`,
      );
      await sleep(waitMs, signal);
      if (aborted()) break;
    }

    const startedTickAt = now();
    // A tick is filed under the boundary it belongs to, not the instant the timer happened to fire.
    // Waking 300ms late must not stamp the capture 59m 59.7s after the previous one.
    const scheduledFor = immediate
      ? startedTickAt
      : alignToBoundary(startedTickAt, options.intervalMinutes);

    const skipped =
      lastTickAt === null ? 0 : missedTicks(lastTickAt, startedTickAt, options.intervalMinutes);
    if (skipped > 0) {
      missed += skipped;
      // Said out loud, because a silent gap in an archive is indistinguishable from a quiet news day.
      log(`gap: ${skipped} scheduled capture(s) missed — not backfilled, the pages are gone`);
    }

    index += 1;
    lastTickAt = startedTickAt;

    try {
      await onTick({
        index,
        scheduled_for: scheduledFor.toISOString(),
        started_at: startedTickAt.toISOString(),
        missed: skipped,
      });
    } catch (error) {
      // One failed capture must never end the watch. Losing this hour is a hole; losing the loop
      // loses every hour after it too, and unattended is exactly when nobody notices.
      failed += 1;
      log(`tick ${index} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (aborted()) stoppedBecause = 'aborted';

  return {
    ticks_run: index,
    ticks_missed: missed,
    ticks_failed: failed,
    started_at: startedAt.toISOString(),
    ended_at: now().toISOString(),
    stopped_because: stoppedBecause,
  };
}

/** The boundary a moment belongs to: the most recent one at or before it. */
function alignToBoundary(moment: Date, intervalMinutes: number): Date {
  const previous = new Date(
    nextTickAfter(moment, intervalMinutes).getTime() - intervalMinutes * 60_000,
  );
  return previous;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export { alignToBoundary };
