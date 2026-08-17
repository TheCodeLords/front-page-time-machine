import { expect } from 'chai';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCaptureSnapshot } from '../src/schema/normalize.js';
import type { CaptureSnapshot } from '../src/schema/story-snapshot.js';
import {
  appendCapture,
  captureFilePath,
  listCaptureDates,
  readCapturesForDate,
  readRecentCaptures,
  utcDateKey,
} from '../src/store/snapshot-store.js';
import type { StoreOptions } from '../src/store/snapshot-store.js';

let options: StoreOptions;

beforeEach(async () => {
  options = { rootDir: await mkdtemp(path.join(tmpdir(), 'fptm-store-')) };
});

afterEach(async () => {
  await rm(options.rootDir, { recursive: true, force: true });
});

let uuidCounter = 0;
function nextCaptureId(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function makeSnapshot(capturedAt: string, headlines: string[], source = 'npr'): CaptureSnapshot {
  return buildCaptureSnapshot(
    headlines.map((headline, index) => ({
      headline,
      article_url: `/story/${encodeURIComponent(headline)}-${index}`,
    })),
    {
      source,
      source_name: 'NPR',
      homepage_url: 'https://www.npr.org',
      captured_at: capturedAt,
      capture_id: nextCaptureId(),
    },
    { collector_id: 'c_test', screenshot_path: null },
  );
}

describe('utcDateKey', () => {
  it('buckets by UTC day, not by the offset in the timestamp', () => {
    // 02:00 on the 18th at +05:30 is still the 17th in UTC. Bucketing on the local date would
    // scatter one outlet's day across two files and break the trailing-window comparison.
    expect(utcDateKey('2026-08-18T02:00:00+05:30')).to.equal('2026-08-17');
    expect(utcDateKey('2026-08-17T23:59:59.000Z')).to.equal('2026-08-17');
  });

  it('refuses an unparseable timestamp rather than inventing a bucket', () => {
    expect(() => utcDateKey('not a date')).to.throw();
  });
});

describe('appendCapture', () => {
  it('writes to <root>/<source>/<utc-date>.ndjson', async () => {
    const snapshot = makeSnapshot('2026-08-17T10:00:00.000Z', ['One']);
    const written = await appendCapture(snapshot, options);
    expect(written).to.equal(captureFilePath('npr', '2026-08-17T10:00:00.000Z', options));
    expect(written.endsWith(path.join('npr', '2026-08-17.ndjson'))).to.equal(true);
  });

  it('appends rather than overwrites, so history is never lost', async () => {
    await appendCapture(makeSnapshot('2026-08-17T10:00:00.000Z', ['Ten']), options);
    await appendCapture(makeSnapshot('2026-08-17T11:00:00.000Z', ['Eleven']), options);

    const captures = await readCapturesForDate('npr', '2026-08-17', options);
    expect(captures).to.have.length(2);
    expect(captures.map((c) => c.records[0]?.headline)).to.deep.equal(['Ten', 'Eleven']);
  });

  it('writes exactly one line per capture', async () => {
    const snapshot = makeSnapshot('2026-08-17T10:00:00.000Z', ['Multi\nline\theadline']);
    const written = await appendCapture(snapshot, options);
    const contents = await readFile(written, 'utf8');
    expect(contents.split('\n').filter((l) => l.trim() !== '')).to.have.length(1);
  });
});

describe('readCapturesForDate', () => {
  it('returns nothing for a source that has never been captured', async () => {
    expect(await readCapturesForDate('bbc', '2026-08-17', options)).to.deep.equal([]);
  });

  it('returns captures oldest first regardless of append order', async () => {
    await appendCapture(makeSnapshot('2026-08-17T12:00:00.000Z', ['Noon']), options);
    await appendCapture(makeSnapshot('2026-08-17T09:00:00.000Z', ['Nine']), options);

    const captures = await readCapturesForDate('npr', '2026-08-17', options);
    expect(captures.map((c) => c.records[0]?.headline)).to.deep.equal(['Nine', 'Noon']);
  });

  it('survives a truncated final line from an interrupted write', async () => {
    // Losing the capture in flight is recoverable. Losing the archive behind it is not.
    const good = makeSnapshot('2026-08-17T10:00:00.000Z', ['Survivor']);
    const filePath = captureFilePath('npr', '2026-08-17T10:00:00.000Z', options);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(good)}\n{"capture_id":"trunc`, 'utf8');

    const captures = await readCapturesForDate('npr', '2026-08-17', options);
    expect(captures).to.have.length(1);
    expect(captures[0]?.records[0]?.headline).to.equal('Survivor');
  });

  it('still reads captures written before diagnostics were persisted', async () => {
    // Verified against the five real NPR captures on disk. Had `diagnostics` been made required,
    // every one of them would have failed validation and been silently skipped — irreplaceable
    // history deleted to add a field.
    const legacy = {
      capture_id: '11111111-2222-4333-8444-555555555555',
      source: 'npr',
      source_name: 'NPR',
      homepage_url: 'https://www.npr.org',
      captured_at: '2026-08-17T10:00:00.000Z',
      collector_id: 'c_legacy',
      screenshot_path: null,
      records: [],
    };
    const filePath = captureFilePath('npr', '2026-08-17T10:00:00.000Z', options);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(legacy)}\n`, 'utf8');

    const captures = await readCapturesForDate('npr', '2026-08-17', options);
    expect(captures).to.have.length(1);
    expect(captures[0]?.diagnostics).to.equal(null);
  });

  it('round-trips diagnostics on captures that carry them', async () => {
    const snapshot = makeSnapshot('2026-08-17T10:00:00.000Z', ['One', 'Two']);
    await appendCapture(snapshot, options);

    const [stored] = await readCapturesForDate('npr', '2026-08-17', options);
    expect(stored?.diagnostics?.raw_count).to.equal(2);
    expect(stored?.diagnostics?.rejected_no_headline).to.equal(0);
  });

  it('skips a line that parses as JSON but violates the schema', async () => {
    const filePath = captureFilePath('npr', '2026-08-17T10:00:00.000Z', options);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `{"capture_id":"not-a-uuid","source":"npr"}\n`, 'utf8');

    expect(await readCapturesForDate('npr', '2026-08-17', options)).to.deep.equal([]);
  });
});

describe('listCaptureDates', () => {
  it('lists captured days oldest first', async () => {
    await appendCapture(makeSnapshot('2026-08-18T10:00:00.000Z', ['B']), options);
    await appendCapture(makeSnapshot('2026-08-16T10:00:00.000Z', ['A']), options);

    expect(await listCaptureDates('npr', options)).to.deep.equal(['2026-08-16', '2026-08-18']);
  });

  it('returns nothing for an unknown source', async () => {
    expect(await listCaptureDates('nope', options)).to.deep.equal([]);
  });
});

describe('readRecentCaptures', () => {
  it('returns the trailing window across day boundaries, oldest first', async () => {
    await appendCapture(makeSnapshot('2026-08-16T22:00:00.000Z', ['D1-a']), options);
    await appendCapture(makeSnapshot('2026-08-16T23:00:00.000Z', ['D1-b']), options);
    await appendCapture(makeSnapshot('2026-08-17T00:00:00.000Z', ['D2-a']), options);

    const recent = await readRecentCaptures('npr', 2, options);
    expect(recent.map((c) => c.records[0]?.headline)).to.deep.equal(['D1-b', 'D2-a']);
  });

  it('returns everything it has when the archive is shorter than the window', async () => {
    await appendCapture(makeSnapshot('2026-08-17T10:00:00.000Z', ['Only']), options);
    expect(await readRecentCaptures('npr', 5, options)).to.have.length(1);
  });

  it('returns nothing for a non-positive window', async () => {
    await appendCapture(makeSnapshot('2026-08-17T10:00:00.000Z', ['Only']), options);
    expect(await readRecentCaptures('npr', 0, options)).to.deep.equal([]);
  });

  it('keeps sources isolated from one another', async () => {
    await appendCapture(makeSnapshot('2026-08-17T10:00:00.000Z', ['NPR story'], 'npr'), options);
    await appendCapture(makeSnapshot('2026-08-17T10:00:00.000Z', ['BBC story'], 'bbc'), options);

    const recent = await readRecentCaptures('npr', 5, options);
    expect(recent).to.have.length(1);
    expect(recent[0]?.records[0]?.headline).to.equal('NPR story');
  });
});
