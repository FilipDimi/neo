import { describe, expect, it } from 'vitest';
import { ago, attention, cardLine, longestSilence } from '../../src/shared/view.ts';
import { decision, plus, run, T0, task } from '../helpers.ts';

const now = plus(T0, 600);

describe('attention', () => {
  it('is working for a task with a live run inside its lease, and none for a queued one', () => {
    expect(attention(task({ state: 'running' }), run({ leaseUntil: plus(now, 60).toISOString() }), [], now)).toBe('working');
    expect(attention(task({ state: 'briefing' }), run({ mode: 'brief', leaseUntil: plus(now, 60).toISOString() }), [], now)).toBe('working');
    expect(attention(task(), undefined, [], now)).toBe('none');
    expect(attention(task({ state: 'done' }), undefined, [], now)).toBe('none');
  });

  it('is silent for a run past its lease, and for an open lease card', () => {
    expect(attention(task({ state: 'running' }), run({ leaseUntil: plus(now, -1).toISOString() }), [], now)).toBe('silent');
    expect(attention(task({ state: 'blocked', blockedFrom: 'running' }), undefined, [decision({ kind: 'lease' })], now)).toBe('silent');
  });

  it('is over_budget for a cap card and waiting_on_you for any other open card', () => {
    expect(attention(task({ state: 'blocked' }), undefined, [decision({ kind: 'cap' })], now)).toBe('over_budget');
    for (const kind of ['question', 'tool', 'merge', 'review', 'ownership', 'briefing', 'staffing', 'invariant', 'failed'] as const) expect(attention(task({ state: 'blocked' }), undefined, [decision({ kind })], now), kind).toBe('waiting_on_you');
  });

  it('is review for a task in review, with or without a run', () => {
    expect(attention(task({ state: 'review' }), undefined, [], now)).toBe('review');
    expect(attention(task({ state: 'review' }), run({ mode: 'review', leaseUntil: plus(now, 60).toISOString() }), [], now)).toBe('review');
  });

  it('a running parent whose children carry the work counts as working', () => {
    expect(attention(task({ state: 'running' }), undefined, [], now)).toBe('working');
  });
});

describe('cardLine', () => {
  it("names the last event's age and the gate count for a running task", () => {
    const live = run({ lastEventAt: plus(now, -40).toISOString(), gateResults: [] });
    expect(cardLine(task({ state: 'running' }), [live], [], now)).toBe('event 40 s ago');
    const earlier = run({ id: 'r0', outcome: 'done', gateResults: [{ name: 'a', command: '', exitCode: 0, output: '', durationMs: 1 }, { name: 'b', command: '', exitCode: 1, output: '', durationMs: 1 }] });
    expect(cardLine(task({ state: 'running', gates: ['a', 'b', 'c'] }), [earlier, live], [], now)).toBe('event 40 s ago · gates 1/3');
  });

  it("shows the employee's own status line when it has one", () => {
    expect(cardLine(task({ state: 'briefing' }), [run({ mode: 'brief', activity: 'splitting into 3 sub-tasks', lastEventAt: now.toISOString() })], [], now)).toBe('splitting into 3 sub-tasks');
  });

  it('shows the diff size and the gates for a task in review', () => {
    const authored = run({ outcome: 'done', diffLines: 412, gateResults: [{ name: 'tests', command: '', exitCode: 0, output: '', durationMs: 1 }] });
    expect(cardLine(task({ state: 'review', gates: ['tests'] }), [authored], [], now)).toBe('diff 412 lines · gates passed');
    expect(cardLine(task({ state: 'review' }), [run({ outcome: 'done', diffLines: 3 })], [], now)).toBe('diff 3 lines');
  });

  it('says why a blocked task is blocked and for how long the decision has been open', () => {
    const expired = [run({ id: 'a', outcome: 'expired' }), run({ id: 'b', outcome: 'expired', attempt: 2 })];
    const card = decision({ kind: 'lease', askedAt: plus(now, -9 * 60).toISOString() });
    expect(cardLine(task({ state: 'blocked', blockedFrom: 'running' }), expired, [card], now)).toBe('2 runs · lease expired twice · decision open 9 min');
    expect(cardLine(task({ state: 'blocked' }), [run({ outcome: 'refused' })], [decision({ kind: 'tool', askedAt: plus(now, -60).toISOString() })], now)).toBe('1 run · a call was refused · decision open 1 min');
    expect(cardLine(task({ state: 'blocked' }), [], [decision({ kind: 'merge', askedAt: plus(now, -22 * 60).toISOString() })], now)).toBe('ready to merge · decision open 22 min');
  });

  it('counts the sub-tasks of a parent that is waiting for them', () => {
    const children = [task({ id: 'a', state: 'done' }), task({ id: 'b', state: 'running' }), task({ id: 'c', state: 'queued' })];
    expect(cardLine(task({ state: 'running' }), [run({ mode: 'brief', outcome: 'done' })], [], now, children)).toBe('1 of 3 sub-tasks done');
  });

  it('says where a done task was merged, why a failed one failed, and nothing for a queued one', () => {
    expect(cardLine(task({ state: 'done', mergedInto: 'track' }), [], [], now)).toBe('merged track');
    expect(cardLine(task({ state: 'done' }), [], [], now)).toBe('');
    expect(cardLine(task({ state: 'failed' }), [run({ outcome: 'stopped', reason: 'task_stopped' })], [], now)).toBe('stopped');
    expect(cardLine(task(), [], [], now)).toBe('');
  });
});

describe('ago and longestSilence', () => {
  it('formats ages as the artboards do', () => {
    expect(ago(plus(now, -5).toISOString(), now)).toBe('5 s');
    expect(ago(plus(now, -41 * 60).toISOString(), now)).toBe('41 min');
    expect(ago(plus(now, -3600).toISOString(), now)).toBe('1 h');
    expect(ago(plus(now, -26 * 3600).toISOString(), now)).toBe('1 d');
    expect(ago(plus(now, 5).toISOString(), now)).toBe('0 s');
  });

  it('finds the run that has been quiet the longest', () => {
    const runs = [run({ id: 'a', lastEventAt: plus(now, -40).toISOString() }), run({ id: 'b', lastEventAt: plus(now, -5).toISOString() })];
    expect(longestSilence(runs, now)).toEqual({ runId: 'a', seconds: 40, leaseMinutes: 15 });
    expect(longestSilence([], now)).toBeNull();
  });
});
