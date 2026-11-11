/**
 * Merges, done by the engine. Children are merged into their parent's branch in the parent's
 * folder; a finished branch lands on its target only by fast-forward, and never under a
 * checkout that has uncommitted changes.
 */
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
