/**
 * Reads, and builders for new rows. Nothing here writes: rows change only through `apply`.
 */
import { randomUUID } from 'node:crypto';
import { leaseEnd, type TableName } from '../shared/project.ts';
import type { Company, Decision, Employee, Grant, HealthReport, Message, PlanUsage, Repo, Run, RunRequest, Task, TaskState, Team } from '../shared/types.ts';
import { getRow } from './apply.ts';
import type { Db } from './open.ts';

export const newId = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

function rows<T>(db: Db, table: TableName, where = '', ...params: unknown[]): T[] {
  return (db.prepare(`SELECT data FROM ${table} ${where}`).all(...params) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
}

const byAge = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);

export const getCompany = (db: Db): Company | undefined => rows<Company>(db, 'company')[0];
export const getTask = (db: Db, id: string) => getRow<Task>(db, 'tasks', id);
export const getRun = (db: Db, id: string) => getRow<Run>(db, 'runs', id);
export const getTeam = (db: Db, id: string) => getRow<Team>(db, 'teams', id);
export const getEmployee = (db: Db, id: string) => getRow<Employee>(db, 'employees', id);
export const getRepo = (db: Db, id: string) => getRow<Repo>(db, 'repos', id);
export const getDecision = (db: Db, id: string) => getRow<Decision>(db, 'decisions', id);
export const getRequest = (db: Db, id: string) => getRow<RunRequest>(db, 'run_requests', id);
export const getHealth = (db: Db) => getRow<HealthReport & { id: string }>(db, 'meta', 'health');
export const getPlanUsage = (db: Db) => getRow<PlanUsage & { id: string; at: string }>(db, 'meta', 'planUsage');

export const allTeams = (db: Db) => rows<Team>(db, 'teams');
export const allEmployees = (db: Db) => rows<Employee>(db, 'employees');
export const allRepos = (db: Db) => rows<Repo>(db, 'repos');
export const allRuns = (db: Db) => rows<Run>(db, 'runs').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
export const allDecisions = (db: Db) => rows<Decision>(db, 'decisions').sort((a, b) => a.askedAt.localeCompare(b.askedAt));

/** Tasks by priority, then age. */
export function listTasks(db: Db, where: { state?: TaskState; parentId?: string; teamId?: string } = {}): Task[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (where.state !== undefined) clauses.push('state = ?'), params.push(where.state);
  if (where.parentId !== undefined) clauses.push('parent_id = ?'), params.push(where.parentId);
  if (where.teamId !== undefined) clauses.push('team_id = ?'), params.push(where.teamId);
  const found = rows<Task>(db, 'tasks', clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', ...params);
  return found.sort((a, b) => a.priority - b.priority || byAge(a, b));
}

export const openRequests = (db: Db) => rows<RunRequest>(db, 'run_requests').sort(byAge);
export const requestsOf = (db: Db, taskId: string) => rows<RunRequest>(db, 'run_requests', 'WHERE task_id = ?', taskId).sort(byAge);
export const liveRuns = (db: Db) => rows<Run>(db, 'runs', "WHERE outcome = 'running'");
export const runsOf = (db: Db, taskId: string) => rows<Run>(db, 'runs', 'WHERE task_id = ?', taskId).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
export const grantsOf = (db: Db, taskId: string) => rows<Grant>(db, 'grants', 'WHERE task_id = ?', taskId);

export function openDecisions(db: Db, taskId?: string): Decision[] {
  const found = taskId === undefined ? rows<Decision>(db, 'decisions', 'WHERE answered_at IS NULL') : rows<Decision>(db, 'decisions', 'WHERE answered_at IS NULL AND task_id = ?', taskId);
  return found.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

export const waitingMessages = (db: Db, toId: string) => rows<Message>(db, 'messages', "WHERE to_id = ? AND state = 'waiting' ORDER BY at", toId);
export const recentMessages = (db: Db, limit: number) => rows<Message>(db, 'messages', 'ORDER BY at DESC LIMIT ?', limit).reverse();

/** What a task has cost so far, over every run it has had. */
export function spentOn(db: Db, taskId: string): number {
  return runsOf(db, taskId).reduce((sum, run) => sum + run.costUsd, 0);
}

export type Spend = { company: number; byTeam: Map<string, number>; byEmployee: Map<string, number> };

/** Spend since local midnight, from the usage each finished turn reported. */
export function spendToday(db: Db, now: Date): Spend {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const found = db
    .prepare(
      `SELECT team_id AS team, employee_id AS employee, sum(json_extract(payload, '$.event.costUsd')) AS usd
       FROM events WHERE kind = 'run_event' AND at >= ? AND json_extract(payload, '$.event.kind') = 'usage'
       GROUP BY team_id, employee_id`,
    )
    .all(midnight) as { team: string; employee: string; usd: number }[];
  const spend: Spend = { company: 0, byTeam: new Map(), byEmployee: new Map() };
  for (const { team, employee, usd } of found) {
    spend.company += usd;
    spend.byTeam.set(team, (spend.byTeam.get(team) ?? 0) + usd);
    spend.byEmployee.set(employee, (spend.byEmployee.get(employee) ?? 0) + usd);
  }
  return spend;
}

// ---------- builders ----------

export type NewTask = Pick<Task, 'teamId' | 'title' | 'brief' | 'createdBy'> & Partial<Task>;

export function newTask(input: NewTask, now: Date): Task {
  const at = now.toISOString();
  return {
    id: newId(),
    assigneeId: null,
    reviewerId: null,
    parentId: null,
    kind: 'work',
    priority: 2,
    state: 'queued',
    blockedFrom: null,
    doneCondition: '',
    repoId: null,
    gates: [],
    ownership: [],
    capUsd: 2,
    retryAllowed: true,
    leaseMinutes: null,
    reviewRounds: 0,
    folder: null,
    branch: null,
    mergedInto: null,
    createdAt: at,
    updatedAt: at,
    blockedAt: null,
    ...input,
  };
}

export type NewRequest = Pick<RunRequest, 'taskId' | 'mode' | 'employeeId' | 'reason'> & Partial<RunRequest>;

export function newRequest(input: NewRequest, now: Date): RunRequest {
  return { id: newId(), resumeSessionId: null, firstTurn: null, attempt: 1, leaseMinutes: null, createdAt: now.toISOString(), ...input };
}

export function newRun(request: RunRequest, now: Date, leaseMinutes: number): Run {
  const at = now.toISOString();
  return {
    id: newId(),
    taskId: request.taskId,
    employeeId: request.employeeId,
    mode: request.mode,
    attempt: request.attempt,
    sessionId: null,
    pid: null,
    pidStartedAt: null,
    leaseMinutes,
    leaseUntil: leaseEnd(at, leaseMinutes),
    startedAt: at,
    endedAt: null,
    lastEventAt: at,
    outcome: 'running',
    reason: null,
    activity: null,
    summary: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    commit: null,
    diffLines: null,
    gateResults: [],
  };
}
