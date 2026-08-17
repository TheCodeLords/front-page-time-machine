import { z } from 'zod';

/**
 * The outlets we watch.
 *
 * Chosen for STRUCTURAL difference, not editorial balance — the point of the exercise is proving one
 * schema survives six unrelated layouts, and a set of look-alike homepages would prove nothing. The
 * edition is pinned on each because `bbc.com/news` and `bbc.co.uk/news`, or CNN US and CNN
 * International, are different front pages; leaving that to chance makes the time series drift
 * without ever looking wrong.
 */

export const OutletSchema = z.object({
  source: z.string().regex(/^[a-z0-9-]+$/),
  source_name: z.string().min(1),
  homepage_url: z.string().url(),
  /** Assigned by `brightdata scraper create`. Null until the collector exists. */
  collector_id: z.string().nullable(),
  notes: z.string().optional(),
});
export type Outlet = z.infer<typeof OutletSchema>;

export const OutletRegistrySchema = z.array(OutletSchema);

export const DEFAULT_OUTLETS: Outlet[] = [
  {
    source: 'npr',
    source_name: 'NPR',
    homepage_url: 'https://www.npr.org',
    collector_id: null,
    notes: 'Cleanest semantic HTML of the set — build and validate the collector here first.',
  },
  {
    source: 'bbc',
    source_name: 'BBC News',
    homepage_url: 'https://www.bbc.com/news',
    collector_id: null,
    notes: 'Dense card grid. Pin .com, not .co.uk — they are different front pages.',
  },
  {
    source: 'cnn',
    source_name: 'CNN',
    homepage_url: 'https://edition.cnn.com',
    collector_id: null,
    notes: 'Heavy JS zones. Edition pinned to International.',
  },
  {
    source: 'foxnews',
    source_name: 'Fox News',
    homepage_url: 'https://www.foxnews.com',
    collector_id: null,
    notes: 'Large lead slot above a classic list.',
  },
  {
    source: 'aljazeera',
    source_name: 'Al Jazeera',
    homepage_url: 'https://www.aljazeera.com',
    collector_id: null,
    notes: 'Different DOM idiom again — good stress test for one shared description.',
  },
  {
    source: 'guardian',
    source_name: 'The Guardian',
    homepage_url: 'https://www.theguardian.com/international',
    collector_id: null,
    notes: 'Very dense grid, many labelled sections. Edition pinned to International.',
  },
];

/** An outlet that can actually be captured — the collector exists. */
export type ReadyOutlet = Outlet & { collector_id: string };

/** Outlets with a collector attached. The type carries the guarantee, so callers cannot forget. */
export function readyOutlets(outlets: readonly Outlet[]): ReadyOutlet[] {
  return outlets.filter((outlet): outlet is ReadyOutlet => Boolean(outlet.collector_id));
}

/**
 * `FPTM_COLLECTORS="npr:c_abc,bbc:c_def"` overlays collector ids onto the registry.
 *
 * Ids live in the environment rather than in the committed registry so the repo stays publishable
 * and a rebuilt collector does not need a code change.
 */
export function applyCollectorEnv(
  outlets: readonly Outlet[],
  value: string | undefined = process.env['FPTM_COLLECTORS'],
): Outlet[] {
  if (value === undefined || value.trim() === '') return [...outlets];

  const assigned = new Map<string, string>();
  for (const pair of value.split(',')) {
    const [source, collectorId] = pair.split(':').map((part) => part.trim());
    if (source && collectorId) assigned.set(source, collectorId);
  }

  return outlets.map((outlet) => {
    const collectorId = assigned.get(outlet.source);
    return collectorId === undefined ? outlet : { ...outlet, collector_id: collectorId };
  });
}
