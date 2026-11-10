/**
 * Engine commits. Employees never commit: after each work run the engine commits what is in
 * the folder, with the employee as author, so there is always a diff to review and to merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertOwnGitDir, git, must, type Identity } from './git.ts';

/** A folder inside the task folder has a git repository of its own. Git would commit a pointer to it, or nothing: never its files. */
export class NestedRepoError extends Error {
  constructor(readonly dirs: string[]) {
    super(`${dirs.length === 1 ? `the folder ${dirs[0]} has` : `the folders ${dirs.join(', ')} have`} a git repository of ${dirs.length === 1 ? 'its' : 'their'} own, so the files inside would not be in the commit`);
  }
}

const HEAVY = new Set(['node_modules', 'target', '.build', 'DerivedData']);

/** Folders below the task folder that are repositories of their own, and that git neither ignores nor already tracks as one. */
export async function nestedRepos(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = (relative: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    if (relative !== '' && entries.some((entry) => entry.name === '.git')) return void found.push(relative); // what is below belongs to it
    if (depth >= 8) return;
    for (const entry of entries) if (entry.isDirectory() && entry.name !== '.git' && !HEAVY.has(entry.name)) walk(path.join(relative, entry.name), depth + 1);
  };
  walk('', 0);
  if (found.length === 0) return [];
  const ignored = new Set((await git(dir, ['check-ignore', ...found])).out.split('\n').filter(Boolean));
  // A submodule the repository already has is recorded as one on purpose.
  const tracked = new Set((await git(dir, ['ls-files', '-s', '--', ...found])).out.split('\n').filter((line) => line.startsWith('160000 ')).map((line) => line.split('\t')[1]));
  return found.filter((folder) => !ignored.has(folder) && !tracked.has(folder)).sort();
}

/**
 * Commits everything in the folder, on the task's branch. Returns the commit, or null when nothing
 * changed. Completes a merge in progress. If the folder was switched to another branch, the task's
 * branch is moved to where the folder is, so what is reviewed and landed is what is there.
 */
export async function commitAll(dir: string, author: Identity, message: string, branch?: string): Promise<string | null> {
  assertOwnGitDir(dir);
  if (branch && (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).out !== branch) await must(dir, ['checkout', '-q', '-B', branch]);
  const nested = await nestedRepos(dir);
  if (nested.length > 0) throw new NestedRepoError(nested);
  await must(dir, ['add', '-A']);
  const staged = await git(dir, ['diff', '--cached', '--quiet']);
  const merging = (await git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
  if (staged.code === 0 && !merging) return null;
  await must(dir, ['commit', '-q', '-m', message], author);
  return must(dir, ['rev-parse', 'HEAD']);
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean);
// A diff is computed by git itself: no outside diff program and no converter named in the repository.
const PLAIN = ['--no-ext-diff', '--no-textconv'];

/** What the branch changed since it left its base. */
export async function diffStat(dir: string, base: string): Promise<{ files: number; lines: number; text: string }> {
  const short = await must(dir, ['diff', ...PLAIN, '--shortstat', `${base}...HEAD`]);
  const count = (pattern: RegExp) => Number(pattern.exec(short)?.[1] ?? 0);
  const text = await must(dir, ['diff', ...PLAIN, '--stat', `${base}...HEAD`]);
  return { files: count(/(\d+) files? changed/), lines: count(/(\d+) insertions?/) + count(/(\d+) deletions?/), text };
}

export async function patch(dir: string, base: string, capBytes: number): Promise<string> {
  const full = await must(dir, ['diff', ...PLAIN, `${base}...HEAD`]);
  return full.length <= capBytes ? full : `${full.slice(0, capBytes)}…`;
}

export async function changedFiles(dir: string, base: string): Promise<string[]> {
  // A move is two changes: a file gone from one place and a file new in another. Both are named.
  return lines(await must(dir, ['diff', ...PLAIN, '--no-renames', '--name-only', `${base}...HEAD`])).sort();
}
