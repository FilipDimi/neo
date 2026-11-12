/**
 * The company's record: what was decided, by whom, in a numbered list the engine keeps. Agents add to
 * it through tools and read it at the start of their runs; nothing is ever deleted from it, and no
 * two decisions can be given one number, because the number is taken inside the write that stores it.
 */
import { apply, type Tx } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { ToolReply } from '../runtime/tools.ts';
import type { Decision, RecordEntry, Run, Task } from '../shared/types.ts';
import { TOOL_INPUT } from '../worker/protocol.ts';

export const entryId = (n: number): string => `D-${n}`;

/** The first line of a text, its spaces tidied, cut where it would run past `max`. For an index, a title, a label. */
export function oneLine(text: string, max: number): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export type NewEntry = { statement: string; why: string; by: RecordEntry['by']; taskId?: string | null; repoId?: string | null; replaces?: string | null; detail?: string };

/** Files one decision under the next number. A decision it replaces is marked, never removed. */
export function recordDecision(tx: Tx, db: Db, now: Date, input: NewEntry): RecordEntry {
  const replaced = input.replaces ? store.getEntry(db, input.replaces) : undefined;
  if (input.replaces && !replaced) throw new Error(`There is no decision ${input.replaces} to replace.`);
  if (replaced?.replacedBy) throw new Error(`${replaced.id} was already replaced by ${replaced.replacedBy}. Replace that one, if this reverses it.`);
  const n = (store.allRecord(db).at(-1)?.n ?? 0) + 1;
  const entry: RecordEntry = {
    id: entryId(n),
    n,
    at: now.toISOString(),
    statement: input.statement.trim(),
    why: input.why.trim(),
    by: input.by,
    taskId: input.taskId ?? null,
    repoId: input.repoId ?? null,
    replaces: replaced?.id ?? null,
    replacedBy: null,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  tx.emit({ kind: 'record_changed', entry });
  if (replaced) tx.emit({ kind: 'record_changed', entry: { ...replaced, replacedBy: entry.id } });
  return entry;
}

export type Query = { ids?: string[]; search?: string; by?: RecordEntry['by']['kind']; since?: Date };

/**
 * Decisions by their numbers, in the order asked for; or, newest first, those that hold every word of
 * `search` somewhere in what they say, why, or the question and answer they came from.
 */
export function findEntries(db: Db, query: Query): RecordEntry[] {
  if (query.ids) return query.ids.flatMap((id) => store.getEntry(db, id.trim().toUpperCase()) ?? []);
  const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const since = query.since?.toISOString();
  return store
    .allRecord(db)
    .filter((entry) => {
      if (query.by && entry.by.kind !== query.by) return false;
      if (since && entry.at < since) return false;
      const text = `${entry.id} ${entry.statement} ${entry.why} ${entry.detail ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .reverse();
}

// ---------- the contract's version ----------

const parts = (version: string): number[] => version.split('.').map(Number);
/** Which of two versions is the later: negative when `a` is, positive when `b` is. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
}

/** The version a repository's contract is at: the highest ever handed out for it. Null before any was. */
export function currentContract(db: Db, repoId: string): string | null {
  const issued = store.contractVersions(db, repoId).map((entry) => entry.version);
  return issued.length === 0 ? null : issued.reduce((highest, version) => (compareVersions(version, highest) > 0 ? version : highest));
}

// ---------- what a ticket is built on, and what a run is shown ----------

/**
 * What a new ticket is built on: the decisions its maker named, after its parent's, each once; and the version its
 * repository's contract is at today. Undefined when that is nothing at all. A number nobody recorded is refused.
 */
export function builtOnFor(db: Db, input: { decisions?: string[] | undefined; parent?: Task | null | undefined; repoId: string | null }): Task['builtOn'] {
  const named = (input.decisions ?? []).map((id) => id.trim().toUpperCase());
  const missing = named.find((id) => !store.getEntry(db, id));
  if (missing) throw new Error(`There is no decision ${missing} on record. Name decisions by their numbers, such as D-12; mcp__engine__read_decisions finds them.`);
  const decisions = [...new Set([...(input.parent?.builtOn?.decisions ?? []), ...named])];
  const contract = input.repoId ? currentContract(db, input.repoId) : null;
  return decisions.length === 0 && contract === null ? undefined : { decisions, contract };
}

/** How many of the newest decisions a run is shown without asking. */
const NEWEST = 20;
const LINE = 160;

export type RecordIndex = { cited: RecordEntry[]; recent: RecordEntry[]; contract: { paths: string[]; version: string | null } | null; changesContractTo: string | null };

/** What of the record is put in front of a run on this ticket: what the ticket is built on, the newest that still hold, the contract. */
export function indexFor(db: Db, task: Task): RecordIndex {
  const cited = (task.builtOn?.decisions ?? []).flatMap((id) => store.getEntry(db, id) ?? []);
  const shown = new Set(cited.map((entry) => entry.id));
  const recent = store
    .allRecord(db)
    .filter((entry) => !entry.replacedBy && !shown.has(entry.id))
    .slice(-NEWEST)
    .reverse();
  const repo = task.repoId ? store.getRepo(db, task.repoId) : undefined;
  const parent = task.parentId ? store.getTask(db, task.parentId) : undefined;
  return {
    cited,
    recent,
    contract: repo?.contract ? { paths: repo.contract.paths, version: currentContract(db, repo.id) } : null,
    changesContractTo: task.contractVersion ?? parent?.contractVersion ?? null,
  };
}

/** The index as a run reads it at its start. One line per decision; empty when there is nothing to say. */
export function recordSection(db: Db, index: RecordIndex): string {
  const line = (entry: RecordEntry, withWhy: boolean): string =>
    `- ${entry.id} (${entry.at.slice(0, 10)}, ${whoDecided(db, entry)}): ${oneLine(entry.statement, LINE)}${withWhy && entry.why ? ` Why: ${oneLine(entry.why, LINE)}` : ''}${entry.replacedBy ? ` (replaced by ${entry.replacedBy})` : ''}`;
  const decided = [
    index.cited.length > 0 ? `This ticket is built on:\n${index.cited.map((entry) => line(entry, true)).join('\n')}` : '',
    index.recent.length > 0 ? `The newest:\n${index.recent.map((entry) => line(entry, false)).join('\n')}` : '',
  ].filter(Boolean);
  const contract = index.contract
    ? [
        `The contract is ${index.contract.paths.join(', ')}${index.contract.version ? `, at version ${index.contract.version}` : ', with no version yet'}. Its files change only on a ticket the engine gave a version to.`,
        index.changesContractTo ? `This ticket changes the contract. Its version is ${index.changesContractTo}: the contract's files must state it.` : '',
      ].filter(Boolean)
    : [];
  if (decided.length === 0 && contract.length === 0) return '';
  const head = decided.length > 0 ? 'Decisions on record. This is the company\'s own numbered list of what was decided: go by it, not by memory. Read any one whole, or search them all, with mcp__engine__read_decisions.' : '';
  return [head, ...decided, ...contract].filter(Boolean).join('\n\n');
}

// ---------- in words ----------

/** Who decided, as a reader is told it. */
export function whoDecided(db: Db, entry: RecordEntry): string {
  const name = entry.by.employeeId ? store.getEmployee(db, entry.by.employeeId)?.name : undefined;
  if (entry.by.kind === 'user') return 'the user';
  if (entry.by.kind === 'chief') return `${name ?? 'the chief of staff'}, for the user`;
  return name ?? 'a team lead';
}

/** One decision, whole: for whoever asked to read it. */
function inFull(db: Db, entry: RecordEntry): string {
  return [
    `${entry.id} · ${entry.at.slice(0, 10)} · ${whoDecided(db, entry)}`,
    entry.statement,
    entry.why ? `Why: ${entry.why}` : '',
    entry.detail ?? '',
    entry.replaces ? `Replaces ${entry.replaces}.` : '',
    entry.replacedBy ? `Replaced by ${entry.replacedBy}: this one no longer holds.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- the tools ----------

/** How many decisions one search gives back. */
const FOUND = 10;
const words = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/** `read_decisions`: by number, or by words, or the newest. Open to everyone. */
export function onReadDecisions(db: Db, input: unknown): ToolReply {
  const asked = TOOL_INPUT.read_decisions.safeParse(input);
  if (!asked.success) return { ok: false, text: 'Give ids (a list of numbers such as "D-12"), or search (words), or neither for the newest.' };
  const found = findEntries(db, asked.data.ids ? { ids: asked.data.ids } : { search: asked.data.search ?? '' }).slice(0, asked.data.ids ? undefined : FOUND);
  return { ok: true, text: found.length === 0 ? 'Nothing on record matches.' : found.map((entry) => inFull(db, entry)).join('\n\n') };
}

/** `record_decision`: for those who decide for others, a team's lead and the chief of staff. */
export function onRecordDecision(db: Db, now: Date, run: Run, input: unknown): ToolReply {
  const asked = TOOL_INPUT.record_decision.safeParse(input);
  if (!asked.success) return { ok: false, text: 'A decision needs a statement (one sentence saying what is now so) and a why.' };
  const employee = store.getEmployee(db, run.employeeId);
  const chief = store.getCompany(db)?.chiefOfStaffId === run.employeeId;
  const lead = Boolean(employee && store.getTeam(db, employee.teamId)?.leadId === employee.id);
  if (!chief && !lead) return { ok: false, text: 'Decisions are recorded by a team\'s lead or the chief of staff. If something needs deciding, ask with mcp__engine__request_decision: the answer is recorded for you.' };
  if (asked.data.onBehalfOfUser && !chief) return { ok: false, text: 'Only the chief of staff records what the user said as the user\'s. Record it as your own choice, or leave onBehalfOfUser out.' };
  const task = store.getTask(db, run.taskId);
  // A conversation is not a ticket anyone will look a decision up under: what is said in one is about the company.
  const about = task && task.kind === 'work' ? task : undefined;
  try {
    let made!: RecordEntry;
    apply(
      db,
      (tx) =>
        void (made = recordDecision(tx, db, now, {
          statement: asked.data.statement,
          why: asked.data.why,
          by: asked.data.onBehalfOfUser ? { kind: 'user', employeeId: null } : { kind: chief ? 'chief' : 'lead', employeeId: run.employeeId },
          taskId: about?.id ?? null,
          repoId: about?.repoId ?? null,
          replaces: asked.data.replaces ?? null,
        })),
      now,
    );
    return { ok: true, text: `Recorded as ${made.id}.` };
  } catch (failure) {
    return { ok: false, text: words(failure) };
  }
}

/**
 * A question card was answered with words: that is a decision, and the engine files it itself, in the
 * change that answers the card. By the user, or by the chief of staff deciding for them.
 */
export function fileAnswer(tx: Tx, db: Db, now: Date, card: Decision, given: { words: string; by: string | null; why: string }): RecordEntry {
  const task = card.taskId ? store.getTask(db, card.taskId) : undefined;
  const chief = given.by !== null && store.getCompany(db)?.chiefOfStaffId === given.by;
  return recordDecision(tx, db, now, {
    statement: `${oneLine(card.text, 120)} Answer: ${oneLine(given.words, 120)}`,
    why: given.why,
    by: chief ? { kind: 'chief', employeeId: given.by } : { kind: 'user', employeeId: null },
    taskId: task?.id ?? null,
    repoId: task?.repoId ?? null,
    detail: `Question:\n${card.text.trim()}\n\nAnswer:\n${given.words.trim()}`,
  });
}
