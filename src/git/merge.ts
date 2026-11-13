/**
 * Merges, done by the engine. Children are merged into their parent's branch in the parent's
 * folder; a finished branch lands on its target only by fast-forward, and never under a
 * checkout that has uncommitted changes.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertOwnGitDir, git, must, type Identity } from './git.ts';
import { checkoutOf, publish } from './folder.ts';

const names = (text: string): string[] => text.split('\n').filter(Boolean).sort();

/** Whether the folder's branch already contains a published branch. */
export async function isMerged(dir: string, otherBranch: string): Promise<boolean> {
  assertOwnGitDir(dir);
  await must(dir, ['fetch', '-q', 'origin', `refs/heads/${otherBranch}`]);
  return (await git(dir, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'])).code === 0;
}

/** Merges a published branch into the folder's branch. A conflict is left in the folder for someone to resolve. */
export async function mergeInto(dir: string, otherBranch: string, engine: Identity): Promise<{ ok: true; commit: string } | { ok: false; conflicts: string[] }> {
  assertOwnGitDir(dir);
  await must(dir, ['fetch', '-q', 'origin', `refs/heads/${otherBranch}`]);
  const merged = await git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', `Merge ${otherBranch}`, 'FETCH_HEAD'], engine);
  if (merged.code === 0) return { ok: true, commit: await must(dir, ['rev-parse', 'HEAD']) };
  const conflicts = names((await git(dir, ['diff', '--name-only', '--diff-filter=U'])).out);
  if (conflicts.length === 0) throw new Error(`merging ${otherBranch} failed: ${merged.out}`);
  return { ok: false, conflicts };
}

/** `over` is the target as it was, `tip` the work that was put on it: between the two is what this landing changed. */
export type Landing = { result: 'landed'; mergedTarget: boolean; over: string; tip: string } | { result: 'conflict'; conflicts: string[] } | { result: 'gates_failed' } | { result: 'checkout_dirty'; where: string } | { result: 'target_moved' };

/**
 * Lands the task branch on a target branch of the user's repository.
 * If the target moved since the task began, it is merged into the task branch first, and
 * `recheck` (the gates) must pass on the result. Then the target moves by fast-forward only.
 */
export async function landOn(repoPath: string, dir: string, branch: string, target: string, engine: Identity, recheck?: () => Promise<boolean>): Promise<Landing> {
  assertOwnGitDir(dir);
  await must(dir, ['fetch', '-q', 'origin', `refs/heads/${target}`]);
  const over = await must(dir, ['rev-parse', 'FETCH_HEAD']);
  const upToDate = (await git(dir, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'])).code === 0;
  if (!upToDate) {
    const merged = await git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', `Merge ${target} into ${branch}`, 'FETCH_HEAD'], engine);
    if (merged.code !== 0) {
      const conflicts = names((await git(dir, ['diff', '--name-only', '--diff-filter=U'])).out);
      if (conflicts.length === 0) throw new Error(`merging ${target} failed: ${merged.out}`);
      return { result: 'conflict', conflicts };
    }
    if (recheck && !(await recheck())) return { result: 'gates_failed' };
  }
  await publish(repoPath, dir, branch);
  const landed = { result: 'landed' as const, mergedTarget: !upToDate, over, tip: await must(dir, ['rev-parse', 'HEAD']) };

  const checkout = await checkoutOf(repoPath, target);
  if (checkout === null) {
    // Nobody has the target checked out: move it, fast-forward only.
    const moved = await git(repoPath, ['fetch', '-q', dir, `refs/heads/${branch}:refs/heads/${target}`]);
    return moved.code === 0 ? landed : { result: 'target_moved' };
  }
  // The target is checked out. Never move a branch under someone's uncommitted work.
  if ((await must(checkout, ['status', '--porcelain', '--untracked-files=no'])) !== '') return { result: 'checkout_dirty', where: checkout };
  const forwarded = await git(checkout, ['merge', '-q', '--ff-only', branch]);
  if (forwarded.code === 0) return landed;
  return /untracked|overwritten/i.test(forwarded.out) ? { result: 'checkout_dirty', where: checkout } : { result: 'target_moved' };
}

export type Carried = 'carried' | 'same' | 'not_in_step' | 'checkout_dirty' | 'moved' | 'absent';

/**
 * Carries some paths, as they are at one commit, onto another branch of the user's repository, as one commit of the
 * engine's on top of that branch. Only where that branch held those paths exactly as they `was` before the change:
 * otherwise something there would be overwritten that nobody looked at, and nothing is done. The branch moves by
 * fast-forward only, and never under someone's uncommitted work. Nothing in the folder's working tree is touched.
 */
export async function carryPaths(input: { repoPath: string; dir: string; from: string; was: string; branch: string; paths: string[]; message: string; engine: Identity; force?: boolean }): Promise<Carried> {
  const { repoPath, dir, from, was, branch, paths, engine } = input;
  assertOwnGitDir(dir);
  // A branch that is not there is not one that moved: there is nothing to carry to.
  if ((await git(repoPath, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`])).code !== 0) return 'absent';
  if ((await git(dir, ['fetch', '-q', 'origin', `refs/heads/${branch}`])).code !== 0) return 'moved';
  const onto = await must(dir, ['rev-parse', 'FETCH_HEAD']);
  // What a path is at a commit: its kind, its mode and the hash of what it holds, or that it is not there.
  const at = async (commit: string, file: string): Promise<string> => (await git(dir, ['ls-tree', commit, '--', file])).out.trim().split('\t')[0] || 'absent';
  let same = true;
  let inStep = true;
  for (const file of paths) {
    const there = await at(onto, file);
    if (there !== (await at(from, file))) same = false;
    if (there !== (await at(was, file))) inStep = false;
    // A file that stands where one of the path's folders would go would be replaced by the folder: that is not in step either.
    const above = file.split('/').slice(0, -1);
    for (let depth = 1; depth <= above.length; depth++) if ((await at(onto, above.slice(0, depth).join('/'))).split(' ')[1] === 'blob') inStep = false;
  }
  if (same) return 'same';
  if (!inStep && !input.force) return 'not_in_step';

  const index = path.join(os.tmpdir(), `vs-carry-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  const ref = `refs/carry/${randomUUID()}`;
  try {
    await must2(dir, ['read-tree', onto], env);
    for (const file of paths) {
      // Only the scratch index is changed: -f, because git would otherwise compare it with the folder's files, which are another branch's.
      await must2(dir, ['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', file], env);
      const entry = (await git(dir, ['ls-tree', from, '--', file])).out.trim();
      if (!entry) continue; // not there at the source: it goes
      const [meta] = entry.split('\t');
      const [mode, type, hash] = meta!.split(' ');
      if (type === 'tree') await must2(dir, ['read-tree', `--prefix=${file.replace(/\/+$/, '')}/`, hash!], env);
      else await must2(dir, ['update-index', '--add', '--cacheinfo', `${mode},${hash},${file}`], env);
    }
    const tree = await must2(dir, ['write-tree'], env);
    const commit = (await git(dir, ['commit-tree', tree, '-p', onto, '-m', input.message], engine, { GIT_AUTHOR_NAME: engine.name, GIT_AUTHOR_EMAIL: engine.email, GIT_COMMITTER_NAME: engine.name, GIT_COMMITTER_EMAIL: engine.email })).out.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return 'moved';
    await must(dir, ['update-ref', ref, commit]);
    const checkout = await checkoutOf(repoPath, branch);
    if (checkout === null) return (await git(repoPath, ['fetch', '-q', dir, `${ref}:refs/heads/${branch}`])).code === 0 ? 'carried' : 'moved';
    if ((await must(checkout, ['status', '--porcelain', '--untracked-files=no'])) !== '') return 'checkout_dirty';
    await must(repoPath, ['fetch', '-q', dir, ref]);
    return (await git(checkout, ['merge', '-q', '--ff-only', commit])).code === 0 ? 'carried' : 'checkout_dirty';
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
    await git(dir, ['update-ref', '-d', ref]);
  }
}

async function must2(cwd: string, args: string[], env: Record<string, string>): Promise<string> {
  const result = await git(cwd, args, undefined, env);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.out.trim();
}
