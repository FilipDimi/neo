/**
 * The company's record: what was decided, by whom, in a numbered list the engine keeps. Agents add to
 * it through tools and read it at the start of their runs; nothing is ever deleted from it, and no
 * two decisions can be given one number, because the number is taken inside the write that stores it.
 */
import type { Tx } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { RecordEntry } from '../shared/types.ts';

export const entryId = (n: number): string => `D-${n}`;

/** The first line of a text, its spaces tidied, cut where it would run past `max`. For an index, a title, a label. */
export function oneLine(text: string, max: number): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export type NewEntry = { statement: string; why: string; by: RecordEntry['by']; taskId?: string | null; repoId?: string | null; replaces?: string | null; detail?: string };

/** Files one decision under the next number. A decision it replaces is marked, never removed. */
export function recordDecision(tx: Tx, db: Db, now: Date, input: NewEntry): RecordEntry {
  const replaced = input.replaces ? store.getEntry(db, input.replaces) : undefined;
  if (input.replaces && !replaced) throw new Error(`There is no decision ${input.replaces} to replace.`);
  if (replaced?.replacedBy) throw new Error(`${replaced.id} was already replaced by ${replaced.replacedBy}. Replace that one, if this reverses it.`);
  const n = (store.allRecord(db).at(-1)?.n ?? 0) + 1;
  const entry: RecordEntry = {
    id: entryId(n),
    n,
    at: now.toISOString(),
    statement: input.statement.trim(),
    why: input.why.trim(),
    by: input.by,
    taskId: input.taskId ?? null,
    repoId: input.repoId ?? null,
    replaces: replaced?.id ?? null,
    replacedBy: null,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  tx.emit({ kind: 'record_changed', entry });
  if (replaced) tx.emit({ kind: 'record_changed', entry: { ...replaced, replacedBy: entry.id } });
  return entry;
}

export type Query = { ids?: string[]; search?: string; by?: RecordEntry['by']['kind']; since?: Date };

/**
 * Decisions by their numbers, in the order asked for; or, newest first, those that hold every word of
 * `search` somewhere in what they say, why, or the question and answer they came from.
 */
export function findEntries(db: Db, query: Query): RecordEntry[] {
  if (query.ids) return query.ids.flatMap((id) => store.getEntry(db, id.trim().toUpperCase()) ?? []);
  const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const since = query.since?.toISOString();
  return store
    .allRecord(db)
    .filter((entry) => {
      if (query.by && entry.by.kind !== query.by) return false;
      if (since && entry.at < since) return false;
      const text = `${entry.id} ${entry.statement} ${entry.why} ${entry.detail ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .reverse();
}
