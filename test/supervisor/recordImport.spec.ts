import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { recordDecision } from '../../src/supervisor/record.ts';
import { importDecisions, parseLog } from '../../src/supervisor/recordImport.ts';
import { gitIn, gitRepo, repo, T0, tempDb } from '../helpers.ts';

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
    expect(first).toEqual({ imported: 4, already: 0, renumbered: [{ from: 'D-2', branch: 'team', to: 'D-4' }] });
    expect(store.allRecord(db).map((entry) => [entry.id, entry.statement, entry.at, entry.archived, entry.by.kind, entry.repoId])).toEqual([
      ['D-1', 'The API speaks JSON.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
      ['D-2', 'Dates are ISO 8601.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
      ['D-3', 'Names are trimmed.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
      ['D-4', 'Money is in cents.', '2026-11-07T12:00:00.000Z', true, 'chief', 'repo1'],
    ]);
    expect(store.getEntry(db, 'D-4')!.importedFrom).toBe('team, where it was D-2');
    expect(store.getEntry(db, 'D-1')!.why).toBe('Because.');
    // Again: everything is there already, the renumbered one included.
    expect(await importDecisions({ db, now: T0 }, here, 'docs/decisions.md', ['main', 'team'])).toEqual({ imported: 0, already: 4, renumbered: [] });
    // What is decided from now on is numbered after the highest imported.
    let next = '';
    apply(db, (tx) => void (next = recordDecision(tx, db, T0, { statement: 'New.', why: '', by: { kind: 'lead', employeeId: null } }).id));
    expect(next).toBe('D-5');
    await expect(importDecisions({ db, now: T0 }, here, 'docs/nope.md', ['main'])).rejects.toThrow(/docs\/nope\.md.*main/);
  });
});
