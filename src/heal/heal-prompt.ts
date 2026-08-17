import { failingSignals } from '../health/health.js';
import type { HealthReport } from '../health/health.js';

/**
 * Turn a health report into a repair instruction.
 *
 * The point of generating this rather than hand-writing it: the prompt carries the actual numbers
 * from the actual failure. "38 of 41 rows had an empty headline while article_url stayed populated"
 * tells the AI flow where to look. "The scraper is broken" does not. The CLI is explicit that it
 * never decides a scraper has failed — we do — so this function is the whole detector-to-repair
 * handoff, and it is deterministic and testable.
 */

/** Hard API limit on `scraper heal`. Exceeding it fails the request outright, so we enforce it. */
export const HEAL_PROMPT_MAX = 1000;

/** The contract the healed collector must still satisfy. Named explicitly so a heal cannot drift. */
const REQUIRED_FIELDS =
  'headline, article_url, section, summary, image_url, published_at, story_type, position';

function truncateTo(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut on a word boundary where possible so the instruction does not end mid-token.
  const clipped = text.slice(0, max - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}.`;
}

export function buildHealPrompt(report: HealthReport, homepageUrl: string): string {
  const failing = failingSignals(report);
  const overExtracting = failing.some((signal) => signal.name === 'over_extraction');
  const healthy = report.signals.filter(
    (signal) =>
      signal.severity === 'ok' &&
      // During an over-extraction, `story_count` grades ok (the count is not LOW) — but listing it
      // under "still working" would tell the AI the count is fine in the same prompt that complains
      // there are too many rows. One report, two contradictory instructions; drop the misleading one.
      !(overExtracting && signal.name === 'story_count'),
  );

  const problem =
    failing.length > 0
      ? failing.map((signal) => signal.detail).join('; ')
      : `story extraction returned ${report.story_count} stories`;

  // What still WORKS is diagnostic gold: if URLs survive and headlines do not, the anchor is intact
  // and only the text node moved. Naming that narrows the search instead of inviting a rewrite.
  const stillWorking =
    healthy.length > 0 ? ` Still working: ${healthy.map((signal) => signal.name).join(', ')}.` : '';

  // The default framing is RECALL — "every story card must yield…" — which is exactly the wrong
  // medicine for over-extraction, where the collector is already reading too much of the page. Feed
  // that prompt to an over-extractor and the heal makes the disease worse. Precision framing instead:
  // narrow the scope, keep the fields.
  const essential = overExtracting
    ? `The homepage scraper for ${homepageUrl} is extracting too much: ${problem}. ` +
      `Restrict extraction to editorial story promos on the front page only — exclude navigation ` +
      `menus, section rails, footers, tickers and recirculation links. Keep these exact output ` +
      `fields: ${REQUIRED_FIELDS}. Do not rename, add or drop output fields.`
    : `The homepage scraper for ${homepageUrl} is returning bad data: ${problem}. ` +
      `Fix the extraction so every story card on the page yields all of these fields, ` +
      `with these exact names: ${REQUIRED_FIELDS}. Do not rename, add or drop output fields.`;

  const optional =
    `${stillWorking} Locate stories by their semantic role on the page — a prominent link ` +
    `introducing a news item — not by CSS class names or style hashes, which change on every redesign.`;

  const full = `${essential}${optional}`;
  if (full.length <= HEAL_PROMPT_MAX) return full;
  // Shed the guidance before the instruction: a prompt that loses "keep the field names" is worse
  // than one that loses the advice about class names.
  if (essential.length <= HEAL_PROMPT_MAX) return essential;
  return truncateTo(essential, HEAL_PROMPT_MAX);
}
