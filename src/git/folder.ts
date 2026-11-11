/**
 * A task's folder: its own clone of the repository, on its own branch, under the data directory.
 * A clone keeps its .git inside the folder, so nothing done there can move a branch of the user's
 * repository. The engine publishes the branch back; an employee cannot.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../shared/types.ts';
import { assertOwnGitDir, forgetGitSettings, git, must, recordGitSettings } from './git.ts';

export function branchName(task: Pick<Task, 'id' | 'title'>): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `task/${slug || 'task'}-${task.id.slice(0, 6)}`;
}

/** Clones the repository into `dir` on a new branch that starts at one of its branches. */
export async function createFolder(input: { repoPath: string; dir: string; branch: string; startPoint: string }): Promise<void> {
  if (fs.existsSync(input.dir) && fs.readdirSync(input.dir).length > 0) throw new Error(`the folder ${input.dir} already exists`);
  fs.mkdirSync(path.dirname(input.dir), { recursive: true });
  // --shared borrows the repository's objects instead of copying them; the clone's own objects stay in the clone.
  await must(path.dirname(input.dir), ['clone', '-q', '--shared', '--no-checkout', input.repoPath, input.dir]);
  try {
    await must(input.dir, ['checkout', '-q', '-b', input.branch, `origin/${input.startPoint}`]);
  } catch (error) {
    fs.rmSync(input.dir, { recursive: true, force: true });
    throw new Error(`cannot start a task from "${input.startPoint}": ${error instanceof Error ? error.message : String(error)}`);
  }
  recordGitSettings(input.dir);
}

/** The worktree of the user's repository that has a branch checked out, if any. */
export async function checkoutOf(repoPath: string, branch: string): Promise<string | null> {
  const blocks = (await must(repoPath, ['worktree', 'list', '--porcelain'])).split('\n\n');
  const block = blocks.find((b) => b.split('\n').includes(`branch refs/heads/${branch}`));
  return block ? block.split('\n')[0]!.replace(/^worktree /, '') : null;
}

/**
 * Copies the task branch into the user's repository, so it outlives the folder. A checkout of another branch is never
 * touched. Someone who has checked out the task's own branch, to try the work, is moved forward with it, since git
 * moves no branch under a checkout; uncommitted changes there are never moved under, and the refusal says so.
 */
export async function publish(repoPath: string, dir: string, branch: string): Promise<void> {
  assertOwnGitDir(dir);
  const ours = await must(dir, ['rev-parse', `refs/heads/${branch}`]);
  const theirs = await git(repoPath, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]);
  if (theirs.code === 0 && theirs.out.trim() === ours) return;
  const checkout = await checkoutOf(repoPath, branch);
  if (checkout === null) return void (await must(repoPath, ['fetch', '-q', dir, `+refs/heads/${branch}:refs/heads/${branch}`]));
  const free = `Commit or discard them, or check out another branch there, then try again`;
  if ((await must(checkout, ['status', '--porcelain', '--untracked-files=no'])) !== '') throw new Error(`the branch ${branch} is checked out in ${checkout} with changes that are not committed. ${free}`);
  await must(repoPath, ['fetch', '-q', dir, `refs/heads/${branch}`]);
  const forwarded = await git(checkout, ['merge', '-q', '--ff-only', ours]);
  if (forwarded.code !== 0) throw new Error(`the branch ${branch} is checked out in ${checkout} and could not be moved forward there (${forwarded.out.trim().split('\n')[0]}). Check out another branch there, then try again`);
}

/** Removes the folder only. The branch stays until it is merged or discarded. */
export async function removeFolder(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
  forgetGitSettings(dir);
}
