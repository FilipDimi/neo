/**
 * The single write path. State changes only by emitting events inside `apply`: each event is
 * validated against the catalogue, appended to the log, and projected onto the rows, all in one
 * transaction. Nothing else writes a state table.
 */
import { EngineEvent, subjectsOf, type EventRow } from '../shared/events.ts';
import { changesOf, type TableName } from '../shared/project.ts';
import type { Db } from './open.ts';

export type Tx = {
  /** Records one event and applies it to the rows at once, so later steps of the same change can read it. */
  emit(event: EngineEvent): EventRow;
};

type Listener = (rows: EventRow[]) => void;
const listeners = new WeakMap<Db, Set<Listener>>();

export function getRow<T>(db: Db, table: TableName, id: string): T | undefined {
  const found = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
  return found ? (JSON.parse(found.data) as T) : undefined;
}

function project(db: Db, row: EventRow): void {
  for (const change of changesOf(row, (table, id) => getRow(db, table, id))) {
    if (change.row === null) db.prepare(`DELETE FROM ${change.table} WHERE id = ?`).run(change.id);
    else db.prepare(`INSERT INTO ${change.table} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(change.id, JSON.stringify(change.row));
  }
}

export function apply(db: Db, change: (tx: Tx) => void, at: Date = new Date()): EventRow[] {
  if (db.inTransaction) throw new Error('apply() does not nest: pass the Tx to the helper instead');
  const written: EventRow[] = [];
  const time = at.toISOString();
  db.transaction(() => {
    change({
      emit(raw) {
        const event = EngineEvent.parse(raw);
        const subjects = subjectsOf(event);
        const { lastInsertRowid } = db
          .prepare('INSERT INTO events (at, task_id, run_id, employee_id, team_id, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(time, subjects.taskId, subjects.runId, subjects.employeeId, subjects.teamId, event.kind, JSON.stringify(event));
        const row: EventRow = { id: Number(lastInsertRowid), at: time, ...subjects, event };
        project(db, row);
        written.push(row);
        return row;
      },
    });
  })();
  if (written.length > 0) for (const listener of listeners.get(db) ?? []) listener(written);
  return written;
}

/** Hears every committed change, in order. Returns the function that stops listening. */
export function onEvents(db: Db, listener: Listener): () => void {
  const set = listeners.get(db) ?? new Set<Listener>();
  listeners.set(db, set);
  set.add(listener);
  return () => set.delete(listener);
}

type StoredEvent = { id: number; at: string; task_id: string | null; run_id: string | null; employee_id: string | null; team_id: string | null; payload: string };

export function readEvents(db: Db, sinceId: number, limit = 5000, taskId?: string): EventRow[] {
  const rows = (
    taskId === undefined
      ? db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(sinceId, limit)
      : db.prepare('SELECT * FROM events WHERE id > ? AND task_id = ? ORDER BY id LIMIT ?').all(sinceId, taskId, limit)
  ) as StoredEvent[];
  return rows.map((r) => ({ id: r.id, at: r.at, taskId: r.task_id, runId: r.run_id, employeeId: r.employee_id, teamId: r.team_id, event: JSON.parse(r.payload) as EventRow['event'] }));
}

export function lastEventId(db: Db): number {
  return (db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id;
}

/** Rebuilds the tables of an empty database from a log. */
export function replay(db: Db, rows: EventRow[]): void {
  db.transaction(() => {
    for (const row of rows) {
      db.prepare('INSERT INTO events (id, at, task_id, run_id, employee_id, team_id, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.at, row.taskId, row.runId, row.employeeId, row.teamId, row.event.kind, JSON.stringify(row.event));
      project(db, row);
    }
  })();
}
