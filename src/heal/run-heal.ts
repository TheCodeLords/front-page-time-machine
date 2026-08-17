import { approveHeal, healCollector, runCollector } from '../collect/brightdata.js';
import type { CommandRunner } from '../collect/brightdata.js';
import type { Outlet } from '../config/outlets.js';
import type { HealthReport } from '../health/health.js';
import { normalizeCapture } from '../schema/normalize.js';
import { beginEpisode, markPhase, resolveEpisode } from './episode.js';
import type { HealEpisode } from './episode.js';
import { buildHealPrompt } from './heal-prompt.js';

/**
 * Detection -> repair -> proof, as one call.
 *
 * The proof step is the part that matters and the part most demos skip: after approving a fix we
 * re-run the collector and count what comes back. A heal that reports `done` but still returns three
 * stories has not recovered anything, and saying so is the difference between a reliability feature
 * and a press release.
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

    // Proof. Not "the API said done" — actual rows, actually normalized.
    const rawRecords = await runCollector(outlet.collector_id, outlet.homepage_url, runnerOption);
    const { records } = normalizeCapture(rawRecords, {
      source: outlet.source,
      source_name: outlet.source_name,
      homepage_url: outlet.homepage_url,
      captured_at: now(),
      capture_id: '00000000-0000-4000-8000-000000000000',
    });
    episode = markPhase(episode, 'verified_by_rerun', now());

    return resolveEpisode(episode, 'heal_approved', {
      stories_after: records.length,
      resolved_at: now(),
    });
  } catch (error) {
    // A failed heal is non-destructive: the previous collector is untouched and still working.
    const message = error instanceof Error ? error.message : String(error);
    return resolveEpisode(episode, 'heal_failed', {
      resolved_at: now(),
      error: isRepairAlreadyRunning(message)
        ? `a repair is already running on this collector — wait for it rather than retrying (${message.slice(0, 120)}…)`
        : message,
    });
  }
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
