import {
  prominenceTierForPosition,
  StorySnapshotRecordSchema,
  CaptureSnapshotSchema,
} from './story-snapshot.js';
import type {
  CaptureDiagnostics,
  CaptureSnapshot,
  RawStoryRecord,
  StorySnapshotRecord,
  StoryType,
} from './story-snapshot.js';
import { normalizeArticleUrl } from './url-normalize.js';

export { ProminenceTier, StoryType, CaptureDiagnosticsSchema } from './story-snapshot.js';
export type { CaptureDiagnostics } from './story-snapshot.js';

/**
 * Raw collector output -> the canonical contract.
 *
 * This module is the ONLY road between the two, which is what makes self-healing safe: a healed
 * collector may return a completely different raw shape, and as long as it still carries a headline
 * and a link, everything downstream is unaffected. Nothing here knows which publisher it is looking
 * at, and nothing here is allowed to.
 */

export interface CaptureContext {
  source: string;
  source_name: string;
  homepage_url: string;
  captured_at: string;
  capture_id: string;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Homepages are full of soft-wrapped and indented markup; collapse before deciding it is empty.
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/** Publishers label the same concept a dozen ways; match loosely, and admit `unknown` otherwise. */
function coerceStoryType(value: unknown): StoryType {
  const text = cleanText(value)?.toLowerCase();
  if (text === null || text === undefined) return 'unknown';
  if (text.includes('video') || text.includes('watch')) return 'video';
  if (text.includes('live')) return 'live';
  if (text.includes('update')) return 'update';
  if (text.includes('article') || text.includes('story')) return 'article';
  return 'unknown';
}

/**
 * Newsroom timezone abbreviations mapped to offsets.
 *
 * NPR stamps stories "7:54 AM ET", which `new Date()` cannot parse at all — the whole timestamp
 * becomes null. For the ambiguous civil abbreviations we take the daylight offset, which is right for
 * roughly two-thirds of the year and wrong by one hour otherwise. That error is bounded and
 * documented; discarding the publisher's own timestamp entirely is a bigger loss than an hour.
 */
const TIMEZONE_OFFSETS: Record<string, string> = {
  ET: '-04:00',
  EDT: '-04:00',
  EST: '-05:00',
  CT: '-05:00',
  CDT: '-05:00',
  CST: '-06:00',
  MT: '-06:00',
  MDT: '-06:00',
  MST: '-07:00',
  PT: '-07:00',
  PDT: '-07:00',
  PST: '-08:00',
  UTC: '+00:00',
  GMT: '+00:00',
  BST: '+01:00',
};

/** A homepage timestamp we cannot parse is worth less than an honest null. */
function coerceIsoDate(value: unknown): string | null {
  const text = cleanText(value);
  if (text === null) return null;

  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const zoneMatch = /\s([A-Z]{2,4})$/.exec(text);
  const abbreviation = zoneMatch?.[1];
  if (zoneMatch !== null && abbreviation !== undefined) {
    const offset = TIMEZONE_OFFSETS[abbreviation];
    if (offset !== undefined) {
      const retried = new Date(`${text.slice(0, zoneMatch.index)} ${offset}`);
      if (!Number.isNaN(retried.getTime())) return retried.toISOString();
    }
  }

  return null;
}

/**
 * A row reporting a failure upstream of extraction, rather than a story.
 *
 * Scraper Studio emits these in-band: the run "succeeds", and the rows read
 * `{input, error, error_code}`. We hit it on 2026-08-17 as
 * `proxy_error — "Your account exceeded the allowed rate limits"`, and the pipeline dutifully
 * reported "14/14 rows had an empty headline (100%)" — a perfect description of the symptom and a
 * completely misleading account of the cause.
 *
 * That distinction is worth real money. A headline-extraction verdict sends a heal prompt asking the
 * AI to fix selectors, which costs 15–30 minutes and cannot possibly work, because the collector was
 * never the problem. Counting these separately keeps a throttle, a blocked request or an upstream
 * outage from ever being mistaken for a broken scraper.
 */
export function isUpstreamErrorRow(raw: RawStoryRecord): boolean {
  const row = raw as Record<string, unknown>;
  const hasError = cleanText(row['error']) !== null || cleanText(row['error_code']) !== null;
  // Only when there is nothing story-like alongside it — a story that happens to carry an `error`
  // field is still a story, and discarding it would lose real data.
  return hasError && cleanText(raw.headline) === null && cleanText(raw.article_url) === null;
}

function coercePosition(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

/** Whether the collector supplied a usable rank of its own, as opposed to us falling back. */
export function hasExplicitPosition(raw: RawStoryRecord): boolean {
  return coercePosition(raw.position, 0) !== 0;
}

/**
 * House promotion, detected conservatively — and narrowed by adversarial review.
 *
 * A false positive here demotes a real story from the lead, which is worse than letting the
 * occasional promo through. The first draft matched bare imperatives ("listen live", "follow us",
 * "download the app") and a review panel demonstrated each demoting real journalism: NPR headlines
 * breaking coverage as "Listen live: …", and "Follow us into the tunnels beneath Gaza" is a story.
 * So the headline rule now requires the full self-referential ask ("sign up for/to …",
 * "subscribe to/for …"), and everything else leans on URLs: the live Guardian promos all resolve to
 * `/sign-up-to-the-hotspot`-style slugs or `/newsletters/` paths — publishers reserve those routes
 * for plumbing, which makes them a far safer signal than headline wording. "Newsletter" alone is
 * NOT a promo signal — "DOJ investigates newsletter startup" is news.
 */
const PROMO_HEADLINE = /^\s*(sign\s?up (for|to)\b|subscribe (to|for)\b|newsletter:)/i;
const PROMO_URL_PATH =
  /\/(newsletters?|subscribe|subscriptions?|account|support-us)([/?#]|$)|\/sign-?up(-|[/?#]|$)/i;

export function classifyContentKind(headline: string, articleUrl: string): 'editorial' | 'promo' {
  if (PROMO_HEADLINE.test(headline)) return 'promo';
  try {
    if (PROMO_URL_PATH.test(new URL(articleUrl).pathname)) return 'promo';
  } catch {
    // An unparseable URL cannot vote either way.
  }
  return 'editorial';
}

/**
 * Normalize one raw record. Returns `null` when the record cannot be a story.
 *
 * Rejection is not failure — homepages are full of nav links, ad slots and cookie banners, and a
 * collector will occasionally hand one over. Dropping them here is normal. `src/health/` is what
 * decides whether we are dropping SO many that extraction has actually broken.
 */
export function normalizeRecord(
  raw: RawStoryRecord,
  context: CaptureContext,
  fallbackPosition: number,
): StorySnapshotRecord | null {
  const headline = cleanText(raw.headline);
  if (headline === null) return null;

  const articleUrl = normalizeArticleUrl(raw.article_url, context.homepage_url);
  if (articleUrl === null) return null;

  // A link back to the homepage is the masthead or a "Home" tab, not a story. Compare normalized,
  // since the nav link and the page URL rarely match character-for-character.
  if (articleUrl === normalizeArticleUrl(context.homepage_url)) return null;

  const position = coercePosition(raw.position, fallbackPosition);

  return StorySnapshotRecordSchema.parse({
    source: context.source,
    source_name: context.source_name,
    captured_at: context.captured_at,
    capture_id: context.capture_id,
    section: cleanText(raw.section),
    headline,
    article_url: articleUrl,
    summary: cleanText(raw.summary),
    image_url: normalizeArticleUrl(raw.image_url, context.homepage_url),
    published_at: coerceIsoDate(raw.published_at),
    position,
    story_type: coerceStoryType(raw.story_type),
    is_lead: position === 1,
    prominence_tier: prominenceTierForPosition(position),
    content_kind: classifyContentKind(headline, articleUrl),
  });
}

/**
 * Normalize a whole capture: drop non-stories, collapse duplicate URLs to their most prominent
 * appearance, then re-rank 1..N.
 *
 * Re-ranking matters. A homepage links its lead story from the hero AND a sidebar rail, so raw
 * positions have holes once deduped — and a hole is exactly what the position-integrity health check
 * treats as extraction damage. Contiguous ranks keep that signal meaningful.
 */
export interface NormalizedCapture {
  records: StorySnapshotRecord[];
  diagnostics: CaptureDiagnostics;
}

/**
 * Normalize a whole capture: drop non-stories, collapse duplicate URLs to their most prominent
 * appearance, then re-rank 1..N.
 *
 * Re-ranking matters. A homepage links its lead story from the hero AND a sidebar rail, so raw
 * positions have holes once deduped — and a hole is exactly what the position-integrity health check
 * treats as extraction damage. Contiguous ranks keep that signal meaningful.
 */
export function normalizeCapture(
  rawRecords: readonly RawStoryRecord[],
  context: CaptureContext,
): NormalizedCapture {
  const bestByUrl = new Map<string, { record: StorySnapshotRecord; explicitPosition: boolean }>();
  const homepageUrl = normalizeArticleUrl(context.homepage_url);
  // The vocabulary is recorded from the rows as received (post-alias, so canonical names appear
  // alongside the originals they were mapped from — the originals are preserved by design, and
  // canonical presence tracks source presence, so drift in this set mirrors drift at the source).
  const vocabulary = new Set<string>();
  for (const raw of rawRecords) for (const key of Object.keys(raw)) vocabulary.add(key);

  const diagnostics: CaptureDiagnostics = {
    raw_count: rawRecords.length,
    rejected_no_headline: 0,
    rejected_no_url: 0,
    collapsed_duplicates: 0,
    rejected_self_link: 0,
    rejected_upstream_error: 0,
    raw_fields: [...vocabulary].sort((a, b) => a.localeCompare(b)),
    positions_from_collector: 0,
  };

  rawRecords.forEach((raw, index) => {
    // Counted first, and separately, because it is not an extraction failure at all.
    if (isUpstreamErrorRow(raw)) {
      diagnostics.rejected_upstream_error += 1;
      return;
    }

    // Attribute the rejection before delegating, so the counts say WHICH field failed.
    if (cleanText(raw.headline) === null) {
      diagnostics.rejected_no_headline += 1;
      return;
    }
    const candidateUrl = normalizeArticleUrl(raw.article_url, context.homepage_url);
    if (candidateUrl === null) {
      diagnostics.rejected_no_url += 1;
      return;
    }
    if (candidateUrl === homepageUrl) {
      diagnostics.rejected_self_link += 1;
      return;
    }

    const record = normalizeRecord(raw, context, index + 1);
    if (record === null) return;

    const existing = bestByUrl.get(record.article_url);
    if (existing !== undefined) diagnostics.collapsed_duplicates += 1;
    // First appearance wins: the hero placement is the one that reflects editorial intent.
    if (existing === undefined || record.position < existing.record.position) {
      bestByUrl.set(record.article_url, { record, explicitPosition: hasExplicitPosition(raw) });
    }
  });

  // The lead is the first EDITORIAL story, not merely rank 1: a newsletter signup card at the top
  // of the page keeps its rank (it really does occupy that slot) but must not become "the day's
  // most important story". If every record is a promo, rank 1 stays the lead — an honest fallback.
  const ranked = [...bestByUrl.values()].sort((a, b) => a.record.position - b.record.position);
  const leadIndex = Math.max(
    0,
    ranked.findIndex((entry) => entry.record.content_kind === 'editorial'),
  );
  // Counted over the SURVIVING records, not the raw rows: the field documents how many of this
  // capture's final ranks came from the collector, so duplicates collapsed away must not inflate it
  // past records.length — that would break the audit it exists to provide.
  diagnostics.positions_from_collector = ranked.filter((entry) => entry.explicitPosition).length;
  const records = ranked.map((entry, index) => {
    const position = index + 1;
    return {
      ...entry.record,
      position,
      is_lead: index === leadIndex,
      prominence_tier: prominenceTierForPosition(position),
    };
  });

  return { records, diagnostics };
}

/** Records only, for callers that do not need the rejection breakdown. */
export function normalizeRecords(
  rawRecords: readonly RawStoryRecord[],
  context: CaptureContext,
): StorySnapshotRecord[] {
  return normalizeCapture(rawRecords, context).records;
}

export interface CaptureMeta {
  collector_id: string;
  screenshot_path: string | null;
  /** The tick boundary this capture belongs to. Null for one-off manual captures. */
  scheduled_for?: string | null;
  /** When the collector returned. With `captured_at` (fetch start), bounds the observation. */
  capture_completed_at?: string | null;
}

/** Build a snapshot and keep the rejection breakdown that produced it. */
export function buildCapture(
  rawRecords: readonly RawStoryRecord[],
  context: CaptureContext,
  meta: CaptureMeta,
): { snapshot: CaptureSnapshot; diagnostics: CaptureDiagnostics } {
  const { records, diagnostics } = normalizeCapture(rawRecords, context);
  const snapshot = CaptureSnapshotSchema.parse({
    capture_id: context.capture_id,
    source: context.source,
    source_name: context.source_name,
    homepage_url: context.homepage_url,
    captured_at: context.captured_at,
    collector_id: meta.collector_id,
    screenshot_path: meta.screenshot_path,
    scheduled_for: meta.scheduled_for ?? null,
    capture_completed_at: meta.capture_completed_at ?? null,
    diagnostics,
    records,
  });
  return { snapshot, diagnostics };
}

export function buildCaptureSnapshot(
  rawRecords: readonly RawStoryRecord[],
  context: CaptureContext,
  meta: CaptureMeta,
): CaptureSnapshot {
  return buildCapture(rawRecords, context, meta).snapshot;
}
