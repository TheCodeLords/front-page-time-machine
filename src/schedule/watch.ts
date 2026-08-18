import { captureOutlet } from '../collect/capture.js';
import type { CommandRunner } from '../collect/brightdata.js';
import type { ReadyOutlet } from '../config/outlets.js';
import { healOutlet } from '../heal/run-heal.js';
import type { HealEpisode } from '../heal/episode.js';
import type { HealMode } from '../heal/run-heal.js';
import {
  computeHealth,
  diagnosticsFor,
  isHealable,
  shouldHeal,
  DEFAULT_THRESHOLDS,
} from '../health/health.js';
import type { HealthStatus, HealthThresholds } from '../health/health.js';
import { readRecentCaptures } from '../store/snapshot-store.js';
import type { StoreOptions } from '../store/snapshot-store.js';
import { appendEpisode, readEpisodes } from '../store/episode-store.js';
import type { EpisodeRecord, EpisodeStoreOptions } from '../store/episode-store.js';
import type { TickContext } from './scheduler.js';

/**
 * What happens on each tick: capture every outlet, judge it, and repair the ones that stayed broken.
 *
 * This is the module where self-healing stops being a demo. Running `fptm heal` by hand proves the
 * mechanism works; a watcher that notices degradation at 03:00 and fixes it before anyone wakes up is
 * the actual feature. The detection logic is unchanged — `computeHealth` and `shouldHeal` are the same
 * functions the demo uses — so what is added here is autonomy, not a second opinion.
 */

export interface WatchOptions {
  outlets: readonly ReadyOutlet[];
  store: StoreOptions;
  screenshotDir?: string | null;
  /** Gated stops at Bright Data's approval gate. The safe default: a human sees the fix first. */
  healMode?: HealMode;
  /** Off makes the watcher observe and report without ever touching a collector. */
  autoHeal?: boolean;
  thresholds?: HealthThresholds;
  runner?: CommandRunner;
  /** Where heal episodes are persisted. Defaults to `episodes/` beside the snapshots. */
  episodeStore?: EpisodeStoreOptions;
  log?: (line: string) => void;
}

export interface OutletState {
  /** Most recent statuses, oldest first. Feeds the debounce. */
  statuses: HealthStatus[];
  /**
   * A gated heal is waiting on a human. Latched so the watcher does not re-request the same fix every
   * hour while nobody is awake to approve it — which would burn the AI-flow cap and bury the one
   * notification that mattered under twelve identical ones.
   */
  healPending: boolean;
  /**
   * Heals spent on the CURRENT outage. Reset only by recovery, so the budget is per-breakage rather
   * than per-day: three shots at one problem, not three shots every midnight at the same problem.
   *
   * Without this, autonomous mode is an open loop — a permanently broken outlet re-satisfies the
   * debounce every capture and heals forever, 20 minutes of AI Flow at a time. Three attempts at the
   * same failure without recovery is strong evidence the failure is not something healing fixes
   * (we measured exactly that live: two heals against the same collector changed nothing).
   */
  healsThisOutage: number;
}

export type WatchState = Map<string, OutletState>;

/**
 * Heal attempts allowed per outage: bound the expensive loop, require recovery to earn more
 * attempts, and route persistent failures to a human instead of burning the same repair on the
 * same wall. See docs/learnings.md.
 */
export const MAX_HEALS_PER_OUTAGE = 3;

export interface OutletTickResult {
  source: string;
  source_name: string;
  status: HealthStatus | null;
  story_count: number;
  error: string | null;
  screenshot_error: string | null;
  heal: HealEpisode | null;
}

export interface WatchTickResult {
  index: number;
  scheduled_for: string;
  missed: number;
  outlets: OutletTickResult[];
}

function stateFor(state: WatchState, source: string): OutletState {
  const existing = state.get(source);
  if (existing !== undefined) return existing;
  const fresh: OutletState = { statuses: [], healPending: false, healsThisOutage: 0 };
  state.set(source, fresh);
  return fresh;
}

/**
 * Prime the debounce from history already on disk.
 *
 * Without this, restarting the watcher resets every outlet to "no failures seen", so a collector that
 * has been broken for five hours gets another two hours of grace before anything fires. The archive
 * already knows; read it.
 */
export async function seedWatchState(options: WatchOptions): Promise<WatchState> {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const state: WatchState = new Map();

  for (const outlet of options.outlets) {
    const recent = await readRecentCaptures(
      outlet.source,
      thresholds.baselineWindow + 1,
      options.store,
    );
    const statuses: HealthStatus[] = [];
    let lastHealthyAt = '';
    recent.forEach((snapshot, index) => {
      // Judge each capture against only what preceded it, exactly as it was judged when written.
      const report = computeHealth(
        {
          snapshot,
          diagnostics: diagnosticsFor(snapshot),
          baseline: recent.slice(0, index),
        },
        thresholds,
      );
      statuses.push(report.status);
      if (report.status === 'HEALTHY') lastHealthyAt = snapshot.captured_at;
    });

    // The heal budget and the gated latch survive a restart the same way the debounce does: the
    // ledger already knows. Without this, every restart granted a permanently-broken outlet a
    // fresh budget — three more 20-minute heals against the same wall, per restart.
    let healsThisOutage = 0;
    let healPending = false;
    let episodes: EpisodeRecord[] = [];
    try {
      episodes = await readEpisodes(outlet.source, options.episodeStore ?? {});
    } catch {
      // A missing or unreadable ledger primes nothing — same grace as a fresh outlet.
    }
    const latestByDetection = new Map<string, EpisodeRecord>();
    for (const episode of episodes) latestByDetection.set(episode.detected_at, episode);
    const sinceOutage = [...latestByDetection.values()].filter(
      (episode) => episode.detected_at > lastHealthyAt,
    );
    healsThisOutage = sinceOutage.length;
    healPending = sinceOutage.at(-1)?.state === 'HEALING';

    state.set(outlet.source, { statuses, healPending, healsThisOutage });
  }

  return state;
}

/** One tick: every outlet captured, judged, and healed if it has stayed broken. */
export async function runWatchTick(
  context: TickContext,
  state: WatchState,
  options: WatchOptions,
): Promise<WatchTickResult> {
  const log = options.log ?? ((): void => {});
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const autoHeal = options.autoHeal ?? true;
  const results: OutletTickResult[] = [];

  for (const outlet of options.outlets) {
    const outletState = stateFor(state, outlet.source);

    let result: OutletTickResult = {
      source: outlet.source,
      source_name: outlet.source_name,
      status: null,
      story_count: 0,
      error: null,
      screenshot_error: null,
      heal: null,
    };

    try {
      const captured = await captureOutlet(outlet, {
        store: options.store,
        ...(options.screenshotDir === undefined ? {} : { screenshotDir: options.screenshotDir }),
        ...(options.runner ? { runner: options.runner } : {}),
        thresholds,
        // Outlets are fetched serially, so the tick boundary is what groups them into one
        // editorial moment. Recording it is what makes "the 14:00 capture window" a stored fact.
        scheduledFor: context.scheduled_for,
      });

      result = {
        ...result,
        status: captured.health.status,
        story_count: captured.health.story_count,
        screenshot_error: captured.screenshotError,
      };

      outletState.statuses.push(captured.health.status);
      // Bound the history at what the debounce can consult, so a long-running watch does not grow a
      // list forever to answer a question about the last two entries.
      if (outletState.statuses.length > thresholds.baselineWindow + 1) outletState.statuses.shift();

      if (captured.health.status === 'HEALTHY') {
        outletState.healPending = false;
        outletState.healsThisOutage = 0; // recovery re-arms the budget
      }

      log(
        `  ${outlet.source.padEnd(10)} ${captured.health.status.padEnd(9)} ` +
          `${String(captured.health.story_count).padStart(3)} stories`,
      );

      const debounced =
        autoHeal && !outletState.healPending && shouldHeal(outletState.statuses, thresholds);
      const budgetSpent = outletState.healsThisOutage >= MAX_HEALS_PER_OUTAGE;

      if (debounced && !isHealable(captured.health)) {
        // Broken for two captures running, but not by anything a heal can reach.
        log(`  ${outlet.source.padEnd(10)} degraded, but the cause is upstream — not healing`);
      } else if (debounced && budgetSpent) {
        log(
          `  ${outlet.source.padEnd(10)} still broken after ${MAX_HEALS_PER_OUTAGE} heals this outage — needs a human, not another heal`,
        );
      } else if (debounced) {
        log(
          `  ${outlet.source.padEnd(10)} debounce satisfied (${outletState.statuses.slice(-thresholds.consecutiveFailuresBeforeHeal).join(' → ')}) — healing`,
        );
        // A heal that throws must not cost us the remaining outlets this hour.
        try {
          outletState.healsThisOutage += 1;
          const mode = options.healMode ?? 'gated';
          const episode = await healOutlet(outlet, captured.health, {
            mode,
            ...(options.runner ? { runner: options.runner } : {}),
            // The verification rerun is judged against the same stored baseline the trigger was.
            store: options.store,
            thresholds,
          });
          result = { ...result, heal: episode };
          // The ledger write is best-effort: losing a ledger line must never lose the tick.
          try {
            await appendEpisode(episode, options.episodeStore ?? {});
          } catch (ledgerError) {
            log(`  ${outlet.source.padEnd(10)} episode not persisted: ${String(ledgerError)}`);
          }
          // Only a GATED heal latches — it is waiting on a human, and asking again adds nothing.
          // An autonomous heal that did not restore health deserves its remaining budget: the next
          // still-broken capture may produce a sharper diagnosis than the last one.
          if (mode === 'gated') outletState.healPending = true;
          log(`  ${outlet.source.padEnd(10)} heal → ${episode.state}`);
        } catch (error) {
          log(
            `  ${outlet.source.padEnd(10)} heal failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      // One outlet's outage is not the others'. Record it and keep going round the loop.
      result = { ...result, error: error instanceof Error ? error.message : String(error) };
      log(`  ${outlet.source.padEnd(10)} ERROR     ${result.error}`);
    }

    results.push(result);
  }

  return {
    index: context.index,
    scheduled_for: context.scheduled_for,
    missed: context.missed,
    outlets: results,
  };
}
