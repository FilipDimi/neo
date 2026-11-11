/**
 * What a task changed, read from the user's repository, where the engine publishes its branch after every work run.
 */
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { git } from '../git/git.ts';
import type { Task } from '../shared/types.ts';

export type TaskDiff = { stat: string; patch: string; lines: number };
const NONE: TaskDiff = { stat: '', patch: '', lines: 0 };

async function between(repoPath: string, range: string): Promise<TaskDiff | null> {
  const [stat, patch, short] = await Promise.all([git(repoPath, ['diff', '--stat', range]), git(repoPath, ['diff', range]), git(repoPath, ['diff', '--shortstat', range])]);
  if (stat.code !== 0) return null;
  const count = (pattern: RegExp) => Number(pattern.exec(short.out)?.[1] ?? 0);
  return { stat: stat.out, patch: patch.out.slice(0, 200_000), lines: count(/(\d+) insertions?/) + count(/(\d+) deletions?/) };
}

export async function diffOf(db: Db, task: Task): Promise<TaskDiff> {
  const repo = task.repoId ? store.getRepo(db, task.repoId) : undefined;
  const teamRepo = store.getTeam(db, task.teamId)?.repos.find((r) => r.repoId === task.repoId);
  if (!repo || !teamRepo || !task.branch) return NONE;
  // Work that has landed is measured against what it landed on: its branch and the target are one from then on, and
  // the usual question (what is on the branch that the base does not have) would be answered with "nothing".
  if (task.landed) return (await between(repo.path, `${task.landed.over}..${task.landed.tip}`)) ?? NONE;
  const base = (task.parentId && store.getTask(db, task.parentId)?.branch) || teamRepo.baseBranch;
  const ahead = await between(repo.path, `${base}...${task.branch}`);
  // A part its parent has taken in is in the same place: measured from where its branch began.
  if (ahead && ahead.lines === 0 && task.startedFrom) return (await between(repo.path, `${task.startedFrom}..${task.branch}`)) ?? ahead;
  return ahead ?? NONE;
}
