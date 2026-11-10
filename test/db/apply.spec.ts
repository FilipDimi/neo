import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, getRow, onEvents, readEvents, replay } from '../../src/db/apply.ts';
import { dataDir, paths } from '../../src/db/dataDir.ts';
import { openDb, type Db } from '../../src/db/open.ts';
import type { Task } from '../../src/shared/types.ts';
import { company, decision, employee, plus, request, run, T0, task, team, tempDb, tempDir } from '../helpers.ts';

const TABLES = ['company', 'repos', 'teams', 'employees', 'tasks', 'runs', 'run_requests', 'decisions', 'messages', 'grants', 'meta'];
const dump = (db: Db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT id, data FROM ${t} ORDER BY id`).all()]));
const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('apply', () => {
  it('writes the row and its event together, with increasing ids and ISO times', () => {
    const db = tempDb();
    const [a] = apply(db, (tx) => tx.emit({ kind: 'task_changed', task: task(), cause: 'created' }), T0);
    const [b] = apply(db, (tx) => tx.emit({ kind: 'task_changed', task: task({ state: 'running' }), cause: 'state' }), plus(T0, 1));
    expect(b!.id).toBe(a!.id + 1);
    expect(a!.at).toBe('2026-11-09T18:00:00.000Z');
    expect(a).toMatchObject({ taskId: 'task1', runId: null, teamId: 'team1' });
    expect(getRow<Task>(db, 'tasks', 'task1')?.state).toBe('running');
  });

  it('rolls everything back when one event fails validation', () => {
    const db = tempDb();
    expect(() =>
      apply(db, (tx) => {
        tx.emit({ kind: 'task_changed', task: task(), cause: 'created' });
        tx.emit({ kind: 'nope' } as never);
      }),
    ).toThrow();
    expect(count(db, 'tasks')).toBe(0);
    expect(count(db, 'events')).toBe(0);
  });

  it('lets a later step of the same change read what an earlier step wrote', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'task_changed', task: task(), cause: 'created' });
      expect(getRow<Task>(db, 'tasks', 'task1')?.title).toBe('Do the thing');
    });
  });

  it('tells listeners after the change is committed, and not when it fails', () => {
    const db = tempDb();
    const heard: string[] = [];
    const off = onEvents(db, (rows) => heard.push(...rows.map((r) => `${r.event.kind}:${count(db, 'tasks')}`)));
    apply(db, (tx) => tx.emit({ kind: 'task_changed', task: task(), cause: 'created' }));
    expect(() => apply(db, (tx) => tx.emit({ kind: 'nope' } as never))).toThrow();
    off();
    apply(db, (tx) => tx.emit({ kind: 'team_changed', team: team() }));
    expect(heard).toEqual(['task_changed:1']);
  });

  it('reads events after an id, in order, optionally for one task', () => {
    const db = tempDb();
    const [a] = apply(db, (tx) => tx.emit({ kind: 'task_changed', task: task(), cause: 'created' }));
    apply(db, (tx) => {
      tx.emit({ kind: 'task_changed', task: task({ id: 'task2' }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ state: 'running' }), cause: 'state' });
    });
    expect(readEvents(db, a!.id).map((e) => e.taskId)).toEqual(['task2', 'task1']);
    expect(readEvents(db, 0, 10, 'task1')).toHaveLength(2);
    expect(readEvents(db, 0, 1)).toHaveLength(1);
  });

  it('replaying the log into an empty database reproduces every table', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'company_changed', company: company() });
      tx.emit({ kind: 'team_changed', team: team() });
      tx.emit({ kind: 'employee_changed', employee: employee() });
      tx.emit({ kind: 'task_changed', task: task(), cause: 'created' });
      tx.emit({ kind: 'run_requested', request: request() });
    }, T0);
    apply(db, (tx) => tx.emit({ kind: 'run_started', run: run(), requestId: 'req1', teamId: 'team1' }), plus(T0, 1));
    apply(
      db,
      (tx) => {
        tx.emit({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'usage', inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, sessionCostUsd: 0.25 } });
        tx.emit({ kind: 'run_activity', runId: 'run1', taskId: 'task1', employeeId: 'emp1', text: 'working' });
        tx.emit({ kind: 'decision_raised', decision: decision() });
        tx.emit({ kind: 'plan_usage', status: 'allowed', window: 'seven_day', utilization: 0.4, resetsAt: 1 });
      },
      plus(T0, 30),
    );
    const empty = tempDb();
    replay(empty, readEvents(db, 0));
    expect(dump(empty)).toEqual(dump(db));
    expect(count(empty, 'events')).toBe(count(db, 'events'));
    expect(count(db, 'run_requests')).toBe(0);
  });

  it('opening twice applies the schema once and keeps the data', () => {
    const file = path.join(tempDir(), 'company.db');
    const first = openDb(file);
    apply(first, (tx) => tx.emit({ kind: 'team_changed', team: team() }));
    first.close();
    const second = openDb(file);
    expect(count(second, 'teams')).toBe(1);
    expect(second.pragma('journal_mode', { simple: true })).toBe('wal');
  });
});

describe('the data directory', () => {
  it('uses VS_DATA_DIR, creates it private, and names the places inside it', () => {
    const dir = path.join(tempDir(), 'data');
    const made = dataDir({ VS_DATA_DIR: dir });
    expect(made).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(paths(dir)).toMatchObject({ db: path.join(dir, 'company.db'), token: path.join(dir, 'token'), folders: path.join(dir, 'folders'), memory: path.join(dir, 'memory') });
  });

  it('defaults to a folder in the home directory, outside any repository', () => {
    expect(dataDir({ HOME: tempDir() }, false)).toMatch(/\.virtual-startup$/);
  });
});
