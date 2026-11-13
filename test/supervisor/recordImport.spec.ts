import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { recordDecision } from '../../src/supervisor/record.ts';
import { importDecisions, parseLog } from '../../src/supervisor/recordImport.ts';
import { gitIn, gitRepo, repo, T0, task, tempDb } from '../helpers.ts';

const HEAD = '# Decisions\n\nNumbered, never deleted.\n\n| ID | Date | Decision | Why |\n|----|------|----------|-----|\n';
const row = (n: number, decision: string, why = 'Because.') => `| D-${String(n).padStart(3, '0')} | 2026-11-07 | ${decision} | ${why} |\n`;

describe('reading a log of decisions kept by hand', () => {
  it('takes each row of the table as a decision, and is not split by a bar inside code or after a backslash', () => {
    const text = `${HEAD}${row(1, '**Errors.** One shape: `a | b`, always.', 'Every client \\| every time.')}${row(2, 'Plain.', '')}not a row\n| D-x | nope | x | y |\n${row(40, 'Later | on.', 'Split | why.')}`;
    expect(parseLog(text)).toEqual([
      { n: 1, date: '2026-11-07', statement: '**Errors.** One shape: `a | b`, always.', why: 'Every client | every time.' },
      { n: 2, date: '2026-11-07', statement: 'Plain.', why: '' },
      // A bare bar does split: what follows the third cell is all why.
      { n: 40, date: '2026-11-07', statement: 'Later', why: 'on. | Split | why.' },
    ]);
    expect(parseLog('no table here')).toEqual([]);
  });

  it('imports with the numbers and dates kept, settles a number two branches used twice, and does nothing the second time', async () => {
    const dir = gitRepo(['team']);
    const write = (branch: string, rows: string) => {
      gitIn(dir, 'checkout', '-q', branch);
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs/decisions.md'), `${HEAD}${rows}`);
      gitIn(dir, 'add', '-A');
      gitIn(dir, 'commit', '-q', '-m', `log on ${branch}`);
    };
    write('main', row(1, 'The API speaks JSON.') + row(2, 'Dates are ISO 8601.'));
    write('team', row(1, 'The API  speaks JSON.') + row(2, 'Money is in cents.') + row(3, 'Names are trimmed.'));
    gitIn(dir, 'checkout', '-q', 'main');
    const db = tempDb();
    const here = repo({ path: dir });
    const first = await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main', 'team']);
    expect(first).toEqual({ imported: 4, already: 0, skipped: [], moved: [], renumbered: [{ from: 'D-2', branch: 'team', to: 'D-4', because: 'branch' }] });
    expect(store.allRecord(db).map((entry) => [entry.id, entry.statement, entry.at, entry.archived, entry.by.kind, entry.repoId])).toEqual([
      ['D-1', 'The API speaks JSON.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
      ['D-2', 'Dates are ISO 8601.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
      ['D-3', 'Names are trimmed.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
      ['D-4', 'Money is in cents.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
    ]);
    expect(store.getEntry(db, 'D-4')!.importedFrom).toBe('team, where it was D-2');
    expect(store.getEntry(db, 'D-1')!.why).toBe('Because.');
    // Again: everything is there already, the renumbered one included.
    expect(await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main', 'team'])).toEqual({ imported: 0, already: 4, skipped: [], moved: [], renumbered: [] });
    // What is decided from now on is numbered after the highest imported.
    let next = '';
    apply(db, (tx) => void (next = recordDecision(tx, db, T0, { statement: 'New.', why: '', by: { kind: 'lead', employeeId: null } }).id));
    expect(next).toBe('D-5');
    await expect(importDecisions({ db, now: T0 }, here, 'docs/nope.md', ['main'])).rejects.toThrow(/docs\/nope\.md.*main/);
  });

  it('does not push the log\'s numbers aside for something recorded since: it refuses, unless told to renumber, and then says truly why', async () => {
    const dir = gitRepo([]);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/decisions.md'), `${HEAD}${row(1, 'The API speaks JSON.')}${row(2, 'Dates are ISO 8601.')}`);
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'log');
    const db = tempDb();
    const here = repo({ path: dir });
    // The engine filed an answer before anyone ran the import: D-1 is taken.
    apply(db, (tx) => void recordDecision(tx, db, T0, { statement: 'Friendly, not formal.', why: '', by: { kind: 'user', employeeId: null } }));
    await expect(importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main'])).rejects.toThrow(/D-1 is already on record \("Friendly, not formal\."\).*renumber/s);
    expect(store.allRecord(db)).toHaveLength(1);
    const forced = await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main'], { renumber: true });
    expect(forced).toMatchObject({ imported: 2, renumbered: [{ from: 'D-1', branch: 'main', to: 'D-3', because: 'record' }] });
    expect(store.allRecord(db).map((entry) => [entry.id, entry.statement])).toEqual([['D-1', 'Friendly, not formal.'], ['D-2', 'Dates are ISO 8601.'], ['D-3', 'The API speaks JSON.']]);
  });

  it('imports nothing twice when it is run again with the branches in another order', async () => {
    const dir = gitRepo(['team']);
    for (const [branch, text] of [['main', 'The API speaks JSON.'], ['team', 'Errors carry a code.']] as const) {
      gitIn(dir, 'checkout', '-q', branch);
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs/decisions.md'), `${HEAD}${row(7, text)}`);
      gitIn(dir, 'add', '-A');
      gitIn(dir, 'commit', '-q', '-m', 'log');
    }
    const db = tempDb();
    const here = repo({ path: dir });
    expect((await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main', 'team'])).imported).toBe(2);
    expect(await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['team', 'main'])).toMatchObject({ imported: 0, already: 2, renumbered: [] });
    expect(await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['team'])).toMatchObject({ imported: 0, already: 1 });
    expect(store.allRecord(db)).toHaveLength(2);
  });

  it('says which rows it could not read, and refuses a file it could read no row of', async () => {
    const dir = gitRepo([]);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/decisions.md'), `${HEAD}${row(1, 'The API speaks JSON.')}| **D-002** | 2026-11-07 | Bold number. | x |\n| D-003 (was 5) | 2026-11-07 | Annotated. | x |\n| D-000 | 2026-11-07 | Zero. | x |\n| D-004 | 2026-11-07 |  | no statement |\n`);
    fs.writeFileSync(path.join(dir, 'docs/notes.md'), '# Notes\n\nNo table here.\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'log');
    const db = tempDb();
    const done = await importDecisions({ db, now: T0 }, repo({ path: dir }), 'docs/decisions.md', ['main']);
    expect(done.imported).toBe(1);
    expect(done.skipped).toEqual(['| **D-002** | 2026-11-07 | Bold number. | x |', '| D-003 (was 5) | 2026-11-07 | Annotated. | x |', '| D-000 | 2026-11-07 | Zero. | x |', '| D-004 | 2026-11-07 |  | no statement |']);
    await expect(importDecisions({ db, now: T0 }, repo({ path: dir }), 'docs/notes.md', ['main'])).rejects.toThrow(/no row .*\| D-12 \|/s);
  });

  it('makes room for the log: what was recorded since moves to numbers after it, with every reference to it', async () => {
    const dir = gitRepo([]);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/decisions.md'), `${HEAD}${row(1, 'Skills are mandatory.')}${row(2, 'Dates are ISO 8601.')}${row(5, 'Money is in cents.')}`);
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'log');
    const db = tempDb();
    const here = repo({ path: dir });
    // Recorded before anyone took the log over: D-1 and D-2 clash with it, D-3 does not.
    apply(db, (tx) => {
      recordDecision(tx, db, T0, { statement: 'Take the first choice.', why: '', by: { kind: 'chief', employeeId: 'neo' } });
      recordDecision(tx, db, T0, { statement: 'Take the second choice.', why: '', by: { kind: 'lead', employeeId: 'lead' }, replaces: 'D-1' });
      recordDecision(tx, db, T0, { statement: 'Park the task.', why: '', by: { kind: 'chief', employeeId: 'neo' } });
      tx.emit({ kind: 'task_changed', task: task({ id: 'cites', builtOn: { decisions: ['D-2', 'D-3'], contract: null } }), cause: 'created' });
      tx.emit({ kind: 'contract_version_issued', issued: { id: 'cv1', repoId: 'repo1', version: '0.2.0', change: 'adds', summary: 'x', taskId: null, decisions: ['D-1'], by: null, at: T0.toISOString() } });
    });
    await expect(importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main'])).rejects.toThrow(/makeRoom: true/);
    const done = await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main'], { makeRoom: true });
    expect(done).toMatchObject({ imported: 3, moved: [{ from: 'D-1', to: 'D-6' }, { from: 'D-2', to: 'D-7' }] });
    const byId = (id: string) => store.getEntry(db, id)!;
    // The log keeps every number it had.
    expect([byId('D-1').statement, byId('D-2').statement, byId('D-5').statement]).toEqual(['Skills are mandatory.', 'Dates are ISO 8601.', 'Money is in cents.']);
    expect(byId('D-1').archived).toBe(true);
    // What moved keeps what it said and where it came from, and so does everything that pointed at it.
    expect(byId('D-6')).toMatchObject({ statement: 'Take the first choice.', movedFrom: 'D-1', replacedBy: 'D-7' });
    expect(byId('D-7')).toMatchObject({ statement: 'Take the second choice.', movedFrom: 'D-2', replaces: 'D-6' });
    expect(byId('D-3')).toMatchObject({ statement: 'Park the task.' });
    expect(byId('D-3').movedFrom).toBeUndefined();
    expect(store.getTask(db, 'cites')!.builtOn!.decisions).toEqual(['D-7', 'D-3']);
    expect(store.contractVersions(db, 'repo1')[0]!.decisions).toEqual(['D-6']);
    // Numbering goes on after all of it; running the import again moves and adds nothing.
    let next = '';
    apply(db, (tx) => void (next = recordDecision(tx, db, T0, { statement: 'New.', why: '', by: { kind: 'lead', employeeId: null } }).id));
    expect(next).toBe('D-8');
    expect(await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main'], { makeRoom: true })).toMatchObject({ imported: 0, already: 3, moved: [] });
  });

  it('does not make room where the moved decisions may already be files in the repository', async () => {
    const dir = gitRepo([]);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/decisions.md'), `${HEAD}${row(1, 'Skills are mandatory.')}`);
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'log');
    const db = tempDb();
    apply(db, (tx) => void recordDecision(tx, db, T0, { statement: 'Take the first choice.', why: '', by: { kind: 'chief', employeeId: 'neo' } }));
    await expect(importDecisions({ db, now: T0 }, repo({ path: dir, decisionsDir: 'docs/decisions' }), 'docs/decisions.md', ['main'], { makeRoom: true })).rejects.toThrow(/may already be written as files/);
    expect(store.allRecord(db)).toHaveLength(1);
  });
});
