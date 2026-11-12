import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { RecordEntry } from '../../src/shared/types.ts';
import * as decisions from '../../src/supervisor/decisions.ts';
import { engineToolsFor } from '../../src/supervisor/jobs.ts';
import { entryId, findEntries, oneLine, onReadDecisions, onRecordDecision, recordDecision } from '../../src/supervisor/record.ts';
import { company as companyRow, employee, plus, repo, run, T0, task, team, tempDb } from '../helpers.ts';

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

/** Neo is chief of staff; Priya leads Ada, in a repository; one ticket is on the board. */
function company() {
  const db = tempDb();
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: companyRow({ chiefOfStaffId: 'neo' }) });
    tx.emit({ kind: 'repo_changed', repo: repo() });
    tx.emit({ kind: 'team_changed', team: team({ id: 'office', name: 'Office', leadId: 'neo' }) });
    tx.emit({ kind: 'team_changed', team: team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'main', mergeTarget: null }] }) });
    for (const person of [employee({ id: 'neo', name: 'Neo', teamId: 'office' }), employee({ id: 'lead', name: 'Priya' }), employee()]) tx.emit({ kind: 'employee_changed', employee: person });
    tx.emit({ kind: 'task_changed', task: task({ repoId: 'repo1', state: 'running' }), cause: 'created' });
  });
  return db;
}
const runOf = (employeeId: string) => run({ id: `run-${employeeId}`, employeeId });

describe('writing and reading decisions with the tools', () => {
  it('lets a lead and the chief of staff record, files who decided, and refuses everyone else in words', () => {
    const db = company();
    expect(onRecordDecision(db, T0, runOf('lead'), { statement: 'Errors are problem+json.', why: 'One shape for every client.' })).toEqual({ ok: true, text: 'Recorded as D-1.' });
    expect(store.getEntry(db, 'D-1')).toMatchObject({ by: { kind: 'lead', employeeId: 'lead' }, taskId: 'task1', repoId: 'repo1', why: 'One shape for every client.' });
    expect(onRecordDecision(db, T0, runOf('neo'), { statement: 'Launch in two regions.', why: 'Nobody said which.' }).ok).toBe(true);
    expect(store.getEntry(db, 'D-2')!.by).toEqual({ kind: 'chief', employeeId: 'neo' });
    // What the user said, written down by the chief of staff, is the user's.
    expect(onRecordDecision(db, T0, runOf('neo'), { statement: 'Launch in one region.', why: 'The user said so in the chat.', replaces: 'D-2', onBehalfOfUser: true }).text).toBe('Recorded as D-3.');
    expect(store.getEntry(db, 'D-3')).toMatchObject({ by: { kind: 'user', employeeId: null }, replaces: 'D-2' });
    const refused = onRecordDecision(db, T0, runOf('emp1'), { statement: 'Use tabs.', why: '' });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/request_decision/);
    expect(onRecordDecision(db, T0, runOf('lead'), { statement: 'The user wants tabs.', why: '', onBehalfOfUser: true })).toMatchObject({ ok: false, text: expect.stringMatching(/chief of staff/) });
    expect(onRecordDecision(db, T0, runOf('lead'), { statement: 'Again.', why: '', replaces: 'D-2' })).toMatchObject({ ok: false, text: expect.stringMatching(/already replaced by D-3/) });
    expect(onRecordDecision(db, T0, runOf('lead'), { statement: '  ', why: '' }).ok).toBe(false);
    expect(store.allRecord(db)).toHaveLength(3);
  });

  it('reads decisions back whole, by number or by words, and says what replaced one', () => {
    const db = company();
    onRecordDecision(db, T0, runOf('lead'), { statement: 'Errors are problem+json.', why: 'One shape for every client.' });
    onRecordDecision(db, plus(T0, 60), runOf('neo'), { statement: 'Errors are problem+json with a code.', why: 'Clients switch on the code.', replaces: 'D-1' });
    const one = onReadDecisions(db, { ids: ['d-1'] });
    expect(one.ok).toBe(true);
    for (const part of ['D-1', '2026-11-09', 'Priya', 'Errors are problem+json.', 'One shape for every client.', 'Replaced by D-2']) expect(one.text, part).toContain(part);
    expect(onReadDecisions(db, { search: 'code clients' }).text).toMatch(/^D-2 .*Neo, for the user/);
    expect(onReadDecisions(db, { search: 'nothing like this' })).toEqual({ ok: true, text: 'Nothing on record matches.' });
    expect(onReadDecisions(db, {}).text).toMatch(/D-2[\s\S]*D-1/);
  });

  it('files the answer to a question card by itself, as the user\'s or as the chief of staff\'s for the user', () => {
    const db = company();
    const ask = (question: string, choices: string[] = []) => {
      let id = '';
      apply(db, (tx) => void (id = decisions.raise(tx, db, T0, { taskId: 'task1', kind: 'question', text: question, freeText: true, options: decisions.optionsFor('question', { choices }) }).id));
      return id;
    };
    decisions.answer(db, T0, ask('Ada asks about "Do the thing": Formal or friendly?\nThe store page is read by everyone.'), { optionId: 'answer', text: 'Friendly.\nKeep it to two lines.' });
    expect(store.getEntry(db, 'D-1')).toMatchObject({
      statement: 'Ada asks about "Do the thing": Formal or friendly? Answer: Friendly.',
      by: { kind: 'user', employeeId: null },
      taskId: 'task1',
      repoId: 'repo1',
      detail: 'Question:\nAda asks about "Do the thing": Formal or friendly?\nThe store page is read by everyone.\n\nAnswer:\nFriendly.\nKeep it to two lines.',
    });
    // A button that carries its own answer, pressed by the chief of staff for the user.
    decisions.answer(db, T0, ask('Ada asks: which region first?', ['Europe', 'Asia']), { optionId: 'choice2', by: 'neo', why: 'More of the waiting list is there.' });
    expect(store.getEntry(db, 'D-2')).toMatchObject({ statement: 'Ada asks: which region first? Answer: Asia', by: { kind: 'chief', employeeId: 'neo' }, why: 'More of the waiting list is there.' });
    // A card that is not a question, and a question that was stopped, decide nothing about the product.
    let merge = '';
    apply(db, (tx) => void (merge = decisions.raise(tx, db, T0, { taskId: 'task1', kind: 'merge', text: 'Merge it?', options: decisions.optionsFor('merge') }).id));
    decisions.answer(db, T0, merge, { optionId: 'keep' });
    decisions.answer(db, T0, ask('Ada asks: tabs or spaces?'), { optionId: 'stop' });
    expect(store.allRecord(db)).toHaveLength(2);
  });

  it('gives every run the tool that reads decisions, and the ones that write only to a lead or the chief of staff', () => {
    const base = { deciding: false, admin: false, chief: false, lead: false };
    expect(engineToolsFor({ ...base, mode: 'work' })).toEqual(['report_done', 'request_decision', 'request_tools', 'set_status', 'run_gate', 'read_decisions']);
    expect(engineToolsFor({ ...base, mode: 'review', lead: true })).toEqual(['submit_review', 'request_decision', 'request_tools', 'set_status', 'run_gate', 'read_decisions', 'record_decision', 'contract_version']);
    expect(engineToolsFor({ ...base, mode: 'route', chief: true })).toEqual(['create_task', 'set_status', 'read_decisions', 'record_decision', 'contract_version']);
    expect(engineToolsFor({ ...base, mode: 'route', chief: true, deciding: true })).toEqual(['decide', 'set_status', 'read_decisions', 'record_decision', 'contract_version']);
    expect(engineToolsFor({ ...base, mode: 'route', admin: true })).toEqual(expect.arrayContaining(['create_task', 'company_setup', 'set_gates', 'read_decisions']));
    expect(engineToolsFor({ ...base, mode: 'route', admin: true })).not.toContain('record_decision');
  });
});
