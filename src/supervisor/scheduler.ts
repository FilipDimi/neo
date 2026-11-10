/**
 * The scheduler: the only reader of run requests. Pure, so every rule has a test.
 * Every reason to start a run (a new task, a send-back, an integration, a review, a resume,
 * a retry) is a request; nothing starts a run any other way.
 */
import type { Company, Employee, RunMode, RunRequest, Task, Team } from '../shared/types.ts';

export type PickInput = {
  requests: RunRequest[];
  tasks: Map<string, Task>;
  teams: Map<string, Team>;
  employees: Map<string, Employee>;
  company: Company;
  runningEmployeeIds: Set<string>;
  /** Tasks with a live run. One run on a task at a time: two sessions never share a folder. */
  runningTaskIds: Set<string>;
  runningCount: number;
  spend: { company: number; byTeam: Map<string, number> };
  blockedRepoIds: Set<string>;
};

export type Pick = { request: RunRequest } | { problem: 'fired' | 'stale'; request: RunRequest } | null;

/** Who should run a task that has just been created, and how. */
export function requestFor(task: Task, team: Team): { mode: RunMode; employeeId: string } | { problem: 'no_lead' | 'no_assignee' } {
  if (task.assigneeId) return { mode: task.kind === 'chat' ? 'route' : 'work', employeeId: task.assigneeId };
  if (team.selfManaged) return { problem: 'no_assignee' };
  if (team.leadId) return { mode: 'brief', employeeId: team.leadId };
  return { problem: 'no_lead' };
}

/**
 * Who reviews a piece of work. Never its author. On a led team the lead reviews its members,
 * and a teammate reviews the lead: the first one hired who can read the work. Null means there
 * is nobody, and the gates alone decide; the merge card then says that nobody reviewed it.
 */
export function reviewerFor(task: Task, team: Team, authorId: string, staff: Employee[] = []): string | null {
  if (task.reviewerId) return task.reviewerId === authorId ? null : task.reviewerId;
  if (team.selfManaged || !team.leadId) return null;
  if (team.leadId !== authorId) return team.leadId;
  const teammate = staff.find((employee) => employee.teamId === team.id && employee.id !== authorId && !employee.fired && employee.capabilities.includes('read_files'));
  return teammate?.id ?? null;
}

export function pickNext(input: PickInput): Pick {
  const { company, tasks, teams, employees } = input;
  if (company.paused) return null;
  if (input.runningCount >= company.concurrency) return null;
  if (company.dailyCapUsd > 0 && input.spend.company >= company.dailyCapUsd) return null;

  const ordered = [...input.requests].sort((a, b) => {
    const ta = tasks.get(a.taskId);
    const tb = tasks.get(b.taskId);
    if (!ta || !tb) return ta ? 1 : tb ? -1 : 0;
    return ta.priority - tb.priority || ta.createdAt.localeCompare(tb.createdAt) || a.createdAt.localeCompare(b.createdAt);
  });

  for (const request of ordered) {
    const task = tasks.get(request.taskId);
    if (!task || task.state === 'done' || task.state === 'failed') return { problem: 'stale', request };
    if (task.state === 'blocked') continue;
    const employee = employees.get(request.employeeId);
    if (!employee || employee.fired) return { problem: 'fired', request };
    const team = teams.get(task.teamId);
    if (team && team.dailyCapUsd > 0 && (input.spend.byTeam.get(team.id) ?? 0) >= team.dailyCapUsd) continue;
    if (input.runningEmployeeIds.has(employee.id) || input.runningTaskIds.has(task.id)) continue;
    if (task.repoId && input.blockedRepoIds.has(task.repoId)) continue;
    return { request };
  }
  return null;
}
