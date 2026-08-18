import type { StorySnapshotRecord } from '../schema/story-snapshot.js';

/**
 * Group headlines from different outlets into one conceptual story.
 *
 * Deliberately deterministic. Three publishers describing one event ("Company X announces new AI
 * model" / "Company X unveils latest artificial intelligence system") share their rare words and
 * differ in their common ones, which token overlap captures well enough to be useful and — crucially
 * — reproducibly. A model would cluster better on the hard cases, but a demo whose grouping changes
 * between two runs of the same data cannot be tested, and cannot be trusted on stage.
 *
 * The seam for an LLM or embedding pass is `clusterStories`' signature: swap the similarity function,
 * keep everything downstream. Interpretation belongs here, never in the collector.
 */

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'from',
  'by',
  'with',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'has',
  'have',
  'had',
  'will',
  'would',
  'can',
  'could',
  'says',
  'say',
  'said',
  'after',
  'over',
  'into',
  'new',
  'more',
  'its',
  'his',
  'her',
  'their',
  'this',
  'that',
  'these',
  'those',
  'it',
  'he',
  'she',
  'they',
  'we',
  'you',
  'not',
  'no',
  'up',
  'out',
  'off',
  'down',
  'about',
  'than',
  'then',
  'now',
  'how',
  'why',
  'what',
  'who',
  'live',
  'latest',
  'breaking',
  'update',
  'updates',
  'watch',
  'video',
]);

/**
 * Fold a trailing plural so "rate cut" and "rates cuts" are the same two words.
 *
 * Found by the demo, not by theory: three outlets writing "cuts interest rates" / "rates cut" /
 * "interest rate cut" scored 0.571 against a 0.6 threshold and refused to cluster, purely on
 * singular-vs-plural. Two tokens were being counted as four. `ss` is left alone so "business" does
 * not become "busines".
 */
function foldPlural(token: string): string {
  if (token.length >= 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Content words only: lowercase, punctuation stripped, stopwords and short tokens removed. */
export function headlineTokens(headline: string): Set<string> {
  const tokens = headline
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map(foldPlural)
    .filter((token) => !STOPWORDS.has(token));
  return new Set(tokens);
}

/**
 * Containment rather than Jaccard: one outlet writes a six-word headline and another writes
 * eighteen, and Jaccard punishes that length gap even when the short headline is entirely contained
 * in the long one. Dividing by the smaller set asks the right question — "is one of these about the
 * same thing as the other" — instead of "are these the same length".
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export interface ClusterOptions {
  /** Containment above which two headlines are the same story. */
  threshold?: number;
  /** Overlap floor, so two short headlines cannot match on a single incidental word. */
  minSharedTokens?: number;
  /**
   * Hours within which two records may be compared by headline. Without a window, "Central bank
   * cuts interest rates" in week one merges with the same phrasing in week three — different
   * events, one cluster — and the pairwise pass is quadratic over the whole archive. Same-URL
   * identity ignores the window on purpose: a live blog running for days is genuinely one story.
   */
  windowHours?: number;
}

export const DEFAULT_CLUSTER_OPTIONS: Required<ClusterOptions> = {
  threshold: 0.6,
  minSharedTokens: 2,
  windowHours: 72,
};

export interface StoryCluster {
  cluster_id: number;
  /** The earliest-seen headline, used as a neutral label. Never a summary we wrote. */
  label: string;
  records: StorySnapshotRecord[];
  sources: string[];
  /**
   * How firmly this cluster hangs together, 0–1. A singleton is trivially 1. For groups it is the
   * weakest member's best link into the rest: each record's strongest tie to any other member
   * (same URL = 1, else headline containment), minimized across members. Deterministic like the
   * clustering itself — the point is that a judge can ask "how sure are you these are one story?"
   * and get a number derived from the same arithmetic that grouped them, not a vibe.
   */
  confidence: number;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root] ?? root;
    // Path compression: point every node on the walk directly at the root, so a long merge chain
    // is paid for once instead of on every subsequent find.
    let current = node;
    while (this.parent[current] !== root) {
      const next = this.parent[current] ?? root;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  }
}

/**
 * Single-link agglomerative clustering over headline containment.
 *
 * Records are processed in a stable order (captured_at, then source, then position) so the same
 * input always yields the same cluster ids — which is what makes the propagation view reproducible
 * and the tests meaningful.
 */
export function clusterStories(
  records: readonly StorySnapshotRecord[],
  options: ClusterOptions = {},
): StoryCluster[] {
  const { threshold, minSharedTokens, windowHours } = { ...DEFAULT_CLUSTER_OPTIONS, ...options };
  const windowMs = windowHours * 3_600_000;

  const ordered = [...records].sort(
    (a, b) =>
      a.captured_at.localeCompare(b.captured_at) ||
      a.source.localeCompare(b.source) ||
      a.position - b.position,
  );
  const tokens = ordered.map((record) => headlineTokens(record.headline));
  const times = ordered.map((record) => new Date(record.captured_at).getTime());
  const unionFind = new UnionFind(ordered.length);

  // The same URL is the same story regardless of how the headline was rewritten — this is what
  // keeps an hourly-retitled live blog in one cluster instead of scattering it across the hour.
  // One map pass replaces the pairwise URL check, and it deliberately ignores the time window.
  const firstIndexByUrl = new Map<string, number>();
  ordered.forEach((record, index) => {
    const first = firstIndexByUrl.get(record.article_url);
    if (first === undefined) firstIndexByUrl.set(record.article_url, index);
    else unionFind.union(first, index);
  });

  // Headline comparison via an inverted index: a pair is only scored if it shares at least one
  // token, which is implied by the minSharedTokens >= 2 rule — so this prunes nothing that could
  // have matched, it just stops paying O(n²) for pairs with nothing in common. Measured before the
  // rewrite: 12k records took 17.5s and the cost compounded every capture; the archive-wide
  // all-pairs walk was the whole bill.
  const postings = new Map<string, number[]>();
  for (let i = 0; i < ordered.length; i += 1) {
    const left = tokens[i];
    const timeI = times[i];
    if (left === undefined || timeI === undefined) continue;

    const sharedCounts = new Map<number, number>();
    for (const token of left) {
      const posting = postings.get(token);
      if (posting === undefined) continue;
      for (const j of posting) sharedCounts.set(j, (sharedCounts.get(j) ?? 0) + 1);
    }

    // Ascending j keeps union order identical to the old pairwise loop, so cluster ids are stable.
    for (const j of [...sharedCounts.keys()].sort((a, b) => a - b)) {
      const shared = sharedCounts.get(j) ?? 0;
      const right = tokens[j];
      const timeJ = times[j];
      if (right === undefined || timeJ === undefined) continue;
      if (Math.abs(timeI - timeJ) > windowMs) continue;
      if (shared >= minSharedTokens && similarity(right, left) >= threshold) {
        unionFind.union(j, i);
      }
    }

    for (const token of left) {
      const posting = postings.get(token);
      if (posting === undefined) postings.set(token, [i]);
      else posting.push(i);
    }
  }

  const groups = new Map<number, number[]>();
  ordered.forEach((_, index) => {
    const root = unionFind.find(index);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [index]);
    else group.push(index);
  });

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, memberIndexes], clusterIndex) => {
      const members = memberIndexes
        .map((i) => ordered[i])
        .filter((r): r is StorySnapshotRecord => r !== undefined);
      return {
        cluster_id: clusterIndex + 1,
        label: members[0]?.headline ?? '',
        records: members,
        sources: [...new Set(members.map((record) => record.source))].sort(),
        confidence: clusterConfidence(memberIndexes, ordered, tokens),
      };
    });
}

/** The weakest member's best link into the cluster. See `StoryCluster.confidence`. */
function clusterConfidence(
  memberIndexes: readonly number[],
  ordered: readonly StorySnapshotRecord[],
  tokens: readonly Set<string>[],
): number {
  if (memberIndexes.length <= 1) return 1;
  let weakest = 1;
  for (const i of memberIndexes) {
    let best = 0;
    for (const j of memberIndexes) {
      if (i === j) continue;
      if (ordered[i]?.article_url === ordered[j]?.article_url) {
        best = 1;
        break;
      }
      const left = tokens[i];
      const right = tokens[j];
      if (left !== undefined && right !== undefined) best = Math.max(best, similarity(left, right));
    }
    weakest = Math.min(weakest, best);
  }
  return Math.round(weakest * 100) / 100;
}
