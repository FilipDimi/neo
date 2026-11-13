/**
 * Stale, computed. Every ticket records the decisions and the contract version it was built on. It is stale when one
 * of those decisions has been replaced, or the contract of its repository has landed a newer version. The engine says
 * exactly which, tells whoever has the ticket when it happens, and holds a report on a stale ticket once.
 */
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { ContractVersion, RecordEntry, Task } from '../shared/types.ts';
import { compareVersions } from './record.ts';
import { sentence } from './tell.ts';

export type Moved = {
  /** Decisions it is built on that were replaced, each with the one that stands now. */
  decisions: { id: string; replacedBy: string; statement: string }[];
  /** The contract, when a newer version than the one it was built on has landed. */
  contract: { from: string; to: string; changes: string[] } | null;
};

/** The decision that stands now where this one did: the end of its line of replacements. */
function standing(db: Db, entry: RecordEntry): RecordEntry {
  let last = entry;
  for (let hops = 0; last.replacedBy && hops < 50; hops++) {
    const next = store.getEntry(db, last.replacedBy);
    if (!next) break;
    last = next;
  }
  return last;
}

/** A version has landed when the task that holds it, or the task that one is a part of, is done and merged somewhere. */
export function hasLanded(db: Db, version: ContractVersion): boolean {
  if (version.taskId === null) return true; // where the counting began
  const holder = store.getTask(db, version.taskId);
  const top = holder?.parentId ? store.getTask(db, holder.parentId) : holder;
  return top?.state === 'done' && Boolean(top.mergedInto);
}

/** A task, the task it is a part of, its parts and its fellow parts: what one of them changes is not news to another. */
export function familyOf(db: Db, task: Task): Set<string> {
  const top = task.parentId ?? task.id;
  return new Set([top, task.id, ...store.listTasks(db, { parentId: top }).map((child) => child.id)]);
}

const versionLine = (version: ContractVersion): string => `${version.version} (${version.change}): ${sentence(version.summary || 'no summary')}`;

export function movedFor(db: Db, task: Task): Moved {
  const decisions = (task.builtOn?.decisions ?? []).flatMap((id) => {
    const entry = store.getEntry(db, id);
    if (!entry?.replacedBy) return [];
    const now = standing(db, entry);
    return [{ id, replacedBy: now.id, statement: now.statement }];
  });
  const from = task.builtOn?.contract ?? null;
  if (!task.repoId || !from) return { decisions, contract: null };
  const family = familyOf(db, task);
  const newer = store
    .contractVersions(db, task.repoId)
    .filter((version) => compareVersions(version.version, from) > 0 && !(version.taskId && family.has(version.taskId)) && hasLanded(db, version))
    .sort((a, b) => compareVersions(a.version, b.version));
  return { decisions, contract: newer.length === 0 ? null : { from, to: newer.at(-1)!.version, changes: newer.map(versionLine) } };
}

export const isStale = (moved: Moved): boolean => moved.decisions.length > 0 || moved.contract !== null;

/** For the board, in one line. Null: nothing it is built on has moved. */
export function staleLine(moved: Moved): string | null {
  const parts = [...moved.decisions.map((one) => `built on ${one.id}, replaced by ${one.replacedBy}`), ...(moved.contract ? [`built on contract ${moved.contract.from}, now ${moved.contract.to}`] : [])];
  return parts.length === 0 ? null : parts.join('; ');
}

/** In sentences, for whoever has the ticket. */
export function movedText(moved: Moved): string {
  return [
    ...moved.decisions.map((one) => `${one.id}, which this ticket is built on, was replaced by ${one.replacedBy}: ${sentence(one.statement)}`),
    ...(moved.contract ? [`The contract is now ${moved.contract.to} (this ticket was made at ${moved.contract.from}). ${moved.contract.changes.join(' ')}`] : []),
  ].join(' ');
}

/** What the ticket is built on once its author has answered for everything that moved: the decisions that stand, the contract as it is. */
export function upToDate(db: Db, task: Task): Task['builtOn'] {
  if (!task.builtOn) return undefined;
  const moved = movedFor(db, task);
  const stands = new Map(moved.decisions.map((one) => [one.id, one.replacedBy]));
  return { decisions: [...new Set(task.builtOn.decisions.map((id) => stands.get(id) ?? id))], contract: moved.contract?.to ?? task.builtOn.contract };
}
