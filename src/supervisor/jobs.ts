/**
 * What a worker is told to run: the job for one run of one employee on one task.
 */
import fs from 'node:fs';
import path from 'node:path';
import { engineFiles, type Paths } from '../db/dataDir.ts';
import { ADMIN_TOOLS } from '../shared/adminTools.ts';
import { plainEnv, withToolchains } from '../runtime/env.ts';
import type { Company, Employee, Message, Repo, Run, RunMode, RunRequest, Task, Team } from '../shared/types.ts';
import type { EngineTool, WorkerJob } from '../worker/protocol.ts';
import { sessionShape } from './blastRadius.ts';
import { buildFirstTurn, buildSystemPrompt, type TeamView } from './definition.ts';
import { readIndex } from './memory.ts';

export const MAX_TURNS: Record<RunMode, number> = { brief: 40, review: 40, route: 20, work: 150, integrate: 150 };

export const ENGINE_TOOLS_FOR: Record<RunMode, EngineTool[]> = {
  brief: ['propose_subtasks', 'report_done', 'request_decision', 'request_tools', 'set_status', 'run_gate'],
  work: ['report_done', 'request_decision', 'request_tools', 'set_status', 'run_gate'],
  integrate: ['report_done', 'request_decision', 'request_tools', 'set_status', 'run_gate'],
  review: ['submit_review', 'request_decision', 'request_tools', 'set_status', 'run_gate'],
  route: ['create_task', 'set_status'],
};

/**
 * The engine's tools for one run. Everyone can read the company's record of decisions. Writing to it, and
 * asking for a contract version, is for those who decide for others: a team's lead and the chief of staff.
 */
export function engineToolsFor(input: { mode: RunMode; deciding: boolean; admin: boolean; chief: boolean; lead: boolean }): EngineTool[] {
  // The admin's conversations change the setup: they get the setup tools, and no one else's do.
  // A conversation about a card has one thing to do: answer it.
  const own = input.deciding ? DECIDING_TOOLS : input.admin && input.mode === 'route' ? [...ENGINE_TOOLS_FOR.route, ...ADMIN_TOOLS] : ENGINE_TOOLS_FOR[input.mode];
  return [...own, 'read_decisions', ...(input.chief || input.lead ? (['record_decision', 'contract_version'] as const) : [])];
}

/** The chief of staff deciding a card for the user: it reads, then answers the card. */
export const DECIDING_TOOLS: EngineTool[] = ['decide', 'set_status'];
const DECIDING_TURNS = 40;

/**
 * The environment of a session: the short list of `plainEnv`, so nothing that could redirect
 * billing and no token from the engine's shell gets through. A company set to run on an API key
 * gets that one key added, and nothing else.
 */
export function sessionEnv(company: Pick<Company, 'auth'>, parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = plainEnv(parent);
  if (company.auth === 'api_key' && parent.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = parent.ANTHROPIC_API_KEY;
  return env;
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
  /** The state of every board, for the chief of staff, who is asked about it. */
  board?: string | undefined;
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
  const admin = Boolean(company.adminId) && company.adminId === employee.id;
  fs.mkdirSync(cwd, { recursive: true });
  const shape = sessionShape({ task, team, employee, mode: run.mode, folder: cwd, company, envFiles: input.envFiles, protect: engineFiles(input.paths) });
  const first = request.firstTurn ?? buildFirstTurn({ task, mode: run.mode, team, repo: input.repo, teammates: input.teammates, remainingUsd: input.remainingUsd, teams: input.teams, board: input.board, chief: company.chiefOfStaffId === employee.id, admin, self: employee });
  // A command may run long, but never longer than the lease: the Bash timeout sits two minutes under it.
  const bashTimeout = String(Math.max(1, run.leaseMinutes - 2) * 60_000);
  return {
    runId: run.id,
    mode: run.mode,
    cwd,
    systemPrompt: buildSystemPrompt({ company, team, employee, teammates: input.teammates, memoryIndex: readIndex(employee.memoryDir), mode: run.mode, admin }),
    firstTurn: [first, messagesTurn(input.messages, input.nameOf)].filter(Boolean).join('\n\n'),
    model: employee.model,
    // A conversation is answered at the model's own effort, so that it stays quick. Work runs at the effort the employee was hired with.
    // Deciding a card for the user is judgement, not small talk: it gets the effort too.
    ...(employee.effort && (run.mode !== 'route' || task.decisionId) ? { effort: employee.effort } : {}),
    env: { ...withToolchains(sessionEnv(company)), BASH_DEFAULT_TIMEOUT_MS: bashTimeout, BASH_MAX_TIMEOUT_MS: bashTimeout },
    tools: shape.tools,
    engineTools: engineToolsFor({ mode: run.mode, deciding: Boolean(task.decisionId), admin, chief: company.chiefOfStaffId === employee.id, lead: team.leadId === employee.id }),
    skills: input.mounted.skills,
    plugins: input.mounted.plugins,
    additionalDirectories: shape.additionalDirectories,
    sandbox: shape.sandbox,
    maxTurns: task.decisionId ? DECIDING_TURNS : MAX_TURNS[run.mode],
    ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
    ...(input.runtimeModule ? { runtimeModule: input.runtimeModule } : {}),
  };
}
