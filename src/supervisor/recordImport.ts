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

const ROW = /^\s*\|\s*D-(\d+)\s*\|/i;

/** One line of the file as a decision, or null when it is not a row this reads. */
function rowOf(line: string): LogRow | null {
  const number = ROW.exec(line);
  if (!number || Number(number[1]) < 1) return null;
  const [, date = '', statement = '', ...why] = cells(line);
  return statement ? { n: Number(number[1]), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', statement, why: why.join(' | ').trim() } : null;
}

/**
 * The decisions in a log kept by hand. It understands one shape: a table whose rows begin with the number,
 * `| D-12 | 2026-11-07 | what was decided | why |`. Whatever follows the third cell is the why.
 */
export function parseLog(text: string): LogRow[] {
  return text.split('\n').flatMap((line) => rowOf(line) ?? []);
}

/** The lines that look like a decision's row and could not be read as one: a number in bold or with a note beside it, no statement, D-0. */
export function unreadRows(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^\s*\|\s*[*_`[]*\s*D-?\d/i.test(line) && !rowOf(line))
    .map((line) => line.trim());
}

const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** `because`: another branch had the number first, or something recorded since the log was kept already holds it. */
export type Imported = { imported: number; already: number; renumbered: { from: string; branch: string; to: string; because: 'branch' | 'record' }[]; skipped: string[] };

/**
 * Reads `file` on each branch, in the order given, and files what is not on record yet. A number keeps the text
 * of the first branch that has it. Where another branch wrote something else under that number, nothing is lost
 * and nothing is guessed: that text gets the next free number, and says where it came from and as what.
 *
 * A number of the log that the engine has since given to a decision of its own is another matter: the log's row
 * would lose the number every document cites it by. That is refused, with nothing written, unless `renumber` says
 * to go ahead.
 */
export async function importDecisions(ctx: { db: Db; now: Date }, repo: Repo, file: string, branches: string[], options: { renumber?: boolean } = {}): Promise<Imported> {
  const { db, now } = ctx;
  const claimed = new Map<number, { row: LogRow; branch: string }>();
  const second: { row: LogRow; branch: string; because: 'branch' | 'record' }[] = [];
  const skipped: string[] = [];
  for (const branch of branches) {
    const shown = await git(repo.path, ['show', `${branch}:${file}`]);
    if (shown.code !== 0) throw new Error(`${file} was not found on the branch ${branch} of ${repo.path}.`);
    for (const line of unreadRows(shown.out)) if (!skipped.includes(line)) skipped.push(line);
    for (const row of parseLog(shown.out)) {
      const first = claimed.get(row.n);
      if (!first) claimed.set(row.n, { row, branch });
      else if (!same(first.row.statement, row.statement) && !second.some((other) => other.row.n === row.n && same(other.row.statement, row.statement))) second.push({ row, branch, because: 'branch' });
    }
  }
  if (claimed.size === 0) throw new Error(`${file} has no row of the shape this reads: | D-12 | 2026-11-07 | what was decided | why |.`);
  // Numbers of the log that hold something recorded since. Said before anything is written.
  const taken = [...claimed].flatMap(([n, { row }]) => {
    const there = store.getEntry(db, entryId(n));
    return there && !there.archived && !same(there.statement, row.statement) ? [there] : [];
  });
  if (taken.length > 0 && !options.renumber) {
    throw new Error(
      `${taken.map((entry) => `${entry.id} is already on record ("${entry.statement.split('\n')[0]!.slice(0, 80)}")`).join('; ')}, and the log has another decision under ${taken.length === 1 ? 'that number' : 'each of those numbers'}. Importing now would give the log's a new number, though everything written so far cites it by the old one. A log is imported before anything is recorded. To import anyway and take new numbers for those, say renumber: true.`,
    );
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
  const result: Imported = { imported: 0, already: 0, renumbered: [], skipped };
  /** Already taken over from this repository's log, under whatever number: a second run, or the branches named in another order. */
  const onRecord = (row: LogRow): boolean => store.allRecord(db).some((other) => other.archived && other.repoId === repo.id && same(other.statement, row.statement));
  apply(
    db,
    (tx) => {
      const add = (made: RecordEntry) => {
        tx.emit({ kind: 'record_changed', entry: made });
        result.imported++;
      };
      const displaced: typeof second = [];
      for (const [n, { row, branch }] of [...claimed].sort((a, b) => a[0] - b[0])) {
        const there = store.getEntry(db, entryId(n));
        if (!there) add(entry(n, row));
        else if (same(there.statement, row.statement)) result.already++;
        // The number holds something else: another branch's text from an earlier import, or a decision recorded since.
        else displaced.push({ row, branch, because: there.archived ? 'branch' : 'record' });
      }
      for (const { row, branch, because } of [...displaced, ...second]) {
        if (onRecord(row)) {
          result.already++;
          continue;
        }
        const made = entry((store.allRecord(db).at(-1)?.n ?? 0) + 1, row, `${branch}, where it was ${entryId(row.n)}`);
        add(made);
        result.renumbered.push({ from: entryId(row.n), branch, to: made.id, because });
      }
    },
    now,
  );
  return result;
}
