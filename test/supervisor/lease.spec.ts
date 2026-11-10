import { describe, expect, it } from 'vitest';
import { isExpired, leaseMinutesFor, onFailure } from '../../src/supervisor/lease.ts';
import { plus, request, run, T0, task, team } from '../helpers.ts';

describe('leases', () => {
  it('is not expired before leaseUntil and is after', () => {
    const until = plus(T0, 60).toISOString();
    expect(isExpired(until, plus(T0, 59))).toBe(false);
    expect(isExpired(until, plus(T0, 61))).toBe(true);
  });

  it('takes the lease from the request, then the task, then the team', () => {
    expect(leaseMinutesFor(request({ leaseMinutes: 30 }), task({ leaseMinutes: 20 }), team())).toBe(30);
    expect(leaseMinutesFor(request(), task({ leaseMinutes: 20 }), team())).toBe(20);
    expect(leaseMinutesFor(request(), task(), team({ leaseMinutes: 15 }))).toBe(15);
  });

  it('retries a first attempt of a retryable task and cards a second', () => {
    expect(onFailure(run({ outcome: 'expired' }), task())).toBe('retry');
    expect(onFailure(run({ outcome: 'expired', attempt: 2 }), task())).toBe('card');
    expect(onFailure(run({ outcome: 'expired' }), task({ retryAllowed: false }))).toBe('card');
    expect(onFailure(run({ outcome: 'failed', reason: 'crashed' }), task())).toBe('retry');
  });

  it('never retries a run that ended at a limit or without a report: that needs a person', () => {
    for (const reason of ['error_max_turns', 'error_max_budget_usd', 'no_report']) expect(onFailure(run({ outcome: 'failed', reason }), task())).toBe('card');
  });
});
