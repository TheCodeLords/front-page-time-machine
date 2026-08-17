/**
 * URL normalization — the identity function for a story.
 *
 * We dedupe by URL, never by headline text. Live blogs and developing stories rewrite their headline
 * every hour against a fixed URL; that churn is the most interesting signal we collect, and
 * headline-keyed dedupe would either destroy it or explode one story into twelve. The URL is the
 * only stable handle a publisher gives us.
 *
 * Which means normalization has to be aggressive: the SAME article linked from the hero module and
 * from a sidebar carries different campaign params, and un-normalized those look like two stories.
 */

/** Exact query keys that carry attribution, never identity. Compared case-insensitively. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ncid',
  'cmpid',
  'cmp',
  'ito',
  'smid',
  'smtyp',
  'partner',
  'ref',
  'referrer',
  'source',
  '__source',
  'intcmp',
  'icid',
  'guccounter',
]);

/**
 * Key prefixes that carry attribution. `at_` is BBC's, `ns_` is BBC News', `utm_` is everyone's,
 * `pk_`/`piwik_`/`matomo_` are Matomo's.
 */
const TRACKING_PREFIXES = ['utm_', 'at_', 'ns_', 'pk_', 'piwik_', 'matomo_', 'wt_', 'ga_'];

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Resolve, clean, and canonicalize an article URL.
 *
 * @param raw   href as the collector found it — may be relative, may be junk.
 * @param base  the homepage URL, used to resolve relative hrefs.
 * @returns the canonical absolute URL, or `null` if it is not a usable http(s) article link.
 */
export function normalizeArticleUrl(
  raw: string | null | undefined,
  base?: string | null,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // A bare fragment addresses a position on the CURRENT page, never a separate resource. It has to
  // be rejected before resolution, because `new URL('#main', base)` happily yields the base itself —
  // which would turn every "skip to content" link into a phantom lead story.
  if (trimmed.startsWith('#')) return null;

  // `mailto:`, `javascript:` and friends are navigation, not stories.
  let url: URL;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hostname = url.hostname.toLowerCase();
  // `www.` and the bare host serve the same article; collapsing them keeps one story as one story.
  if (url.hostname.startsWith('www.')) url.hostname = url.hostname.slice(4);

  // Fragments address a position on a page, not a different page.
  url.hash = '';

  // Snapshot the keys before deleting: mutating a live URLSearchParams iterator skips entries.
  const trackingKeys = [...url.searchParams.keys()].filter(isTrackingParam);
  for (const key of trackingKeys) url.searchParams.delete(key);
  // Sorted so two orderings of the same surviving params produce one identity, not two.
  url.searchParams.sort();

  // `/news/article-123/` and `/news/article-123` are one article. The root path keeps its slash.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}

/**
 * URLs appearing more than once in a capture, with their counts.
 *
 * A homepage legitimately links the same story twice (hero + section rail), so a low duplicate rate
 * is normal. A SPIKE is the signal — it usually means extraction collapsed onto one container and is
 * re-reading the same node. `src/health/` consumes this; it does not judge here.
 */
export function findDuplicateUrls(urls: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  for (const [url, count] of counts) {
    if (count < 2) counts.delete(url);
  }
  return counts;
}
