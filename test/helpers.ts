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
