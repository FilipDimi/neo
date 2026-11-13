/**
 * The task state table. Every legal move of a task is a row here; anything else throws.
 * A task that is blocked remembers the state it was blocked from and returns to it.
 */
import type { Task, TaskState } from '../shared/types.ts';

export type TaskEvent = 'start_brief' | 'start_work' | 'subtasks_created' | 'reported_done' | 'approved' | 'sent_back' | 'complete' | 'block' | 'unblock' | 'fail' | 'wait';

/** event -> from -> to. `block` and `unblock` are handled below, because they carry `blockedFrom`. */
export const TRANSITIONS: Record<TaskEvent, Partial<Record<TaskState, TaskState>>> = {
  start_brief: { queued: 'briefing' },
  start_work: { queued: 'running' },
  subtasks_created: { briefing: 'running' },
  reported_done: { briefing: 'review', running: 'review' },
  approved: { review: 'done' },
  sent_back: { review: 'running' },
  complete: { briefing: 'done', running: 'done', review: 'done' },
  block: { queued: 'blocked', briefing: 'blocked', running: 'blocked', review: 'blocked' },
  unblock: {},
  fail: { queued: 'failed', briefing: 'failed', running: 'failed', review: 'failed', blocked: 'failed' },
  // A run put its task to wait for another: it is queued again, and the engine starts it when that one is done.
  wait: { briefing: 'queued', running: 'queued' },
};

export class IllegalTransition extends Error {
  constructor(from: TaskState, event: TaskEvent) {
    super(`a ${from} task cannot ${event}`);
    this.name = 'IllegalTransition';
  }
}

export function transition(task: Pick<Task, 'state' | 'blockedFrom'>, event: TaskEvent): { state: TaskState; blockedFrom: TaskState | null } {
  if (event === 'unblock') {
    if (task.state !== 'blocked' || task.blockedFrom === null) throw new IllegalTransition(task.state, event);
    return { state: task.blockedFrom, blockedFrom: null };
  }
  const to = TRANSITIONS[event][task.state];
  if (!to) throw new IllegalTransition(task.state, event);
  return { state: to, blockedFrom: event === 'block' ? task.state : null };
}

export function canTransition(task: Pick<Task, 'state' | 'blockedFrom'>, event: TaskEvent): boolean {
  if (event === 'unblock') return task.state === 'blocked' && task.blockedFrom !== null;
  return TRANSITIONS[event][task.state] !== undefined;
}
