import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import type { Db } from '../../src/db/open.ts';
import * as store from '../../src/db/store.ts';
import { answer, optionsFor, raise } from '../../src/supervisor/decisions.ts';
import { company, employee, plus, request, run, T0, task, team, tempDb } from '../helpers.ts';

function seeded(taskOver = {}, runOver = {}): Db {
  const db = tempDb();
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company() });
    tx.emit({ kind: 'team_changed', team: team({ leadId: 'lead' }) });
    tx.emit({ kind: 'employee_changed', employee: employee() });
    tx.emit({ kind: 'task_changed', task: task({ state: 'running', assigneeId: 'emp1', ...taskOver }), cause: 'created' });
    tx.emit({ kind: 'run_ended', run: run({ outcome: 'expired', sessionId: 'sess-1', endedAt: T0.toISOString(), costUsd: 0.4, ...runOver }), teamId: 'team1' });
  });
  return db;
}

const raiseLease = (db: Db) => apply(db, (tx) => raise(tx, db, T0, { taskId: 'task1', runId: 'run1', employeeId: 'emp1', kind: 'lease', text: 'Expired twice.', options: optionsFor('lease', { leaseMinutes: 15 }) }), T0);

describe('raise', () => {
  it('raising a card blocks the task, remembers its state and records the cost so far', () => {
    const db = seeded();
    raiseLease(db);
    expect(store.getTask(db, 'task1')).toMatchObject({ state: 'blocked', blockedFrom: 'running', blockedAt: T0.toISOString() });
    expect(store.openDecisions(db)[0]).toMatchObject({ kind: 'lease', taskId: 'task1', costSoFarUsd: 0.4, answer: null });
  });

  it('raises one open card per task and kind', () => {
    const db = seeded();
    raiseLease(db);
    raiseLease(db);
    expect(store.openDecisions(db)).toHaveLength(1);
  });

  it('raises a card with no task without blocking anything', () => {
    const db = seeded();
    apply(db, (tx) => raise(tx, db, T0, { taskId: null, kind: 'usage_limit', text: 'The plan limit was reached.', options: optionsFor('usage_limit') }));
    expect(store.openDecisions(db)).toHaveLength(1);
    expect(store.getTask(db, 'task1')?.state).toBe('running');
  });
});

describe('answer', () => {
  it('Retry on a lease card unblocks the task and queues a retry with the longer lease', () => {
    const db = seeded();
    raiseLease(db);
    const [card] = store.openDecisions(db);
    expect(card!.options[0]).toMatchObject({ label: 'Retry, 30 min', effect: 'retry', params: { leaseMinutes: 30 } });
    expect(answer(db, plus(T0, 60), card!.id, { optionId: 'retry' }).result).toBe('applied');
    expect(store.getTask(db, 'task1')).toMatchObject({ state: 'running', blockedFrom: null });
    expect(store.openRequests(db)[0]).toMatchObject({ reason: 'retry', mode: 'work', employeeId: 'emp1', leaseMinutes: 30, resumeSessionId: 'sess-1', attempt: 1 });
    expect(store.openDecisions(db)).toHaveLength(0);
  });

  it('Stop it fails the task from blocked, drops its requests and fails its open children', () => {
    const db = seeded();
    apply(db, (tx) => {
      tx.emit({ kind: 'task_changed', task: task({ id: 'kid', parentId: 'task1', state: 'queued' }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'done-kid', parentId: 'task1', state: 'done' }), cause: 'created' });
      tx.emit({ kind: 'run_requested', request: request({ id: 'kid-req', taskId: 'kid' }) });
    });
    raiseLease(db);
    answer(db, T0, store.openDecisions(db)[0]!.id, { optionId: 'stop' });
    expect(store.getTask(db, 'task1')?.state).toBe('failed');
    expect(store.getTask(db, 'kid')?.state).toBe('failed');
    expect(store.getTask(db, 'done-kid')?.state).toBe('done');
    expect(store.openRequests(db)).toHaveLength(0);
  });

  it('ignores a second answer and an answer for a finished task', () => {
    const db = seeded();
    raiseLease(db);
    const id = store.openDecisions(db)[0]!.id;
    expect(answer(db, T0, id, { optionId: 'retry' }).result).toBe('applied');
    expect(answer(db, T0, id, { optionId: 'stop' }).result).toBe('ignored');
    expect(store.getTask(db, 'task1')?.state).toBe('running');
    expect(store.openRequests(db)).toHaveLength(1);

    const other = seeded();
    raiseLease(other);
    apply(other, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(other, 'task1')!, state: 'failed', blockedFrom: null }, cause: 'state' }));
    const late = store.openDecisions(other)[0]!.id;
    expect(answer(other, T0, late, { optionId: 'retry' }).result).toBe('ignored');
    expect(store.openRequests(other)).toHaveLength(0);
    expect(store.openDecisions(other)).toHaveLength(0);
  });

  it('refuses an option the card does not have', () => {
    const db = seeded();
    raiseLease(db);
    expect(() => answer(db, T0, store.openDecisions(db)[0]!.id, { optionId: 'merge' })).toThrow(/option/);
  });

  it("an answer to a question resumes the session with the answer as its first turn", () => {
    const db = seeded({}, { outcome: 'stopped' });
    apply(db, (tx) => raise(tx, db, T0, { taskId: 'task1', runId: 'run1', employeeId: 'emp1', kind: 'question', text: 'Blue or green?', freeText: true, options: optionsFor('question', { choices: ['Blue', 'Green'] }) }));
    const card = store.openDecisions(db)[0]!;
    expect(card.options.map((o) => o.label)).toEqual(['Blue', 'Green', 'Answer', 'Stop it']);
    answer(db, T0, card.id, { optionId: 'answer', text: 'Teal, actually.' });
    expect(store.openRequests(db)[0]).toMatchObject({ reason: 'resume', resumeSessionId: 'sess-1' });
    expect(store.openRequests(db)[0]!.firstTurn).toContain('Teal, actually.');
  });

  it('Raise by adds to the cap and resumes the session', () => {
    const db = seeded({ capUsd: 2 }, { outcome: 'over_budget' });
    apply(db, (tx) => raise(tx, db, T0, { taskId: 'task1', runId: 'run1', kind: 'cap', text: 'Over its cap.', options: optionsFor('cap', { capUsd: 2 }) }));
    const card = store.openDecisions(db)[0]!;
    expect(card.options[0]).toMatchObject({ label: 'Raise by $2.00', effect: 'raise_cap' });
    answer(db, T0, card.id, { optionId: 'raise' });
    expect(store.getTask(db, 'task1')).toMatchObject({ capUsd: 4, state: 'running' });
    expect(store.openRequests(db)[0]).toMatchObject({ reason: 'resume', resumeSessionId: 'sess-1' });
  });

  it('Allow once stores a grant for exactly the refused call', () => {
    const db = seeded({}, { outcome: 'refused' });
    apply(db, (tx) => raise(tx, db, T0, { taskId: 'task1', runId: 'run1', kind: 'tool', text: 'Wants to write outside.', options: optionsFor('tool'), subject: { tool: 'Write', inputHash: 'abc' } }));
    answer(db, T0, store.openDecisions(db)[0]!.id, { optionId: 'allow_once' });
    expect(store.grantsOf(db, 'task1')).toMatchObject([{ tool: 'Write', inputHash: 'abc', used: false }]);
    expect(store.openRequests(db)[0]!.firstTurn).toMatch(/allowed once/);
  });

  it('Resume now lifts a company pause', () => {
    const db = seeded();
    apply(db, (tx) => {
      tx.emit({ kind: 'company_changed', company: company({ paused: { reason: 'usage_limit', until: null } }) });
      raise(tx, db, T0, { taskId: null, kind: 'usage_limit', text: 'Paused.', options: optionsFor('usage_limit') });
    });
    answer(db, T0, store.openDecisions(db)[0]!.id, { optionId: 'resume' });
    expect(store.getCompany(db)?.paused).toBeNull();
  });
});
