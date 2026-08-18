import type { HealthReport, HealthStatus } from '../health/health.js';

/**
 * The lifecycle of one repair, as an explicit state machine.
 *
 * Written as a machine rather than a set of booleans because the interesting states are the
 * transitions, and those are what the demo shows: DEGRADED twice, then HEALING, then RECOVERED. A
 * pile of flags cannot express "recovered" as distinct from "was never broken", and that distinction
 * is the entire claim being made.
 */

export type HealEvent =
  | 'capture_healthy'
  | 'capture_degraded'
  | 'capture_failed'
  | 'heal_started'
  | 'heal_approved'
  /**
   * The fix was committed but the verification run did NOT come back healthy. Distinct from
   * `heal_failed` (nothing was committed) because the collector HAS changed — and distinct from
   * `heal_approved` because "Bright Data said done" is not recovery. Measured live: of three real
   * heals, one recovered, and the API reported success identically in all three.
   */
  | 'heal_unverified'
  | 'heal_rejected'
  | 'heal_failed';

/**
 * `RECOVERED` is a distinct state from `HEALTHY` on purpose: it means "this collector was repaired
 * and the next capture proved it", which is worth surfacing once and then retiring. The following
 * clean capture returns it to plain HEALTHY so the badge does not linger and overstate the claim.
 */
export function transition(state: HealthStatus, event: HealEvent): HealthStatus {
  switch (event) {
    case 'heal_started':
      return state === 'DEGRADED' || state === 'FAILED' ? 'HEALING' : state;
    case 'heal_approved':
      return state === 'HEALING' ? 'RECOVERED' : state;
    case 'heal_unverified':
      // Committed but not proven: the outlet is still degraded until a capture says otherwise.
      return state === 'HEALING' ? 'DEGRADED' : state;
    case 'heal_rejected':
    case 'heal_failed':
      // A failed heal is non-destructive; we fall back to the broken-but-working state, not to a
      // worse one, because the previous collector is still live and still returning what it did.
      return state === 'HEALING' ? 'DEGRADED' : state;
    case 'capture_healthy':
      return state === 'HEALING' ? 'RECOVERED' : 'HEALTHY';
    case 'capture_degraded':
      return state === 'HEALING' ? 'HEALING' : 'DEGRADED';
    case 'capture_failed':
      return state === 'HEALING' ? 'HEALING' : 'FAILED';
  }
}

export function statusForCapture(report: HealthReport): HealEvent {
  if (report.status === 'FAILED') return 'capture_failed';
  if (report.status === 'DEGRADED') return 'capture_degraded';
  return 'capture_healthy';
}

/** A named moment inside a repair — where the 15–30 minutes actually went. */
export interface PhaseMark {
  phase: string;
  at: string;
}

/**
 * The verification verdict: the post-heal rerun, judged by the SAME health engine that triggered
 * the heal. `stories_after` alone cannot carry this — a rerun can return 30 rows that are all
 * navigation links, and only the health signals can tell. RECOVERED without this is a press release.
 */
export interface HealVerification {
  status: HealthStatus;
  /** Names of signals still at degraded-or-worse on the verification run. Empty when healthy. */
  failing: string[];
}

/** One complete repair, from detection to proof. This is the record the demo narrates. */
export interface HealEpisode {
  source: string;
  source_name: string;
  collector_id: string;
  detected_at: string;
  /** The health report that tripped the debounce. */
  trigger: HealthReport;
  /** Generated from `trigger`, never hand-written. */
  prompt: string;
  state: HealthStatus;
  stories_before: number;
  stories_after: number | null;
  approved: boolean;
  /** Null until the verification rerun has been judged; then the health engine's verdict on it. */
  health_after: HealVerification | null;
  resolved_at: string | null;
  error: string | null;
  /**
   * Stage timings, appended as each stage completes. A wall clock can say a heal took 24 minutes;
   * only this can say 21 of them were AI generation and the verification run took 40 seconds —
   * which is the difference between "healing is slow" and knowing WHAT is slow.
   */
  phase_marks: PhaseMark[];
}

export function beginEpisode(
  trigger: HealthReport,
  prompt: string,
  detectedAt: string,
): HealEpisode {
  return {
    source: trigger.source,
    source_name: trigger.source_name,
    collector_id: trigger.collector_id,
    detected_at: detectedAt,
    trigger,
    prompt,
    state: transition(trigger.status, 'heal_started'),
    stories_before: trigger.story_count,
    stories_after: null,
    approved: false,
    health_after: null,
    resolved_at: null,
    error: null,
    phase_marks: [{ phase: 'heal_requested', at: detectedAt }],
  };
}

/** Append a stage timestamp. Returns a new episode — marks are history and history is immutable. */
export function markPhase(episode: HealEpisode, phase: string, at: string): HealEpisode {
  return { ...episode, phase_marks: [...episode.phase_marks, { phase, at }] };
}

export function resolveEpisode(
  episode: HealEpisode,
  event: HealEvent,
  outcome: {
    stories_after?: number;
    health_after?: HealVerification;
    resolved_at: string;
    error?: string;
  },
): HealEpisode {
  return {
    ...episode,
    state: transition(episode.state, event),
    // `heal_unverified` IS approved — the fix was committed. What it lacks is proof of recovery.
    approved: event === 'heal_approved' || event === 'heal_unverified',
    stories_after: outcome.stories_after ?? null,
    health_after: outcome.health_after ?? null,
    resolved_at: outcome.resolved_at,
    error: outcome.error ?? null,
  };
}
