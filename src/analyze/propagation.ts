import type { StoryCluster } from './cluster.js';
import type { ProminenceTier, StorySnapshotRecord } from '../schema/story-snapshot.js';

/**
 * How one story spread across front pages over time.
 *
 * The discipline that makes this publishable: every number here is placement, duration or timing.
 * There is no tone score, no alignment label, no ranking of outlets. "Outlet A led with this for
 * eight hours; Outlet D never placed it above the fold" contains no opinion and needs no defending —
 * and it says more than any bias score could. We hold up the x-ray; the reader draws the conclusion.
 */

export interface OutletTrace {
  source: string;
  source_name: string;
  first_seen: string;
  last_seen: string;
  /** Best (lowest) rank this outlet ever gave the story. */
  peak_position: number;
  peak_tier: ProminenceTier;
  /** Distinct captures in which this outlet had the story as its lead. */
  captures_as_lead: number;
  /** Distinct captures in which the story appeared at all — its shelf life on that front page. */
  captures_present: number;
  /** Quoted verbatim, with the time we saw it. */
  headline_at_first_seen: string;
}

export interface CoveragePoint {
  at: string;
  outlet_count: number;
}

export interface StoryPropagation {
  cluster_id: number;
  label: string;
  first_detected: { source: string; source_name: string; at: string };
  outlets: OutletTrace[];
  coverage_timeline: CoveragePoint[];
  /** Outlets present in the dataset that never carried this story. The blind spots. */
  never_covered: string[];
}

function traceForOutlet(records: readonly StorySnapshotRecord[]): OutletTrace {
  const ordered = [...records].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('traceForOutlet requires at least one record');
  }

  const best = ordered.reduce(
    (acc, record) => (record.position < acc.position ? record : acc),
    first,
  );

  return {
    source: first.source,
    source_name: first.source_name,
    first_seen: first.captured_at,
    last_seen: last.captured_at,
    peak_position: best.position,
    peak_tier: best.prominence_tier,
    captures_as_lead: new Set(ordered.filter((r) => r.is_lead).map((r) => r.captured_at)).size,
    captures_present: new Set(ordered.map((r) => r.captured_at)).size,
    headline_at_first_seen: first.headline,
  };
}

/**
 * @param cluster        one conceptual story
 * @param knownSources   every outlet in the dataset, so silence can be distinguished from absence.
 *                       Without this list a story simply "has four outlets"; with it, the same story
 *                       has four outlets AND two that never touched it, which is the interesting half.
 */
export function buildPropagation(
  cluster: StoryCluster,
  knownSources: readonly string[],
): StoryPropagation {
  const bySource = new Map<string, StorySnapshotRecord[]>();
  for (const record of cluster.records) {
    const existing = bySource.get(record.source);
    if (existing === undefined) bySource.set(record.source, [record]);
    else existing.push(record);
  }

  const outlets = [...bySource.values()]
    .map(traceForOutlet)
    .sort((a, b) => a.first_seen.localeCompare(b.first_seen));

  const first = outlets[0];
  if (first === undefined) throw new Error('Cannot build propagation for an empty cluster');

  // Outlet count per capture time — the shape that becomes the story-river swimlane.
  const perTime = new Map<string, Set<string>>();
  for (const record of cluster.records) {
    const bucket = perTime.get(record.captured_at);
    if (bucket === undefined) perTime.set(record.captured_at, new Set([record.source]));
    else bucket.add(record.source);
  }

  return {
    cluster_id: cluster.cluster_id,
    label: cluster.label,
    first_detected: { source: first.source, source_name: first.source_name, at: first.first_seen },
    outlets,
    coverage_timeline: [...perTime.entries()]
      .map(([at, sources]) => ({ at, outlet_count: sources.size }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    never_covered: knownSources.filter((source) => !bySource.has(source)).sort(),
  };
}

/**
 * Shannon entropy over which cluster each outlet is leading with, at one moment.
 *
 * High entropy means the front pages disagree about what matters; low means they have converged.
 * Plotted hourly it marks the moments worth scrubbing to — it turns "when should I look?" into a
 * guided tour, and it is arithmetic rather than judgement.
 */
export function leadDivergence(leadClusterIdByOutlet: ReadonlyMap<string, number>): number {
  const total = leadClusterIdByOutlet.size;
  if (total === 0) return 0;

  const counts = new Map<number, number>();
  for (const clusterId of leadClusterIdByOutlet.values()) {
    counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
