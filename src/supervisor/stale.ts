/**
 * Stale, computed. Every ticket records the decisions and the contract version it was built on. It is stale when one
 * of those decisions has been replaced, or the contract of its repository has landed a change since the ticket was
 * made. The engine says exactly which, tells whoever has the ticket when it happens, and holds a report on a stale
 * ticket until its author has been shown everything that moved.
 */
import { apply } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { ContractVersion, RecordEntry, Task } from '../shared/types.ts';
import { sentence } from './tell.ts';

export type Moved = {
  /** Decisions it is built on that were replaced, each with the one that stands now. */
  decisions: { id: string; replacedBy: string; statement: string }[];
  /** The contract, when a change to it has landed since the ticket was made (or last brought up to date). */
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

/** A version has landed when the engine wrote down that it did: its change is in the contract's files on a team's branch. */
export function hasLanded(version: ContractVersion): boolean {
  return version.taskId === null || Boolean(version.landedAt);
}

/** A task, the task it is a part of, its parts and its fellow parts: what one of them changes is not news to another. */
export function familyOf(db: Db, task: Task): Set<string> {
  const top = task.parentId ?? task.id;
  return new Set([top, task.id, ...store.listTasks(db, { parentId: top }).map((child) => child.id)]);
}

const versionLine = (version: ContractVersion): string => `${version.version} (${version.change}): ${sentence(version.summary || 'no summary')}`;

export function movedFor(db: Db, task: Task): Moved {
  const cited = task.builtOn?.decisions ?? [];
  const replaced = cited.flatMap((id) => {
    const entry = store.getEntry(db, id);
    if (!entry?.replacedBy) return [];
    const now = standing(db, entry);
    // A ticket that cites the one that stands as well has nothing to catch up on.
    return cited.includes(now.id) ? [] : [{ id, replacedBy: now.id, statement: now.statement, direct: entry.replacedBy === now.id }];
  });
  // Where it cites several of one line (the first and the one that replaced it), the line has moved once: said of the newest it cites.
  const decisions = [...new Set(replaced.map((one) => one.replacedBy))].map((stands) => {
    const line = replaced.filter((one) => one.replacedBy === stands);
    const { direct: _direct, ...newest } = line.find((one) => one.direct) ?? line.at(-1)!;
    return newest;
  });
  const from = task.builtOn?.contract ?? null;
  if (!task.repoId || !from) return { decisions, contract: null };
  // Everything that landed after the ticket was made (or last brought up to date), whatever its number: versions are
  // handed out in one order and land in another.
  const since = task.builtOn?.at ?? task.createdAt;
  const family = familyOf(db, task);
  const newer = store
    .contractVersions(db, task.repoId)
    .filter((version) => version.landedAt !== undefined && version.landedAt > since && !(version.taskId && family.has(version.taskId)))
    .sort((a, b) => a.landedAt!.localeCompare(b.landedAt!));
  const to = newer.at(-1)?.version;
  return { decisions, contract: !to || to === from ? null : { from, to, changes: newer.map(versionLine) } };
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

/** What moved, as one string: two moments with the same string have shown their reader the same. */
export const shownAs = (moved: Moved): string => JSON.stringify([moved.decisions.map((one) => [one.id, one.replacedBy]), moved.contract ? [moved.contract.from, moved.contract.to] : null]);

/**
 * What the ticket is built on once its author has answered for what it was shown: the decisions that stand, and the
 * contract as it is where the ticket lands. A contract change that has not reached the ticket's branch stays ahead of
 * it: its author could not check the work against files it does not have.
 */
export function upToDate(db: Db, task: Task, moved: Moved, branch: string | null, now: Date): Task['builtOn'] {
  if (!task.builtOn) return undefined;
  const stands = new Map(moved.decisions.map((one) => [one.id, one.replacedBy]));
  const decisions = [...new Set(task.builtOn.decisions.map((id) => stands.get(id) ?? id))];
  const reached = moved.contract && task.repoId ? store.contractVersions(db, task.repoId).some((version) => version.version === moved.contract!.to && (branch === null || (version.on ?? []).includes(branch))) : false;
  return reached ? { decisions, contract: moved.contract!.to, at: now.toISOString() } : { ...task.builtOn, decisions };
}

/**
 * Versions the engine handed out before it wrote down landings: one whose ticket is done and merged (itself, or the
 * task it is a part of) is taken as landed when that task ended. Run once at start; a version that has a landing
 * written down is left alone.
 */
export function backfillLanded(db: Db, now: Date): void {
  const missing = store.allContractVersions(db).filter((version) => version.taskId !== null && version.landedAt === undefined);
  const landed = missing.flatMap((version) => {
    const holder = store.getTask(db, version.taskId!);
    const top = holder?.parentId ? store.getTask(db, holder.parentId) : holder;
    if (!holder || holder.state !== 'done' || holder.dropped || !top || top.state !== 'done' || !top.mergedInto) return [];
    return [{ ...version, landedAt: top.updatedAt, on: [top.mergedInto] }];
  });
  if (landed.length > 0) apply(db, (tx) => void landed.map((issued) => tx.emit({ kind: 'contract_version_issued', issued })), now);
}
