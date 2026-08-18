import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { mapFieldAliases } from '../schema/field-aliases.js';
import { RawStoryRecordSchema } from '../schema/story-snapshot.js';
import type { RawStoryRecord } from '../schema/story-snapshot.js';

/**
 * The only module that shells out to Bright Data.
 *
 * Everything above this line — normalization, health, diffing, clustering — is pure and offline, so
 * the entire pipeline is testable without a network or an API key. That boundary is also what keeps
 * Scraper Studio genuinely central rather than nominally central: extraction happens in the
 * collector, and this file does nothing but carry its output across.
 */

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Injected so tests never spawn a process. */
export type CommandRunner = (bin: string, args: readonly string[]) => Promise<CommandResult>;

/** The logical command name. Used for display and assertions; see `resolveExecutable` for the real one. */
export function brightDataBin(): string {
  return (
    process.env['FPTM_BRIGHTDATA_BIN'] ??
    (process.platform === 'win32' ? 'brightdata.cmd' : 'brightdata')
  );
}

/**
 * What we actually spawn.
 *
 * On Windows npm installs `brightdata.cmd`, and since the Node 20.12/18.20 security fix a `.cmd`
 * cannot be spawned without `shell: true` — it fails with `spawn EINVAL`. Turning the shell on would
 * push every argument through cmd.exe parsing, and one of those arguments is a generated heal prompt
 * containing arbitrary headline text, quotes included. That is a command-injection surface we have no
 * reason to open, so we locate the CLI's JS entry point and run it with this process's own node.
 */
export function resolveExecutable(): { command: string; prefixArgs: string[] } {
  const override = process.env['FPTM_BRIGHTDATA_BIN'];
  if (override !== undefined && override !== '') return { command: override, prefixArgs: [] };

  const jsOverride = process.env['FPTM_BRIGHTDATA_JS'];
  if (jsOverride !== undefined && jsOverride !== '') {
    return { command: process.execPath, prefixArgs: [jsOverride] };
  }

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData !== undefined) {
      const entry = path.join(
        appData,
        'npm',
        'node_modules',
        '@brightdata',
        'cli',
        'dist',
        'index.js',
      );
      if (existsSync(entry)) return { command: process.execPath, prefixArgs: [entry] };
    }
  }

  return { command: 'brightdata', prefixArgs: [] };
}

export const execRunner: CommandRunner = async (_bin, args) => {
  const { command, prefixArgs } = resolveExecutable();
  const { stdout, stderr } = await execFileAsync(command, [...prefixArgs, ...args], {
    // Homepage captures with 40+ stories and summaries comfortably exceed the 1MB default.
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
};

export interface BrightDataOptions {
  runner?: CommandRunner;
  /** Seconds. Generation and healing are slow by nature; runs are not. */
  timeoutSeconds?: number;
}

/**
 * Pull the JSON payload out of CLI stdout.
 *
 * `--json` is supposed to make stdout pure JSON, but the CLI also emits progress lines and, on some
 * paths, a trailing note. Locating the outermost JSON value is more robust than trusting the whole
 * buffer to parse, and a scrape that succeeded should not be discarded over a stray banner line.
 */
export function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') throw new Error('Bright Data CLI returned no output');
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to line scanning.
  }

  // The payload lands at the END of stdout, after any progress lines — so walk lines from the
  // bottom and parse from the first JSON-looking line to the end. This is what keeps a progress
  // line like "[12:00] fetching…" ahead of the payload from anchoring the naive first-bracket scan
  // on a timestamp and poisoning the slice.
  const lines = trimmed.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (!line.startsWith('[') && !line.startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(index).join('\n'));
    } catch {
      // Not the payload start — keep walking up.
    }
  }

  // Bracket-scan fallback for payloads with trailing chatter. Successive opening brackets are
  // tried rather than trusting the first one blindly — "[12:00] fetching…" ahead of the payload
  // is an opening bracket too, and anchoring on it used to poison the slice.
  let start = -1;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const nextArray = trimmed.indexOf('[', start + 1);
    const nextObject = trimmed.indexOf('{', start + 1);
    const candidates = [nextArray, nextObject].filter((index) => index >= 0);
    if (candidates.length === 0) break;
    start = Math.min(...candidates);

    const closer = trimmed[start] === '[' ? ']' : '}';
    const end = trimmed.lastIndexOf(closer);
    if (end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // A false anchor — advance to the next opening bracket.
    }
  }
  throw new Error(`No JSON found in CLI output: ${trimmed.slice(0, 200)}`);
}

/**
 * Coerce whatever the collector returned into a row list.
 *
 * Scraper Studio collectors are AI-generated per outlet, so the envelope is not guaranteed: some
 * return a bare array, some wrap it. Guessing wrong here would look exactly like extraction failure
 * to the health module, so we accept every shape we have seen rather than let a wrapper key cause a
 * false alarm.
 */
/** Enough to be a story: something to link to, or something to call it. */
const STORY_KEYS = [
  'headline',
  'title',
  'article_url',
  'product_page_url',
  'story_url',
  'url',
  'link',
];

/** The keys that name a story. A container never has one; a story almost always does. */
const HEADLINE_KEYS = ['headline', 'title', 'story_title', 'heading'];

function keysOf(value: unknown): Set<string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return new Set(Object.keys(value).map((key) => key.toLowerCase()));
}

function looksLikeStory(value: unknown): boolean {
  const keys = keysOf(value);
  return keys !== null && STORY_KEYS.some((candidate) => keys.has(candidate));
}

function hasOwnHeadline(value: unknown): boolean {
  const keys = keysOf(value);
  return keys !== null && HEADLINE_KEYS.some((candidate) => keys.has(candidate));
}

/**
 * Unwrap rows that carry their stories in a nested array.
 *
 * The BBC collector returns rows shaped `{news_stories: [ ...real stories... ], product_page_url,
 * input}` — the extraction is correct and the inner field names are already canonical, but each row
 * reads as one headline-less story. Left alone, 105 good stories scored as a total extraction
 * failure and healing would have "fixed" a collector that was never broken.
 *
 * The rule is that a headline is what makes a row a story. A container does not have one, so a row
 * with its own headline is never unwrapped no matter what it contains. That distinction is load
 * bearing: real NPR rows carry a `related_stories: [{headline, url}]` sidebar, and an
 * unwrap-array-first version of this function threw away each actual story and promoted its "related"
 * link in its place. The row counts still matched, so only an assertion on the text caught it.
 */
export function flattenNestedRows(rows: readonly unknown[]): unknown[] {
  const flattened: unknown[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;

    if (hasOwnHeadline(row)) {
      flattened.push(row);
      continue;
    }

    let unwrapped = false;
    for (const value of Object.values(row as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > 0 && value.every(looksLikeStory)) {
        flattened.push(...value);
        unwrapped = true;
      }
    }
    if (unwrapped) continue;

    // Keep an unrecognised row rather than dropping it: normalization rejects it honestly, and the
    // rejection shows up in diagnostics instead of vanishing before anything can count it.
    flattened.push(row);
  }

  return flattened;
}

export function toRawRecords(payload: unknown): RawStoryRecord[] {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? ((payload as Record<string, unknown>)['data'] ??
        (payload as Record<string, unknown>)['results'] ??
        (payload as Record<string, unknown>)['records'])
      : undefined;

  if (!Array.isArray(rows)) return [];

  const records: RawStoryRecord[] = [];
  for (const row of flattenNestedRows(rows)) {
    if (typeof row !== 'object' || row === null) continue;
    // Alias-map BEFORE validating: the live NPR collector named its link `product_page_url`, and
    // without this every row fails as "no usable link" — a working scraper misread as a dead one.
    const parsed = RawStoryRecordSchema.safeParse(mapFieldAliases(row as Record<string, unknown>));
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

/** `brightdata scraper run <collector_id> <url> --json` */
export async function runCollector(
  collectorId: string,
  url: string,
  options: BrightDataOptions = {},
): Promise<RawStoryRecord[]> {
  const runner = options.runner ?? execRunner;
  const args = ['scraper', 'run', collectorId, url, '--json'];
  if (options.timeoutSeconds !== undefined) args.push('--timeout', String(options.timeoutSeconds));
  const { stdout } = await runner(brightDataBin(), args);
  return toRawRecords(extractJson(stdout));
}

/**
 * `brightdata scrape <url> -f screenshot -o <path>`
 *
 * Deliberately the Unlocker path, not `brightdata browser screenshot`: Unlocker is covered by the
 * free/promo credit pool at 1 credit per request and captures the full scrollable page, while the
 * Browser API bills separately. Same receipts, no extra spend.
 */
export async function captureScreenshot(
  url: string,
  outputPath: string,
  options: BrightDataOptions = {},
): Promise<string> {
  const runner = options.runner ?? execRunner;
  await runner(brightDataBin(), ['scrape', url, '-f', 'screenshot', '-o', outputPath]);
  return outputPath;
}

export interface HealEnvelope {
  collector_id: string;
  status: string;
  preview_result?: unknown;
  diff_summary?: string;
  view_url?: string;
  next_step?: string;
  error?: string;
}

/**
 * `brightdata scraper heal <collector_id> "<prompt>"`
 *
 * Stops at the approval gate by design. `status: "awaiting_approval"` is a SUCCESS — the fix is
 * ready and waiting on a decision — and a failed heal is non-destructive, leaving the previous
 * collector working. Callers must not treat either as an outage.
 */
export async function healCollector(
  collectorId: string,
  prompt: string,
  url: string,
  options: BrightDataOptions & { autoApprove?: boolean } = {},
): Promise<HealEnvelope> {
  const runner = options.runner ?? execRunner;
  const args = ['scraper', 'heal', collectorId, prompt, '--url', url, '--json'];
  if (options.autoApprove === true) args.push('--auto-approve');
  if (options.timeoutSeconds !== undefined) args.push('--timeout', String(options.timeoutSeconds));
  const { stdout } = await runner(brightDataBin(), args);
  return extractJson(stdout) as HealEnvelope;
}

/** `brightdata scraper approve <collector_id>` — commits or rejects a pending heal. */
export async function approveHeal(
  collectorId: string,
  url: string,
  options: BrightDataOptions & { reject?: boolean } = {},
): Promise<HealEnvelope> {
  const runner = options.runner ?? execRunner;
  const args = ['scraper', 'approve', collectorId, '--url', url, '--json'];
  if (options.reject === true) args.push('--reject');
  const { stdout } = await runner(brightDataBin(), args);
  return extractJson(stdout) as HealEnvelope;
}
