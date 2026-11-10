/**
 * Merges, done by the engine. Children are merged into their parent's branch in the parent's
 * folder; a finished branch lands on its target only by fast-forward, and never under a
 * checkout that has uncommitted changes.
 */
import { assertOwnGitDir, git, must, type Identity } from './git.ts';
import { publish } from './folder.ts';

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

export type Landing = { result: 'landed'; mergedTarget: boolean } | { result: 'conflict'; conflicts: string[] } | { result: 'gates_failed' } | { result: 'checkout_dirty'; where: string } | { result: 'target_moved' };

/** The worktree of the user's repository that has a branch checked out, if any. */
async function checkoutOf(repoPath: string, branch: string): Promise<string | null> {
  const blocks = (await must(repoPath, ['worktree', 'list', '--porcelain'])).split('\n\n');
  const block = blocks.find((b) => b.split('\n').includes(`branch refs/heads/${branch}`));
  return block ? block.split('\n')[0]!.replace(/^worktree /, '') : null;
}

/**
 * Lands the task branch on a target branch of the user's repository.
 * If the target moved since the task began, it is merged into the task branch first, and
 * `recheck` (the gates) must pass on the result. Then the target moves by fast-forward only.
 */
export async function landOn(repoPath: string, dir: string, branch: string, target: string, engine: Identity, recheck?: () => Promise<boolean>): Promise<Landing> {
  assertOwnGitDir(dir);
  await must(dir, ['fetch', '-q', 'origin', `refs/heads/${target}`]);
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

  const checkout = await checkoutOf(repoPath, target);
  if (checkout === null) {
    // Nobody has the target checked out: move it, fast-forward only.
    const moved = await git(repoPath, ['fetch', '-q', dir, `refs/heads/${branch}:refs/heads/${target}`]);
    return moved.code === 0 ? { result: 'landed', mergedTarget: !upToDate } : { result: 'target_moved' };
  }
  // The target is checked out. Never move a branch under someone's uncommitted work.
  if ((await must(checkout, ['status', '--porcelain', '--untracked-files=no'])) !== '') return { result: 'checkout_dirty', where: checkout };
  const forwarded = await git(checkout, ['merge', '-q', '--ff-only', branch]);
  if (forwarded.code === 0) return { result: 'landed', mergedTarget: !upToDate };
  return /untracked|overwritten/i.test(forwarded.out) ? { result: 'checkout_dirty', where: checkout } : { result: 'target_moved' };
}
