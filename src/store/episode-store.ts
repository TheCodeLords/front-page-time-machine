import { mkdir, readFile, appendFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HealEpisode } from '../heal/episode.js';

/**
 * The repair ledger: every heal episode, persisted append-only beside the snapshots.
 *
 * Until this existed, the evidence that self-healing works lived in a README narrative — three real
 * heals, described in prose. A narrative cannot be queried, graphed, or put on the timeline. The
 * ledger makes repairs a first-class dataset with the same discipline as the archive itself:
 * one line per episode, appended, never rewritten. `fptm timeline` reads it to draw the collector
 * breaking and being repaired on the same axis as the news it was collecting.
 */

export interface EpisodeStoreOptions {
  /** Defaults to `episodes` under the working directory. */
  rootDir?: string;
}

const DEFAULT_ROOT = 'episodes';

/**
 * Permissive on read, exactly like the snapshot store: an episode written by an older version of
 * the code must never be silently deleted by a newer schema. Core fields only; the rest passes
 * through.
 */
export const EpisodeRecordSchema = z
  .object({
    source: z.string().min(1),
    source_name: z.string().min(1),
    collector_id: z.string().min(1),
    detected_at: z.string().min(1),
    state: z.string().min(1),
    prompt: z.string(),
    stories_before: z.number(),
    stories_after: z.number().nullable(),
    approved: z.boolean(),
    resolved_at: z.string().nullable(),
    error: z.string().nullable(),
  })
  .passthrough();
export type EpisodeRecord = z.infer<typeof EpisodeRecordSchema>;

export function episodeFilePath(source: string, options: EpisodeStoreOptions = {}): string {
  return path.join(options.rootDir ?? DEFAULT_ROOT, `${source}.ndjson`);
}

/** Append one episode. The trigger report is dropped — its numbers already live in the prompt. */
export async function appendEpisode(
  episode: HealEpisode,
  options: EpisodeStoreOptions = {},
): Promise<string> {
  const filePath = episodeFilePath(episode.source, options);
  await mkdir(path.dirname(filePath), { recursive: true });

  const { trigger: _trigger, ...persisted } = episode;
  await appendFile(filePath, `${JSON.stringify(persisted)}\n`, 'utf8');
  return filePath;
}

/** All episodes for one source, oldest first. Malformed lines are skipped, never fatal. */
export async function readEpisodes(
  source: string,
  options: EpisodeStoreOptions = {},
): Promise<EpisodeRecord[]> {
  let raw: string;
  try {
    raw = await readFile(episodeFilePath(source, options), 'utf8');
  } catch {
    return [];
  }

  const episodes: EpisodeRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = EpisodeRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) episodes.push(parsed.data);
    } catch {
      // A truncated line from an interrupted write costs that line, not the ledger.
    }
  }
  return episodes.sort((a, b) => a.detected_at.localeCompare(b.detected_at));
}

/** Every source that has ever recorded an episode. */
export async function listEpisodeSources(options: EpisodeStoreOptions = {}): Promise<string[]> {
  try {
    const entries = await readdir(options.rootDir ?? DEFAULT_ROOT);
    return entries
      .filter((name) => name.endsWith('.ndjson'))
      .map((name) => name.slice(0, -'.ndjson'.length))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
