import { header, spendToday } from '../model/select.ts';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, EventRow } from '../../../src/shared/events.ts';
import { subjectsOf } from '../../../src/shared/events.ts';
import { company, decision, employee, message, plus, request, run, T0, task, team } from '../../../test/rows.ts';
import { fromSnapshot, reduce, type Snapshot } from './reduce.ts';

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  version: 1,
  company: company(),
  repos: [],
  teams: [team()],
  employees: [employee()],
  tasks: [task()],
  runs: [],
  requests: [request()],
  decisions: [],
  messages: [],
  health: null,
  planUsage: null,
  spend: { company: 1, byTeam: { team1: 1 }, byEmployee: { emp1: 1 } },
  lastEventId: 10,
  now: T0.toISOString(),
  ...over,
});
let nextId = 11;
const row = (event: EngineEvent, at = T0): EventRow => ({ id: nextId++, at: at.toISOString(), ...subjectsOf(event), event });

describe('the store', () => {
  it('drops a team that was removed, and its tasks with it', () => {
    const store = fromSnapshot(snapshot({ teams: [team(), team({ id: 'team2', name: 'qa' })], tasks: [task(), task({ id: 'qa-task', teamId: 'team2' })] }));
    const next = reduce(store, row({ kind: 'team_changed', team: team({ id: 'team2', name: 'qa', removed: true }) }));
    expect([...next.teams.keys()]).toEqual(['team1']);
    expect([...next.tasks.keys()]).toEqual(['task1']);
  });

  it('builds maps from a snapshot', () => {
    const store = fromSnapshot(snapshot());
    expect(store.tasks.get('task1')?.title).toBe('Do the thing');
    expect(store.teams.size).toBe(1);
    expect(store.company?.name).toBe('Acme');
    expect(store).toMatchObject({ lastEventId: 10, online: true, needsReload: false, spend: { company: 1 } });
  });

  it('upserts the task an event carries and keeps the others, without changing the store it was given', () => {
    const before = fromSnapshot(snapshot({ tasks: [task(), task({ id: 'task2' })] }));
    const after = reduce(before, row({ kind: 'task_changed', task: task({ state: 'running' }), cause: 'state' }));
    expect(after.tasks.get('task1')?.state).toBe('running');
    expect(after.tasks.get('task2')).toBe(before.tasks.get('task2'));
    expect(before.tasks.get('task1')?.state).toBe('queued');
    expect(after.teams).toBe(before.teams);
    expect(after.lastEventId).toBe(nextId - 1);
  });

  it('drops a request when its run starts', () => {
    const after = reduce(fromSnapshot(snapshot()), row({ kind: 'run_started', run: run(), requestId: 'req1', teamId: 'team1' }));
    expect(after.requests.size).toBe(0);
    expect(after.runs.get('run1')?.outcome).toBe('running');
  });

  it("adds a turn's usage to the company, the team and the employee spend, and to the run", () => {
    let store = reduce(fromSnapshot(snapshot(), T0), row({ kind: 'run_started', run: run(), requestId: 'req1', teamId: 'team1' }));
    store = reduce(store, row({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'usage', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, sessionCostUsd: 0.5 } }));
    expect(store.spend).toEqual({ company: 1.5, byTeam: { team1: 1.5 }, byEmployee: { emp1: 1.5 } });
    expect(store.runs.get('run1')?.costUsd).toBe(0.5);
  });

  it("starts today's spend again when the day changes", () => {
    const usage = (costUsd: number, at: Date) => row({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'usage', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, sessionCostUsd: costUsd } }, at);
    const tomorrow = new Date(T0.getTime() + 24 * 3600_000);
    const yesterday = reduce(fromSnapshot(snapshot(), T0), usage(0.5, T0));
    expect(spendToday(yesterday, T0).company).toBe(1.5);
    // Past midnight with nothing spent yet: the figure is today's, which is nothing.
    expect(spendToday(yesterday, tomorrow)).toEqual({ company: 0, byTeam: [] });
    expect(header(yesterday, tomorrow).spentToday).toBe(0);
    // The first spend of the new day starts from zero, not from yesterday's total.
    const today = reduce(yesterday, usage(0.25, tomorrow));
    expect(today.spend).toEqual({ company: 0.25, byTeam: { team1: 0.25 }, byEmployee: { emp1: 0.25 } });
    expect(header(today, tomorrow).spentToday).toBe(0.25);
  });

  it("sets a run's activity, and renews its lease from the event's time", () => {
    const later = plus(T0, 120);
    let store = reduce(fromSnapshot(snapshot()), row({ kind: 'run_started', run: run(), requestId: null, teamId: 'team1' }));
    store = reduce(store, row({ kind: 'run_activity', runId: 'run1', taskId: 'task1', employeeId: 'emp1', text: 'docking the glass row' }, later));
    expect(store.runs.get('run1')).toMatchObject({ activity: 'docking the glass row', lastEventAt: later.toISOString() });
  });

  it('keeps decisions, messages, the company, health and the plan usage up to date', () => {
    let store = fromSnapshot(snapshot());
    store = reduce(store, row({ kind: 'decision_raised', decision: decision() }));
    store = reduce(store, row({ kind: 'message_sent', message: message() }));
    store = reduce(store, row({ kind: 'company_changed', company: company({ paused: { reason: 'user', until: null } }) }));
    store = reduce(store, row({ kind: 'health_changed', report: { at: T0.toISOString(), diskFreeGb: 3, login: 'ok', repos: [], services: [], failures: [] } }));
    store = reduce(store, row({ kind: 'plan_usage', status: 'allowed', window: 'seven_day', utilization: 0.4, resetsAt: 5 }));
    expect(store.decisions.get('dec1')?.kind).toBe('question');
    expect(store.messages.size).toBe(1);
    expect(store.company?.paused?.reason).toBe('user');
    expect(store.health?.diskFreeGb).toBe(3);
    expect(store.planUsage).toMatchObject({ utilization: 0.4, window: 'seven_day' });
    store = reduce(store, row({ kind: 'decision_answered', decision: decision({ answer: { optionId: 'stop' }, answeredAt: T0.toISOString() }), result: 'applied' }));
    expect(store.decisions.get('dec1')?.answeredAt).not.toBeNull();
  });

  it('ignores an unknown event kind and still upserts the rows it carries', () => {
    const before = fromSnapshot(snapshot());
    const fromTheFuture = { id: 99, at: T0.toISOString(), taskId: 'task1', runId: null, employeeId: null, teamId: null, event: { kind: 'task_celebrated', task: task({ title: 'Renamed by a newer engine' }), confetti: true } } as unknown as EventRow;
    const after = reduce(before, fromTheFuture);
    expect(after.tasks.get('task1')?.title).toBe('Renamed by a newer engine');
    expect(after.lastEventId).toBe(99);
    const nothing = reduce(after, { ...fromTheFuture, id: 100, event: { kind: 'something_else' } } as unknown as EventRow);
    expect(nothing.tasks).toBe(after.tasks);
  });

  it('skips an event it has already applied', () => {
    const store = fromSnapshot(snapshot());
    const stale = { ...row({ kind: 'task_changed', task: task({ state: 'failed' }), cause: 'state' }), id: 10 };
    expect(reduce(store, stale)).toBe(store);
  });
});
