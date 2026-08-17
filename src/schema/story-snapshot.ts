import { z } from 'zod';

/**
 * The stable contract of Front Page Time Machine.
 *
 * Everything downstream — diffing, clustering, health, the timeline UI — depends on THIS shape and
 * nothing else. No publisher-specific field ever crosses this boundary. When a publisher redesigns
 * its homepage, the Scraper Studio extraction changes and this file does not. That invariant is the
 * whole point: `test/story-snapshot.spec.ts` asserts a healed collector still satisfies it.
 */

/** Distinguishable only where a publisher reliably signals it; `unknown` is honest, guessing is not. */
export const StoryType = z.enum(['article', 'video', 'live', 'update', 'unknown']);
export type StoryType = z.infer<typeof StoryType>;

/**
 * Ordinal prominence, bucketed. Deliberately NOT pixel- or font-size-derived: hero modules and type
 * scales are not comparable across outlets, so any visual score turns the methodology into the
 * argument. Rank within a single outlet's own page is a fact; "40px headline" is an opinion.
 */
export const ProminenceTier = z.enum(['lead', 'above_fold', 'below']);
export type ProminenceTier = z.infer<typeof ProminenceTier>;

/** Rank 1 is the lead; 2-5 stand in for above-the-fold; the rest is the tail. */
export const LEAD_RANK = 1;
export const ABOVE_FOLD_MAX_RANK = 5;

export function prominenceTierForPosition(position: number): ProminenceTier {
  if (position <= LEAD_RANK) return 'lead';
  if (position <= ABOVE_FOLD_MAX_RANK) return 'above_fold';
  return 'below';
}

const IsoDateTime = z.string().datetime({ offset: true });

/**
 * What a Scraper Studio collector may hand back — deliberately lenient.
 *
 * Collectors are AI-generated per outlet, so they return ragged data: relative URLs, empty strings
 * for a missing summary, absent keys entirely. Parsing that with the strict schema would throw away
 * a whole capture over one malformed row. Raw parses permissively; `normalizeRecord` is the only
 * road from here to canonical.
 */
export const RawStoryRecordSchema = z
  .object({
    headline: z.string().optional().nullable(),
    article_url: z.string().optional().nullable(),
    section: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    image_url: z.string().optional().nullable(),
    published_at: z.string().optional().nullable(),
    story_type: z.string().optional().nullable(),
    position: z.union([z.number(), z.string()]).optional().nullable(),
  })
  .passthrough();
export type RawStoryRecord = z.infer<typeof RawStoryRecordSchema>;

/** The canonical record. Strict by design — if it parses, downstream can trust every field. */
export const StorySnapshotRecordSchema = z.object({
  /** Stable outlet slug, e.g. `bbc`. Never a display name — those get rebranded. */
  source: z.string().regex(/^[a-z0-9-]+$/, 'source must be a lowercase slug'),
  source_name: z.string().min(1),
  /** When WE observed the homepage. Ours, and therefore authoritative. */
  captured_at: IsoDateTime,
  /** Groups every record from one homepage fetch, making snapshot diffs a set operation. */
  capture_id: z.string().uuid(),
  section: z.string().min(1).nullable(),
  /** Verbatim. Never paraphrased — paraphrasing a headline is editorialising it. */
  headline: z.string().min(1),
  /** Absolute and normalized. This, not the headline, is a story's identity. */
  article_url: z.string().url(),
  summary: z.string().min(1).nullable(),
  image_url: z.string().url().nullable(),
  /** The publisher's own timestamp, when exposed. Often absent on a homepage. */
  published_at: IsoDateTime.nullable(),
  position: z.number().int().positive(),
  story_type: StoryType,
  is_lead: z.boolean(),
  prominence_tier: ProminenceTier,
});
export type StorySnapshotRecord = z.infer<typeof StorySnapshotRecordSchema>;

/**
 * Why rows were discarded, counted as they were discarded.
 *
 * Lives on the snapshot because the strict record schema destroys the evidence: a row with no
 * headline never becomes a record, so a stored capture cannot otherwise say whether it holds three
 * stories because the news was quiet or because headline extraction collapsed. Persisting it means a
 * heal prompt written tomorrow is as specific as one written at capture time.
 */
export const CaptureDiagnosticsSchema = z.object({
  /** Rows the collector handed us, before any judgement. */
  raw_count: z.number().int().nonnegative(),
  rejected_no_headline: z.number().int().nonnegative(),
  rejected_no_url: z.number().int().nonnegative(),
  /** Rows that were real stories but pointed at a URL already seen in this capture. */
  collapsed_duplicates: z.number().int().nonnegative(),
  /** Rows whose link was the homepage itself — masthead and "Home" tabs. */
  rejected_self_link: z.number().int().nonnegative(),
  /**
   * Rows that carried an upstream error instead of a story.
   *
   * Defaulted rather than required, for the same reason `diagnostics` itself is nullable: making it
   * mandatory would fail validation on every capture already written, and `readCapturesForDate` skips
   * what fails to parse. A new field must never be able to delete history.
   */
  rejected_upstream_error: z.number().int().nonnegative().default(0),
  /**
   * The raw field vocabulary this capture arrived with — every distinct key across the collector's
   * rows, sorted. Recorded so drift is visible while the alias layer is busy absorbing it: a heal
   * that renames `author_name` to `author` produces identical canonical records, and without this
   * the rename is invisible until the day a rename lands on a field the aliases don't know.
   * Defaulted for the same reason as every other addition here: a new field must never be able to
   * delete history.
   */
  raw_fields: z.array(z.string()).default([]),
});
export type CaptureDiagnostics = z.infer<typeof CaptureDiagnosticsSchema>;

/** One homepage fetch: the envelope plus its records. This is what one NDJSON file holds. */
export const CaptureSnapshotSchema = z.object({
  capture_id: z.string().uuid(),
  source: z.string().regex(/^[a-z0-9-]+$/),
  source_name: z.string().min(1),
  homepage_url: z.string().url(),
  captured_at: IsoDateTime,
  /** The Scraper Studio collector that produced this. Kept so a heal is traceable to a capture. */
  collector_id: z.string().min(1),
  screenshot_path: z.string().min(1).nullable(),
  /**
   * Null on captures written before diagnostics were persisted.
   *
   * Nullable with a default rather than required, deliberately: `readCapturesForDate` skips lines
   * that fail validation, so making this mandatory would silently delete every capture already on
   * disk — destroying irreplaceable history to add a field. Old lines parse and read back as null.
   */
  diagnostics: CaptureDiagnosticsSchema.nullable().default(null),
  records: z.array(StorySnapshotRecordSchema),
});
export type CaptureSnapshot = z.infer<typeof CaptureSnapshotSchema>;
