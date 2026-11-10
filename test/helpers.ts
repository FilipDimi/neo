/** Row builders and a temp database for tests. Every builder takes overrides. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/open.ts';
import type { Company, Decision, Employee, Message, Repo, Run, RunRequest, Task, Team } from '../src/shared/types.ts';

export const T0 = new Date('2026-11-09T18:00:00.000Z');
export const plus = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

export function tempDir(prefix = 'vs-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function tempDb(): Db {
  return openDb(path.join(tempDir(), 'company.db'));
}

export const company = (over: Partial<Company> = {}): Company => ({
  id: 'co',
  name: 'Acme',
  rules: 'Nothing invented.',
  auth: 'subscription',
  concurrency: 3,
  dailyCapUsd: 40,
  models: { lead: 'claude-opus-5-5', member: 'claude-sonnet-5-5', routine: 'claude-haiku-5-5' },
  denyRead: [],
  minFreeGb: 5,
  services: [],
  chiefOfStaffId: null,
  paused: null,
  ...over,
});

export const repo = (over: Partial<Repo> = {}): Repo => ({ id: 'repo1', path: '/tmp/repo', gates: [], ...over });

export const team = (over: Partial<Team> = {}): Team => ({
  id: 'team1',
  name: 'Engineering',
  purpose: 'Builds the product.',
  leadId: null,
  selfManaged: false,
  dailyCapUsd: 20,
  repos: [],
  mayPush: false,
  mayOpenPr: false,
  mayPublish: false,
  maySend: false,
  mayPay: false,
  mayDelete: false,
  leaseMinutes: 15,
  maxReviewRounds: 3,
  sandboxWrite: [],
  ...over,
});

export const employee = (over: Partial<Employee> = {}): Employee => ({
  id: 'emp1',
  teamId: 'team1',
  name: 'Ada',
  role: 'Writes code.',
  skills: [],
  capabilities: ['read_files', 'write_code'],
  model: 'claude-haiku-5-5',
  memoryDir: '/tmp/memory/emp1',
  chatSessionId: null,
  fired: false,
  ...over,
});

export const task = (over: Partial<Task> = {}): Task => ({
  id: 'task1',
  teamId: 'team1',
  assigneeId: null,
  reviewerId: null,
  parentId: null,
  kind: 'work',
  createdBy: 'user',
  title: 'Do the thing',
  brief: 'Do the thing well.',
  priority: 2,
  state: 'queued',
  blockedFrom: null,
  doneCondition: 'The thing is done.',
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
  createdAt: T0.toISOString(),
  updatedAt: T0.toISOString(),
  blockedAt: null,
  ...over,
});

export const run = (over: Partial<Run> = {}): Run => ({
  id: 'run1',
  taskId: 'task1',
  employeeId: 'emp1',
  mode: 'work',
  attempt: 1,
  sessionId: null,
  pid: null,
  pidStartedAt: null,
  leaseMinutes: 15,
  leaseUntil: plus(T0, 15 * 60).toISOString(),
  startedAt: T0.toISOString(),
  endedAt: null,
  lastEventAt: T0.toISOString(),
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
  ...over,
});

export const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  id: 'req1',
  taskId: 'task1',
  mode: 'work',
  employeeId: 'emp1',
  reason: 'new',
  resumeSessionId: null,
  firstTurn: null,
  attempt: 1,
  leaseMinutes: null,
  createdAt: T0.toISOString(),
  ...over,
});

export const decision = (over: Partial<Decision> = {}): Decision => ({
  id: 'dec1',
  taskId: 'task1',
  runId: null,
  employeeId: null,
  kind: 'question',
  text: 'Which one?',
  options: [{ id: 'stop', label: 'Stop it', effect: 'stop_task' }],
  costSoFarUsd: 0,
  answer: null,
  askedAt: T0.toISOString(),
  answeredAt: null,
  ...over,
});

export const message = (over: Partial<Message> = {}): Message => ({
  id: 'msg1',
  fromId: 'user',
  toId: 'emp1',
  taskId: null,
  text: 'Hello',
  state: 'waiting',
  at: T0.toISOString(),
  deliveredAt: null,
  ...over,
});

// ---------- a company in a temp data directory, with a supervisor on a clock the test moves ----------

import { apply } from '../src/db/apply.ts';
import { paths } from '../src/db/dataDir.ts';
import type { Spawn } from '../src/supervisor/link.ts';
import { Supervisor, type SupervisorOptions } from '../src/supervisor/supervisor.ts';

export type World = { dir: string; db: Db; sup: Supervisor; clock: { now(): Date; advance(seconds: number): void } };

/** A self-managed team "team1" with emp1 and emp2 unless told otherwise. */
export function world(spawn: Spawn, over: { company?: Partial<Company>; teams?: Team[]; employees?: Employee[]; repos?: Repo[]; options?: Partial<SupervisorOptions> } = {}): World {
  const dir = tempDir();
  const db = openDb(paths(dir).db);
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company(over.company) });
    for (const r of over.repos ?? []) tx.emit({ kind: 'repo_changed', repo: r });
    for (const t of over.teams ?? [team({ selfManaged: true })]) tx.emit({ kind: 'team_changed', team: t });
    for (const e of over.employees ?? [employee(), employee({ id: 'emp2', name: 'Grace' })]) tx.emit({ kind: 'employee_changed', employee: { ...e, memoryDir: path.join(dir, 'memory', e.id) } });
  });
  let now = T0;
  const clock = { now: () => now, advance: (seconds: number) => void (now = plus(now, seconds)) };
  const sup = new Supervisor({ db, dataDir: dir, now: clock.now, spawn, ...over.options });
  return { dir, db, sup, clock };
}

// ---------- a throwaway git repository ----------

import { execFileSync } from 'node:child_process';

export const sh = (cwd: string, command: string, ...args: string[]): string => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const gitIn = (cwd: string, ...args: string[]): string => sh(cwd, 'git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args);

/** A repository with one commit on `main` and, by default, a `team` branch at the same commit. `main` stays checked out. */
export function gitRepo(branches: string[] = ['team'], files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const dir = tempDir('vs-repo-');
  gitIn(dir, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'first');
  for (const branch of branches) gitIn(dir, 'branch', branch);
  return dir;
}

export const refOf = (repo: string, ref: string): string => gitIn(repo, 'rev-parse', ref);
export const fileAt = (repo: string, ref: string, file: string): string | null => {
  try {
    return gitIn(repo, 'show', `${ref}:${file}`);
  } catch {
    return null;
  }
};
