/**
 * Engine commits. Employees never commit: after each work run the engine commits what is in
 * the folder, with the employee as author, so there is always a diff to review and to merge.
 */
import { assertOwnGitDir, git, must, type Identity } from './git.ts';

/**
 * Commits everything in the folder, on the task's branch. Returns the commit, or null when nothing
 * changed. Completes a merge in progress. If the folder was switched to another branch, the task's
 * branch is moved to where the folder is, so what is reviewed and landed is what is there.
 */
export async function commitAll(dir: string, author: Identity, message: string, branch?: string): Promise<string | null> {
  assertOwnGitDir(dir);
  if (branch && (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).out !== branch) await must(dir, ['checkout', '-q', '-B', branch]);
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
