/**
 * Taking over a log of decisions that was kept by hand: a markdown table in the repository, one row
 * per decision. Each row becomes an entry of the record under the number it had, marked as archived:
 * it lives in that file, and the engine writes no file of its own for it.
 */
import { apply } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { git } from '../git/git.ts';
import type { RecordEntry, Repo } from '../shared/types.ts';
import { entryId } from './record.ts';

export type LogRow = { n: number; date: string; statement: string; why: string };

/** The cells of one table row. A bar inside backticks, or after a backslash, is text and not the end of a cell. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  const out: string[] = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === '\\' && body[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (char === '|' && !code) {
      out.push(cell.trim());
      cell = '';
    } else {
      if (char === '`') code = !code;
      cell += char;
    }
  }
  return [...out, cell.trim()];
}

/**
 * The decisions in a log kept by hand. It understands one shape: a table whose rows begin with the number,
 * `| D-12 | 2026-11-07 | what was decided | why |`. Whatever follows the third cell is the why.
 */
export function parseLog(text: string): LogRow[] {
  return text.split('\n').flatMap((line) => {
    const number = /^\s*\|\s*D-(\d+)\s*\|/i.exec(line);
    if (!number) return [];
    const [, date = '', statement = '', ...why] = cells(line);
    return statement ? [{ n: Number(number[1]), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', statement, why: why.join(' | ').trim() }] : [];
  });
}

const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

export type Imported = { imported: number; already: number; renumbered: { from: string; branch: string; to: string }[] };

/**
 * Reads `file` on each branch, in the order given, and files what is not on record yet. A number keeps the text
 * of the first branch that has it. Where another branch wrote something else under that number, nothing is lost
 * and nothing is guessed: that text gets the next free number, and says where it came from and as what.
 */
export async function importDecisions(ctx: { db: Db; now: Date }, repo: Repo, file: string, branches: string[]): Promise<Imported> {
  const { db, now } = ctx;
  const claimed = new Map<number, LogRow>();
  const second: { row: LogRow; branch: string }[] = [];
  for (const branch of branches) {
    const shown = await git(repo.path, ['show', `${branch}:${file}`]);
    if (shown.code !== 0) throw new Error(`${file} was not found on the branch ${branch} of ${repo.path}.`);
    for (const row of parseLog(shown.out)) {
      const first = claimed.get(row.n);
      if (!first) claimed.set(row.n, row);
      else if (!same(first.statement, row.statement) && !second.some((other) => other.row.n === row.n && same(other.row.statement, row.statement))) second.push({ row, branch });
    }
  }
  const chief = store.getCompany(db)?.chiefOfStaffId ?? null;
  const entry = (n: number, row: LogRow, from?: string): RecordEntry => ({
    id: entryId(n),
    n,
    at: row.date ? `${row.date}T12:00:00.000Z` : now.toISOString(),
    statement: row.statement,
    why: row.why,
    // The log was the chief of staff's to keep; who decided each thing is in its own words.
    by: { kind: 'chief', employeeId: chief },
    taskId: null,
    repoId: repo.id,
    replaces: null,
    replacedBy: null,
    archived: true,
    ...(from ? { importedFrom: from } : {}),
  });
  const result: Imported = { imported: 0, already: 0, renumbered: [] };
  apply(
    db,
    (tx) => {
      const add = (made: RecordEntry) => {
        tx.emit({ kind: 'record_changed', entry: made });
        result.imported++;
      };
      for (const [n, row] of [...claimed].sort((a, b) => a[0] - b[0])) {
        const there = store.getEntry(db, entryId(n));
        if (!there) add(entry(n, row));
        else if (same(there.statement, row.statement)) result.already++;
        // The number is taken on record by something else (an earlier import named another branch first): this text is the second one.
        else second.unshift({ row, branch: branches[0]! });
      }
      for (const { row, branch } of second) {
        const from = `${branch}, where it was ${entryId(row.n)}`;
        const all = store.allRecord(db);
        if (all.some((other) => other.importedFrom === from && same(other.statement, row.statement))) {
          result.already++;
          continue;
        }
        const made = entry((all.at(-1)?.n ?? 0) + 1, row, from);
        add(made);
        result.renumbered.push({ from: entryId(row.n), branch, to: made.id });
      }
    },
    now,
  );
  return result;
}
