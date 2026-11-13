/**
 * The engine telling someone that something they depend on has changed: a message from whoever made the change, to
 * whoever has the ticket. A session that is running gets it as its next turn; one that is not finds it at the start
 * of its next run. Nobody has to ask.
 */
import type { Tx } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { Task } from '../shared/types.ts';

/** Whoever has a ticket right now: the one running it, else its assignee, else its team's lead. */
export function holderOf(db: Db, task: Task): string | null {
  const live = store.liveRuns(db).find((run) => run.taskId === task.id);
  const to = live?.employeeId ?? task.assigneeId ?? store.getTeam(db, task.teamId)?.leadId ?? null;
  const employee = to ? store.getEmployee(db, to) : undefined;
  return employee && !employee.fired ? employee.id : null;
}

/** A message to one employee, about a ticket or about none. */
export function tell(tx: Tx, now: Date, input: { toId: string; fromId: string; taskId: string | null; text: string }): void {
  tx.emit({ kind: 'message_sent', message: { id: store.newId(), fromId: input.fromId, toId: input.toId, taskId: input.taskId, text: input.text, state: 'waiting', at: now.toISOString(), deliveredAt: null } });
}

/** Tells whoever has the ticket. Nothing is said when nobody has it: the board's stale mark still says it. */
export function tellTicket(tx: Tx, db: Db, now: Date, task: Task, fromId: string, text: string): void {
  const toId = holderOf(db, task);
  if (toId) tell(tx, now, { toId, fromId, taskId: task.id, text: `About "${task.title}": ${text}` });
}

/** A sentence that ends once. */
export const sentence = (text: string): string => `${text.trim().replace(/[.\s]+$/, '')}.`;

/** Work tasks that are neither done nor stopped. */
export const openWork = (db: Db): Task[] => store.listTasks(db).filter((task) => task.kind === 'work' && task.state !== 'done' && task.state !== 'failed');
