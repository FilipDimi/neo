/**
 * Claims. A task holds the files it has changed until it lands: the engine notes them as they are written and exactly
 * at every commit. Another task that lands on the same branch is not to write a held file; it waits for the holder
 * instead. A task's family (the task it was split from, its parts, its fellow parts) shares claims, because inside a
 * split the plan already keeps files apart.
 */
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { overlaps } from '../git/ownership.ts';
import type { Task } from '../shared/types.ts';
import { familyOf } from './stale.ts';
import { openWork } from './tell.ts';

/** The branch a task's work lands on: where its team merges by itself, or the branch it works from. */
export function landingBranch(db: Db, task: Pick<Task, 'teamId' | 'repoId'>): string | null {
  const entry = store.getTeam(db, task.teamId)?.repos.find((one) => one.repoId === task.repoId);
  return entry ? (entry.mergeTarget ?? entry.baseBranch) : null;
}

/** Open tasks outside a task's family that land on the same branch of the same repository: those whose claims concern it. */
function others(db: Db, task: Pick<Task, 'id' | 'teamId' | 'repoId' | 'parentId'>): Task[] {
  if (!task.repoId) return [];
  const branch = landingBranch(db, task);
  const family = task.id ? familyOf(db, task as Task) : new Set<string>(task.parentId ? [task.parentId, ...store.listTasks(db, { parentId: task.parentId }).map((child) => child.id)] : []);
  return openWork(db).filter((other) => other.repoId === task.repoId && !family.has(other.id) && other.id !== task.id && !other.meetingRole && landingBranch(db, other) === branch);
}

/** Who holds a file a task wants to write: another open task on its branch that has changed it and not landed. Null: nobody. */
export function heldBy(db: Db, task: Task, file: string): Task | null {
  return others(db, task).find((other) => other.claims?.includes(file)) ?? null;
}

/**
 * What stands in the way of a plan: for the files a new task or sub-task names, the open tasks outside its family that
 * hold some of them, each with one file it holds there. A holder's files are what it has changed, and for a ticket of
 * a split what its lead gave it.
 */
export function holdersOf(db: Db, task: Pick<Task, 'id' | 'teamId' | 'repoId' | 'parentId'>, files: string[]): { holder: Task; file: string }[] {
  if (files.length === 0) return [];
  return others(db, task).flatMap((holder) => {
    const held = [...(holder.claims ?? []), ...(holder.parentId ? holder.ownership : [])];
    const file = held.find((one) => overlaps([one], files));
    return file ? [{ holder, file }] : [];
  });
}

/** Whether a task waits, directly or through others, for another: waiting for it in turn would be a circle. */
export function waitsFor(db: Db, task: Task, targetId: string, seen = new Set<string>()): boolean {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  return (task.after ?? []).some((id) => {
    if (id === targetId) return true;
    const dep = store.getTask(db, id);
    return dep ? waitsFor(db, dep, targetId, seen) : false;
  });
}

/** A title as it is compared for "the same ask": capitals, spaces and punctuation aside. */
export const sameAsk = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
