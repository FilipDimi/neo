/**
 * What each view shows, as pure functions of the store and the clock. The board and the office
 * are both made from these, so they cannot disagree.
 */
import { reviewerFor } from '../../../src/supervisor/scheduler.ts';
import type { Company, Decision, Employee, Run, Task, Team } from '../../../src/shared/types.ts';
import { ago, attention, cardLine, countsCost, EARLIER_SHOWN, WHY, type Attention } from '../../../src/shared/view.ts';
import { clock, initials, money } from '../format.ts';
import { dayOf, type Store } from '../store/reduce.ts';

const authored = (run: Run): boolean => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate';
const isOpen = (decision: Decision): boolean => decision.answeredAt === null;

/** The cards on the user's desk. One the chief of staff is deciding on the user's behalf is open, and not here. */
export const openDecisions = (store: Store): Decision[] => [...store.decisions.values()].filter((decision) => isOpen(decision) && !decision.deciderId);
const beingDecided = (store: Store, taskId: string): Decision | undefined => [...store.decisions.values()].find((decision) => isOpen(decision) && decision.deciderId && decision.taskId === taskId);
export const liveRuns = (store: Store): Run[] => [...store.runs.values()].filter((run) => run.outcome === 'running');
export const runsOf = (store: Store, taskId: string): Run[] => [...store.runs.values()].filter((run) => run.taskId === taskId);
const nameOf = (store: Store, id: string | null): string => (id === 'user' ? 'you' : ((id && store.employees.get(id)?.name) ?? 'nobody'));

// ---------- a task at a glance ----------

/** What a task is, when nobody wrote a summary for it: the opening of its brief, whole sentences, a line or two. */
export function gist(brief: string, max = 160): string {
  const opening = (brief.trim().split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
  if (opening.length <= max) return opening;
  let out = '';
  for (const sentence of opening.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []) {
    if ((out + sentence).length > max) break;
    out += sentence;
  }
  if (out.trim()) return out.trim();
  const cut = opening.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trimEnd()}…`;
}

export type Glance = { summary: string; /** Where it stands, most important first, each a plain sentence. */ lines: string[]; /** What its author last reported. */ report: { by: string; text: string } | null };

/** The top of a task's drawer: what it is and where it stands, for someone who has ten seconds. */
export function glance(store: Store, taskId: string, _now: Date): Glance | null {
  const task = store.tasks.get(taskId);
  if (!task) return null;
  const runs = runsOf(store, taskId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const live = runs.find((run) => run.outcome === 'running');
  const team = store.teams.get(task.teamId);
  const who = (id: string | null | undefined): string => (id && store.employees.get(id)?.name) || 'someone';
  const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  const card = openDecisions(store).find((decision) => decision.taskId === taskId);
  const held = beingDecided(store, taskId);
  const children = [...store.tasks.values()].filter((child) => child.parentId === taskId);
  const lines: string[] = [];

  if (live) lines.push(live.mode === 'review' ? `${who(live.employeeId)} is reviewing it now.` : live.mode === 'brief' ? `${who(live.employeeId)} is splitting it into sub-tasks.` : `${who(live.employeeId)} is working on it now${live.activity ? `: ${live.activity.replace(/[.!?]+$/, '')}` : ''}.`);
  else if (task.state === 'done') lines.push(`Done${task.mergedInto ? `, merged into ${task.mergedInto}` : task.branch ? `, kept on the branch ${task.branch}` : ''}.`);
  else if (task.state === 'failed') lines.push('Stopped.');
  else if (card) lines.push(`Waiting on you: ${WHY[card.kind]}.`);
  else if (held) lines.push(`${who(held.deciderId)} is deciding what happens next.`);
  else if (task.state === 'queued') lines.push(`Waiting to start, for ${who(task.assigneeId ?? team?.leadId)}.`);
  else if (task.state === 'review') lines.push('Waiting for its review to start.');
  else if (children.some((child) => child.state !== 'done' && child.state !== 'failed')) lines.push('Waiting on its sub-tasks.');
  else lines.push('Nobody is on it right now.');

  if (children.length > 0) lines.push(`${children.filter((child) => child.state === 'done').length} of ${count(children.length, 'sub-task')} done.`);

  // What the last review of the work as it stands left to fix.
  const review = runs.slice(runs.findLastIndex(authored) + 1).findLast((run) => run.mode === 'review' && run.reason === 'sent_back');
  const mustFix = (review?.findings ?? []).filter((finding) => finding.severity === 'blocking').length;
  const times = task.reviewRounds === 1 ? 'once' : task.reviewRounds === 2 ? 'twice' : `${task.reviewRounds} times`;
  if (task.reviewRounds > 0) lines.push(review && mustFix > 0 ? `Sent back ${times}: ${who(review.employeeId)} found ${count(mustFix, 'thing')} that must be fixed.` : `Sent back ${times}.`);

  const gates = runs.findLast((run) => run.gateResults.length > 0)?.gateResults ?? [];
  if (gates.length > 0) lines.push(`Gates last time: ${gates.map((gate) => `${gate.name} ${gate.exitCode === 0 ? 'passed' : 'failed'}`).join(', ')}.`);

  if (runs.length > 0) lines.push(countsCost(store.company) ? `${money(runs.reduce((sum, run) => sum + run.costUsd, 0))} of ${money(task.capUsd)} spent over ${count(runs.length, 'run')}.` : `${count(runs.length, 'run')} so far.`);

  const reported = runs.findLast((run) => authored(run) && run.outcome !== 'running' && Boolean(run.summary?.trim()));
  return { summary: task.summary?.trim() || gist(task.brief), lines, report: reported ? { by: who(reported.employeeId), text: reported.summary!.trim() } : null };
}

// ---------- the header ----------

export type HeaderView = { company: string; clock: string; seatsBusy: number; seats: number; /** False where cost is not counted: then no spend is shown. */ priced: boolean; spentToday: number; capToday: number; openDecisions: number; paused: string | null };

export function header(store: Store, now: Date): HeaderView {
  const paused = store.company?.paused;
  const until = paused?.until ? ` until ${new Date(paused.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  return {
    company: store.company?.name ?? '',
    clock: clock(now),
    seatsBusy: liveRuns(store).length,
    seats: store.company?.concurrency ?? 0,
    priced: countsCost(store.company),
    spentToday: spendToday(store, now).company,
    capToday: store.company?.dailyCapUsd ?? 0,
    openDecisions: openDecisions(store).length,
    paused: !paused ? null : paused.reason === 'usage_limit' ? `paused at the plan's usage limit${until}` : paused.reason === 'health' ? 'paused: the machine needs attention' : 'paused by you',
  };
}

/** Today's spend, once: the header, the board's footer and the office's wall board all read this. */
export function spendToday(store: Store, now?: Date): { company: number; byTeam: { teamId: string; name: string; usd: number }[] } {
  // What the store holds is for the day it was last added to. Past midnight, today's spend is nothing until something is spent.
  if (now && dayOf(now) !== store.spendDay) return { company: 0, byTeam: [] };
  const byTeam = [...store.teams.values()].map((team) => ({ teamId: team.id, name: team.name, usd: store.spend.byTeam[team.id] ?? 0 })).filter((team) => team.usd > 0);
  return { company: store.spend.company, byTeam };
}

// ---------- the decision deck ----------

export type LocalAction = 'open_diff' | 'read_first' | 'not_now';
export type DeckCard = { id: string; kind: Decision['kind']; age: string; team: string | null; /** Who is waiting for the answer, when the card is an employee's own question. */ asker: string | null; text: string; freeText: boolean; options: { id: string; label: string; primary: boolean }[]; taskId: string | null; local: LocalAction[] };

export function deck(store: Store, now: Date): DeckCard[] {
  return openDecisions(store)
    .sort((a, b) => b.askedAt.localeCompare(a.askedAt) || b.id.localeCompare(a.id))
    .map((decision) => {
      const task = decision.taskId ? store.tasks.get(decision.taskId) : undefined;
      // The screen's own actions. They open or put aside; none of them answers the card.
      const local: LocalAction[] = [...(task?.branch ? (['open_diff'] as const) : []), ...(task && (decision.kind === 'question' || decision.kind === 'tool') ? (['read_first'] as const) : []), 'not_now'];
      return {
        id: decision.id,
        kind: decision.kind,
        age: ago(decision.askedAt, now),
        team: task ? (store.teams.get(task.teamId)?.name ?? null) : null,
        asker: decision.kind === 'question' && decision.employeeId ? (store.employees.get(decision.employeeId)?.name ?? null) : null,
        text: decision.text,
        freeText: decision.freeText === true,
        options: decision.options.map((option, index) => ({ id: option.id, label: option.label, primary: index === 0 })),
        taskId: task?.id ?? null,
        local,
      };
    });
}

// ---------- the board ----------

export type ColumnKey = 'queued' | 'briefing' | 'running' | 'review' | 'blocked' | 'done';
export type BoardCard = { taskId: string; title: string; line2: string; line3: string | null; attention: Attention; failed: boolean };
/** `earlier` is only ever filled for the last column: the last few things that finished before today. They are not in `count`. */
export type Column = { key: ColumnKey; title: string; count: number; cards: BoardCard[]; more: number; earlier: BoardCard[] };

const COLUMNS: [ColumnKey, string][] = [['queued', 'Queued'], ['briefing', 'Briefing'], ['running', 'Running'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done today']];
const DONE_SHOWN = 8;

function card(store: Store, task: Task, now: Date): BoardCard {
  const runs = runsOf(store, task.id);
  const live = runs.find((run) => run.outcome === 'running');
  const decisions = openDecisions(store).filter((decision) => decision.taskId === task.id);
  const team = store.teams.get(task.teamId);
  // Where cost is not counted, a card says nothing about it.
  const priced = countsCost(store.company);
  const spent = priced && money(runs.reduce((sum, run) => sum + run.costUsd, 0));
  const worker = nameOf(store, live?.employeeId ?? runs.filter(authored).at(-1)?.employeeId ?? task.assigneeId ?? team?.leadId ?? null);
  const parts = (...items: (string | false | undefined)[]) => items.filter(Boolean).join(' · ');
  const children = [...store.tasks.values()].filter((child) => child.parentId === task.id);
  let line2: string;
  switch (task.state) {
    case 'queued':
      line2 = parts(team?.name, `from ${nameOf(store, task.createdBy)}`, `P${task.priority}`, priced && `cap ${money(task.capUsd, true)}`);
      break;
    case 'review': {
      const author = runs.filter(authored).at(-1)?.employeeId ?? task.assigneeId;
      const reviewer = live?.mode === 'review' ? live.employeeId : team && author ? reviewerFor(task, team, author, [...store.employees.values()]) : null;
      line2 = parts(team?.name, `${nameOf(store, author ?? null)} → ${nameOf(store, reviewer)}`);
      break;
    }
    case 'done':
      line2 = parts(team?.name, worker, task.mergedInto ? `merged ${task.mergedInto}` : undefined, spent);
      break;
    case 'failed':
      line2 = parts(team?.name, worker, 'failed', spent);
      break;
    case 'blocked':
      line2 = parts(team?.name, worker, spent);
      break;
    default: {
      const started = runs[0]?.startedAt;
      line2 = parts(team?.name, worker, started ? ago(started, now) : undefined, spent);
    }
  }
  // A card someone is deciding for the user: the task waits on them, and says so, in the colour of work that is being looked at.
  const held = decisions.length === 0 && task.state === 'blocked' ? beingDecided(store, task.id) : undefined;
  if (held) return { taskId: task.id, title: task.title, line2, line3: `${nameOf(store, held.deciderId ?? null)} is deciding · ${ago(held.askedAt, now)}`, attention: 'review', failed: false };
  const line3 = task.state === 'done' ? '' : cardLine(task, runs, decisions, now, children);
  return { taskId: task.id, title: task.title, line2, line3: line3 || null, attention: attention(task, live, decisions, now), failed: task.state === 'failed' };
}

export function board(store: Store, now: Date): Column[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const work = [...store.tasks.values()].filter((task) => task.kind === 'work');
  const byOrder = (a: Task, b: Task) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return COLUMNS.map(([key, title]) => {
    if (key !== 'done') {
      const tasks = work.filter((task) => task.state === key).sort(byOrder);
      return { key, title, count: tasks.length, cards: tasks.map((task) => card(store, task, now)), more: 0, earlier: [] };
    }
    // Done and failed today. A failed task is what needs seeing, so it goes first; then the latest.
    const finished = work
      .filter((task) => (task.state === 'done' || task.state === 'failed') && task.updatedAt >= midnight)
      .sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed') || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    // Yesterday's work does not vanish at midnight: the newest of it stays within reach, so what it produced can still be opened.
    const before = work
      .filter((task) => (task.state === 'done' || task.state === 'failed') && task.updatedAt < midnight)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, EARLIER_SHOWN);
    return { key, title, count: finished.length, cards: finished.slice(0, DONE_SHOWN).map((task) => card(store, task, now)), more: Math.max(0, finished.length - DONE_SHOWN), earlier: before.map((task) => card(store, task, now)) };
  });
}

// ---------- the org chart ----------

export type PersonStatus = 'working' | 'reviewing' | 'idle' | 'stuck';
export type Person = { id: string; name: string; tag: string; role: string; status: PersonStatus };
export type OrgTeam = { id: string; name: string; summary: string; lead: Person | null; members: Person[] };

export function personStatus(store: Store, employeeId: string): PersonStatus {
  const open = openDecisions(store);
  const stuck = [...store.tasks.values()].some((task) => task.state === 'blocked' && task.assigneeId === employeeId) || open.some((decision) => decision.kind === 'lease' && decision.employeeId === employeeId);
  if (stuck) return 'stuck';
  const live = liveRuns(store).find((run) => run.employeeId === employeeId);
  if (!live) return 'idle';
  return live.mode === 'review' ? 'reviewing' : 'working';
}

function person(store: Store, employee: Employee): Person {
  return { id: employee.id, name: employee.name, tag: employee.name.length <= 3 ? employee.name : initials(employee.name), role: employee.role, status: personStatus(store, employee.id) };
}

export function teamSummary(team: Team, company?: Pick<Company, 'costs'> | null): string {
  const targets = [...new Set(team.repos.map((repo) => repo.mergeTarget).filter((target): target is string => target !== null))];
  const limit = team.repos.length > 0 ? `may merge: ${targets.join(', ') || 'no'}` : `may publish: ${team.mayPublish ? 'yes' : 'no'}`;
  return [team.selfManaged ? 'self-managed' : 'led', ...(countsCost(company) ? [`${money(team.dailyCapUsd, true)}/day`] : []), limit].join(' · ');
}

export function orgChart(store: Store, _now: Date): { chief: Person | null; teams: OrgTeam[] } {
  const staff = [...store.employees.values()].filter((employee) => !employee.fired);
  const chief = staff.find((employee) => employee.id === store.company?.chiefOfStaffId);
  const teams = [...store.teams.values()]
    // The chief of staff's own office is not a team to show unless someone else works in it.
    .filter((team) => !chief || team.id !== chief.teamId || staff.some((employee) => employee.teamId === team.id && employee.id !== chief.id))
    .map((team) => {
      const lead = staff.find((employee) => employee.id === team.leadId && employee.id !== chief?.id);
      return {
        id: team.id,
        name: team.name,
        summary: teamSummary(team, store.company),
        lead: lead ? person(store, lead) : null,
        members: staff.filter((employee) => employee.teamId === team.id && employee.id !== team.leadId && employee.id !== chief?.id).map((employee) => person(store, employee)),
      };
    });
  return { chief: chief ? person(store, chief) : null, teams };
}
