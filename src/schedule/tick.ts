/**
 * When the next capture is due.
 *
 * Pure arithmetic on timestamps — no timers, no I/O — so the whole cadence is testable in
 * milliseconds instead of hours. `scheduler.ts` turns these answers into actual waiting.
 */

/**
 * Ticks land on wall-clock boundaries, not on "whenever the last one finished plus an hour".
 *
 * Drift is the reason. A capture that takes 40s pushes the next one to :00:40, then :01:22, and by
 * the end of a day the series is 20 minutes out of phase — which quietly ruins the two things this
 * project exists to do. Cross-outlet comparison needs every outlet sampled at the same instant to
 * mean anything, and hour-over-hour diffs need even spacing or "what changed in an hour" is really
 * "what changed in 68 minutes". Aligning to the boundary makes late runs lose their lateness instead
 * of accumulating it.
 */
export function nextTickAfter(now: Date, intervalMinutes: number): Date {
  assertInterval(intervalMinutes);
  const intervalMs = intervalMinutes * 60_000;
  // Anchor on the UTC day so boundaries are absolute rather than relative to process start.
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsed = now.getTime() - dayStart;
  const next = dayStart + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  return new Date(next);
}

export function msUntilNextTick(now: Date, intervalMinutes: number): number {
  return nextTickAfter(now, intervalMinutes).getTime() - now.getTime();
}

/**
 * How many scheduled captures were missed between two points in time.
 *
 * Deliberately a COUNT and not a work queue. A missed capture cannot be performed late — the
 * homepage that existed at 03:00 is gone, and re-running the collector now would file the current
 * front page under a past hour. So the gap gets counted and reported, never backfilled. An honest
 * hole in the archive is worth more than a plausible fabrication, and a system that "catches up"
 * after a laptop sleeps would silently produce exactly that.
 */
export function missedTicks(lastTickAt: Date, now: Date, intervalMinutes: number): number {
  assertInterval(intervalMinutes);
  const intervalMs = intervalMinutes * 60_000;
  const elapsed = now.getTime() - lastTickAt.getTime();
  if (elapsed <= intervalMs) return 0;
  // The tick that is due right now is not missed — it is about to run.
  return Math.floor(elapsed / intervalMs) - 1;
}

/**
 * Intervals must tile the hour evenly, or "aligned" is a lie.
 *
 * At 50 minutes the boundaries would be :00, :50, :40, :30 — a different offset every hour, which is
 * the drift this module exists to prevent, only harder to notice.
 */
function assertInterval(intervalMinutes: number): void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error(`interval must be a positive whole number of minutes, got ${intervalMinutes}`);
  }
  if (intervalMinutes > 1440 || 1440 % intervalMinutes !== 0) {
    throw new Error(
      `interval must divide 24h evenly so ticks land on stable boundaries, got ${intervalMinutes}`,
    );
  }
}

export { assertInterval };
