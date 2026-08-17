#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clusterStories } from '../analyze/cluster.js';
import { diffCaptures } from '../analyze/diff.js';
import { buildPropagation, leadDivergence } from '../analyze/propagation.js';
import { captureOutlet } from '../collect/capture.js';
import { applyCollectorEnv, DEFAULT_OUTLETS, readyOutlets } from '../config/outlets.js';
import { DEMO_FEATURED_SLUG, DEMO_HOURS, DEMO_MARKER, buildDemoCaptures } from '../demo/seed.js';
import { beginEpisode } from '../heal/episode.js';
import { buildHealPrompt } from '../heal/heal-prompt.js';
import { healOutlet } from '../heal/run-heal.js';
import { computeHealth, diagnosticsFor, isHealable, shouldHeal } from '../health/health.js';
import type { HealthStatus } from '../health/health.js';
import { renderDiff, renderHealEpisode, renderHealthReport } from '../report/render.js';
import { buildTimelinePayload, renderTimeline } from '../report/timeline.js';
import { runScheduler } from '../schedule/scheduler.js';
import { runWatchTick, seedWatchState } from '../schedule/watch.js';
import type { WatchOptions } from '../schedule/watch.js';
import {
  appendCapture,
  listCaptureDates,
  readCapturesForDate,
  readRecentCaptures,
} from '../store/snapshot-store.js';
import { appendEpisode, listEpisodeSources, readEpisodes } from '../store/episode-store.js';
import type { StoreOptions } from '../store/snapshot-store.js';
import type { CaptureSnapshot, StorySnapshotRecord } from '../schema/story-snapshot.js';

/* eslint-disable no-console -- this module IS the terminal output. */

const rule = (label: string): void => {
  console.log(`\n${'═'.repeat(78)}\n${label}\n${'═'.repeat(78)}`);
};

/**
 * `fptm demo` — the whole product on synthetic data, so the pipeline is provable before a week of
 * real history exists (and before a Bright Data collector is available).
 */
async function demo(): Promise<void> {
  console.log(`\n  FRONT PAGE TIME MACHINE`);
  console.log(`  A memory of what the public web cared about.\n`);
  console.log(`  ⚠  ${DEMO_MARKER}`);
  console.log(`     Real captures live under snapshots/ and come from Scraper Studio collectors.`);

  const root = await mkdtemp(path.join(tmpdir(), 'fptm-demo-'));
  const store: StoreOptions = { rootDir: root };

  try {
    const captures = buildDemoCaptures();
    for (const { snapshot } of captures) await appendCapture(snapshot, store);

    // ---- Scene 2: time travel -------------------------------------------------------------
    rule('SCENE 2 — TIME TRAVEL: what changed on one front page');
    const bbc = captures
      .filter((c) => c.snapshot.source === 'bbc')
      .map((c) => c.snapshot)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const before = bbc.find((c) => c.captured_at.includes('T09:'));
    const after = bbc.find((c) => c.captured_at.includes('T10:'));
    if (before && after) console.log(`\n${renderDiff(diffCaptures(before, after))}`);

    // ---- Scene 3: self-healing ------------------------------------------------------------
    rule('SCENE 3 — SELF-HEALING: detection, repair, proof');
    const nprCaptures = captures.filter((c) => c.snapshot.source === 'npr');
    const statuses: HealthStatus[] = [];
    let fired = false;

    const seen: CaptureSnapshot[] = [];
    for (const { snapshot, diagnostics } of nprCaptures) {
      // Walk the day forward, so each capture is judged only against what preceded it — exactly what
      // the live collector does when it reads the trailing window before appending.
      const report = computeHealth({ snapshot, diagnostics, baseline: seen.slice(-5) });
      seen.push(snapshot);
      statuses.push(report.status);

      const hour = snapshot.captured_at.slice(11, 16);
      console.log(`  ${hour}  ${report.status.padEnd(9)} ${report.story_count} stories`);

      if (!fired && shouldHeal(statuses)) {
        fired = true;
        console.log(`\n  Debounce satisfied: ${statuses.slice(-2).join(' → ')} — healing.\n`);
        const prompt = buildHealPrompt(report, 'https://www.npr.org');
        const episode = beginEpisode(report, prompt, snapshot.captured_at);
        console.log(renderHealEpisode({ ...episode, state: 'RECOVERED', stories_after: 20 }));
        console.log(
          `\n  (In demo mode the repair is simulated. With a live collector this is\n` +
            `   brightdata scraper heal → approve → run, driven by src/heal/run-heal.ts.)`,
        );
      }
    }

    // ---- Scene 4: cross-publisher propagation ---------------------------------------------
    rule('SCENE 4 — PROPAGATION: how one story spread');
    const allRecords: StorySnapshotRecord[] = captures.flatMap((c) => c.snapshot.records);
    const knownSources = [...new Set(allRecords.map((r) => r.source))].sort();
    const chosen = clusterStories(allRecords).find((cluster) =>
      cluster.records.some((record) => record.article_url.includes(DEMO_FEATURED_SLUG)),
    );

    if (chosen) {
      const propagation = buildPropagation(chosen, knownSources);
      console.log(`\n  "${propagation.label}"\n`);
      console.log(
        `  First detected: ${propagation.first_detected.source_name} — ${propagation.first_detected.at.slice(11, 16)}\n`,
      );
      for (const outlet of propagation.outlets) {
        console.log(
          `  ${outlet.source_name.padEnd(12)} ${outlet.first_seen.slice(11, 16)}–${outlet.last_seen.slice(11, 16)}  ` +
            `peak rank ${outlet.peak_position} (${outlet.peak_tier})  ` +
            `led for ${outlet.captures_as_lead} capture(s)`,
        );
      }
      if (propagation.never_covered.length > 0) {
        console.log(`\n  Never carried it: ${propagation.never_covered.join(', ')}`);
        console.log(`  (Placement and timing only — no tone, no alignment, no ranking.)`);
      }
    }

    // ---- Scene 5: divergence ---------------------------------------------------------------
    rule('SCENE 5 — DIVERGENCE: the hours front pages disagreed most');
    const allClusters = clusterStories(allRecords);
    const clusterOf = new Map<string, number>();
    for (const cluster of allClusters) {
      for (const record of cluster.records) {
        clusterOf.set(
          `${record.source}|${record.captured_at}|${record.article_url}`,
          cluster.cluster_id,
        );
      }
    }

    for (const hour of DEMO_HOURS) {
      const at = `2026-08-17T${String(hour).padStart(2, '0')}:00:00.000Z`;
      const leads = new Map<string, number>();
      for (const capture of captures) {
        if (capture.snapshot.captured_at !== at) continue;
        const lead = capture.snapshot.records.find((r) => r.is_lead);
        if (!lead) continue;
        const id = clusterOf.get(`${lead.source}|${at}|${lead.article_url}`);
        if (id !== undefined) leads.set(lead.source, id);
      }
      const entropy = leadDivergence(leads);
      const bar = '█'.repeat(Math.round(entropy * 12));
      console.log(`  ${at.slice(11, 16)}  ${entropy.toFixed(2)} ${bar}`);
    }
    console.log(
      `\n  Higher = front pages disagreed more about what mattered. Shannon entropy over`,
    );
    console.log(`  which story each outlet led with. Spikes are where to scrub to.`);

    console.log(`\n  ⚠  ${DEMO_MARKER}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** `fptm capture` — one real capture of every outlet that has a collector. */
async function capture(): Promise<void> {
  const outlets = readyOutlets(applyCollectorEnv(DEFAULT_OUTLETS));
  if (outlets.length === 0) {
    console.error('No outlet has a collector yet.');
    console.error(
      'Create one with: brightdata scraper create <homepage> "$(cat collectors/homepage-description.txt)"',
    );
    console.error('Then set FPTM_COLLECTORS="npr:c_xxx,bbc:c_yyy" in .env');
    process.exitCode = 1;
    return;
  }

  const store: StoreOptions = { rootDir: 'snapshots' };
  for (const outlet of outlets) {
    try {
      const result = await captureOutlet(outlet, { store, screenshotDir: 'screenshots' });
      console.log(`\n${renderHealthReport(result.health)}`);
      if (result.screenshotError !== null) {
        console.log(`\n  note: screenshot failed (${result.screenshotError}) — capture kept.`);
      }
    } catch (error) {
      console.error(`${outlet.source}: capture failed — ${String(error)}`);
      process.exitCode = 1;
    }
  }
}

/** Every stored record for every configured outlet. The analysis commands all start here. */
async function readAllRecords(
  store: StoreOptions,
): Promise<{ records: StorySnapshotRecord[]; sources: string[] }> {
  const records: StorySnapshotRecord[] = [];
  const sources: string[] = [];

  for (const outlet of applyCollectorEnv(DEFAULT_OUTLETS)) {
    const dates = await listCaptureDates(outlet.source, store);
    if (dates.length === 0) continue;
    sources.push(outlet.source);
    for (const date of dates) {
      for (const capture of await readCapturesForDate(outlet.source, date, store)) {
        records.push(...capture.records);
      }
    }
  }

  return { records, sources: sources.sort() };
}

/** `fptm diff <source>` — what changed on one front page between its last two captures. */
async function diff(source: string | undefined): Promise<void> {
  if (source === undefined) {
    console.error('usage: fptm diff <source>');
    process.exitCode = 1;
    return;
  }

  const recent = await readRecentCaptures(source, 2, { rootDir: 'snapshots' });
  const previous = recent[0];
  const current = recent[1];
  if (previous === undefined || current === undefined) {
    console.error(`Need at least two captures for "${source}" — have ${recent.length}.`);
    console.error('Run `npm run capture` again once the homepage has had time to move.');
    process.exitCode = 1;
    return;
  }

  console.log(renderDiff(diffCaptures(previous, current)));
}

/** `fptm story` — cluster everything captured so far and trace how each story spread. */
async function story(): Promise<void> {
  const { records, sources } = await readAllRecords({ rootDir: 'snapshots' });
  if (records.length === 0) {
    console.error('No captures stored yet. Run `npm run capture` first.');
    process.exitCode = 1;
    return;
  }

  const clusters = clusterStories(records);
  console.log(
    `${records.length} records · ${sources.length} outlet(s) · ${clusters.length} distinct stories\n`,
  );

  if (sources.length < 2) {
    // Say this plainly rather than printing a cross-outlet view built from one outlet, which would
    // read as a finding when it is only a reflection of what we have collected.
    console.log('Only one outlet is being captured, so cross-outlet comparison is not available.');
    console.log('Coverage, propagation and blind spots need at least two.\n');
  }

  // Longest-running first: a story that held a front page for hours is the interesting one.
  const ranked = clusters
    .map((cluster) => buildPropagation(cluster, sources))
    .sort(
      (a, b) =>
        b.outlets.length - a.outlets.length ||
        Math.max(...b.outlets.map((o) => o.captures_present)) -
          Math.max(...a.outlets.map((o) => o.captures_present)),
    );

  for (const propagation of ranked.slice(0, 10)) {
    console.log(`"${propagation.label}"`);
    console.log(
      `  first seen: ${propagation.first_detected.source_name} at ${propagation.first_detected.at.slice(11, 16)}`,
    );
    for (const outlet of propagation.outlets) {
      console.log(
        `  ${outlet.source_name.padEnd(12)} ${outlet.first_seen.slice(11, 16)}-${outlet.last_seen.slice(11, 16)}` +
          `  peak rank ${outlet.peak_position} (${outlet.peak_tier})` +
          `  ${outlet.captures_present} capture(s), led ${outlet.captures_as_lead}`,
      );
    }
    if (propagation.never_covered.length > 0) {
      console.log(`  never carried it: ${propagation.never_covered.join(', ')}`);
    }
    console.log('');
  }
}

/**
 * `fptm watch` — the hourly collector. Capture every outlet on the hour, heal what stays broken.
 *
 * This command is what makes the archive an archive rather than five files someone ran by hand. Kept
 * deliberately thin: the cadence lives in src/schedule/scheduler.ts and the per-tick work in
 * src/schedule/watch.ts, both of which are tested against a fake clock.
 */
async function watch(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const outlets = readyOutlets(applyCollectorEnv(DEFAULT_OUTLETS));
  if (outlets.length === 0) {
    console.error('No outlet has a collector yet. Set FPTM_COLLECTORS in .env first.');
    process.exitCode = 1;
    return;
  }

  const interval = Number(flags['interval'] ?? 60);
  const maxTicks = flags['ticks'] === undefined ? null : Number(flags['ticks']);
  const autonomous = flags['autonomous'] === 'true';

  const options: WatchOptions = {
    outlets,
    store: { rootDir: 'snapshots' },
    screenshotDir: flags['no-screenshots'] === 'true' ? null : 'screenshots',
    healMode: autonomous ? 'autonomous' : 'gated',
    autoHeal: flags['no-heal'] !== 'true',
    log: (line) => {
      console.log(line);
    },
  };

  let healLabel = 'gated (approval required)';
  if (options.autoHeal === false) healLabel = 'off';
  else if (autonomous) healLabel = 'autonomous';
  const stopLabel = maxTicks === null ? 'until stopped (Ctrl-C)' : `${maxTicks} tick(s) then exit`;

  console.log(`\n  FRONT PAGE TIME MACHINE — watching ${outlets.length} outlet(s)`);
  console.log(`  ${outlets.map((o) => o.source).join(', ')}`);
  console.log(`  every ${interval} min · heal ${healLabel}`);
  console.log(`  ${stopLabel}\n`);

  // Prime the debounce from what is already on disk, so a restart does not hand a
  // collector that has been broken for hours another two hours of grace.
  const state = await seedWatchState(options);

  // Ctrl-C stops after the current tick instead of killing a capture mid-write.
  const controller = new AbortController();
  const onSignal = (): void => {
    console.log('\n  stopping after the current tick…');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const summary = await runScheduler(
    async (context) => {
      console.log(
        `\n── tick ${context.index} · ${context.scheduled_for.slice(0, 16)}Z ${'─'.repeat(30)}`,
      );
      const result = await runWatchTick(context, state, options);
      for (const outlet of result.outlets) {
        if (outlet.heal !== null) console.log(`\n${renderHealEpisode(outlet.heal)}\n`);
      }
    },
    {
      intervalMinutes: interval,
      maxTicks,
      runImmediately: flags['now'] === 'true',
      signal: controller.signal,
      log: (line) => {
        console.log(`  ${line}`);
      },
    },
  );

  console.log(
    `\n  ${summary.ticks_run} tick(s) run · ${summary.ticks_failed} failed · ` +
      `${summary.ticks_missed} missed · stopped: ${summary.stopped_because}\n`,
  );
}

/** `--flag value` and bare `--flag` (which reads as "true"). Enough for this CLI, no dependency. */
function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = 'true';
    }
  }
  return flags;
}

/** `fptm timeline [--out <path>]` — render the archive into one self-contained HTML page. */
async function timeline(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const store: StoreOptions = { rootDir: 'snapshots' };

  const captures: CaptureSnapshot[] = [];
  for (const outlet of applyCollectorEnv(DEFAULT_OUTLETS)) {
    for (const date of await listCaptureDates(outlet.source, store)) {
      captures.push(...(await readCapturesForDate(outlet.source, date, store)));
    }
  }

  const episodes = (
    await Promise.all((await listEpisodeSources()).map((source) => readEpisodes(source)))
  ).flat();

  const outPath = flags['out'] ?? 'timeline.html';
  const payload = buildTimelinePayload(captures, episodes);
  await writeFile(outPath, renderTimeline(payload), 'utf8');
  console.log(
    `${outPath}: ${payload.captures.length} captures · ${payload.outlets.length} outlets · ` +
      `${payload.ticks.length} scrubber stops · ${payload.episodes.length} repair episode(s)`,
  );
  console.log('Self-contained — open it in any browser, no server, no network.');
}

/** `fptm heal <source>` — run the real repair loop against the latest stored capture. */
async function heal(source: string | undefined, argv: readonly string[]): Promise<void> {
  if (source === undefined) {
    console.error('usage: fptm heal <source> [--timeout <seconds>] [--autonomous]');
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(argv);
  const outlet = readyOutlets(applyCollectorEnv(DEFAULT_OUTLETS)).find((o) => o.source === source);
  if (outlet === undefined) {
    console.error(`No ready collector for "${source}".`);
    process.exitCode = 1;
    return;
  }

  const store: StoreOptions = { rootDir: 'snapshots' };
  const recent: CaptureSnapshot[] = await readRecentCaptures(source, 6, store);
  const latest = recent[recent.length - 1];
  if (latest === undefined) {
    console.error(`No captures stored for "${source}" yet.`);
    process.exitCode = 1;
    return;
  }

  const report = computeHealth({
    snapshot: latest,
    diagnostics: diagnosticsFor(latest),
    baseline: recent.slice(0, -1),
  });

  console.log(renderHealthReport(report));

  // Healing against a rate-limited or blocked account is worse than useless: the heal's own preview
  // fetches the page through the same account, so the AI would "repair" the collector to parse an
  // error page. Verified live — the account throttle produced exactly this bait.
  if (!isHealable(report) && flags['force'] !== 'true') {
    console.error(
      '\nRefusing to heal: the failure is upstream of the collector (see signals above).',
    );
    console.error('Fix the account/network condition first, or pass --force to heal anyway.');
    process.exitCode = 1;
    return;
  }

  const episode = await healOutlet(outlet, report, {
    mode: flags['autonomous'] === 'true' ? 'autonomous' : 'gated',
    ...(flags['timeout'] === undefined ? {} : { timeoutSeconds: Number(flags['timeout']) }),
  });
  const ledgerPath = await appendEpisode(episode);
  console.log(`\n${renderHealEpisode(episode)}`);
  console.log(`\n  episode recorded → ${ledgerPath}`);
}

const [, , command, argument] = process.argv;
const rest = process.argv.slice(3);

switch (command) {
  case 'demo':
    await demo();
    break;
  case 'capture':
    await capture();
    break;
  case 'watch':
    await watch(rest);
    break;
  case 'diff':
    await diff(argument);
    break;
  case 'story':
    await story();
    break;
  case 'timeline':
    await timeline(rest);
    break;
  case 'heal':
    await heal(argument, rest);
    break;
  default:
    console.log('usage: fptm <demo|capture|watch|diff|story|timeline|heal>');
    console.log('  demo            run the whole product on synthetic data (no account needed)');
    console.log('  capture         capture every outlet that has a Scraper Studio collector, once');
    console.log('  watch           capture on the hour, forever, healing what stays broken');
    console.log("  diff <source>   what changed between that outlet's last two captures");
    console.log('  story           cluster every stored capture and trace how stories spread');
    console.log('  timeline        render the archive into one self-contained HTML page');
    console.log("  heal <source>   detect, repair and verify one outlet's collector");
    console.log('');
    console.log('watch flags:');
    console.log('  --interval <min>   capture cadence, must divide 24h evenly (default 60)');
    console.log('  --ticks <n>        stop after n captures (default: run until Ctrl-C)');
    console.log('  --now              capture immediately instead of waiting for the boundary');
    console.log('  --autonomous       commit heals without waiting for approval');
    console.log('  --no-heal          observe and report only, never touch a collector');
    console.log('  --no-screenshots   skip the PNG receipts');
    break;
}
