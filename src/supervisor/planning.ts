/**
 * The plan the engine keeps: what waits for what. A task that names others in `after` is not started until they are
 * done; whoever plans (the chief of staff making tasks, a lead splitting one) says the order there, and has the board
 * and the history in front of it when it does. This file is the reading side: names to tasks, what a task still waits
 * for, and the planner's view. The flow does the starting.
 */
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { Task, Team } from '../shared/types.ts';
import { listed } from './meeting.ts';

const over = (task: Task): boolean => task.state === 'done' || task.state === 'failed';

/**
 * The tasks a new task is to wait for, from what its maker wrote: each an id, or the exact title of a task that was
 * not stopped. Throws, in words that say what would work, for a name that is no task or more than one.
 */
export function resolveAfter(db: Db, names: string[] | undefined): string[] {
  const work = store.listTasks(db).filter((task) => task.kind === 'work');
  const ids: string[] = [];
  for (const raw of names ?? []) {
    const name = raw.trim();
    const byId = work.find((task) => task.id === name);
    // Among tasks of one title, one that is still open is the one meant; a finished one is waited for no longer anyway.
    const titled = work.filter((task) => task.state !== 'failed' && task.title.trim().toLowerCase() === name.toLowerCase());
    const open = titled.filter((task) => !over(task));
    const found = byId ? [byId] : open.length > 0 ? open : titled.slice(-1);
    if (found.length === 0) throw new Error(`There is no task "${name}" to wait for. Name it by its id or its exact title`);
    if (found.length > 1) throw new Error(`More than one task is called "${name}". Name the one to wait for by its id: ${found.map((task) => task.id).join(', ')}`);
    if (!ids.includes(found[0]!.id)) ids.push(found[0]!.id);
  }
  return ids;
}

/** What a task waits for, sorted by what became of it. */
export function waitingOn(db: Db, task: Pick<Task, 'after'>): { open: Task[]; stopped: Task[]; done: Task[] } {
  const all = (task.after ?? []).map((id) => store.getTask(db, id));
  return {
    open: all.filter((dep): dep is Task => dep !== undefined && !over(dep)),
    // One that is gone is as good as stopped: nothing will come of it.
    stopped: all.flatMap((dep, index) => (dep === undefined ? [{ id: task.after![index]!, title: 'a task that is gone', state: 'failed' } as Task] : dep.state === 'failed' ? [dep] : [])),
    done: all.filter((dep): dep is Task => dep?.state === 'done'),
  };
}

/** In a proposal: sub-tasks that wait for something that is no sub-task of it, for themselves, or for each other in a circle. */
export function orderProblems(subtasks: { title: string; after?: string[] | undefined }[]): { code: 'unknown_order' | 'circular_order'; text: string }[] {
  const problems: { code: 'unknown_order' | 'circular_order'; text: string }[] = [];
  const key = (title: string) => title.trim().toLowerCase();
  const titles = subtasks.map((sub) => key(sub.title));
  const edges = new Map<string, string[]>();
  for (const sub of subtasks) {
    const waits: string[] = [];
    for (const name of sub.after ?? []) {
      const matches = titles.filter((title) => title === key(name)).length;
      if (matches === 0) problems.push({ code: 'unknown_order', text: `"${sub.title}" waits for "${name}", which is not one of the sub-tasks you propose. Name another sub-task of this proposal by its exact title.` });
      else if (matches > 1) problems.push({ code: 'unknown_order', text: `"${sub.title}" waits for "${name}", which is the title of ${matches} sub-tasks. Give each sub-task its own title.` });
      else waits.push(key(name));
    }
    edges.set(key(sub.title), waits);
  }
  // A circle: following what each waits for comes back to where it began.
  const named = (title: string) => subtasks.find((sub) => key(sub.title) === title)?.title ?? title;
  const reported = new Set<string>();
  const walk = (start: string, at: string, path: string[]): void => {
    for (const next of edges.get(at) ?? []) {
      if (next === start) {
        const circle = [...path].sort();
        if (reported.has(circle.join('\u0000'))) continue;
        reported.add(circle.join('\u0000'));
        problems.push({
          code: 'circular_order',
          text: path.length === 1 ? `"${named(start)}" waits for itself.` : `${listed(path.map((title) => `"${named(title)}"`))} wait for each other${path.length > 2 ? ' in a circle' : ''}, so none of them could ever start. Take one of the waits out.`,
        });
      } else if (!path.includes(next)) walk(start, next, [...path, next]);
    }
  };
  for (const title of new Set(titles)) walk(title, title, [title]);
  return problems;
}

const WEEK_MS = 7 * 24 * 3600_000;
const SHOWN = 20;

/**
 * What a lead is shown when it plans: its team's board (what is open, what finished in the last week, who has each and
 * the files it owns), and who has worked where, from the work the engine landed. So that a ticket goes to whoever
 * knows the files, and nothing that is done or under way is planned a second time.
 */
export function planLines(db: Db, team: Team, planning: Task, now: Date): string {
  const name = (id: string | null | undefined): string => (id && store.getEmployee(db, id)?.name) || 'nobody yet';
  const authorOf = (task: Task): string | null => store.runsOf(db, task.id).findLast((run) => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate')?.employeeId ?? task.assigneeId;
  const mine = store.listTasks(db, { teamId: team.id }).filter((task) => task.kind === 'work' && task.id !== planning.id && !task.meetingRole && !task.dropped);
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const board = mine
    .filter((task) => task.state !== 'failed' && (task.state !== 'done' || task.updatedAt >= since))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const boardLines = board.slice(-SHOWN).map((task) => {
    const waits = waitingOn(db, task).open;
    return `- "${task.title}" (${task.state}), ${name(task.state === 'done' ? authorOf(task) : (task.assigneeId ?? team.leadId))}: ${task.ownership.join(', ') || 'no files named'}${waits.length > 0 ? `; waits for ${listed(waits.map((dep) => `"${dep.title}"`))}` : ''}`;
  });
  // Who knows which files: whoever did the finished work that owned them.
  const worked = new Map<string, Set<string>>();
  for (const task of mine.filter((one) => one.state === 'done' && one.ownership.length > 0)) {
    const who = authorOf(task);
    if (!who) continue;
    const files = worked.get(who) ?? new Set<string>();
    for (const file of task.ownership) files.add(file);
    worked.set(who, files);
  }
  const workedLines = [...worked].map(([who, files]) => `- ${name(who)}: ${[...files].slice(0, 12).join(', ')}${files.size > 12 ? ` and ${files.size - 12} more` : ''}`);
  return `Your team's board (what is open, and what finished in the last week):
${boardLines.join('\n') || '- (nothing else is on it)'}

Who has worked where (from the work the engine landed):
${workedLines.join('\n') || '- (nothing has landed yet)'}

Plan with this in front of you: give a ticket to whoever knows its files, do not plan again what is done or under way, and where one piece builds on another say so with after.`;
}
