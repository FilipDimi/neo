/**
 * Talking to the company. What the user types in the company chat goes to the chief of staff,
 * who turns it into tasks on the right teams and replies. Any employee can also be written to
 * directly: a busy one gets the message as its next turn, an idle one gets it as a task.
 */
import { apply } from '../db/apply.ts';
import * as store from '../db/store.ts';
import type { Message } from '../shared/types.ts';
import type { Supervisor } from './supervisor.ts';

const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0]!;
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
};

function record(sup: Supervisor, toId: string, taskId: string, text: string): Message {
  const now = sup.now();
  const at = now.toISOString();
  const message: Message = { id: store.newId(), fromId: 'user', toId, taskId, text, state: 'delivered', at, deliveredAt: at };
  apply(sup.db, (tx) => tx.emit({ kind: 'message_sent', message }), now);
  return message;
}

/** A line in the company chat: a small task for the chief of staff, who routes it. The reply arrives as a message. */
export function chat(sup: Supervisor, text: string): Message {
  const company = store.getCompany(sup.db);
  const chief = company?.chiefOfStaffId ? store.getEmployee(sup.db, company.chiefOfStaffId) : undefined;
  if (!chief || chief.fired) throw new Error('This company has no chief of staff to talk to. Hire one first.');
  const task = sup.createTask({ teamId: chief.teamId, assigneeId: chief.id, kind: 'chat', title: titleOf(text), brief: text.trim(), repoId: null, capUsd: 1 });
  return record(sup, chief.id, task.id, text.trim());
}

export function messageEmployee(sup: Supervisor, employeeId: string, text: string): Message {
  const employee = store.getEmployee(sup.db, employeeId);
  if (!employee || employee.fired) throw new Error(`there is no employee ${employeeId}`);
  // Writing to the chief of staff is the company chat, whichever box it was typed in: it answers or routes, and nothing is ticked off as a task.
  if (store.getCompany(sup.db)?.chiefOfStaffId === employeeId) return chat(sup, text);
  if (store.liveRuns(sup.db).some((run) => run.employeeId === employeeId)) return sup.send({ employeeId }, text.trim(), 'user');
  // Nobody is idle with orders unread: for an idle employee the message is work, so it becomes a task on the board.
  const task = sup.createTask({ teamId: employee.teamId, assigneeId: employee.id, title: titleOf(text), brief: text.trim() });
  return record(sup, employee.id, task.id, text.trim());
}
