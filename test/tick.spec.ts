import { expect } from 'chai';
import { missedTicks, msUntilNextTick, nextTickAfter } from '../src/schedule/tick.js';

const at = (iso: string): Date => new Date(iso);

describe('nextTickAfter', () => {
  it('lands on the next wall-clock boundary, not now-plus-interval', () => {
    // The whole reason for aligning: a capture that started at :17 must not schedule the next at :17.
    expect(nextTickAfter(at('2026-08-17T10:17:33.000Z'), 60).toISOString()).to.equal(
      '2026-08-17T11:00:00.000Z',
    );
  });

  it('advances to the following boundary when called exactly on one', () => {
    // Otherwise the loop would fire, compute a 0ms wait, and spin the same tick forever.
    expect(nextTickAfter(at('2026-08-17T10:00:00.000Z'), 60).toISOString()).to.equal(
      '2026-08-17T11:00:00.000Z',
    );
  });

  it('rolls over midnight', () => {
    expect(nextTickAfter(at('2026-08-17T23:30:00.000Z'), 60).toISOString()).to.equal(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('honours sub-hour intervals', () => {
    expect(nextTickAfter(at('2026-08-17T10:07:00.000Z'), 15).toISOString()).to.equal(
      '2026-08-17T10:15:00.000Z',
    );
    expect(nextTickAfter(at('2026-08-17T10:52:00.000Z'), 15).toISOString()).to.equal(
      '2026-08-17T11:00:00.000Z',
    );
  });

  it('does not drift across a full day of ticks', () => {
    // Twenty-four hops must land exactly one day later. A one-second-per-tick drift would put the
    // series 24s out by tomorrow and 12 minutes out by the end of the month.
    let cursor = at('2026-08-17T00:00:00.000Z');
    for (let hop = 0; hop < 24; hop += 1) cursor = nextTickAfter(cursor, 60);
    expect(cursor.toISOString()).to.equal('2026-08-18T00:00:00.000Z');
  });

  it('rejects an interval that does not tile the hour', () => {
    // At 50 minutes the boundaries walk — :00, :50, :40 — which is the drift alignment prevents.
    expect(() => nextTickAfter(at('2026-08-17T10:00:00.000Z'), 50)).to.throw(/divide 24h/);
  });

  it('rejects nonsense intervals rather than scheduling something surprising', () => {
    expect(() => nextTickAfter(at('2026-08-17T10:00:00.000Z'), 0)).to.throw();
    expect(() => nextTickAfter(at('2026-08-17T10:00:00.000Z'), -60)).to.throw();
    expect(() => nextTickAfter(at('2026-08-17T10:00:00.000Z'), 1.5)).to.throw();
  });
});

describe('msUntilNextTick', () => {
  it('measures the wait to the boundary', () => {
    expect(msUntilNextTick(at('2026-08-17T10:59:30.000Z'), 60)).to.equal(30_000);
  });

  it('is never zero, so the loop always waits before repeating', () => {
    expect(msUntilNextTick(at('2026-08-17T10:00:00.000Z'), 60)).to.equal(3_600_000);
  });
});

describe('missedTicks', () => {
  it('reports nothing when the schedule is being kept', () => {
    expect(
      missedTicks(at('2026-08-17T10:00:00.000Z'), at('2026-08-17T11:00:00.000Z'), 60),
    ).to.equal(0);
  });

  it('tolerates a late tick without calling it a miss', () => {
    // Waking 40 seconds late is normal. Counting it as a gap would cry wolf every hour.
    expect(
      missedTicks(at('2026-08-17T10:00:00.000Z'), at('2026-08-17T11:00:40.000Z'), 60),
    ).to.equal(0);
  });

  it('counts the hours lost while the machine slept', () => {
    // Asleep 10:00 → 15:00. Eleven, twelve, thirteen and fourteen are gone; fifteen is running now.
    expect(
      missedTicks(at('2026-08-17T10:00:00.000Z'), at('2026-08-17T15:00:00.000Z'), 60),
    ).to.equal(4);
  });

  it('never reports a negative count if the clock moves backwards', () => {
    expect(
      missedTicks(at('2026-08-17T12:00:00.000Z'), at('2026-08-17T10:00:00.000Z'), 60),
    ).to.equal(0);
  });
});
