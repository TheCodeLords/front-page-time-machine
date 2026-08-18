import { approveHeal, healCollector, runCollector } from '../collect/brightdata.js';
import type { CommandRunner } from '../collect/brightdata.js';
import type { Outlet } from '../config/outlets.js';
import {
  computeHealth,
  diagnosticsFor,
  failingSignals,
  DEFAULT_THRESHOLDS,
} from '../health/health.js';
import type { HealthReport, HealthThresholds } from '../health/health.js';
import type { CaptureSnapshot } from '../schema/story-snapshot.js';
import { buildCapture } from '../schema/normalize.js';
import { readRecentCaptures } from '../store/snapshot-store.js';
import type { StoreOptions } from '../store/snapshot-store.js';
import { beginEpisode, markPhase, resolveEpisode } from './episode.js';
import type { HealEpisode, HealVerification } from './episode.js';
import { buildHealPrompt } from './heal-prompt.js';

/**
 * Detection -> repair -> proof, as one call.
 *
 * The proof step is the part that matters and the part most demos skip: after approving a fix we
 * re-run the collector, normalize the rows, and judge the result with the SAME health engine that
 * detected the breakage — against the outlet's last known-HEALTHY baseline, frozen at detection
 * time. A heal that reports `done` but whose rerun is still degraded resolves as `heal_unverified`,
 * not RECOVERED. Counting rows is not enough: a "successful" heal can return 30 rows of navigation
 * links, and only the signals can tell.
 */

export type HealMode =
  /** Stop at Bright Data's approval gate and let a human review `preview_result`. The default. */
  | 'gated'
  /** Heal and commit in one shot. For the unattended hourly collector. */
  | 'autonomous';

/**
 * How long to let a heal run before giving up, in seconds.
 *
 * The CLI defaults to 600, which we measured to be too short for a real repair: healing the CNN
 * collector on 2026-08-17 ran through `planner`, `code_fixer`, `step_preview_runner` and
 * `request_fulfillment_validator`, reached `agent_picker` — the last step — and timed out on attempt
 * 600 of 600. The work was thrown away with the finish line in sight.
 *
 * Timing out is safe (the previous collector is untouched) but it is not free: it costs 10 minutes and
 * leaves the outlet broken. A generous ceiling on an operation that already takes a quarter of an hour
 * is the cheaper mistake.
 */
export const DEFAULT_HEAL_TIMEOUT_SECONDS = 1800;

export interface HealRunOptions {
  mode?: HealMode;
  runner?: CommandRunner;
  now?: () => string;
  timeoutSeconds?: number;
  /**
   * Where the outlet's stored captures live. When provided, the verification rerun is judged
   * against the outlet's last known-HEALTHY baseline (see `healthyBaseline`); without it the rerun
   * is judged on its absolute signals alone (empty capture, over-extraction, extraction failures
   * still fire — only the baseline-relative comparisons go quiet).
   */
  store?: StoreOptions;
  thresholds?: HealthThresholds;
}

/**
 * The baseline a verification rerun is judged against: the outlet's last known-HEALTHY captures,
 * frozen at detection time.
 *
 * Naively re-reading the trailing window here is wrong in both directions, and an adversarial
 * review executed both failures against this very code. By verification time the outage's own
 * captures are on disk, so the tail window contains them: three 8-story broken captures drag the
 * median to 8, a still-broken rerun of 8 scores 1.0 and verifies HEALTHY — while a genuinely fixed
 * rerun of 40 scores 5× the poisoned median and "fails" as over-extraction. Judging against the
 * last captures that were actually healthy — decided by walking the archive forward and judging
 * each capture only against what preceded it, exactly as it was judged live — restores both
 * verdicts. The freeze (`before` = detection time) also keeps a concurrently running watch from
 * silently mutating the verification window mid-heal.
 */
export async function healthyBaseline(
  source: string,
  before: string,
  store: StoreOptions,
  thresholds: HealthThresholds,
): Promise<CaptureSnapshot[]> {
  // Read wide: outage captures at the tail are expected and must not crowd out the healthy ones.
  const recent = (await readRecentCaptures(source, thresholds.baselineWindow * 4, store)).filter(
    (capture) => capture.captured_at < before,
  );
  const healthy: CaptureSnapshot[] = [];
  recent.forEach((snapshot, index) => {
    const report = computeHealth(
      { snapshot, diagnostics: diagnosticsFor(snapshot), baseline: recent.slice(0, index) },
      thresholds,
    );
    if (report.status === 'HEALTHY') healthy.push(snapshot);
  });
  return healthy.slice(-thresholds.baselineWindow);
}

/**
 * Rerun the collector and judge the result with the same health engine that detects breakage.
 * Shared by the autonomous heal path and `fptm approve`, so gated and unattended repairs are
 * verified by literally the same code.
 */
export async function verifyCollector(
  outlet: Outlet & { collector_id: string },
  options: {
    runner?: CommandRunner;
    store?: StoreOptions;
    thresholds?: HealthThresholds;
    detectedAt: string;
    now: () => string;
  },
): Promise<{ report: HealthReport; storyCount: number; healthAfter: HealVerification }> {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const rawRecords = await runCollector(outlet.collector_id, outlet.homepage_url, {
    ...(options.runner ? { runner: options.runner } : {}),
  });
  const { snapshot, diagnostics } = buildCapture(
    rawRecords,
    {
      source: outlet.source,
      source_name: outlet.source_name,
      homepage_url: outlet.homepage_url,
      captured_at: options.now(),
      capture_id: '00000000-0000-4000-8000-000000000000',
    },
    { collector_id: outlet.collector_id, screenshot_path: null },
  );
  const baseline = options.store
    ? await healthyBaseline(outlet.source, options.detectedAt, options.store, thresholds)
    : [];
  const report = computeHealth({ snapshot, diagnostics, baseline }, thresholds);
  return {
    report,
    storyCount: snapshot.records.length,
    healthAfter: {
      status: report.status,
      failing: failingSignals(report).map((signal) => signal.name),
    },
  };
}

export async function healOutlet(
  outlet: Outlet & { collector_id: string },
  trigger: HealthReport,
  options: HealRunOptions = {},
): Promise<HealEpisode> {
  const now = options.now ?? (() => new Date().toISOString());
  const mode = options.mode ?? 'gated';
  const runnerOption = options.runner ? { runner: options.runner } : {};
  const timeoutOption = {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_HEAL_TIMEOUT_SECONDS,
  };

  const prompt = buildHealPrompt(trigger, outlet.homepage_url);
  let episode = beginEpisode(trigger, prompt, now());
  // Once the fix is committed, failures change meaning: an exception before this point resolves as
  // heal_failed ("nothing was committed — the old collector still works"); after it, the collector
  // HAS been replaced, and pretending otherwise would send a triaging human to the wrong incident.
  let committed = false;

  try {
    const healed = await healCollector(outlet.collector_id, prompt, outlet.homepage_url, {
      ...runnerOption,
      ...timeoutOption,
      autoApprove: mode === 'autonomous',
    });
    // The AI generation is where most of a heal's wall-clock goes; this mark is what proves it.
    episode = markPhase(episode, 'ai_generation_finished', now());

    // `awaiting_approval` is a SUCCESS: the fix is ready and waiting on a decision. Treating it as a
    // failure here would make the gated path look broken every single time it worked.
    if (mode === 'gated' && healed.status === 'awaiting_approval') {
      return { ...markPhase(episode, 'stopped_at_approval_gate', now()), error: null };
    }

    if (healed.status !== 'done' && healed.status !== 'awaiting_approval') {
      return resolveEpisode(episode, 'heal_failed', {
        resolved_at: now(),
        error: healed.error ?? `heal returned status "${healed.status}"`,
      });
    }

    if (healed.status === 'awaiting_approval') {
      const approved = await approveHeal(outlet.collector_id, outlet.homepage_url, {
        ...runnerOption,
      });
      if (approved.status !== 'done') {
        return resolveEpisode(episode, 'heal_failed', {
          resolved_at: now(),
          error: approved.error ?? `approve returned status "${approved.status}"`,
        });
      }
      episode = markPhase(episode, 'approved', now());
    }
    committed = true;

    // Proof. Not "the API said done" — actual rows, normalized, then judged by the same health
    // engine that triggered the heal, against the outlet's last known-HEALTHY baseline.
    const { report, storyCount, healthAfter } = await verifyCollector(outlet, {
      ...runnerOption,
      ...(options.store ? { store: options.store } : {}),
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      detectedAt: episode.detected_at,
      now,
    });
    episode = markPhase(episode, 'verified_by_rerun', now());

    return resolveEpisode(
      episode,
      report.status === 'HEALTHY' ? 'heal_approved' : 'heal_unverified',
      {
        stories_after: storyCount,
        health_after: healthAfter,
        resolved_at: now(),
      },
    );
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    if (committed) {
      // The fix shipped and then the PROOF failed — a different incident from a failed heal. The
      // episode must say the collector changed (approved: true) with recovery unproven, and the
      // 409 rewrite must not apply: "a repair is already running, wait" is wrong advice when the
      // repair finished and the verification run is what broke.
      return resolveEpisode(episode, 'heal_unverified', {
        resolved_at: now(),
        error: `committed, but the verification rerun failed: ${message}`,
      });
    }
    // A failed heal is non-destructive: the previous collector is untouched and still working.
    return resolveEpisode(episode, 'heal_failed', {
      resolved_at: now(),
      error: isRepairAlreadyRunning(message)
        ? `a repair is already running on this collector — wait for it rather than retrying (${message.slice(0, 120)}…)`
        : message,
    });
  }
}

/**
 * Strip local filesystem paths out of an error before it is persisted.
 *
 * A spawn failure quotes the full command line, which contains the user's home directory — and the
 * episode ledger is part of the public archive. The path adds no diagnostic value (the interesting
 * part of the message is the CLI's own text); the home directory is simply not ours to publish.
 */
export function sanitizeErrorMessage(message: string): string {
  return message.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~');
}

/**
 * A client-side timeout does not cancel the server-side repair.
 *
 * Measured on 2026-08-17: the CNN heal exhausted the CLI's 600s polling budget at `agent_picker`, and
 * an immediate retry came back `409 Another refactor job is still in progress`. So a timeout is not a
 * dead end and a retry is not a fresh start — the original job is still working, and hammering it
 * achieves nothing. Worth naming distinctly, because "heal failed, try a sharper prompt" and "a heal
 * is already running, leave it alone" call for opposite actions.
 */
export function isRepairAlreadyRunning(message: string): boolean {
  return /another refactor job is still in progress|\b409\b/i.test(message);
}
