/**
 * Claims. A task holds the files it has changed until its work has landed: the engine notes them as they are written
 * and exactly at every commit. Another task that lands on the same branch is not to write a held file; it waits for
 * the holder instead. A part lands with the task it is a part of, so a part that is done still holds its files until
 * that whole has landed, and the whole is what one waits for. A task's family (the task it was split from, its parts,
 * its fellow parts) shares claims, because inside a split the plan already keeps files apart.
 */
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { overlaps } from '../git/ownership.ts';
import type { Task } from '../shared/types.ts';
import { familyOf } from './stale.ts';

const over = (task: Task | undefined): boolean => !task || task.state === 'done' || task.state === 'failed';

/** The branch a task's work lands on: where its team merges by itself, or the branch it works from. */
export function landingBranch(db: Db, task: Pick<Task, 'teamId' | 'repoId'>): string | null {
  const entry = store.getTeam(db, task.teamId)?.repos.find((one) => one.repoId === task.repoId);
  return entry ? (entry.mergeTarget ?? entry.baseBranch) : null;
}

/** What lands: a part lands with the task it is a part of; any other task by itself. */
export function wholeOf(db: Db, task: Task): Task {
  return (task.parentId && store.getTask(db, task.parentId)) || task;
}

export type Held = { whole: Task; by: Task; file: string };

/**
 * Tasks outside a task's family that hold files on its branch: any that was not stopped or dropped, while what it
 * lands with is still open. Each with the task to wait for (its whole).
 */
function others(db: Db, task: Pick<Task, 'id' | 'teamId' | 'repoId' | 'parentId'>): { by: Task; whole: Task }[] {
  if (!task.repoId) return [];
  const branch = landingBranch(db, task);
  const family = task.id ? familyOf(db, task as Task) : new Set<string>(task.parentId ? [task.parentId, ...store.listTasks(db, { parentId: task.parentId }).map((child) => child.id)] : []);
  return store
    .listTasks(db)
    .filter((other) => other.kind === 'work' && other.repoId === task.repoId && other.id !== task.id && !family.has(other.id) && !other.meetingRole && !other.dropped && other.state !== 'failed' && landingBranch(db, other) === branch)
    .map((by) => ({ by, whole: wholeOf(db, by) }))
    .filter(({ whole }) => !over(whole));
}

/** Two names of one file: as git has it, and as someone may write it on a disk that does not tell capitals apart. */
const sameFile = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

/** Who holds a file a task wants to write: a task on its branch, outside its family, that has changed it and whose work has not landed. Null: nobody. */
export function heldBy(db: Db, task: Task, file: string): Held | null {
  const found = others(db, task).find(({ by }) => by.claims?.some((claim) => sameFile(claim, file)));
  return found ? { ...found, file } : null;
}

/**
 * What stands in the way of a plan: for the files a new task or sub-task names, the tasks outside its family that hold
 * some of them and have not landed, each with one file it holds there. A holder's files are what it has changed, and
 * for a ticket of a split what its lead gave it.
 */
export function holdersOf(db: Db, task: Pick<Task, 'id' | 'teamId' | 'repoId' | 'parentId'>, files: string[]): Held[] {
  if (files.length === 0) return [];
  const seen = new Set<string>();
  return others(db, task).flatMap(({ by, whole }) => {
    const held = [...(by.claims ?? []), ...(by.parentId ? by.ownership : [])];
    const file = held.find((one) => overlaps([one], files));
    if (!file || seen.has(whole.id)) return [];
    seen.add(whole.id);
    return [{ whole, by, file }];
  });
}

/**
 * Whether a task waits, directly or through others, for another: waiting for it in turn would be a circle. A task
 * waits for what it names, and a whole waits for its open parts, since it is done only when they are.
 */
export function waitsFor(db: Db, task: Task, targetId: string, seen = new Set<string>()): boolean {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  const next = [...(task.after ?? []), ...store.listTasks(db, { parentId: task.id }).filter((part) => !over(part)).map((part) => part.id)];
  return next.some((id) => {
    if (id === targetId) return true;
    const dep = store.getTask(db, id);
    return dep && !over(dep) ? waitsFor(db, dep, targetId, seen) : false;
  });
}

/** A title as it is compared for "the same ask": capitals, spaces and punctuation aside, in any alphabet. */
export const sameAsk = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
