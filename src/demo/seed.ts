import { buildCapture } from '../schema/normalize.js';
import type { CaptureDiagnostics } from '../schema/normalize.js';
import type { CaptureSnapshot, RawStoryRecord } from '../schema/story-snapshot.js';

/**
 * SYNTHETIC data, for exercising the pipeline before real history exists.
 *
 * Every consumer of this module must label its output as synthetic. The whole premise of the product
 * is that it is an archive of what outlets actually published, and quietly mixing invented headlines
 * into that archive would destroy the only thing it is for. This lives under `demo/`, writes to its
 * own store root, and the CLI prints a banner.
 */

export const DEMO_MARKER = 'SYNTHETIC DEMO DATA — not a real capture';

interface DemoOutlet {
  source: string;
  source_name: string;
  homepage_url: string;
}

export const DEMO_OUTLETS: DemoOutlet[] = [
  { source: 'bbc', source_name: 'BBC News', homepage_url: 'https://www.bbc.com/news' },
  { source: 'cnn', source_name: 'CNN', homepage_url: 'https://edition.cnn.com' },
  { source: 'npr', source_name: 'NPR', homepage_url: 'https://www.npr.org' },
  { source: 'foxnews', source_name: 'Fox News', homepage_url: 'https://www.foxnews.com' },
];

/** Per-outlet phrasings of the same event, so clustering has something real to do. */
interface DemoStory {
  slug: string;
  variants: Record<string, string>;
  /** Hour (UTC) at which each outlet first runs it. Absent outlet = never runs it. */
  firstHour: Record<string, number>;
  /** Hour at which each outlet drops it. */
  lastHour: Record<string, number>;
  /** Rank the outlet gives it, by hour offset from its first. */
  rank: Record<string, number[]>;
}

const STORIES: DemoStory[] = [
  {
    slug: 'rate-cut',
    variants: {
      bbc: 'Central bank cuts interest rates in surprise move',
      cnn: 'Interest rates cut by central bank in unexpected decision',
      npr: 'Central bank announces surprise interest rate cut',
    },
    firstHour: { bbc: 9, cnn: 10, npr: 10 },
    lastHour: { bbc: 16, cnn: 16, npr: 14 },
    rank: { bbc: [1, 1, 1, 1, 2, 2, 3, 4], cnn: [3, 1, 1, 1, 2, 3, 5], npr: [2, 1, 1, 4, 6] },
  },
  {
    slug: 'storm',
    variants: {
      bbc: 'Storm warning issued for the south coast',
      cnn: 'Severe storm warning issued along southern coastline',
      npr: 'Forecasters issue storm warning for southern coast',
      foxnews: 'Coastal storm warning issued as system approaches',
    },
    firstHour: { bbc: 8, cnn: 8, npr: 8, foxnews: 8 },
    lastHour: { bbc: 16, cnn: 16, npr: 16, foxnews: 16 },
    rank: {
      bbc: [2, 3, 4, 5, 5, 6, 6, 7, 8],
      // Kept clear of CNN's rate-cut and probe ranks: two stories claiming one slot makes "who led"
      // depend on sort stability, and "who led" is the claim the whole product rests on.
      cnn: [1, 2, 4, 5, 6, 7, 8, 9, 10],
      npr: [1, 3, 3, 5, 7, 8, 8, 9, 9],
      // Fox leads with the storm all day — the divergence the scrubber is built to show.
      foxnews: [1, 1, 1, 1, 1, 1, 1, 2, 2],
    },
  },
  {
    slug: 'election-probe',
    variants: {
      cnn: 'Investigators widen inquiry into campaign financing',
      foxnews: 'Campaign finance inquiry widens, officials confirm',
    },
    firstHour: { cnn: 12, foxnews: 13 },
    lastHour: { cnn: 16, foxnews: 16 },
    rank: { cnn: [4, 4, 5, 6, 7], foxnews: [3, 3, 4, 5] },
  },
];

/**
 * Distinct filler subjects.
 *
 * They have to be genuinely different from one another, and the first draft was not: filler titled
 * "BBC section story 1" and "CNN section story 1" share two of three content words, so the clusterer
 * correctly merged them and Scene 4 collapsed into one giant cluster. Real front pages do not carry
 * near-identical boilerplate headlines, so the fixture was lying about the input — but it is a fair
 * warning that containment matching is vulnerable to templated titles.
 */
const FILLER_SUBJECTS = [
  'City council approves transit budget',
  'Researchers map deep ocean currents',
  'Farmers report early harvest yields',
  'Museum reopens after long refurbishment',
  'Rail operators publish timetable changes',
  'Hospital trial expands screening programme',
  'Coastal towns invest in flood defences',
  'Universities widen apprenticeship intake',
  'Regulators publish energy market review',
  'Archaeologists date settlement remains',
  'Cyclists win new protected lane network',
  'Library service extends weekend opening',
  'Manufacturers report supply chain easing',
  'Wildlife survey counts returning otters',
  'Schools pilot later morning start times',
  'Housing scheme breaks ground downtown',
  'Vintners describe unusual growing season',
  'Ferry route resumes after dredging work',
  'Orchestra announces touring programme',
  'Startup opens laboratory in old mill',
  'Volunteers restore canal towpath',
  'Weather service upgrades radar network',
  'Bakers revive regional sourdough recipe',
  'Runners raise funds for air ambulance',
];

/**
 * Filler so each front page has realistic depth and health has a stable baseline.
 *
 * Most slots keep the SAME url hour to hour, and only the last two rotate. A real front page turns
 * over a few stories an hour, not all of them — and filler that churned completely would make every
 * diff read "+18 new, -18 removed", drowning the signal the scene exists to show.
 */
function filler(
  source: string,
  sourceIndex: number,
  hour: number,
  count: number,
  startRank: number,
): RawStoryRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const rotating = index >= count - 2;
    // Offsetting by outlet keeps two front pages from filling with the same subjects.
    const subject =
      FILLER_SUBJECTS[(sourceIndex * 7 + index + (rotating ? hour : 0)) % FILLER_SUBJECTS.length] ??
      'Local news roundup';
    const slug = rotating ? `hourly-${hour}-${index}` : `standing-${index}`;
    return {
      headline: subject,
      article_url: `https://${source}.example/filler/${slug}`,
      position: startRank + index,
      section: index % 2 === 0 ? 'World' : 'Business',
    };
  });
}

function rawFor(outlet: DemoOutlet, sourceIndex: number, hour: number): RawStoryRecord[] {
  const records: RawStoryRecord[] = [];

  for (const story of STORIES) {
    const first = story.firstHour[outlet.source];
    const last = story.lastHour[outlet.source];
    const headline = story.variants[outlet.source];
    if (first === undefined || last === undefined || headline === undefined) continue;
    if (hour < first || hour > last) continue;

    const rank = story.rank[outlet.source]?.[hour - first];
    if (rank === undefined) continue;

    records.push({
      headline,
      article_url: `https://${outlet.source}.example/story/${story.slug}`,
      position: rank,
      section: 'Top Stories',
      story_type: 'article',
    });
  }

  records.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const maxRank = records.reduce((acc, r) => Math.max(acc, Number(r.position ?? 0)), 0);
  return [...records, ...filler(outlet.source, sourceIndex, hour, 18, maxRank + 1)];
}

/**
 * NPR's collector breaks at 13:00 and 14:00 — headlines vanish while links survive, which is what a
 * real hero-module rename looks like — then recovers at 15:00 after a heal.
 */
function applyBreakage(outlet: DemoOutlet, hour: number, raw: RawStoryRecord[]): RawStoryRecord[] {
  if (outlet.source !== 'npr' || hour < 13 || hour > 14) return raw;
  return raw.map((record, index) => (index < 2 ? record : { ...record, headline: '' }));
}

export interface DemoCapture {
  snapshot: CaptureSnapshot;
  diagnostics: CaptureDiagnostics;
}

export const DEMO_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16];

/**
 * The story the demo narrates.
 *
 * Named explicitly rather than picked by a heuristic. Filler subjects legitimately repeat across
 * outlets — several papers really do run the same council-budget story — so "biggest cluster with a
 * blind spot" reliably selects filler over the story the script is about. A scripted demo is allowed
 * to say which story it is telling.
 */
export const DEMO_FEATURED_SLUG = 'rate-cut';

export function buildDemoCaptures(day = '2026-08-17'): DemoCapture[] {
  const captures: DemoCapture[] = [];
  let counter = 0;

  for (const hour of DEMO_HOURS) {
    for (const [sourceIndex, outlet] of DEMO_OUTLETS.entries()) {
      counter += 1;
      const capturedAt = `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
      captures.push(
        buildCapture(
          applyBreakage(outlet, hour, rawFor(outlet, sourceIndex, hour)),
          {
            source: outlet.source,
            source_name: outlet.source_name,
            homepage_url: outlet.homepage_url,
            captured_at: capturedAt,
            capture_id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
          },
          { collector_id: `c_demo_${outlet.source}`, screenshot_path: null },
        ),
      );
    }
  }

  return captures;
}
