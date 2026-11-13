/**
 * The state of the board in plain lines, for the chief of staff. The user asks it what the
 * company is doing; this is the engine's own record, put in front of it with every message,
 * so it answers from what is true now and never from old notes or a guess.
 */
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { ago, checkedLine, countsCost, WHY } from '../shared/view.ts';
import { waitingOn } from './planning.ts';
import { movedFor, staleLine } from './stale.ts';

const SHOWN_PER_TEAM = 12;

export function companyNow(db: Db, now: Date): string {
  const company = store.getCompany(db);
  const employees = new Map(store.allEmployees(db).map((employee) => [employee.id, employee]));
  const name = (id: string | null | undefined): string => (id && employees.get(id)?.name) || 'nobody';
  const live = store.liveRuns(db);
  const cards = store.openDecisions(db);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const work = store.listTasks(db).filter((task) => task.kind === 'work');
  // Who did the work: a task its lead took has no assignee, so the name comes from the last run that made something.
  const authorOf = (taskId: string): string | undefined => store.runsOf(db, taskId).findLast((run) => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate')?.employeeId;
  // What stands behind finished work, from what the engine verified only.
  const checkedOf = (taskId: string): string => {
    const last = store.runsOf(db, taskId).findLast((run) => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate');
    const line = last ? checkedLine(last) : null;
    return line ? ` (${line.replace(/^Checked: /, 'checked: ')})` : '';
  };
  const lines: string[] = [];

  for (const team of store.allTeams(db)) {
    // What is under way, and what ended today. Older finished work is history, not the present.
    const mine = work.filter((task) => task.teamId === team.id && ((task.state !== 'done' && task.state !== 'failed') || task.updatedAt >= midnight));
    if (mine.length === 0) {
      lines.push(`${team.name}: nothing on its board.`);
      continue;
    }
    lines.push(`${team.name}:`);
    for (const task of mine.slice(0, SHOWN_PER_TEAM)) {
      const run = live.find((r) => r.taskId === task.id);
      const card = cards.find((c) => c.taskId === task.id);
      const doing = run ? `${name(run.employeeId)} is ${run.mode === 'review' ? 'reviewing it' : run.mode === 'brief' ? 'splitting it' : 'working on it'}` : '';
      // What the engine is doing for a task nobody is running: its gates, or waiting its turn to run them.
      const engine = run ? undefined : store.runsOf(db, task.id).at(-1)?.waiting;
      const what = run?.waiting
        ? // Waiting is said apart from working: how long it has waited, and for what.
          `${doing}, and has been ${run.waiting.on === 'gate' ? `waiting for the gate "${run.waiting.what}"` : `waiting for ${run.waiting.what}`} for ${ago(run.waiting.since, now)}`
        : run
          ? `${doing}${run.activity ? ` ("${run.activity}")` : ''}, for ${ago(run.startedAt, now)}`
        : engine && !card && task.state !== 'done' && task.state !== 'failed'
          ? engine.on === 'gate'
            ? `the engine is running its gate "${engine.what}", for ${ago(engine.since, now)}`
            : `the engine is waiting for ${engine.what}, to run its gates, for ${ago(engine.since, now)}`
        : card?.deciderId
          ? `${name(card.deciderId)} is deciding it for the user, for ${ago(card.askedAt, now)}`
          : card
            ? `waiting on the user (${WHY[card.kind]}) for ${ago(card.askedAt, now)}`
            : task.dropped
              ? `dropped by ${name(task.dropped.by)}: ${task.dropped.why}`
            : task.state === 'done'
              ? `finished today by ${name(authorOf(task.id) ?? task.assigneeId ?? team.leadId)}${checkedOf(task.id)}${task.mergedInto ? `, merged into ${task.mergedInto}` : task.branch ? `, kept on the branch ${task.branch}` : ''}`
              : task.state === 'failed'
                ? 'stopped today'
                : task.state === 'queued' && waitingOn(db, task).open.length > 0
                  ? `waiting for ${waitingOn(db, task).open.map((dep) => `"${dep.title}"`).join(' and ')} to be done`
                : task.state === 'queued'
                  ? `waiting to start, for ${name(task.assigneeId ?? team.leadId)}`
                  : `nobody is on it right now (${name(task.assigneeId ?? team.leadId)} has it)`;
      // Computed, never asked for: how far a split has come, and whether what the task is built on has moved.
      const open = task.state !== 'done' && task.state !== 'failed';
      const parts = open ? work.filter((child) => child.parentId === task.id && !child.meetingRole && !child.dropped) : [];
      const progress = parts.length > 0 ? `; ${parts.filter((child) => child.state === 'done').length} of ${parts.length} parts done` : '';
      const stale = open ? staleLine(movedFor(db, task)) : null;
      lines.push(`- "${task.title}" (${task.state}): ${what}${progress}${stale ? `; ${stale}` : ''}`);
    }
    if (mine.length > SHOWN_PER_TEAM) lines.push(`- and ${mine.length - SHOWN_PER_TEAM} more`);
  }

  lines.push(live.length === 0 ? 'Nobody is running right now.' : `Running right now: ${live.map((run) => name(run.employeeId)).join(', ')}.`);
  const waiting = cards.filter((card) => !card.deciderId).length;
  lines.push(waiting === 0 ? 'No decision is waiting for the user.' : `${waiting} decision${waiting === 1 ? ' is' : 's are'} waiting for the user.`);
  // Where cost is not counted it is not said either: the figure would be a list price nobody pays.
  if (!countsCost(company)) return lines.join('\n');
  const spent = store.spendToday(db, now).company;
  lines.push(`Spent today: $${spent.toFixed(2)}${company && company.dailyCapUsd > 0 ? ` of $${company.dailyCapUsd.toFixed(2)}` : ''}.`);
  return lines.join('\n');
}
