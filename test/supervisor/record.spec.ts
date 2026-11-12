import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { RecordEntry } from '../../src/shared/types.ts';
import { entryId, findEntries, oneLine, recordDecision } from '../../src/supervisor/record.ts';
import { plus, T0, tempDb } from '../helpers.ts';

const lead = { kind: 'lead' as const, employeeId: 'lead' };
type Over = Partial<Parameters<typeof recordDecision>[3]>;
/** Records one decision in a change of its own, as a tool call does. */
function add(db: ReturnType<typeof tempDb>, statement: string, over: Over = {}, at = T0): RecordEntry {
  let made!: RecordEntry;
  apply(db, (tx) => void (made = recordDecision(tx, db, at, { statement, why: 'Because.', by: lead, ...over })), at);
  return made;
}

describe('the record: numbered decisions', () => {
  it('hands out numbers that rise by one and never repeat, across changes and inside one', () => {
    const db = tempDb();
    expect(add(db, 'The API speaks JSON.')).toMatchObject({ id: 'D-1', n: 1, replaces: null, replacedBy: null, taskId: null, repoId: null });
    expect(add(db, 'Dates are ISO 8601.').id).toBe('D-2');
    const both: string[] = [];
    apply(db, (tx) => {
      both.push(recordDecision(tx, db, T0, { statement: 'Money is in cents.', why: '', by: lead }).id);
      both.push(recordDecision(tx, db, T0, { statement: 'Names are trimmed.', why: '', by: lead }).id);
    });
    expect(both).toEqual(['D-3', 'D-4']);
    expect(store.allRecord(db).map((entry) => entry.id)).toEqual(['D-1', 'D-2', 'D-3', 'D-4']);
    expect(entryId(232)).toBe('D-232');
  });

  it('reverses a decision with a new one that points back, and marks the old one', () => {
    const db = tempDb();
    add(db, 'The API speaks JSON.');
    const next = add(db, 'The API speaks JSON and CSV.', { replaces: 'D-1' });
    expect(next).toMatchObject({ id: 'D-2', replaces: 'D-1' });
    expect(store.getEntry(db, 'D-1')).toMatchObject({ replacedBy: 'D-2', statement: 'The API speaks JSON.' });
    // What is already replaced is replaced by saying so of the newer one; what does not exist cannot be replaced.
    expect(() => add(db, 'CSV only.', { replaces: 'D-1' })).toThrow(/D-1 was already replaced by D-2/);
    expect(() => add(db, 'CSV only.', { replaces: 'D-9' })).toThrow(/no decision D-9/);
    expect(store.allRecord(db)).toHaveLength(2);
  });

  it('keeps a statement whole and gives one line of it where one line is wanted', () => {
    expect(oneLine('a\n| b |\n**c**', 160)).toBe('a');
    expect(oneLine('  spaced   out\ttext  ', 160)).toBe('spaced out text');
    expect(oneLine('x'.repeat(200), 160)).toBe(`${'x'.repeat(159)}…`);
    const db = tempDb();
    expect(add(db, 'First line.\nSecond | line.').statement).toBe('First line.\nSecond | line.');
  });

  it('finds decisions by number, by words, by who decided and by when', () => {
    const db = tempDb();
    add(db, 'The API speaks JSON.', { why: 'Every client has a parser.' });
    add(db, 'Dates are ISO 8601.', { by: { kind: 'user', employeeId: null } }, plus(T0, 3600));
    add(db, 'Rate limits answer 429.', { by: { kind: 'chief', employeeId: 'neo' }, detail: 'Question: what code? Answer: 429, with a parser-friendly body.' }, plus(T0, 7200));
    expect(findEntries(db, { ids: ['D-3', 'D-1', 'D-77'] }).map((entry) => entry.id)).toEqual(['D-3', 'D-1']);
    // Every word, in any order and any case, in the statement, the why or the detail; newest first.
    expect(findEntries(db, { search: 'PARSER' }).map((entry) => entry.id)).toEqual(['D-3', 'D-1']);
    expect(findEntries(db, { search: 'json api' }).map((entry) => entry.id)).toEqual(['D-1']);
    expect(findEntries(db, { search: 'json 429' })).toEqual([]);
    expect(findEntries(db, { by: 'chief' }).map((entry) => entry.id)).toEqual(['D-3']);
    expect(findEntries(db, { since: plus(T0, 1800) }).map((entry) => entry.id)).toEqual(['D-3', 'D-2']);
    expect(findEntries(db, {}).map((entry) => entry.id)).toEqual(['D-3', 'D-2', 'D-1']);
  });
});
