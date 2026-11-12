/**
 * The record in the repository: one file per decision, written by the engine and by nobody else.
 * A file says only what its entry said on the day it was recorded, so the same decision is the same
 * file on every branch, at any time: two branches that each carry it merge without a word from git.
 * That is why being replaced later is said by the newer decision's file and never added to the older.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { RecordEntry, Repo } from '../shared/types.ts';
import { oneLine } from './record.ts';

/** "D-232" as files and their titles write it, so that a folder of them sorts in order: "D-0232". */
export const padded = (id: string): string => `D-${id.replace(/^D-/i, '').padStart(4, '0')}`;
export const fileOf = (entry: RecordEntry): string => `${padded(entry.id)}.md`;

/** The repository's decisions folder as a plain path from its top, or null when it keeps none. */
export function dirOf(repo: Pick<Repo, 'decisionsDir'> | null | undefined): string | null {
  const dir = (repo?.decisionsDir ?? '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/\*{1,2}$/, '')
    .replace(/\/+$/, '');
  return dir === '' || dir === '.' ? null : dir;
}

/** The whole file for one decision. It depends on the entry's own words alone. */
export function render(entry: RecordEntry): string {
  const title = oneLine(entry.statement, 160);
  const facts = [
    `- Date: ${entry.at.slice(0, 10)}`,
    `- Decided by: ${entry.byName ?? (entry.by.kind === 'user' ? 'the user' : entry.by.kind === 'chief' ? 'the chief of staff, for the user' : 'a team lead')}`,
    entry.taskTitle ? `- Ticket: "${entry.taskTitle}"` : '',
    entry.replaces ? `- Replaces: ${padded(entry.replaces)}` : '',
  ].filter(Boolean);
  const sections = [
    `# ${padded(entry.id)}: ${title}`,
    facts.join('\n'),
    // The title is one line of it. Where the decision says more than that, all of it follows.
    entry.statement.trim() !== title ? `## The decision\n\n${entry.statement.trim()}` : '',
    entry.why.trim() ? `## Why\n\n${entry.why.trim()}` : '',
    entry.detail?.trim() ? `## The question and the answer\n\n${entry.detail.trim()}` : '',
  ].filter(Boolean);
  return `${sections.join('\n\n')}\n`;
}

/** The decisions a repository carries as files: those about it and those about the whole company. Never one imported from a log kept by hand. */
export function entriesFor(db: Db, repo: Pick<Repo, 'id'>): RecordEntry[] {
  return store.allRecord(db).filter((entry) => !entry.archived && (entry.repoId === repo.id || entry.repoId === null));
}

/**
 * Writes the decision files into a checkout of the repository, where they are missing or differ. `only` keeps it
 * to some of them. Returns what it wrote, by path from the top of the repository.
 */
export function writeRecordFiles(db: Db, repo: Repo, folder: string, only?: string[]): string[] {
  const dir = dirOf(repo);
  if (!dir) return [];
  const wrote: string[] = [];
  for (const entry of entriesFor(db, repo)) {
    const relative = `${dir}/${fileOf(entry)}`;
    if (only && !only.includes(relative)) continue;
    const file = path.join(folder, relative);
    const content = render(entry);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    wrote.push(relative);
  }
  return wrote.sort();
}

/** Of the files a ticket changed under the decisions folder: the engine's own (a decision's file) and everything else. */
export function underRecord(db: Db, repo: Repo, changed: string[]): { ours: string[]; strays: string[] } {
  const dir = dirOf(repo);
  if (!dir) return { ours: [], strays: [] };
  const under = changed.filter((file) => file.startsWith(`${dir}/`));
  const known = new Set(entriesFor(db, repo).map((entry) => `${dir}/${fileOf(entry)}`));
  return { ours: under.filter((file) => known.has(file)), strays: under.filter((file) => !known.has(file)) };
}
