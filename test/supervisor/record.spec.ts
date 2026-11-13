import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { RecordEntry } from '../../src/shared/types.ts';
import * as decisions from '../../src/supervisor/decisions.ts';
import { engineToolsFor } from '../../src/supervisor/jobs.ts';
import { builtOnFor, entryId, findEntries, indexFor, oneLine, onReadDecisions, onRecordDecision, recordDecision, recordSection } from '../../src/supervisor/record.ts';
import { exit, scripted } from '../fixtures/scriptedLink.ts';
import { company as companyRow, employee, plus, repo, run, T0, task, team, tempDb, world } from '../helpers.ts';

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
    expect(engineToolsFor({ ...base, mode: 'work' })).toEqual(['report_done', 'request_decision', 'request_tools', 'set_status', 'run_gate', 'wait_for', 'read_decisions']);
    expect(engineToolsFor({ ...base, mode: 'review', lead: true })).toEqual(['submit_review', 'request_decision', 'request_tools', 'set_status', 'run_gate', 'read_decisions', 'record_decision', 'contract_version', 'call_meeting']);
    expect(engineToolsFor({ ...base, mode: 'route', chief: true })).toEqual(['create_task', 'set_status', 'read_decisions', 'record_decision', 'contract_version', 'call_meeting']);
    expect(engineToolsFor({ ...base, mode: 'route', chief: true, deciding: true })).toEqual(['decide', 'set_status', 'read_decisions', 'record_decision', 'contract_version']);
    expect(engineToolsFor({ ...base, mode: 'route', admin: true })).toEqual(expect.arrayContaining(['create_task', 'company_setup', 'set_gates', 'read_decisions']));
    expect(engineToolsFor({ ...base, mode: 'route', admin: true })).not.toContain('record_decision');
  });
});

describe('what a run is shown of the record, and what a ticket is built on', () => {
  it('lists the decisions a ticket is built on with their why, then the newest twenty that still hold, then the contract', () => {
    const db = company();
    for (let i = 1; i <= 25; i++) add(db, `Decision number ${i}.`, { why: `Reason ${i}.`, by: { kind: i === 2 ? 'chief' : 'lead', employeeId: i === 2 ? 'neo' : 'lead' } }, plus(T0, i));
    add(db, 'Decision number 24, revised.', { replaces: 'D-24' }, plus(T0, 30));
    const ticket = task({ repoId: 'repo1', builtOn: { decisions: ['D-2', 'D-99'], contract: null } });
    const index = indexFor(db, ticket);
    expect(index.cited.map((entry) => entry.id)).toEqual(['D-2']);
    expect(index.recent).toHaveLength(20);
    expect(index.recent.map((entry) => entry.id)).toEqual(expect.not.arrayContaining(['D-2', 'D-24']));
    expect(index.recent[0]!.id).toBe('D-26');
    const section = recordSection(db, index);
    expect(section).toContain('- D-2 (2026-11-09, Neo, for the user): Decision number 2. Why: Reason 2.');
    expect(section).toContain('- D-26 (2026-11-09, Priya): Decision number 24, revised.');
    expect(section.indexOf('D-2 (')).toBeLessThan(section.indexOf('D-26 ('));
    expect(section).toContain('mcp__engine__read_decisions');
    expect(section).not.toMatch(/contract/i);
    // Every line of the index is one line, however long the decision.
    add(db, `${'A very long statement. '.repeat(20)}\nAnd a second line.`);
    for (const line of recordSection(db, indexFor(db, ticket)).split('\n')) expect(line.length).toBeLessThanOrEqual(220);

    // A repository with a contract: where it is, its version, and that this ticket changes it.
    apply(db, (tx) => {
      tx.emit({ kind: 'repo_changed', repo: repo({ contract: { paths: ['docs/contract'] } }) });
      tx.emit({ kind: 'contract_version_issued', issued: { id: 'cv1', repoId: 'repo1', version: '0.10.1', change: 'start', summary: '', taskId: null, decisions: [], by: null, at: T0.toISOString() } });
    });
    const withContract = recordSection(db, indexFor(db, { ...ticket, contractVersion: '0.10.2' }));
    expect(withContract).toContain('The contract is docs/contract. The newest version handed out for it is 0.10.1.');
    expect(withContract).toContain('This ticket changes the contract. Its version is 0.10.2: the contract\'s files must state it.');
    // Nothing on record and no contract: nothing is said.
    expect(recordSection(tempDb(), { cited: [], recent: [], contract: null, changesContractTo: null })).toBe('');
  });

  it('puts the index in the first turn of a fresh run and not in one that carries on a session', async () => {
    const fake = scripted((worker) => {
      if (fake.workers.length > 1) return;
      worker.say({ t: 'event', event: { kind: 'session_started', sessionId: 'sess-1', model: 'm', loginSource: 'none', tools: [] } });
      worker.say(exit('failed', 'crashed', 'sess-1'));
    });
    const w = world(fake.spawn);
    add(w.db, 'The API speaks JSON.');
    w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Write the note', brief: 'Write it.' });
    for (let i = 0; i < 3; i++) {
      await w.sup.tick();
      await new Promise((resolve) => setImmediate(resolve));
      await w.sup.settle();
    }
    expect(fake.workers).toHaveLength(2);
    expect(fake.workers[0]!.job.firstTurn).toContain('- D-1 (2026-11-09, a team lead): The API speaks JSON.');
    expect(fake.workers[1]!.job.resumeSessionId).toBe('sess-1');
    expect(fake.workers[1]!.job.firstTurn).not.toContain('D-1');
    await w.sup.stop();
  });

  it('records what a ticket is built on: the decisions its maker named, its parent\'s with them, and the contract of the day', () => {
    const w = world(scripted().spawn);
    add(w.db, 'The API speaks JSON.');
    add(w.db, 'Dates are ISO 8601.');
    const base = { teamId: 'team1', assigneeId: 'emp1', title: 'Write the note', brief: 'Write it.' };
    expect(() => w.sup.createTask({ ...base, decisions: ['D-1', 'D-9'] })).toThrow(/no decision D-9/);
    expect(w.sup.createTask({ ...base, decisions: ['d-2', 'D-2'] }).builtOn).toEqual({ decisions: ['D-2'], contract: null });
    // A ticket built on nothing, where there is no contract, says nothing.
    expect(w.sup.createTask({ ...base, title: 'Write another note' }).builtOn).toBeUndefined();
    const parent = task({ builtOn: { decisions: ['D-1'], contract: '0.3.0' } });
    expect(builtOnFor(w.db, { decisions: ['D-2', 'D-1'], parent, repoId: null })).toEqual({ decisions: ['D-1', 'D-2'], contract: null });
  });

  it('knows a decision by its number however it is written: as a file names it, as a log does, in small letters, or bare', () => {
    const db = company();
    for (let i = 1; i <= 45; i++) add(db, `Decision number ${i}.`);
    for (const written of ['D-0045', 'd-45', 'D-045', '45', ' D45 ']) expect(findEntries(db, { ids: [written] }).map((entry) => entry.id), written).toEqual(['D-45']);
    expect(onReadDecisions(db, { ids: ['D-0045'] }).text).toContain('Decision number 45.');
    expect(builtOnFor(db, { decisions: ['D-0007', 'd-7'], repoId: null })).toEqual({ decisions: ['D-7'], contract: null });
    expect(onRecordDecision(db, T0, runOf('lead'), { statement: 'Decision number 45, revised.', why: '', replaces: 'd-0045' }).text).toBe('Recorded as D-46.');
    expect(store.getEntry(db, 'D-45')!.replacedBy).toBe('D-46');
    expect(findEntries(db, { ids: ['not a number'] })).toEqual([]);
  });

  it('does not pass off a log kept by hand as what the chief of staff decided', () => {
    const db = company();
    apply(db, (tx) => tx.emit({ kind: 'record_changed', entry: { id: 'D-1', n: 1, at: T0.toISOString(), statement: 'From the old log.', why: '', by: { kind: 'chief', employeeId: 'neo' }, taskId: null, repoId: 'repo1', replaces: null, replacedBy: null, archived: true } }));
    onRecordDecision(db, T0, runOf('neo'), { statement: 'Launch in two regions.', why: 'Nobody said which.' });
    // "What was assumed for me" is what the chief of staff decided, not everything a file once held.
    expect(findEntries(db, { by: 'chief' }).map((entry) => entry.id)).toEqual(['D-2']);
    expect(onReadDecisions(db, { ids: ['D-1'] }).text).toMatch(/^D-1 · 2026-11-09 · the log kept by hand/);
    expect(recordSection(db, indexFor(db, task()))).toContain('- D-1 (2026-11-09, the log kept by hand): From the old log.');
  });

  it('files the question itself, not the card\'s preamble, and says no contract where a repository has none any more', () => {
    const db = company();
    let id = '';
    const preamble = 'Ada has asked 3 times in a row about "Do the thing" and done no work in between. It is probably missing something an answer cannot give it.';
    apply(db, (tx) => void (id = decisions.raise(tx, db, T0, { taskId: 'task1', kind: 'question', text: `${preamble} Its question: Which of the two layouts?`, freeText: true, options: decisions.optionsFor('question', {}), subject: { question: 'Which of the two layouts?' } }).id));
    decisions.answer(db, T0, id, { optionId: 'answer', text: 'The new one.' });
    expect(store.getEntry(db, 'D-1')!.statement).toBe('Which of the two layouts? Answer: The new one.');
    // A version was handed out once; the repository names no contract now.
    apply(db, (tx) => tx.emit({ kind: 'contract_version_issued', issued: { id: 'cv1', repoId: 'repo1', version: '0.3.0', change: 'start', summary: '', taskId: null, decisions: [], by: null, at: T0.toISOString() } }));
    expect(builtOnFor(db, { repoId: 'repo1' })).toBeUndefined();
    apply(db, (tx) => tx.emit({ kind: 'repo_changed', repo: repo({ contract: { paths: ['docs/contract'] } }) }));
    expect(builtOnFor(db, { repoId: 'repo1' })).toEqual({ decisions: [], contract: '0.3.0' });
  });
});
