/**
 * Map whatever a collector called its fields onto our canonical names.
 *
 * Found the hard way, against live data. The first working NPR collector returned `product_page_url`
 * rather than `article_url`, split the timestamp across `publish_date` and `publish_time`, and did
 * not emit `position` at all. Every row would have been rejected as "no usable link" and health would
 * have reported a total extraction failure — a scraper that worked perfectly, misread as broken.
 *
 * This is the same problem self-healing solves, one layer up: collectors are AI-generated, so their
 * output vocabulary drifts between outlets and between heals, while our contract must not. Asking the
 * description for exact field names helps but cannot be relied on, because a heal regenerates the
 * template and may rename fields again. So we adapt here rather than trust there.
 */

/** Candidate source keys per canonical field, most specific first. Matched case-insensitively. */
const ALIASES = {
  headline: ['headline', 'title', 'story_title', 'heading', 'name', 'text'],
  article_url: [
    'article_url',
    'product_page_url',
    'story_url',
    'page_url',
    'link_url',
    'url',
    'link',
    'href',
    'permalink',
  ],
  section: ['section', 'section_name', 'category', 'topic', 'kicker', 'label'],
  summary: ['summary', 'description', 'teaser', 'standfirst', 'excerpt', 'snippet', 'dek', 'blurb'],
  image_url: ['image_url', 'thumbnail_url', 'thumbnail', 'image', 'photo_url', 'img_url', 'img'],
  published_at: [
    'published_at',
    'publish_date',
    'published_date',
    'pub_date',
    'date_published',
    'timestamp',
    'published',
    'date',
  ],
  story_type: ['story_type', 'content_type', 'media_type', 'type', 'format'],
  position: ['position', 'rank', 'order', 'index'],
} as const satisfies Record<string, readonly string[]>;

/** Time components a collector split off from the date, appended when both are present. */
const TIME_ALIASES = ['publish_time', 'published_time', 'time'];

/**
 * Whether a raw field name is one this adapter would feed into canonical data.
 *
 * Used by the drift signal to separate consequential vocabulary loss from cosmetic churn: a raw
 * field disappearing matters when it was supplying a canonical column, and is merely worth
 * recording when it was ballast the aliases never read.
 */
const KNOWN_ALIAS_NAMES = new Set<string>(
  [...Object.values(ALIASES).flat(), ...TIME_ALIASES].map((name) => name.toLowerCase()),
);

export function isAliasKnown(fieldName: string): boolean {
  return KNOWN_ALIAS_NAMES.has(fieldName.toLowerCase());
}

function lowerKeyIndex(row: Record<string, unknown>): Map<string, unknown> {
  const index = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    // First writer wins, so an exact-case canonical key is never shadowed by a later variant.
    if (!index.has(key.toLowerCase())) index.set(key.toLowerCase(), value);
  }
  return index;
}

function firstMatch(index: Map<string, unknown>, candidates: readonly string[]): unknown {
  for (const candidate of candidates) {
    const value = index.get(candidate);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** Scalars only: a collector that nests `{url: ...}` under a field would otherwise stringify to junk. */
function scalar(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null) {
    const nested =
      (value as Record<string, unknown>)['url'] ?? (value as Record<string, unknown>)['href'];
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

/**
 * Rewrite one raw row into canonical field names, keeping every original key alongside.
 *
 * Originals are preserved because they are evidence: when a heal is needed, knowing the collector
 * emitted `product_page_url` rather than nothing at all is the difference between "extraction broke"
 * and "extraction renamed a field".
 */
export function mapFieldAliases(row: Record<string, unknown>): Record<string, unknown> {
  const index = lowerKeyIndex(row);
  const mapped: Record<string, unknown> = { ...row };

  for (const [canonical, candidates] of Object.entries(ALIASES)) {
    const value = scalar(firstMatch(index, candidates));
    if (value !== undefined) mapped[canonical] = value;
  }

  // NPR's collector returned "August 16, 2026" and "7:54 AM ET" as separate fields. Joined they
  // parse; apart, the date loses its time and every story in a day collapses to midnight.
  const timePart = scalar(firstMatch(index, TIME_ALIASES));
  const datePart = mapped['published_at'];
  if (typeof datePart === 'string' && typeof timePart === 'string' && !datePart.includes(':')) {
    mapped['published_at'] = `${datePart} ${timePart}`;
  }

  return mapped;
}
