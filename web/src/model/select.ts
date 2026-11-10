/**
 * What each view shows, as pure functions of the store and the clock. The board and the office
 * are both made from these, so they cannot disagree.
 */
import { reviewerFor } from '../../../src/supervisor/scheduler.ts';
import type { Decision, Employee, Run, Task, Team } from '../../../src/shared/types.ts';
import { ago, attention, cardLine, type Attention } from '../../../src/shared/view.ts';
import { clock, initials, money } from '../format.ts';
import { dayOf, type Store } from '../store/reduce.ts';

const authored = (run: Run): boolean => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate';
const isOpen = (decision: Decision): boolean => decision.answeredAt === null;

export const openDecisions = (store: Store): Decision[] => [...store.decisions.values()].filter(isOpen);
export const liveRuns = (store: Store): Run[] => [...store.runs.values()].filter((run) => run.outcome === 'running');
export const runsOf = (store: Store, taskId: string): Run[] => [...store.runs.values()].filter((run) => run.taskId === taskId);
const nameOf = (store: Store, id: string | null): string => (id === 'user' ? 'you' : ((id && store.employees.get(id)?.name) ?? 'nobody'));

// ---------- the header ----------

export type HeaderView = { company: string; clock: string; seatsBusy: number; seats: number; spentToday: number; capToday: number; openDecisions: number; paused: string | null };

export function header(store: Store, now: Date): HeaderView {
  const paused = store.company?.paused;
  const until = paused?.until ? ` until ${new Date(paused.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  return {
    company: store.company?.name ?? '',
    clock: clock(now),
    seatsBusy: liveRuns(store).length,
    seats: store.company?.concurrency ?? 0,
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
export type Column = { key: ColumnKey; title: string; count: number; cards: BoardCard[]; more: number };

const COLUMNS: [ColumnKey, string][] = [['queued', 'Queued'], ['briefing', 'Briefing'], ['running', 'Running'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done today']];
const DONE_SHOWN = 8;

function card(store: Store, task: Task, now: Date): BoardCard {
  const runs = runsOf(store, task.id);
  const live = runs.find((run) => run.outcome === 'running');
  const decisions = openDecisions(store).filter((decision) => decision.taskId === task.id);
  const team = store.teams.get(task.teamId);
  const spent = money(runs.reduce((sum, run) => sum + run.costUsd, 0));
  const worker = nameOf(store, live?.employeeId ?? runs.filter(authored).at(-1)?.employeeId ?? task.assigneeId ?? team?.leadId ?? null);
  const parts = (...items: (string | false | undefined)[]) => items.filter(Boolean).join(' · ');
  const children = [...store.tasks.values()].filter((child) => child.parentId === task.id);
  let line2: string;
  switch (task.state) {
    case 'queued':
      line2 = parts(team?.name, `from ${nameOf(store, task.createdBy)}`, `P${task.priority}`, `cap ${money(task.capUsd, true)}`);
      break;
    case 'review': {
      const author = runs.filter(authored).at(-1)?.employeeId ?? task.assigneeId;
      const reviewer = live?.mode === 'review' ? live.employeeId : team && author ? reviewerFor(task, team, author) : null;
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
      return { key, title, count: tasks.length, cards: tasks.map((task) => card(store, task, now)), more: 0 };
    }
    // Done and failed today. A failed task is what needs seeing, so it goes first; then the latest.
    const finished = work
      .filter((task) => (task.state === 'done' || task.state === 'failed') && task.updatedAt >= midnight)
      .sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed') || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return { key, title, count: finished.length, cards: finished.slice(0, DONE_SHOWN).map((task) => card(store, task, now)), more: Math.max(0, finished.length - DONE_SHOWN) };
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

export function teamSummary(team: Team): string {
  const targets = [...new Set(team.repos.map((repo) => repo.mergeTarget).filter((target): target is string => target !== null))];
  const limit = team.repos.length > 0 ? `may merge: ${targets.join(', ') || 'no'}` : `may publish: ${team.mayPublish ? 'yes' : 'no'}`;
  return `${team.selfManaged ? 'self-managed' : 'led'} · ${money(team.dailyCapUsd, true)}/day · ${limit}`;
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
        summary: teamSummary(team),
        lead: lead ? person(store, lead) : null,
        members: staff.filter((employee) => employee.teamId === team.id && employee.id !== team.leadId && employee.id !== chief?.id).map((employee) => person(store, employee)),
      };
    });
  return { chief: chief ? person(store, chief) : null, teams };
}
