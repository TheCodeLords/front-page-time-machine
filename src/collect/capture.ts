import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Outlet } from '../config/outlets.js';
import { computeHealth, DEFAULT_THRESHOLDS } from '../health/health.js';
import type { HealthReport, HealthThresholds } from '../health/health.js';
import { buildCapture } from '../schema/normalize.js';
import type { CaptureDiagnostics } from '../schema/normalize.js';
import type { CaptureSnapshot } from '../schema/story-snapshot.js';
import { appendCapture, readRecentCaptures } from '../store/snapshot-store.js';
import type { StoreOptions } from '../store/snapshot-store.js';
import { captureScreenshot, runCollector } from './brightdata.js';
import type { CommandRunner } from './brightdata.js';

/**
 * One hourly capture, end to end: collector -> normalize -> screenshot -> store -> classify.
 *
 * Ordering here is not arbitrary. The snapshot is persisted BEFORE health is computed and before the
 * screenshot is required to have worked, because the capture is the irreplaceable part — a homepage
 * cannot be re-fetched as it was an hour ago, while a health verdict can be recomputed from the
 * stored record at any time.
 */

export interface CaptureOptions {
  store: StoreOptions;
  /** Where full-page PNGs land. Null disables screenshots. */
  screenshotDir?: string | null;
  runner?: CommandRunner;
  thresholds?: HealthThresholds;
  /** Injected for deterministic tests. */
  now?: () => string;
  newCaptureId?: () => string;
}

export interface CaptureResult {
  snapshot: CaptureSnapshot;
  diagnostics: CaptureDiagnostics;
  health: HealthReport;
  storedAt: string;
  screenshotError: string | null;
}

export function screenshotPathFor(dir: string, source: string, capturedAt: string): string {
  // Colons are legal in ISO timestamps and illegal in Windows filenames.
  return path.join(dir, source, `${capturedAt.replace(/[:.]/g, '-')}.png`);
}

export async function captureOutlet(
  outlet: Outlet & { collector_id: string },
  options: CaptureOptions,
): Promise<CaptureResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const newCaptureId = options.newCaptureId ?? randomUUID;
  const capturedAt = now();

  const rawRecords = await runCollector(outlet.collector_id, outlet.homepage_url, {
    ...(options.runner ? { runner: options.runner } : {}),
  });

  // The screenshot is the receipt, not the record. If it fails we still keep the capture and report
  // the failure — losing an hour of history over a PNG would be an absurd trade.
  let screenshotPath: string | null = null;
  let screenshotError: string | null = null;
  if (options.screenshotDir != null) {
    const target = screenshotPathFor(options.screenshotDir, outlet.source, capturedAt);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await captureScreenshot(outlet.homepage_url, target, {
        ...(options.runner ? { runner: options.runner } : {}),
      });
      screenshotPath = target;
    } catch (error) {
      screenshotError = error instanceof Error ? error.message : String(error);
    }
  }

  const { snapshot, diagnostics } = buildCapture(
    rawRecords,
    {
      source: outlet.source,
      source_name: outlet.source_name,
      homepage_url: outlet.homepage_url,
      captured_at: capturedAt,
      capture_id: newCaptureId(),
    },
    { collector_id: outlet.collector_id, screenshot_path: screenshotPath },
  );

  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  // Baseline is read BEFORE this capture is appended, so a capture never compares against itself.
  const baseline = await readRecentCaptures(
    outlet.source,
    thresholds.baselineWindow,
    options.store,
  );

  const storedAt = await appendCapture(snapshot, options.store);
  const health = computeHealth({ snapshot, diagnostics, baseline }, thresholds);

  return { snapshot, diagnostics, health, storedAt, screenshotError };
}
