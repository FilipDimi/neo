import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { decision, employee, message, plus, request, run, T0, task, team, tempDb } from '../helpers.ts';

const usage = (runId: string, teamId: string, employeeId: string, costUsd: number) =>
  ({ kind: 'run_event', runId, taskId: 'task1', employeeId, teamId, event: { kind: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, sessionCostUsd: costUsd } }) as const;

describe('store', () => {
  it('lists tasks by priority, then age', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'task_changed', task: task({ id: 'p2-old', priority: 2 }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'p2-new', priority: 2, createdAt: plus(T0, 60).toISOString() }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'p1', priority: 1, createdAt: plus(T0, 120).toISOString() }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'running', state: 'running' }), cause: 'created' });
    });
    expect(store.listTasks(db, { state: 'queued' }).map((t) => t.id)).toEqual(['p1', 'p2-old', 'p2-new']);
    expect(store.listTasks(db)).toHaveLength(4);
  });

  it('finds the children of a task', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'task_changed', task: task({ id: 'parent' }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'kid', parentId: 'parent' }), cause: 'created' });
    });
    expect(store.listTasks(db, { parentId: 'parent' }).map((t) => t.id)).toEqual(['kid']);
  });

  it("sums a task's spend over all its runs", () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'run_ended', run: run({ id: 'a', outcome: 'done', costUsd: 0.5 }), teamId: 'team1' });
      tx.emit({ kind: 'run_started', run: run({ id: 'b', costUsd: 0.25 }), requestId: null, teamId: 'team1' });
      tx.emit({ kind: 'run_ended', run: run({ id: 'c', taskId: 'other', outcome: 'done', costUsd: 9 }), teamId: 'team1' });
    });
    expect(store.spentOn(db, 'task1')).toBeCloseTo(0.75, 10);
    expect(store.liveRuns(db).map((r) => r.id)).toEqual(['b']);
    expect(store.runsOf(db, 'task1').map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('sums today only, per team, per employee and for the company', () => {
    const db = tempDb();
    const noon = new Date(2026, 10, 9, 12, 0, 0);
    const yesterday = new Date(2026, 10, 8, 23, 59, 0);
    apply(db, (tx) => tx.emit(usage('r0', 'team1', 'emp1', 100)), yesterday);
    apply(db, (tx) => {
      tx.emit(usage('r1', 'team1', 'emp1', 1.5));
      tx.emit(usage('r2', 'team1', 'emp2', 0.5));
      tx.emit(usage('r3', 'team2', 'emp3', 0.25));
    }, new Date(2026, 10, 9, 0, 0, 1));
    const spend = store.spendToday(db, noon);
    expect(spend.company).toBeCloseTo(2.25, 10);
    expect(Object.fromEntries(spend.byTeam)).toEqual({ team1: 2, team2: 0.25 });
    expect(spend.byEmployee.get('emp1')).toBe(1.5);
  });

  it('lists open requests oldest first, open decisions, and waiting messages', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'run_requested', request: request({ id: 'late', createdAt: plus(T0, 5).toISOString() }) });
      tx.emit({ kind: 'run_requested', request: request({ id: 'early' }) });
      tx.emit({ kind: 'decision_raised', decision: decision({ id: 'open' }) });
      tx.emit({ kind: 'decision_raised', decision: decision({ id: 'closed', answer: { optionId: 'stop' }, answeredAt: T0.toISOString() }) });
      tx.emit({ kind: 'message_sent', message: message({ id: 'm1' }) });
      tx.emit({ kind: 'message_sent', message: message({ id: 'm2', state: 'delivered' }) });
      tx.emit({ kind: 'message_sent', message: message({ id: 'm3', toId: 'someone-else' }) });
    });
    expect(store.openRequests(db).map((r) => r.id)).toEqual(['early', 'late']);
    expect(store.openDecisions(db).map((d) => d.id)).toEqual(['open']);
    expect(store.openDecisions(db, 'task1')).toHaveLength(1);
    expect(store.waitingMessages(db, 'emp1').map((m) => m.id)).toEqual(['m1']);
  });

  it('builds a task with the defaults a caller may leave out', () => {
    const made = store.newTask({ teamId: 'team1', title: 'T', brief: 'B', createdBy: 'user' }, T0);
    expect(made).toMatchObject({ state: 'queued', priority: 2, kind: 'work', capUsd: 2, retryAllowed: true, reviewRounds: 0, gates: [], ownership: [], createdAt: T0.toISOString() });
    expect(made.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('builds a run from a request, with its lease', () => {
    const made = store.newRun(request({ attempt: 2, mode: 'review' }), T0, 20);
    expect(made).toMatchObject({ taskId: 'task1', employeeId: 'emp1', mode: 'review', attempt: 2, outcome: 'running', leaseMinutes: 20, leaseUntil: plus(T0, 20 * 60).toISOString(), costUsd: 0 });
  });

  it('reads teams and employees', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'team_changed', team: team() });
      tx.emit({ kind: 'employee_changed', employee: employee() });
    });
    expect(store.getTeam(db, 'team1')?.name).toBe('Engineering');
    expect(store.allEmployees(db).map((e) => e.id)).toEqual(['emp1']);
  });
});
