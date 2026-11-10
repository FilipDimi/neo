/**
 * Decision cards. Anything beyond what the engine may decide stops the task and becomes a card.
 * A card's options are data; answering one changes rows and queues run requests, and never
 * starts anything itself: the scheduler does that.
 */
import { apply, type Tx } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { Decision, DecisionKind, DecisionOption, Effect, Run, RunRequest, Task } from '../shared/types.ts';
import { requestFor } from './scheduler.ts';
import { canTransition, transition, type TaskEvent } from './taskState.ts';

const STOP: DecisionOption = { id: 'stop', label: 'Stop it', effect: 'stop_task' };
const SEND_BACK: DecisionOption = { id: 'send_back', label: 'Send back', effect: 'send_back' };
const ACCEPT: DecisionOption = { id: 'accept', label: 'Accept as it is', effect: 'accept' };

export function optionsFor(kind: DecisionKind, context: { leaseMinutes?: number; capUsd?: number; choices?: string[] } = {}): DecisionOption[] {
  switch (kind) {
    case 'lease': {
      const longer = (context.leaseMinutes ?? 15) * 2;
      return [{ id: 'retry', label: `Retry, ${longer} min`, effect: 'retry', params: { leaseMinutes: longer } }, STOP];
    }
    case 'failed':
      return [{ id: 'retry', label: 'Retry', effect: 'retry' }, STOP];
    case 'cap': {
      const usd = context.capUsd && context.capUsd > 0 ? context.capUsd : 1;
      return [{ id: 'raise', label: `Raise by $${usd.toFixed(2)}`, effect: 'raise_cap', params: { usd } }, STOP];
    }
    case 'tool':
      return [{ id: 'allow_once', label: 'Allow once', effect: 'allow_once' }, { id: 'keep_refused', label: 'Keep refused', effect: 'keep_refused' }, STOP];
    case 'merge':
      return [{ id: 'merge', label: 'Merge', effect: 'merge' }, { id: 'keep', label: 'Keep the branch', effect: 'complete' }, STOP];
    case 'question':
      return [
        ...(context.choices ?? []).map((text, i): DecisionOption => ({ id: `choice${i + 1}`, label: text, effect: 'resume_with_answer', params: { text } })),
        { id: 'answer', label: 'Answer', effect: 'resume_with_answer' },
        STOP,
      ];
    case 'briefing':
      return [SEND_BACK, STOP];
    case 'review':
    case 'ownership':
      return [SEND_BACK, ACCEPT, STOP];
    case 'invariant':
      return [{ id: 'recheck', label: 'Run it again', effect: 'recheck' }, STOP];
    case 'staffing':
      return [{ id: 'recheck', label: 'Check again', effect: 'recheck' }, STOP];
    case 'health':
      return [{ id: 'recheck', label: 'Check again', effect: 'recheck' }];
    case 'usage_limit':
      return [{ id: 'resume', label: 'Resume now', effect: 'resume_company' }];
  }
}

export type RaiseInput = Pick<Decision, 'taskId' | 'kind' | 'text' | 'options'> & Partial<Pick<Decision, 'runId' | 'employeeId' | 'freeText' | 'subject'>>;

/** Moves a task along its state table and records it. Returns the task as it now is. */
export function move(tx: Tx, task: Task, event: TaskEvent, now: Date, patch: Partial<Task> = {}): Task {
  const at = now.toISOString();
  const next: Task = { ...task, ...patch, ...transition(task, event), updatedAt: at, blockedAt: event === 'block' ? at : null };
  tx.emit({ kind: 'task_changed', task: next, cause: 'state' });
  return next;
}

/**
 * Raises a card and blocks its task. One open card per task and kind (per subject key for cards
 * with no task): raising it again returns the card that is already open.
 */
export function raise(tx: Tx, db: Db, now: Date, input: RaiseInput): Decision {
  const key = input.subject?.key;
  const open = store.openDecisions(db).find((d) => d.kind === input.kind && d.taskId === input.taskId && d.subject?.key === key);
  if (open) return open;
  const task = input.taskId ? store.getTask(db, input.taskId) : undefined;
  if (task && canTransition(task, 'block')) move(tx, task, 'block', now);
  const decision: Decision = {
    id: store.newId(),
    runId: null,
    employeeId: null,
    ...input,
    costSoFarUsd: input.taskId ? store.spentOn(db, input.taskId) : 0,
    answer: null,
    askedAt: now.toISOString(),
    answeredAt: null,
  };
  tx.emit({ kind: 'decision_raised', decision });
  return decision;
}

/** Closes an open card without an answer from the user: the reason for it has gone away. */
export function close(tx: Tx, decision: Decision, now: Date): void {
  tx.emit({ kind: 'decision_answered', decision: { ...decision, answer: { optionId: 'closed' }, answeredAt: now.toISOString() }, result: 'closed' });
}

export type Answer = { optionId: string; text?: string };
export type Answered = { result: 'applied' | 'ignored'; decision: Decision; effect?: Effect; option?: DecisionOption };

export function answer(db: Db, now: Date, decisionId: string, given: Answer): Answered {
  const decision = store.getDecision(db, decisionId);
  if (!decision) throw new Error(`no decision ${decisionId}`);
  let out: Answered = { result: 'ignored', decision };
  apply(
    db,
    (tx) => {
      // Answered twice: the second answer is recorded and changes nothing.
      if (decision.answeredAt !== null) return void tx.emit({ kind: 'decision_answered', decision, result: 'ignored' });
      const answered: Decision = { ...decision, answer: given, answeredAt: now.toISOString() };
      const task = decision.taskId ? store.getTask(db, decision.taskId) : undefined;
      // Answered after its task finished: the card closes and nothing resumes.
      if (decision.taskId && (!task || task.state === 'done' || task.state === 'failed')) {
        out = { result: 'ignored', decision: answered };
        return void tx.emit({ kind: 'decision_answered', decision: answered, result: 'ignored' });
      }
      const option = decision.options.find((o) => o.id === given.optionId);
      if (!option) throw new Error(`decision ${decisionId} has no option "${given.optionId}"`);
      tx.emit({ kind: 'decision_answered', decision: answered, result: 'applied' });
      applyEffect(tx, db, now, answered, option, given.text);
      out = { result: 'applied', decision: answered, effect: option.effect, option };
    },
    now,
  );
  return out;
}

// ---------- what each answer does: rows and requests only ----------

/** The run a card is about: the one it names, else the task's latest. */
function runOf(db: Db, decision: Decision): Run | undefined {
  if (decision.runId) return store.getRun(db, decision.runId);
  return decision.taskId ? store.runsOf(db, decision.taskId).at(-1) : undefined;
}

function unblock(tx: Tx, task: Task, now: Date, patch: Partial<Task> = {}): Task {
  return canTransition(task, 'unblock') ? move(tx, task, 'unblock', now, patch) : task;
}

/** Queues another run of the same employee in the same mode, picking the session up where it stopped. */
function requestAgain(tx: Tx, db: Db, now: Date, task: Task, last: Run | undefined, reason: RunRequest['reason'], firstTurn: string, more: Partial<RunRequest> = {}): void {
  // Whoever ran it last carries on, unless they no longer work here: then it goes to whoever the task is assigned to now, from the start.
  const gone = last ? store.getEmployee(db, last.employeeId)?.fired !== false : false;
  if (gone) last = undefined;
  let who: { mode: RunRequest['mode']; employeeId: string } | undefined = last && { mode: last.mode, employeeId: last.employeeId };
  if (!who) {
    const team = store.getTeam(db, task.teamId);
    const fresh = team ? requestFor(task, team) : { problem: 'no_lead' as const };
    if ('problem' in fresh) return void raise(tx, db, now, { taskId: task.id, kind: 'staffing', text: staffingText(task, fresh.problem), options: optionsFor('staffing') });
    who = fresh;
  }
  tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, ...who, reason, resumeSessionId: last?.sessionId ?? null, firstTurn: last?.sessionId ? firstTurn : null, ...more }, now) });
}

export function staffingText(task: Task, problem: 'no_lead' | 'no_assignee' | 'fired'): string {
  if (problem === 'fired') return `"${task.title}" is waiting for someone who no longer works here. Reassign it or hire, then check again.`;
  if (problem === 'no_lead') return `"${task.title}" has nobody to brief it: its team has no lead. Hire a lead or assign the task, then check again.`;
  return `"${task.title}" has no assignee, and its team is self-managed. Assign it, then check again.`;
}

/** Fails a task and everything under it that is still open, and drops their requests. */
export function failTree(tx: Tx, db: Db, now: Date, task: Task): void {
  if (canTransition(task, 'fail')) move(tx, task, 'fail', now);
  for (const request of store.requestsOf(db, task.id)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: task.id });
  for (const open of store.openDecisions(db, task.id)) close(tx, open, now);
  for (const child of store.listTasks(db, { parentId: task.id })) failTree(tx, db, now, child);
}

function applyEffect(tx: Tx, db: Db, now: Date, decision: Decision, option: DecisionOption, text: string | undefined): void {
  if (option.effect === 'wait') return; // The card is answered; nothing else changes.
  if (option.effect === 'raise_daily_cap') {
    const usd = typeof option.params?.usd === 'number' ? option.params.usd : 0;
    const team = typeof option.params?.teamId === 'string' ? store.getTeam(db, option.params.teamId) : undefined;
    const company = store.getCompany(db);
    if (team) tx.emit({ kind: 'team_changed', team: { ...team, dailyCapUsd: team.dailyCapUsd + usd } });
    else if (company) tx.emit({ kind: 'company_changed', company: { ...company, dailyCapUsd: company.dailyCapUsd + usd } });
    return;
  }
  if (option.effect === 'resume_company') {
    const company = store.getCompany(db);
    if (company?.paused) tx.emit({ kind: 'company_changed', company: { ...company, paused: null } });
    return;
  }
  const task = decision.taskId ? store.getTask(db, decision.taskId) : undefined;
  if (!task) return; // A card with no task (health): the next check decides.
  const last = runOf(db, decision);

  switch (option.effect) {
    case 'stop_task':
      return failTree(tx, db, now, task);
    case 'retry': {
      const leaseMinutes = typeof option.params?.leaseMinutes === 'number' ? option.params.leaseMinutes : null;
      return requestAgain(tx, db, now, unblock(tx, task, now), last, 'retry', 'Your last run was cut short. The files in your folder are as you left them. Carry on with the task.', { leaseMinutes });
    }
    case 'raise_cap': {
      const usd = typeof option.params?.usd === 'number' ? option.params.usd : 0;
      return requestAgain(tx, db, now, unblock(tx, task, now, { capUsd: task.capUsd + usd }), last, 'resume', 'The budget for this task was raised. Carry on.');
    }
    case 'allow_once': {
      const tool = String(decision.subject?.tool ?? '');
      tx.emit({ kind: 'grant_changed', grant: { id: store.newId(), taskId: task.id, tool, inputHash: String(decision.subject?.inputHash ?? ''), used: false } });
      return requestAgain(tx, db, now, unblock(tx, task, now), last, 'resume', `The ${tool} call you were refused is allowed once. Make exactly that call again, then carry on.`);
    }
    case 'keep_refused':
      return requestAgain(tx, db, now, unblock(tx, task, now), last, 'resume', 'The call you were refused stays refused. Finish the task another way, or ask with request_decision if you cannot.');
    case 'resume_with_answer': {
      const reply = text?.trim() || (typeof option.params?.text === 'string' ? option.params.text : '');
      if (!reply) throw new Error('this answer needs text');
      return requestAgain(tx, db, now, unblock(tx, task, now), last, 'resume', `The answer to your question: ${reply}`);
    }
    case 'send_back': {
      // The work goes back to whoever did it, which is not always the run the card names (a review run raised it).
      const author = store.runsOf(db, task.id).filter((r) => r.mode === 'work' || r.mode === 'brief' || r.mode === 'integrate').at(-1) ?? last;
      const back = unblock(tx, task, now);
      const working = canTransition(back, 'sent_back') ? move(tx, back, 'sent_back', now) : back;
      return requestAgain(tx, db, now, working, author, 'send_back', `This was sent back to you:\n\n${text?.trim() || 'See the card.'}`);
    }
    case 'recheck': {
      const open = unblock(tx, task, now);
      // A card may name the run it wants (integrate the rest); otherwise the last run carries on.
      const { mode, employeeId } = option.params ?? {};
      if (mode === 'integrate' && typeof employeeId === 'string') return void tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode, employeeId, reason: 'integrate' }, now) });
      return requestAgain(tx, db, now, open, last, 'resume', 'Carry on with the task where you left off.');
    }
    case 'merge':
    case 'complete':
    case 'accept':
      // The supervisor finishes these: they need git, or the flow's next step.
      return void unblock(tx, task, now);
  }
}
