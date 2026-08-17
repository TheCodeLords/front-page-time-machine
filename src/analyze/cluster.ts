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
}

export const DEFAULT_CLUSTER_OPTIONS: Required<ClusterOptions> = {
  threshold: 0.6,
  minSharedTokens: 2,
};

export interface StoryCluster {
  cluster_id: number;
  /** The earliest-seen headline, used as a neutral label. Never a summary we wrote. */
  label: string;
  records: StorySnapshotRecord[];
  sources: string[];
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root] ?? root;
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
  const { threshold, minSharedTokens } = { ...DEFAULT_CLUSTER_OPTIONS, ...options };

  const ordered = [...records].sort(
    (a, b) =>
      a.captured_at.localeCompare(b.captured_at) ||
      a.source.localeCompare(b.source) ||
      a.position - b.position,
  );
  const tokens = ordered.map((record) => headlineTokens(record.headline));
  const unionFind = new UnionFind(ordered.length);

  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const left = tokens[i];
      const right = tokens[j];
      if (left === undefined || right === undefined) continue;

      // The same URL is the same story regardless of how the headline was rewritten — this is what
      // keeps an hourly-retitled live blog in one cluster instead of scattering it across the hour.
      const sameUrl = ordered[i]?.article_url === ordered[j]?.article_url;
      if (sameUrl) {
        unionFind.union(i, j);
        continue;
      }

      let shared = 0;
      for (const token of left) if (right.has(token)) shared += 1;
      if (shared >= minSharedTokens && similarity(left, right) >= threshold) {
        unionFind.union(i, j);
      }
    }
  }

  const groups = new Map<number, StorySnapshotRecord[]>();
  ordered.forEach((record, index) => {
    const root = unionFind.find(index);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [record]);
    else group.push(record);
  });

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, members], index) => ({
      cluster_id: index + 1,
      label: members[0]?.headline ?? '',
      records: members,
      sources: [...new Set(members.map((record) => record.source))].sort(),
    }));
}
