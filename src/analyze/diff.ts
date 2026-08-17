import type { CaptureSnapshot, StorySnapshotRecord } from '../schema/story-snapshot.js';

/**
 * What changed on one front page between two captures.
 *
 * This is the smallest thing that is already a product: "BBC added 3 stories, dropped 2, and moved
 * Story X from rank 8 to rank 2" is the sentence the whole timeline is built out of. It is pure
 * set arithmetic over URLs — no interpretation, no model, no opinion.
 */

export interface StoryChange {
  article_url: string;
  headline: string;
  previous_position: number | null;
  current_position: number | null;
}

/**
 * A story whose URL stayed fixed while its headline was rewritten.
 *
 * This is the signal that justifies URL-keyed identity in the first place. Live blogs and developing
 * stories re-title themselves hourly against one URL, and that churn is editorial attention made
 * visible — a story being actively reworked. Headline-keyed dedupe would have thrown it away.
 */
export interface HeadlineRewrite {
  article_url: string;
  previous_headline: string;
  current_headline: string;
  position: number;
}

export interface SnapshotDiff {
  source: string;
  source_name: string;
  previous_captured_at: string;
  current_captured_at: string;
  added: StoryChange[];
  removed: StoryChange[];
  moved_up: StoryChange[];
  moved_down: StoryChange[];
  unchanged: StoryChange[];
  headline_rewrites: HeadlineRewrite[];
}

function toChange(
  record: StorySnapshotRecord,
  previousPosition: number | null,
  currentPosition: number | null,
): StoryChange {
  return {
    article_url: record.article_url,
    headline: record.headline,
    previous_position: previousPosition,
    current_position: currentPosition,
  };
}

function byUrl(records: readonly StorySnapshotRecord[]): Map<string, StorySnapshotRecord> {
  return new Map(records.map((record) => [record.article_url, record]));
}

/** Diff two captures of the SAME source. Ordering of arguments is (older, newer). */
export function diffCaptures(previous: CaptureSnapshot, current: CaptureSnapshot): SnapshotDiff {
  if (previous.source !== current.source) {
    throw new Error(
      `Refusing to diff different sources: ${previous.source} vs ${current.source}. ` +
        'Cross-outlet comparison belongs in propagation analysis, not a snapshot diff.',
    );
  }

  const previousByUrl = byUrl(previous.records);
  const currentByUrl = byUrl(current.records);

  const added: StoryChange[] = [];
  const movedUp: StoryChange[] = [];
  const movedDown: StoryChange[] = [];
  const unchanged: StoryChange[] = [];
  const headlineRewrites: HeadlineRewrite[] = [];

  for (const record of current.records) {
    const before = previousByUrl.get(record.article_url);
    if (before === undefined) {
      added.push(toChange(record, null, record.position));
      continue;
    }

    if (before.headline !== record.headline) {
      headlineRewrites.push({
        article_url: record.article_url,
        previous_headline: before.headline,
        current_headline: record.headline,
        position: record.position,
      });
    }

    const change = toChange(record, before.position, record.position);
    // Lower rank number means more prominent, so a DECREASE is a promotion.
    if (record.position < before.position) movedUp.push(change);
    else if (record.position > before.position) movedDown.push(change);
    else unchanged.push(change);
  }

  const removed = previous.records
    .filter((record) => !currentByUrl.has(record.article_url))
    .map((record) => toChange(record, record.position, null));

  const byMovement = (a: StoryChange, b: StoryChange): number =>
    Math.abs((b.previous_position ?? 0) - (b.current_position ?? 0)) -
    Math.abs((a.previous_position ?? 0) - (a.current_position ?? 0));

  return {
    source: current.source,
    source_name: current.source_name,
    previous_captured_at: previous.captured_at,
    current_captured_at: current.captured_at,
    added: added.sort((a, b) => (a.current_position ?? 0) - (b.current_position ?? 0)),
    removed: removed.sort((a, b) => (a.previous_position ?? 0) - (b.previous_position ?? 0)),
    moved_up: movedUp.sort(byMovement),
    moved_down: movedDown.sort(byMovement),
    unchanged: unchanged.sort((a, b) => (a.current_position ?? 0) - (b.current_position ?? 0)),
    headline_rewrites: headlineRewrites,
  };
}

/** True when nothing at all changed — useful for collapsing quiet hours in the timeline. */
export function isQuiet(diff: SnapshotDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.moved_up.length === 0 &&
    diff.moved_down.length === 0 &&
    diff.headline_rewrites.length === 0
  );
}
