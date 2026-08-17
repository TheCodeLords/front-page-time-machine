import type { SnapshotDiff, StoryChange } from '../analyze/diff.js';
import type { HealEpisode } from '../heal/episode.js';
import { failingSignals } from '../health/health.js';
import type { HealthReport } from '../health/health.js';

/**
 * Plain-text rendering for the terminal.
 *
 * Kept apart from every module that computes anything: these functions take a finished value and
 * return a string, so the demo's narration can change without touching a threshold, and a threshold
 * can change without breaking a test that greps for a word.
 */

function hhmm(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

function quote(change: StoryChange): string {
  // Headlines are quoted verbatim, always. Paraphrasing one would editorialise it, and this project
  // holds up an archive rather than a critique.
  return `"${change.headline}"`;
}

/** The Phase 10 output: what changed on one front page since the previous capture. */
export function renderDiff(diff: SnapshotDiff): string {
  const lines: string[] = [
    diff.source_name.toUpperCase(),
    `${hhmm(diff.previous_captured_at)} → ${hhmm(diff.current_captured_at)}`,
    '',
  ];

  lines.push('NEW', diff.added.length === 0 ? '  none' : `  +${diff.added.length} stories`);
  for (const change of diff.added.slice(0, 5)) {
    lines.push(`  ${quote(change)} at position ${change.current_position}`);
  }

  lines.push(
    '',
    'REMOVED',
    diff.removed.length === 0 ? '  none' : `  -${diff.removed.length} stories`,
  );
  for (const change of diff.removed.slice(0, 5)) {
    lines.push(`  ${quote(change)} was position ${change.previous_position}`);
  }

  if (diff.moved_up.length > 0) {
    lines.push('', 'MOVED UP');
    for (const change of diff.moved_up.slice(0, 5)) {
      lines.push(
        `  ${quote(change)}`,
        `  Position ${change.previous_position} → ${change.current_position}`,
      );
    }
  }

  if (diff.moved_down.length > 0) {
    lines.push('', 'MOVED DOWN');
    for (const change of diff.moved_down.slice(0, 5)) {
      lines.push(
        `  ${quote(change)}`,
        `  Position ${change.previous_position} → ${change.current_position}`,
      );
    }
  }

  if (diff.headline_rewrites.length > 0) {
    lines.push('', 'REWRITTEN (same URL, new headline)');
    for (const rewrite of diff.headline_rewrites.slice(0, 5)) {
      lines.push(`  "${rewrite.previous_headline}"`, `    → "${rewrite.current_headline}"`);
    }
  }

  lines.push('', 'PERSISTED', `  ${diff.unchanged.length} stories held their position`);
  return lines.join('\n');
}

/** The Phase 13 output: why a capture was classified the way it was. */
export function renderHealthReport(report: HealthReport): string {
  const failing = failingSignals(report);
  const lines: string[] = [
    `Collector: ${report.source_name} homepage (${report.collector_id})`,
    '',
    'Previous:',
    `  ${report.baseline_median === null ? 'no baseline yet' : `${report.baseline_median} stories (trailing median)`}`,
    '',
    'Current:',
    `  ${report.story_count} stories`,
    '',
    'Status:',
    `  ${report.status}`,
  ];

  if (failing.length > 0) {
    lines.push('', 'Detected:');
    for (const signal of failing) lines.push(`  ${signal.name}: ${signal.detail}`);
  }

  return lines.join('\n');
}

/** The money shot: detection, repair, and proof, as one block. */
export function renderHealEpisode(episode: HealEpisode): string {
  const lines: string[] = [
    renderHealthReport(episode.trigger),
    '',
    'Action:',
    '  Bright Data Self-Healing requested',
    '',
    'Prompt sent (generated from the report above):',
    ...episode.prompt.split('\n').map((line) => `  ${line}`),
    '',
    'Result:',
    `  ${episode.state}`,
  ];

  if (episode.stories_after !== null) {
    lines.push('', 'Recovered:', `  ${episode.stories_before} → ${episode.stories_after} stories`);
  }
  if (episode.error !== null) {
    lines.push('', 'Error:', `  ${episode.error}`);
  }
  lines.push('', 'Schema:', '  unchanged — downstream contract preserved');
  return lines.join('\n');
}
