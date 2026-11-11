/**
 * A lead's proposal to split a task, checked before any sub-task exists. Pure.
 */
import { outside, overlaps, unusable } from '../git/ownership.ts';
import type { Employee, Repo, Task, Team } from '../shared/types.ts';
import type { SubtaskProposal } from '../worker/protocol.ts';

export const MAX_SUBTASKS = 8;

export type ProposalReason = { code: 'unusable_ownership' | 'empty' | 'too_many' | 'overlap' | 'unknown_assignee' | 'assignee_not_in_team' | 'assignee_fired' | 'missing_done_condition' | 'unknown_gate' | 'caps_exceed_parent' | 'parent_is_a_child' | 'outside_parent'; text: string };

export function validateProposal(input: { parent: Task; team: Team; employees: Employee[]; repo: Repo | null; remainingUsd: number; subtasks: SubtaskProposal[] }): { ok: true } | { ok: false; reasons: ProposalReason[] } {
  const { parent, team, subtasks } = input;
  const reasons: ProposalReason[] = [];
  const add = (code: ProposalReason['code'], text: string) => void reasons.push({ code, text });

  // Sub-tasks are worked, never briefed again. Work for another team goes through the chief of staff.
  if (parent.parentId !== null) add('parent_is_a_child', 'This task is itself a sub-task, so it cannot be split further. Do it, or ask with request_decision.');
  if (subtasks.length === 0) add('empty', 'The proposal has no sub-tasks.');
  if (subtasks.length > MAX_SUBTASKS) add('too_many', `A task can be split into at most ${MAX_SUBTASKS} sub-tasks; this proposal has ${subtasks.length}.`);

  for (const sub of subtasks) {
    const assignee = input.employees.find((e) => e.id === sub.assigneeId);
    if (!assignee) add('unknown_assignee', `"${sub.title}": there is no employee with the id ${sub.assigneeId}.`);
    else if (assignee.teamId !== team.id) add('assignee_not_in_team', `"${sub.title}": ${assignee.name} is not on your team.`);
    else if (assignee.fired) add('assignee_fired', `"${sub.title}": ${assignee.name} no longer works here.`);
    if (!sub.doneCondition.trim()) add('missing_done_condition', `"${sub.title}" has no done-condition.`);
    const vague = unusable(sub.ownership);
    if (vague.length > 0) add('unusable_ownership', `"${sub.title}" owns ${vague.map((entry) => `"${entry}"`).join(', ')}, which names no file or folder. Name files or folders by their path from the top of the repository, such as src/api or README.md; patterns are not understood.`);
    // A part cannot own more than the whole: splitting a task is not a way to reach files the task was not given.
    if (parent.ownership.length > 0 && (sub.ownership.length === 0 || outside(sub.ownership, parent.ownership).length > 0)) {
      add('outside_parent', `"${sub.title}" owns ${sub.ownership.join(', ') || 'everything'}, but the task you are splitting owns only ${parent.ownership.join(', ')}. Give each sub-task files inside that.`);
    }
    for (const gate of sub.gates) if (!input.repo?.gates.some((g) => g.name === gate)) add('unknown_gate', `"${sub.title}": there is no gate named "${gate}"${input.repo ? ` (the gates are: ${input.repo.gates.map((g) => g.name).join(', ') || 'none'})` : ''}.`);
  }

  for (let i = 0; i < subtasks.length; i++)
    for (let j = i + 1; j < subtasks.length; j++)
      // Files are owned only where there is a repository: a team without one has none to step on.
      if (input.repo && overlaps(subtasks[i]!.ownership, subtasks[j]!.ownership)) add('overlap', `"${subtasks[i]!.title}" and "${subtasks[j]!.title}" own some of the same files. Give each its own files or folders; an empty list owns everything.`);

  const caps = subtasks.reduce((sum, sub) => sum + sub.capUsd, 0);
  if (caps > input.remainingUsd + 1e-9) add('caps_exceed_parent', `The caps add up to $${caps.toFixed(2)}, but this task has $${Math.max(0, input.remainingUsd).toFixed(2)} left.`);

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
