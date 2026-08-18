import type { CaptureDiagnostics } from '../schema/normalize.js';
import { isAliasKnown } from '../schema/field-aliases.js';
import type { CaptureSnapshot, StorySnapshotRecord } from '../schema/story-snapshot.js';

/**
 * Extraction health — deterministic, offline, and separate from anything editorial.
 *
 * Nothing here knows what a story means. It counts rows, compares against what this outlet normally
 * produces, and classifies. That separation is deliberate: a news homepage legitimately swings from
 * 38 to 44 stories over a morning, and a detector that cannot tell that from a redesign will either
 * cry wolf every hour or sleep through the one failure that matters.
 */

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'HEALING' | 'RECOVERED';
export type SignalSeverity = 'ok' | 'degraded' | 'failed';

const SEVERITY_RANK: Record<SignalSeverity, number> = { ok: 0, degraded: 1, failed: 2 };

export interface HealthThresholds {
  /** Captures compared against, to turn "3 stories" into "3 stories, against a normal of 42". */
  baselineWindow: number;
  /** Fraction of the trailing median below which story count reads as damage. */
  storyCountDegradedRatio: number;
  /** Multiple of the trailing median above which story count reads as over-extraction. */
  storyCountHighRatio: number;
  /**
   * No homepage has this many stories, baseline or not. An absolute ceiling matters because the
   * ratio check is defenceless against a collector that over-extracts from its very first capture —
   * it poisons its own baseline, the median settles at the inflated number, and "normal" is wrong
   * forever after. Found live: Fox News returned 1,911 raw rows collapsing to 499 "stories", every
   * one of them validating, and no signal fired on the count.
   */
  maxPlausibleStoryCount: number;
  /** With no baseline yet, a capture this small is suspicious on its own. */
  minStoryCountWithoutBaseline: number;
  headlineFailureDegraded: number;
  headlineFailureFailed: number;
  urlFailureDegraded: number;
  urlFailureFailed: number;
  duplicateDegraded: number;
  duplicateFailed: number;
  /** Baseline coverage above which a field counts as "this collector reliably returns it". */
  fieldEstablishedCoverage: number;
  /** Consecutive non-healthy captures before healing is allowed to fire. */
  consecutiveFailuresBeforeHeal: number;
}

/** Nullable by contract, so their disappearance is invisible to every other signal. */
const OPTIONAL_FIELDS = ['section', 'summary', 'image_url', 'published_at'] as const;

function coverage(
  records: readonly StorySnapshotRecord[],
  field: (typeof OPTIONAL_FIELDS)[number],
): number {
  if (records.length === 0) return 0;
  return records.filter((record) => record[field] !== null).length / records.length;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  baselineWindow: 5,
  storyCountDegradedRatio: 0.5,
  storyCountHighRatio: 2.5,
  maxPlausibleStoryCount: 300,
  minStoryCountWithoutBaseline: 3,
  headlineFailureDegraded: 0.1,
  headlineFailureFailed: 0.5,
  urlFailureDegraded: 0.05,
  urlFailureFailed: 0.5,
  duplicateDegraded: 0.3,
  duplicateFailed: 0.6,
  fieldEstablishedCoverage: 0.5,
  consecutiveFailuresBeforeHeal: 2,
};

export interface HealthSignal {
  name: string;
  severity: SignalSeverity;
  /** Human-readable and quantified — this text is what the observability report prints. */
  detail: string;
}

export interface HealthReport {
  source: string;
  source_name: string;
  capture_id: string;
  captured_at: string;
  collector_id: string;
  status: HealthStatus;
  story_count: number;
  baseline_median: number | null;
  signals: HealthSignal[];
}

export interface HealthInput {
  snapshot: CaptureSnapshot;
  diagnostics: CaptureDiagnostics;
  /** Trailing captures for this source, oldest first. Empty on the first ever run. */
  baseline: readonly CaptureSnapshot[];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

function asPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

function gradeRatio(ratio: number, degradedAt: number, failedAt: number): SignalSeverity {
  if (ratio >= failedAt) return 'failed';
  if (ratio >= degradedAt) return 'degraded';
  return 'ok';
}

/**
 * Baseline counts, drawn only from captures that actually produced stories.
 *
 * Empty captures are excluded on purpose. If an outlet breaks and returns zero for three hours, a
 * naive median would drift toward zero and quietly declare the broken state to be normal — the
 * detector would heal itself into blindness.
 */
function baselineCounts(
  baseline: readonly CaptureSnapshot[],
  window: number,
  maxPlausible: number,
): number[] {
  return baseline
    .filter(
      (capture) =>
        // Empty captures excluded so an outage cannot drag the median toward zero — and implausibly
        // large ones excluded for the mirror-image reason: an over-extracting collector would drag
        // its own median UP, and with a window of five the ratio check self-silences three captures
        // after onset. Both directions of damage are barred from defining "normal".
        capture.records.length > 0 && capture.records.length <= maxPlausible,
    )
    .slice(-window)
    .map((capture) => capture.records.length);
}

export function computeHealth(
  input: HealthInput,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): HealthReport {
  const { snapshot, diagnostics } = input;
  const storyCount = snapshot.records.length;
  const rawCount = diagnostics.raw_count;
  const signals: HealthSignal[] = [];

  const counts = baselineCounts(
    input.baseline,
    thresholds.baselineWindow,
    thresholds.maxPlausibleStoryCount,
  );
  const baselineMedian = median(counts);

  // 1. The loudest signal there is. An empty homepage is never a slow news hour.
  if (storyCount === 0) {
    signals.push({
      name: 'empty_capture',
      severity: 'failed',
      detail:
        rawCount === 0
          ? 'collector returned no rows at all'
          : `collector returned ${rawCount} rows, none of which survived normalization`,
    });
  } else if (baselineMedian !== null) {
    const ratio = storyCount / baselineMedian;
    signals.push({
      name: 'story_count',
      severity: ratio < thresholds.storyCountDegradedRatio ? 'degraded' : 'ok',
      detail: `${storyCount} stories against a trailing median of ${baselineMedian}`,
    });
  } else if (storyCount < thresholds.minStoryCountWithoutBaseline) {
    signals.push({
      name: 'story_count',
      severity: 'degraded',
      detail: `${storyCount} stories with no baseline yet to compare against`,
    });
  } else {
    signals.push({
      name: 'story_count',
      severity: 'ok',
      detail: `${storyCount} stories, no baseline yet`,
    });
  }

  // 1b. Too MANY stories is damage too, and it is the quieter failure.
  //
  // Under-extraction announces itself — charts empty, demos break. Over-extraction validates: nav
  // links, section rails and footer links all have a headline and a URL, so 499 "stories" parse
  // perfectly and every downstream product silently corrupts. The thesis is that position 1 is the
  // lead story; if the row set contains navigation, rank no longer measures editorial judgement,
  // and propagation and divergence inherit the error without a single schema violation.
  const implausiblyMany = storyCount > thresholds.maxPlausibleStoryCount;
  const aboveBaseline =
    baselineMedian !== null && storyCount > baselineMedian * thresholds.storyCountHighRatio;
  if (implausiblyMany || aboveBaseline) {
    signals.push({
      name: 'over_extraction',
      severity: 'degraded',
      detail: implausiblyMany
        ? `${storyCount} stories — no front page has more than ~${thresholds.maxPlausibleStoryCount}; navigation, rails or footer links are being extracted as news`
        : `${storyCount} stories against a trailing median of ${baselineMedian} — extraction has widened beyond the front page`,
    });
  }

  // 2. Was it extraction at all?
  //
  // Rows carrying an upstream error are not a broken scraper, and saying so out loud is what keeps a
  // rate limit or a blocked request from being answered with a 20-minute heal that cannot help.
  const upstreamErrors = diagnostics.rejected_upstream_error;
  if (upstreamErrors > 0) {
    signals.push({
      name: 'upstream_error',
      severity: upstreamErrors === rawCount ? 'failed' : 'degraded',
      detail:
        `${upstreamErrors}/${rawCount} rows carried an upstream error, not a story ` +
        `— the collector is not at fault and healing will not help`,
    });
  }

  // 3-5. Which PART of extraction broke. These are why the heal prompt can be specific.
  if (rawCount > 0) {
    const headlineFailure = diagnostics.rejected_no_headline / rawCount;
    signals.push({
      name: 'headline_extraction',
      severity: gradeRatio(
        headlineFailure,
        thresholds.headlineFailureDegraded,
        thresholds.headlineFailureFailed,
      ),
      detail: `${diagnostics.rejected_no_headline}/${rawCount} rows had an empty headline (${asPercent(headlineFailure)})`,
    });

    const urlFailure = diagnostics.rejected_no_url / rawCount;
    signals.push({
      name: 'url_extraction',
      severity: gradeRatio(urlFailure, thresholds.urlFailureDegraded, thresholds.urlFailureFailed),
      detail: `${diagnostics.rejected_no_url}/${rawCount} rows had no usable article_url (${asPercent(urlFailure)})`,
    });

    const duplicateRate = diagnostics.collapsed_duplicates / rawCount;
    signals.push({
      name: 'duplicate_urls',
      severity: gradeRatio(duplicateRate, thresholds.duplicateDegraded, thresholds.duplicateFailed),
      // A spike here usually means extraction collapsed onto one container and is re-reading it.
      detail: `${diagnostics.collapsed_duplicates}/${rawCount} rows duplicated an earlier URL (${asPercent(duplicateRate)})`,
    });
  }

  // 5. A field that used to arrive and now never does.
  //
  // The optional fields are nullable by design, so a collector that stops returning `image_url`
  // entirely produces records that are still perfectly valid — every other signal stays green while
  // the dataset quietly loses a column. That is precisely the damage a heal can do, since the AI
  // regenerates the template and may rename or drop an output field while "succeeding".
  for (const field of OPTIONAL_FIELDS) {
    const currentCoverage = coverage(snapshot.records, field);
    const baselineCoverage = median(
      input.baseline
        .filter((capture) => capture.records.length > 0)
        .slice(-thresholds.baselineWindow)
        .map((capture) => coverage(capture.records, field)),
    );

    if (
      baselineCoverage !== null &&
      baselineCoverage >= thresholds.fieldEstablishedCoverage &&
      currentCoverage === 0
    ) {
      signals.push({
        name: `field_lost:${field}`,
        severity: 'degraded',
        detail: `${field} was populated on ${asPercent(baselineCoverage)} of recent stories and is now absent from all ${storyCount}`,
      });
    }
  }

  // 5b. Raw vocabulary drift — the early-warning version of field_lost.
  //
  // The alias layer exists to absorb renames, which means it also HIDES them: a heal that renames
  // `author_name` to `author` produces identical canonical records and a green report. That is fine
  // right up until a rename lands on a field the aliases don't know. So the vocabulary is compared
  // against the most recent baseline capture that recorded one, and a disappeared field is graded by
  // consequence: degraded if it was feeding canonical data (extraction has actually lost an input),
  // merely recorded in the detail text if it was ballast the aliases never read.
  const baselineVocabulary = [...input.baseline]
    .reverse()
    .map((capture) => capture.diagnostics?.raw_fields ?? [])
    .find((fields) => fields.length > 0);
  if (baselineVocabulary !== undefined && diagnostics.raw_fields.length > 0) {
    const current = new Set(diagnostics.raw_fields);
    const disappeared = baselineVocabulary.filter((field) => !current.has(field));
    const consequential = disappeared.filter((field) => isAliasKnown(field));
    if (disappeared.length > 0) {
      signals.push({
        name: 'raw_shape_drift',
        severity: consequential.length > 0 ? 'degraded' : 'ok',
        detail:
          `collector vocabulary changed: ${disappeared.join(', ')} no longer returned` +
          (consequential.length > 0
            ? ` — ${consequential.join(', ')} previously fed canonical fields`
            : ' (cosmetic — never fed canonical data)'),
      });
    }
  }

  // 6. A structural invariant, not a threshold: ranks must be a contiguous 1..N after re-ranking.
  const positions = snapshot.records.map((record) => record.position);
  const contiguous = positions.every((position, index) => position === index + 1);
  signals.push({
    name: 'position_integrity',
    severity: contiguous ? 'ok' : 'failed',
    detail: contiguous
      ? 'ranks are contiguous from 1'
      : `ranks are not contiguous: ${positions.join(',')}`,
  });

  const worst = signals.reduce<SignalSeverity>(
    (acc, signal) => (SEVERITY_RANK[signal.severity] > SEVERITY_RANK[acc] ? signal.severity : acc),
    'ok',
  );

  return {
    source: snapshot.source,
    source_name: snapshot.source_name,
    capture_id: snapshot.capture_id,
    captured_at: snapshot.captured_at,
    collector_id: snapshot.collector_id,
    status: worst === 'failed' ? 'FAILED' : worst === 'degraded' ? 'DEGRADED' : 'HEALTHY',
    story_count: storyCount,
    baseline_median: baselineMedian,
    signals,
  };
}

/**
 * The diagnostics behind a stored capture, reconstructed when the capture predates them.
 *
 * Captures written before the rejection breakdown was persisted read back as null. The
 * reconstruction — "every surviving record, nothing rejected" — is deliberately the most
 * conservative one available: it cannot invent a breakdown, so a health verdict or heal prompt
 * derived from an old capture comes out vaguer. Vaguer is the correct failure. Fabricating plausible
 * rejection counts would make a heal prompt confidently describe damage that may never have happened.
 */
export function diagnosticsFor(capture: CaptureSnapshot): CaptureDiagnostics {
  return (
    capture.diagnostics ?? {
      raw_count: capture.records.length,
      rejected_no_headline: 0,
      rejected_no_url: 0,
      collapsed_duplicates: 0,
      rejected_self_link: 0,
      rejected_upstream_error: 0,
      raw_fields: [],
      positions_from_collector: 0,
    }
  );
}

/**
 * The debounce. One bad capture is a blip; N consecutive is a redesign.
 *
 * Without this the system heals on every transient network hiccup, burns the AI-flow concurrency cap,
 * and — worse — teaches anyone watching the demo that "self-healing" means "fires constantly".
 * Requires the run of non-healthy captures to be the MOST RECENT ones, so a recovery resets it.
 */
export function shouldHeal(
  recentStatuses: readonly HealthStatus[],
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): boolean {
  const required = thresholds.consecutiveFailuresBeforeHeal;
  if (recentStatuses.length < required) return false;
  return recentStatuses
    .slice(-required)
    .every((status) => status === 'DEGRADED' || status === 'FAILED');
}

/**
 * Whether this report describes something a heal could actually fix.
 *
 * Healing is expensive — 15 to 30 minutes of AI Flow, and a concurrency slot other outlets are
 * queueing for. Spending that on a rate limit or a blocked request buys nothing, because the
 * collector was never wrong. The debounce answers "is this real?"; this answers "is this ours?", and
 * both have to be yes.
 */
export function isHealable(report: HealthReport): boolean {
  return !report.signals.some(
    (signal) => signal.name === 'upstream_error' && signal.severity === 'failed',
  );
}

/** Signals at or above `degraded`, worst first — the ones worth acting on or printing. */
export function failingSignals(report: HealthReport): HealthSignal[] {
  return report.signals
    .filter((signal) => signal.severity !== 'ok')
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
