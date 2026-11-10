/**
 * What a worker is told to run: the job for one run of one employee on one task.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from '../db/dataDir.ts';
import { subscriptionEnv } from '../runtime/env.ts';
import type { Company, Employee, Message, Repo, Run, RunMode, RunRequest, Task, Team } from '../shared/types.ts';
import type { EngineTool, WorkerJob } from '../worker/protocol.ts';
import { sessionShape } from './blastRadius.ts';
import { buildFirstTurn, buildSystemPrompt, type TeamView } from './definition.ts';
import { readIndex } from './memory.ts';

export const MAX_TURNS: Record<RunMode, number> = { brief: 40, review: 40, route: 20, work: 150, integrate: 150 };

export const ENGINE_TOOLS_FOR: Record<RunMode, EngineTool[]> = {
  brief: ['propose_subtasks', 'report_done', 'request_decision', 'set_status', 'run_gate'],
  work: ['report_done', 'request_decision', 'set_status', 'run_gate'],
  integrate: ['report_done', 'request_decision', 'set_status', 'run_gate'],
  review: ['submit_review', 'request_decision', 'set_status', 'run_gate'],
  route: ['create_task', 'set_status'],
};

/** The environment of a session. On the subscription login nothing that could redirect billing gets through. */
export function sessionEnv(company: Pick<Company, 'auth'>, parent: Record<string, string | undefined> = process.env): Record<string, string> {
  if (company.auth === 'subscription') return subscriptionEnv(parent).env;
  return Object.fromEntries(Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Where a task's files live. A task with a repository gets its clone here; one without gets a plain folder. */
export function folderOf(paths: Paths, task: Pick<Task, 'id' | 'folder'>): string {
  return task.folder ?? path.join(paths.folders, task.id);
}

export type JobInput = {
  paths: Paths;
  run: Run;
  request: RunRequest;
  task: Task;
  team: Team;
  employee: Employee;
  company: Company;
  repo: Repo | null;
  teammates: Employee[];
  /** Every team, for the chief of staff, who routes work to them. */
  teams: TeamView[];
  remainingUsd: number;
  /** The limit for this run: what the task has left. */
  maxBudgetUsd?: number;
  /** .env files of the registered repositories: hidden from commands as well as from the Read tool. */
  envFiles: string[];
  /** The chosen skills as the session names them, and the plugin folders that carry them. */
  mounted: { skills: string[]; plugins: string[] };
  messages: Message[];
  nameOf: (id: string) => string;
  runtimeModule?: string;
};

export function messagesTurn(messages: Message[], nameOf: (id: string) => string): string {
  if (messages.length === 0) return '';
  return `Messages that were waiting for you:\n${messages.map((m) => `- From ${nameOf(m.fromId)}: ${m.text}`).join('\n')}`;
}

export function buildJob(input: JobInput): WorkerJob {
  const { run, request, task, team, employee, company } = input;
  const cwd = folderOf(input.paths, task);
  fs.mkdirSync(cwd, { recursive: true });
  const shape = sessionShape({ task, team, employee, mode: run.mode, folder: cwd, company, envFiles: input.envFiles });
  const first = request.firstTurn ?? buildFirstTurn({ task, mode: run.mode, team, repo: input.repo, teammates: input.teammates, remainingUsd: input.remainingUsd, teams: input.teams });
  // A command may run long, but never longer than the lease: the Bash timeout sits two minutes under it.
  const bashTimeout = String(Math.max(1, run.leaseMinutes - 2) * 60_000);
  return {
    runId: run.id,
    mode: run.mode,
    cwd,
    systemPrompt: buildSystemPrompt({ company, team, employee, teammates: input.teammates, memoryIndex: readIndex(employee.memoryDir) }),
    firstTurn: [first, messagesTurn(input.messages, input.nameOf)].filter(Boolean).join('\n\n'),
    model: employee.model,
    env: { ...sessionEnv(company), BASH_DEFAULT_TIMEOUT_MS: bashTimeout, BASH_MAX_TIMEOUT_MS: bashTimeout },
    tools: shape.tools,
    engineTools: ENGINE_TOOLS_FOR[run.mode],
    skills: input.mounted.skills,
    plugins: input.mounted.plugins,
    additionalDirectories: shape.additionalDirectories,
    sandbox: shape.sandbox,
    maxTurns: MAX_TURNS[run.mode],
    ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
    ...(input.runtimeModule ? { runtimeModule: input.runtimeModule } : {}),
  };
}
