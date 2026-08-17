import { buildCapture } from '../../src/schema/normalize.js';
import type { CaptureDiagnostics } from '../../src/schema/normalize.js';
import type { CaptureSnapshot, RawStoryRecord } from '../../src/schema/story-snapshot.js';

/** Deterministic capture ids — tests must not depend on randomness. */
let counter = 0;
export function nextCaptureId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export interface MakeCaptureOptions {
  source?: string;
  sourceName?: string;
  capturedAt?: string;
  homepageUrl?: string;
  collectorId?: string;
}

export function makeCapture(
  raw: readonly RawStoryRecord[],
  options: MakeCaptureOptions = {},
): { snapshot: CaptureSnapshot; diagnostics: CaptureDiagnostics } {
  return buildCapture(
    raw,
    {
      source: options.source ?? 'npr',
      source_name: options.sourceName ?? 'NPR',
      homepage_url: options.homepageUrl ?? 'https://www.npr.org',
      captured_at: options.capturedAt ?? '2026-08-17T10:00:00.000Z',
      capture_id: nextCaptureId(),
    },
    { collector_id: options.collectorId ?? 'c_test', screenshot_path: null },
  );
}

/** `count` well-formed stories, each with a distinct URL. */
export function healthyStories(count: number, prefix = 'Story'): RawStoryRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    headline: `${prefix} ${index + 1}`,
    article_url: `/story/${prefix.toLowerCase().replace(/\s+/g, '-')}-${index + 1}`,
  }));
}
