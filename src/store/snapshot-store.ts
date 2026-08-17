import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CaptureSnapshotSchema } from '../schema/story-snapshot.js';
import type { CaptureSnapshot } from '../schema/story-snapshot.js';

/**
 * Append-only capture store.
 *
 * Layout: `<root>/<source>/<YYYY-MM-DD>.ndjson`, one JSON line per capture.
 *
 * Deliberately a filesystem, not a database. A week of six outlets at hourly cadence is ~1,000
 * captures — a scale where a database buys nothing and costs a service to run during a demo. NDJSON
 * also means a capture is appended with a single write and never rewritten, so a crash mid-run can
 * cost at most the line in flight, never the history behind it. That history is irreplaceable: we
 * cannot re-fetch what a homepage said three hours ago.
 */

export interface StoreOptions {
  rootDir: string;
}

/** Captures bucket by UTC day regardless of the offset in `captured_at`, so days never interleave. */
export function utcDateKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new Error(`Unparseable timestamp: ${isoTimestamp}`);
  return date.toISOString().slice(0, 10);
}

export function captureFilePath(
  source: string,
  isoTimestamp: string,
  options: StoreOptions,
): string {
  return path.join(options.rootDir, source, `${utcDateKey(isoTimestamp)}.ndjson`);
}

/** Append one capture. Returns the file it landed in. */
export async function appendCapture(
  snapshot: CaptureSnapshot,
  options: StoreOptions,
): Promise<string> {
  const filePath = captureFilePath(snapshot.source, snapshot.captured_at, options);
  await mkdir(path.dirname(filePath), { recursive: true });
  // One line, one write. JSON.stringify cannot emit a raw newline, so lines never split.
  await appendFile(filePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  return filePath;
}

/**
 * Read one day's captures for a source, oldest first.
 *
 * A malformed line is skipped rather than thrown. A truncated final line from an interrupted write
 * must not make the surrounding week unreadable — losing one capture is recoverable, losing the
 * archive is not.
 */
export async function readCapturesForDate(
  source: string,
  date: string,
  options: StoreOptions,
): Promise<CaptureSnapshot[]> {
  const filePath = path.join(options.rootDir, source, `${date}.ndjson`);
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const captures: CaptureSnapshot[] = [];
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    try {
      captures.push(CaptureSnapshotSchema.parse(JSON.parse(line)));
    } catch {
      continue;
    }
  }
  return captures.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

/** UTC dates that have captures for this source, oldest first. */
export async function listCaptureDates(source: string, options: StoreOptions): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(options.rootDir, source));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => name.slice(0, -'.ndjson'.length))
    .sort();
}

/**
 * The most recent `limit` captures for a source, oldest first.
 *
 * This is what `src/health/` compares against: the trailing window that turns "42 stories" into
 * "42 stories, against a normal of 41" — the difference between a threshold and a guess. Walks days
 * backwards so a long archive costs only the files it actually needs.
 */
export async function readRecentCaptures(
  source: string,
  limit: number,
  options: StoreOptions,
): Promise<CaptureSnapshot[]> {
  if (limit <= 0) return [];
  const dates = await listCaptureDates(source, options);
  const collected: CaptureSnapshot[] = [];

  for (const date of [...dates].reverse()) {
    const dayCaptures = await readCapturesForDate(source, date, options);
    collected.unshift(...dayCaptures);
    if (collected.length >= limit) break;
  }

  return collected.slice(-limit);
}
