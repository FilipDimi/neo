import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { recover } from '../../src/supervisor/recover.ts';
import { company, employee, plus, run, T0, task, team, tempDb } from '../helpers.ts';

function seeded(runOver = {}, taskOver = {}) {
  const db = tempDb();
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company() });
    tx.emit({ kind: 'team_changed', team: team() });
    tx.emit({ kind: 'employee_changed', employee: employee() });
    tx.emit({ kind: 'task_changed', task: task({ state: 'running', assigneeId: 'emp1', ...taskOver }), cause: 'created' });
    tx.emit({ kind: 'run_started', run: run({ pid: 4242, pidStartedAt: 'Mon Nov  9 18:00:00 2026', sessionId: 'sess-1', ...runOver }), requestId: null, teamId: 'team1' });
  });
  return db;
}
const processes = (startedAt: string | null) => {
  const killed: number[] = [];
  return { killed, startedAt: () => startedAt, killGroup: (pid: number) => void killed.push(pid) };
};

describe('recover', () => {
  it('expires every in-flight run on restart and queues a resume of its session', () => {
    const db = seeded();
    const result = recover(db, plus(T0, 60), processes(null));
    expect(result).toEqual({ expired: ['run1'], killed: [] });
    expect(store.getRun(db, 'run1')).toMatchObject({ outcome: 'expired', reason: 'restart', endedAt: plus(T0, 60).toISOString() });
    expect(store.openRequests(db)).toMatchObject([{ taskId: 'task1', mode: 'work', employeeId: 'emp1', reason: 'resume', attempt: 1, resumeSessionId: 'sess-1' }]);
    expect(store.openRequests(db)[0]!.firstTurn).toContain('restarted');
    expect(store.liveRuns(db)).toHaveLength(0);
  });

  it('kills the leftover group when pid and start time both match', () => {
    const db = seeded();
    const procs = processes('Mon Nov  9 18:00:00 2026');
    expect(recover(db, T0, procs).killed).toEqual([4242]);
    expect(procs.killed).toEqual([4242]);
  });

  it('does not kill a process that merely reuses the pid', () => {
    const db = seeded();
    const procs = processes('Tue Nov 10 09:30:00 2026');
    expect(recover(db, T0, procs)).toEqual({ expired: ['run1'], killed: [] });
    expect(procs.killed).toEqual([]);
  });

  it('never kills on a pid with no recorded start time', () => {
    const procs = processes('Mon Nov  9 18:00:00 2026');
    recover(seeded({ pidStartedAt: null }), T0, procs);
    expect(procs.killed).toEqual([]);
  });

  it('starts fresh when the run never got a session', () => {
    const db = seeded({ sessionId: null });
    recover(db, T0, processes(null));
    expect(store.openRequests(db)).toMatchObject([{ reason: 'resume', resumeSessionId: null, firstTurn: null }]);
  });

  it('queues nothing for a task that is waiting on a card or already finished', () => {
    const blocked = seeded({}, { state: 'blocked', blockedFrom: 'running' });
    recover(blocked, T0, processes(null));
    expect(store.getRun(blocked, 'run1')?.outcome).toBe('expired');
    expect(store.openRequests(blocked)).toHaveLength(0);
  });

  it('does nothing when no run was in flight', () => {
    const db = seeded({ outcome: 'done', endedAt: T0.toISOString() });
    expect(recover(db, T0, processes(null))).toEqual({ expired: [], killed: [] });
  });
});
