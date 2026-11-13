/**
 * The company's record: what was decided, by whom, in a numbered list the engine keeps. Agents add to
 * it through tools and read it at the start of their runs; nothing is ever deleted from it, and no
 * two decisions can be given one number, because the number is taken inside the write that stores it.
 */
import { apply, type Tx } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { ToolReply } from '../runtime/tools.ts';
import type { ContractVersion, Decision, RecordEntry, Run, Task } from '../shared/types.ts';
import { TOOL_INPUT } from '../worker/protocol.ts';

export const entryId = (n: number): string => `D-${n}`;

/**
 * A decision's number as the record keeps it, from however someone wrote it: "D-0045" as its file is named, "D-045"
 * as a log kept by hand has it, "d-45", or "45". What is not a number comes back as it was, and matches nothing.
 */
export function normalId(written: string): string {
  const number = /^\s*(?:D-?)?0*(\d+)\s*$/i.exec(written);
  return number ? entryId(Number(number[1])) : written.trim().toUpperCase();
}

/** The first line of a text, its spaces tidied, cut where it would run past `max`. For an index, a title, a label. */
export function oneLine(text: string, max: number): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export type NewEntry = { statement: string; why: string; by: RecordEntry['by']; taskId?: string | null; repoId?: string | null; replaces?: string | null; detail?: string };

/** Files one decision under the next number. A decision it replaces is marked, never removed. */
export function recordDecision(tx: Tx, db: Db, now: Date, input: NewEntry): RecordEntry {
  const replaced = input.replaces ? store.getEntry(db, normalId(input.replaces)) : undefined;
  if (input.replaces && !replaced) throw new Error(`There is no decision ${input.replaces} to replace.`);
  if (replaced?.replacedBy) throw new Error(`${replaced.id} was already replaced by ${replaced.replacedBy}. Replace that one, if this reverses it.`);
  const n = (store.allRecord(db).at(-1)?.n ?? 0) + 1;
  const about = input.taskId ? store.getTask(db, input.taskId) : undefined;
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
    byName: whoDecided(db, { by: input.by }),
    ...(about ? { taskTitle: about.title } : {}),
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
  if (query.ids) return query.ids.flatMap((id) => store.getEntry(db, normalId(id)) ?? []);
  const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const since = query.since?.toISOString();
  return store
    .allRecord(db)
    .filter((entry) => {
      // What a log kept by hand held is nobody's decision as far as the engine knows: it answers to no 'decided by'.
      if (query.by && (entry.archived || entry.by.kind !== query.by)) return false;
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

/** The version after the highest one: a breaking change raises the first number, an addition the second, wording the third. */
export function nextVersion(highest: string | null, change: 'breaking' | 'adds' | 'wording'): string {
  const [major = 0, minor = 0, patch = 0] = parts(highest ?? '0.0.0');
  return change === 'breaking' ? `${major + 1}.0.0` : change === 'adds' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export type NewVersion = { repoId: string; change: ContractVersion['change']; summary: string; taskId: string | null; decisions?: string[] | undefined; by: string | null; version?: string | undefined };

/**
 * Hands out the next version of a repository's contract, and gives it to the ticket named. It is made from the
 * highest ever handed out, so it is higher than every one before it whichever ticket lands first, and one given to
 * a ticket that never lands is simply skipped. `start` says where counting begins, and takes its version as given.
 */
export function issueContractVersion(tx: Tx, db: Db, now: Date, input: NewVersion): ContractVersion {
  const highest = currentContract(db, input.repoId);
  if (input.change === 'start') {
    if (!input.version || !/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error('A version is three numbers with dots between them, such as 0.10.1.');
    if (highest && compareVersions(input.version, highest) <= 0) throw new Error(`${input.version} is not higher than ${highest}, which was already handed out.`);
  }
  const cited = (input.decisions ?? []).map(normalId);
  const missing = cited.find((id) => !store.getEntry(db, id));
  if (missing) throw new Error(`There is no decision ${missing} on record.`);
  const issued: ContractVersion = {
    id: store.newId(),
    repoId: input.repoId,
    version: input.change === 'start' ? input.version! : nextVersion(highest, input.change),
    change: input.change,
    summary: input.summary.trim(),
    taskId: input.taskId,
    decisions: cited,
    by: input.by,
    at: now.toISOString(),
  };
  tx.emit({ kind: 'contract_version_issued', issued });
  const task = input.taskId && input.change !== 'start' ? store.getTask(db, input.taskId) : undefined;
  if (task) tx.emit({ kind: 'task_changed', task: { ...task, contractVersion: issued.version, updatedAt: now.toISOString() }, cause: 'edited' });
  return issued;
}

/** True when a text states this version, and not one it is only part of ("0.10.2" is not stated by "0.10.21" or "10.10.2"). */
export function states(text: string, version: string): boolean {
  return new RegExp(`(?<![\\d.])${version.replace(/\./g, '\\.')}(?!\\d)(?!\\.\\d)`).test(text);
}

/**
 * What is wrong with a ticket's change to the contract, in words for its author; null when nothing is. The contract
 * changes only on a ticket the engine gave a version to (or under one: its parent's, or a part's own), and the
 * ticket that holds the version states it in the contract's files.
 */
export function contractProblem(input: { own: string | null; parent: string | null; parts: string[]; changed: string[]; added: string }): string | null {
  if (input.changed.length === 0) return null;
  if (!input.own && !input.parent && input.parts.length === 0) {
    return `You changed the contract (${input.changed.slice(0, 8).join(', ')}) without a version. A change to the contract needs a version from the engine. On a team with a lead, the lead gets one with mcp__engine__contract_version. Anyone else asks with mcp__engine__request_decision, and the chief of staff can give this ticket one. If the contract did not need to change, take that change out.`;
  }
  if (input.own && !states(input.added, input.own)) {
    return `The contract's files do not state ${input.own}, the version this change was given. Write it where the contract lists its versions. If a later version has landed since, that one stays the current one: add yours beside it, do not put it in its place.`;
  }
  return null;
}

// ---------- what a ticket is built on, and what a run is shown ----------

/**
 * What a new ticket is built on: the decisions its maker named, after its parent's, each once; and the version its
 * repository's contract is at today. Undefined when that is nothing at all. A number nobody recorded is refused.
 */
export function builtOnFor(db: Db, input: { decisions?: string[] | undefined; parent?: Task | null | undefined; repoId: string | null }): Task['builtOn'] {
  const named = (input.decisions ?? []).map(normalId);
  const missing = named.find((id) => !store.getEntry(db, id));
  if (missing) throw new Error(`There is no decision ${missing} on record. Name decisions by their numbers, such as D-12.`);
  const decisions = [...new Set([...(input.parent?.builtOn?.decisions ?? []), ...named])];
  // A repository that names no contract has none, whatever versions were once handed out for it.
  const repo = input.repoId ? store.getRepo(db, input.repoId) : undefined;
  const contract = repo?.contract ? currentContract(db, repo.id) : null;
  return decisions.length === 0 && contract === null ? undefined : { decisions, contract };
}

/** How many of the newest decisions a run is shown without asking. */
const NEWEST = 20;
const LINE = 160;

/** `changesContractTo`: the version this ticket itself holds. `partOfChange`: the one the task it is a part of holds. */
export type RecordIndex = { cited: RecordEntry[]; recent: RecordEntry[]; contract: { paths: string[]; version: string | null } | null; changesContractTo: string | null; partOfChange?: string | null };

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
    changesContractTo: task.contractVersion ?? null,
    partOfChange: task.contractVersion ? null : (parent?.contractVersion ?? null),
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
        // The newest handed out, which is not always what the files say: a ticket that holds a later one may not have landed.
        `The contract is ${index.contract.paths.join(', ')}. ${index.contract.version ? `The newest version handed out for it is ${index.contract.version}.` : 'No version has been handed out for it yet.'} Its files change only on a ticket the engine gave a version to.`,
        index.changesContractTo ? `This ticket changes the contract. Its version is ${index.changesContractTo}: the contract's files must state it.` : '',
        index.partOfChange ? `The task this is a part of changes the contract, as version ${index.partOfChange}. This part may change the contract's files where that is its work.` : '',
      ].filter(Boolean)
    : [];
  if (decided.length === 0 && contract.length === 0) return '';
  const head = decided.length > 0 ? 'Decisions on record. This is the company\'s own numbered list of what was decided: go by it, not by memory. Read any one whole, or search them all, with mcp__engine__read_decisions.' : '';
  return [head, ...decided, ...contract].filter(Boolean).join('\n\n');
}

// ---------- in words ----------

/** Who decided, as a reader is told it. */
export function whoDecided(db: Db, entry: Pick<RecordEntry, 'by' | 'archived'>): string {
  // Taken over from a file: who decided each thing is in its own words, and the engine does not claim to know.
  if (entry.archived) return 'the log kept by hand';
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
  if (!chief && !lead) return { ok: false, text: 'Decisions are recorded by a team\'s lead or the chief of staff. If something needs deciding, ask with mcp__engine__request_decision.' };
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
 * `contract_version`: the next version, for a ticket. A lead asks for its own ticket or one of its parts. The chief of
 * staff asks for the ticket of the card it is deciding, or for one it names: on a team without a lead, nobody else can.
 */
export function onContractVersion(db: Db, now: Date, run: Run, input: unknown): ToolReply {
  const asked = TOOL_INPUT.contract_version.safeParse(input);
  if (!asked.success) return { ok: false, text: 'Say what kind of change it is (breaking, adds or wording) and what it is, in one sentence.' };
  const employee = store.getEmployee(db, run.employeeId);
  const chief = store.getCompany(db)?.chiefOfStaffId === run.employeeId;
  const lead = Boolean(employee && store.getTeam(db, employee.teamId)?.leadId === employee.id);
  if (!chief && !lead) return { ok: false, text: 'A contract version is given by a team\'s lead or the chief of staff. Ask with mcp__engine__request_decision.' };
  const here = store.getTask(db, run.taskId);
  const noPosition = 'A position changes nothing, so it gets no contract version: say in your position what the contract should hold. The design\'s author gets the version when it drafts.';
  if (here?.meetingRole === 'position' && !asked.data.ticket) return { ok: false, text: noPosition };
  const own = here?.kind === 'work' ? here : undefined;
  let ticket: Task | undefined;
  if (asked.data.ticket) {
    const wanted = asked.data.ticket.trim();
    const work = store.listTasks(db).filter((task) => task.kind === 'work');
    const named = work.filter((task) => task.id === wanted);
    const found = named.length > 0 ? named : work.filter((task) => task.state !== 'done' && task.state !== 'failed' && task.title.trim().toLowerCase() === wanted.toLowerCase());
    if (found.length === 0) return { ok: false, text: `There is no ticket "${wanted}". Name it by its id or by its exact title.` };
    if (found.length > 1) return { ok: false, text: `More than one ticket is called "${wanted}". Name it by its id: ${found.map((task) => task.id).join(', ')}.` };
    ticket = found[0]!;
    if (ticket.meetingRole === 'position') return { ok: false, text: noPosition };
    if (!chief && !(own && (ticket.id === own.id || ticket.parentId === own.id))) return { ok: false, text: `"${ticket.title}" is not this ticket or one of its sub-tasks. A lead gives a version to its own ticket and to its parts.` };
  } else if (own) ticket = own;
  else {
    // Deciding a card: the version is for the ticket the card is about.
    const card = here?.decisionId ? store.getDecision(db, here.decisionId) : undefined;
    ticket = card?.taskId ? store.getTask(db, card.taskId) : undefined;
  }
  if (!ticket) return { ok: false, text: 'Name the ticket the version is for: "ticket", its id or its exact title.' };
  const repo = ticket.repoId ? store.getRepo(db, ticket.repoId) : undefined;
  if (!repo?.contract) return { ok: false, text: `The repository of "${ticket.title}" has no contract named, so nothing there needs a version.` };
  const mine = ticket.id === own?.id;
  if (ticket.contractVersion) return { ok: true, text: `${mine ? 'This ticket' : `"${ticket.title}"`} already holds ${ticket.contractVersion}: a ticket holds one version.` };
  const target = ticket;
  try {
    let issued!: ContractVersion;
    apply(db, (tx) => void (issued = issueContractVersion(tx, db, now, { repoId: repo.id, change: asked.data.change, summary: asked.data.summary, taskId: target.id, decisions: asked.data.decisions, by: run.employeeId })), now);
    return { ok: true, text: `Version ${issued.version} is ${mine ? 'this ticket\'s' : `"${target.title}"'s`}. The contract's files (${repo.contract.paths.join(', ')}) may be changed on it, and must state ${issued.version}.` };
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
    // The question as it was asked, where the card kept it: the card's own first line is mostly about who asked and on what.
    statement: `${oneLine(typeof card.subject?.question === 'string' ? card.subject.question : card.text, 120)} Answer: ${oneLine(given.words, 120)}`,
    why: given.why,
    by: chief ? { kind: 'chief', employeeId: given.by } : { kind: 'user', employeeId: null },
    taskId: task?.id ?? null,
    repoId: task?.repoId ?? null,
    detail: `Question:\n${card.text.trim()}\n\nAnswer:\n${given.words.trim()}`,
  });
}
