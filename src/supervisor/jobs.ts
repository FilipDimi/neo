/**
 * What a worker is told to run: the job for one run of one employee on one task.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from '../db/dataDir.ts';
import { subscriptionEnv } from '../runtime/env.ts';
import type { Company, Employee, Message, Run, RunMode, RunRequest, Task, Team } from '../shared/types.ts';
import type { EngineTool, WorkerJob } from '../worker/protocol.ts';

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

export type JobInput = { paths: Paths; run: Run; request: RunRequest; task: Task; team: Team; employee: Employee; company: Company; messages: Message[]; runtimeModule?: string };

export function messagesTurn(messages: Message[], nameOf: (id: string) => string): string {
  if (messages.length === 0) return '';
  return `Messages that were waiting for you:\n${messages.map((m) => `- From ${nameOf(m.fromId)}: ${m.text}`).join('\n')}`;
}

export function buildJob(input: JobInput): WorkerJob {
  const { run, request, task, employee, company } = input;
  const cwd = folderOf(input.paths, task);
  fs.mkdirSync(cwd, { recursive: true });
  const waiting = messagesTurn(input.messages, (id) => (id === 'user' ? 'the user' : id));
  return {
    runId: run.id,
    mode: run.mode,
    cwd,
    systemPrompt: `You are ${employee.name}. ${employee.role}`,
    firstTurn: [request.firstTurn ?? `${task.title}\n\n${task.brief}`, waiting].filter(Boolean).join('\n\n'),
    model: employee.model,
    env: sessionEnv(company),
    tools: [],
    engineTools: ENGINE_TOOLS_FOR[run.mode],
    skills: [],
    plugins: [],
    additionalDirectories: [],
    sandbox: undefined,
    maxTurns: MAX_TURNS[run.mode],
    ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
    ...(input.runtimeModule ? { runtimeModule: input.runtimeModule } : {}),
  };
}
