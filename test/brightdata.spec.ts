import { expect } from 'chai';
import {
  approveHeal,
  captureScreenshot,
  extractJson,
  flattenNestedRows,
  healCollector,
  resolveExecutable,
  runCollector,
  toRawRecords,
} from '../src/collect/brightdata.js';
import type { CommandRunner } from '../src/collect/brightdata.js';

function fakeRunner(stdout: string): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (bin, args) => {
    calls.push([bin, ...args]);
    return { stdout, stderr: '' };
  };
  return { runner, calls };
}

describe('resolveExecutable', () => {
  const saved = { bin: process.env['FPTM_BRIGHTDATA_BIN'], js: process.env['FPTM_BRIGHTDATA_JS'] };

  afterEach(() => {
    if (saved.bin === undefined) delete process.env['FPTM_BRIGHTDATA_BIN'];
    else process.env['FPTM_BRIGHTDATA_BIN'] = saved.bin;
    if (saved.js === undefined) delete process.env['FPTM_BRIGHTDATA_JS'];
    else process.env['FPTM_BRIGHTDATA_JS'] = saved.js;
  });

  it('honours an explicit binary override', () => {
    delete process.env['FPTM_BRIGHTDATA_JS'];
    process.env['FPTM_BRIGHTDATA_BIN'] = '/usr/local/bin/brightdata';
    expect(resolveExecutable()).to.deep.equal({
      command: '/usr/local/bin/brightdata',
      prefixArgs: [],
    });
  });

  it('runs a JS entry point with this process own node', () => {
    // The Windows path: npm ships `brightdata.cmd`, and since Node 20.12 a `.cmd` cannot be spawned
    // without `shell: true` — it fails with `spawn EINVAL`. Enabling the shell would push a generated
    // heal prompt full of arbitrary headline text through cmd.exe parsing, so we avoid it entirely.
    delete process.env['FPTM_BRIGHTDATA_BIN'];
    process.env['FPTM_BRIGHTDATA_JS'] = '/opt/cli/dist/index.js';
    const resolved = resolveExecutable();
    expect(resolved.command).to.equal(process.execPath);
    expect(resolved.prefixArgs).to.deep.equal(['/opt/cli/dist/index.js']);
  });

  it('never resolves to a bare .cmd, which cannot be spawned without a shell', () => {
    delete process.env['FPTM_BRIGHTDATA_BIN'];
    delete process.env['FPTM_BRIGHTDATA_JS'];
    expect(resolveExecutable().command.endsWith('.cmd')).to.equal(false);
  });
});

describe('extractJson', () => {
  it('parses clean JSON', () => {
    expect(extractJson('{"a":1}')).to.deep.equal({ a: 1 });
  });

  it('recovers JSON that the CLI wrapped in progress chatter', () => {
    // A scrape that succeeded must not be discarded over a banner line.
    const stdout = 'Scraping https://www.npr.org...\n[{"headline":"A"}]\nDone.';
    expect(extractJson(stdout)).to.deep.equal([{ headline: 'A' }]);
  });

  it('is not fooled by a progress line that itself starts with a bracket', () => {
    // "[12:00]" is an opening bracket too. Anchoring the scan on the FIRST bracket used to slice
    // from the timestamp and throw away a payload that was sitting right there.
    const stdout = '[12:00] fetching https://www.npr.org…\n[{"headline":"A"}]';
    expect(extractJson(stdout)).to.deep.equal([{ headline: 'A' }]);
    const withTrailer = '[12:00] fetching…\n[{"headline":"A"}]\nDone.';
    expect(extractJson(withTrailer)).to.deep.equal([{ headline: 'A' }]);
  });

  it('refuses empty output rather than returning a silent nothing', () => {
    expect(() => extractJson('   ')).to.throw(/no output/);
  });

  it('refuses output with no JSON at all', () => {
    expect(() => extractJson('Error: not logged in')).to.throw(/No JSON found/);
  });
});

describe('toRawRecords', () => {
  it('accepts a bare array', () => {
    expect(toRawRecords([{ headline: 'A', article_url: '/a' }])).to.have.length(1);
  });

  it('accepts the wrapper shapes collectors actually emit', () => {
    // Guessing wrong here would look exactly like extraction failure to the health module.
    for (const key of ['data', 'results', 'records']) {
      expect(toRawRecords({ [key]: [{ headline: 'A', article_url: '/a' }] })).to.have.length(1);
    }
  });

  it('returns nothing for a shape it does not recognise', () => {
    expect(toRawRecords({ unexpected: 'shape' })).to.deep.equal([]);
    expect(toRawRecords(null)).to.deep.equal([]);
  });

  it('keeps well-formed rows and drops unparseable ones', () => {
    const rows = toRawRecords([{ headline: 'A', article_url: '/a' }, 42, 'nope']);
    expect(rows).to.have.length(1);
  });

  it('preserves extra fields a regenerated template happens to emit', () => {
    const rows = toRawRecords([{ headline: 'A', article_url: '/a', data_testid: 'card' }]);
    expect(rows[0]).to.have.property('data_testid', 'card');
  });
});

describe('flattenNestedRows', () => {
  /**
   * The real BBC collector's row shape, verbatim from a live run on 2026-08-17.
   *
   * The wrapper carries a `product_page_url` of its own, which is exactly what made the first version
   * of this function wrong: it asked "is this row a story?" before "does this row contain stories?",
   * answered yes, and kept 21 headline-less wrappers. Health scored the outlet as a total extraction
   * failure while the collector was returning 105 perfectly good stories.
   */
  const BBC_ROW = {
    news_stories: [
      {
        headline: "World's oceans hit record-high July temperatures",
        article_url: 'https://www.bbc.com/news/articles/cpvw8vmmgrwo',
        section: 'Related',
        position: 1,
      },
      {
        headline: 'Tributes paid to Heroes actress Hayden Panettiere',
        article_url: 'https://www.bbc.com/news/articles/cq5665zgg1po',
        section: 'Related',
        position: 2,
      },
    ],
    product_page_url: 'https://www.bbc.com/news',
    input: { url: 'https://www.bbc.com/news' },
  };

  it('unwraps stories nested under a wrapper that looks like a story itself', () => {
    const flattened = flattenNestedRows([BBC_ROW]);
    expect(flattened).to.have.length(2);
    expect((flattened[0] as Record<string, unknown>)['headline']).to.equal(
      "World's oceans hit record-high July temperatures",
    );
  });

  it('leaves already-flat rows alone', () => {
    const flat = [
      { headline: 'A', article_url: 'https://x.com/a' },
      { headline: 'B', article_url: 'https://x.com/b' },
    ];
    expect(flattenNestedRows(flat)).to.deep.equal(flat);
  });

  it('keeps a row it does not recognise instead of silently dropping it', () => {
    // Dropping it here would remove it from raw_count too, so a collector returning junk would look
    // like a collector returning nothing — and the diagnostics would not say which.
    const rows = [{ cookie_banner: 'Accept all' }];
    expect(flattenNestedRows(rows)).to.deep.equal(rows);
  });

  it('ignores an array that is not made of stories', () => {
    const row = { headline: 'A', article_url: 'https://x.com/a', tags: ['Film', 'Comedy'] };
    expect(flattenNestedRows([row])).to.deep.equal([row]);
  });

  it('never unwraps a row that has a headline of its own', () => {
    // Real NPR rows carry a `related_stories` sidebar. Unwrapping it discards the actual story and
    // promotes a "related" link into its place — same row count, completely different archive.
    const row = {
      headline: "The mom of a trans teen grapples with Trump's Medicaid move",
      product_page_url: 'https://www.npr.org/2026/08/16/nx-s1-5932491/transgender-health-care',
      related_stories: [
        {
          headline: 'In just a few years, half of all states passed bans',
          url: 'https://www.npr.org/sections/health-shots/',
        },
      ],
    };
    expect(flattenNestedRows([row])).to.deep.equal([row]);
  });

  it('survives an empty nested array', () => {
    const row = { news_stories: [], product_page_url: 'https://x.com' };
    expect(flattenNestedRows([row])).to.deep.equal([row]);
  });
});

describe('runCollector', () => {
  it('invokes `scraper run <id> <url> --json` and returns rows', async () => {
    const { runner, calls } = fakeRunner('[{"headline":"Rate cut","article_url":"/a"}]');
    const records = await runCollector('c_abc', 'https://www.npr.org', { runner });

    expect(records).to.have.length(1);
    expect(calls[0]?.slice(1)).to.deep.equal([
      'scraper',
      'run',
      'c_abc',
      'https://www.npr.org',
      '--json',
    ]);
  });

  it('passes a timeout through when given one', async () => {
    const { runner, calls } = fakeRunner('[]');
    await runCollector('c_abc', 'https://x.com', { runner, timeoutSeconds: 120 });
    expect(calls[0]).to.include.members(['--timeout', '120']);
  });

  it('returns an empty list rather than throwing when a collector yields nothing', async () => {
    // An empty capture is the loudest health signal there is; it must arrive as data.
    const { runner } = fakeRunner('[]');
    expect(await runCollector('c_abc', 'https://x.com', { runner })).to.deep.equal([]);
  });
});

describe('captureScreenshot', () => {
  it('uses the Unlocker scrape path, not the separately-billed Browser API', async () => {
    const { runner, calls } = fakeRunner('');
    const written = await captureScreenshot('https://www.npr.org', 'shots/npr.png', { runner });

    expect(written).to.equal('shots/npr.png');
    expect(calls[0]?.slice(1)).to.deep.equal([
      'scrape',
      'https://www.npr.org',
      '-f',
      'screenshot',
      '-o',
      'shots/npr.png',
    ]);
    expect(calls[0]).to.not.include('browser');
  });
});

describe('healCollector', () => {
  it('stops at the approval gate by default', async () => {
    const { runner, calls } = fakeRunner('{"collector_id":"c_abc","status":"awaiting_approval"}');
    const envelope = await healCollector('c_abc', 'headline is empty', 'https://x.com', { runner });

    expect(envelope.status).to.equal('awaiting_approval');
    expect(calls[0]).to.not.include('--auto-approve');
  });

  it('can run autonomously when explicitly asked', async () => {
    const { runner, calls } = fakeRunner('{"collector_id":"c_abc","status":"done"}');
    await healCollector('c_abc', 'fix it', 'https://x.com', { runner, autoApprove: true });
    expect(calls[0]).to.include('--auto-approve');
  });
});

describe('approveHeal', () => {
  it('commits a pending fix', async () => {
    const { runner, calls } = fakeRunner('{"collector_id":"c_abc","status":"done"}');
    const envelope = await approveHeal('c_abc', 'https://x.com', { runner });
    expect(envelope.status).to.equal('done');
    expect(calls[0]).to.not.include('--reject');
  });

  it('can reject instead', async () => {
    const { runner, calls } = fakeRunner('{"collector_id":"c_abc","status":"rejected"}');
    await approveHeal('c_abc', 'https://x.com', { runner, reject: true });
    expect(calls[0]).to.include('--reject');
  });
});
