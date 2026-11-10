/**
 * The event catalogue: every kind of thing the engine records, and the contract with the web app.
 * An event carries the full rows it changed, so a reader only has to upsert by id.
 * Shared with the web app: no Node imports here.
 */
import { z } from 'zod';
import type { RuntimeEvent } from './runtime.ts';
import { Company, Decision, Employee, GateResult, Grant, HealthReport, Message, PlanUsage, Repo, Run, RunRequest, Task, Team } from './types.ts';

export const EVENT_VERSION = 1;

const runtimeEvent = z.custom<RuntimeEvent>((value) => typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string');

export const EngineEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company_changed'), company: Company }),
  z.object({ kind: z.literal('repo_changed'), repo: Repo }),
  z.object({ kind: z.literal('team_changed'), team: Team }),
  z.object({ kind: z.literal('employee_changed'), employee: Employee }),
  z.object({ kind: z.literal('task_changed'), task: Task, cause: z.enum(['created', 'state', 'edited']) }),
  z.object({ kind: z.literal('run_requested'), request: RunRequest }),
  z.object({ kind: z.literal('request_dropped'), requestId: z.string(), taskId: z.string() }),
  z.object({ kind: z.literal('run_started'), run: Run, requestId: z.string().nullable(), teamId: z.string() }),
  z.object({ kind: z.literal('run_activity'), runId: z.string(), taskId: z.string(), employeeId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('run_event'), runId: z.string(), taskId: z.string(), employeeId: z.string(), teamId: z.string(), event: runtimeEvent }),
  z.object({ kind: z.literal('gate_started'), runId: z.string(), taskId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('gate_finished'), runId: z.string(), taskId: z.string(), result: GateResult }),
  z.object({ kind: z.literal('run_ended'), run: Run, teamId: z.string() }),
  z.object({ kind: z.literal('decision_raised'), decision: Decision }),
  z.object({ kind: z.literal('decision_answered'), decision: Decision, result: z.enum(['applied', 'ignored', 'closed']) }),
  z.object({ kind: z.literal('message_sent'), message: Message }),
  z.object({ kind: z.literal('message_delivered'), message: Message }),
  z.object({ kind: z.literal('grant_changed'), grant: Grant }),
  z.object({ kind: z.literal('health_changed'), report: HealthReport }),
  z.object({ kind: z.literal('plan_usage') }).extend(PlanUsage.shape),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

export type Subjects = { taskId: string | null; runId: string | null; employeeId: string | null; teamId: string | null };
export type EventRow = Subjects & { id: number; at: string; event: EngineEvent };

const NOBODY: Subjects = { taskId: null, runId: null, employeeId: null, teamId: null };

/** Which task, run, employee and team an event is about: the columns it can be found by. */
export function subjectsOf(event: EngineEvent): Subjects {
  switch (event.kind) {
    case 'team_changed':
      return { ...NOBODY, teamId: event.team.id };
    case 'employee_changed':
      return { ...NOBODY, employeeId: event.employee.id, teamId: event.employee.teamId };
    case 'task_changed':
      return { ...NOBODY, taskId: event.task.id, employeeId: event.task.assigneeId, teamId: event.task.teamId };
    case 'run_requested':
      return { ...NOBODY, taskId: event.request.taskId, employeeId: event.request.employeeId };
    case 'request_dropped':
      return { ...NOBODY, taskId: event.taskId };
    case 'run_started':
    case 'run_ended':
      return { taskId: event.run.taskId, runId: event.run.id, employeeId: event.run.employeeId, teamId: event.teamId };
    case 'run_activity':
      return { ...NOBODY, taskId: event.taskId, runId: event.runId, employeeId: event.employeeId };
    case 'run_event':
      return { taskId: event.taskId, runId: event.runId, employeeId: event.employeeId, teamId: event.teamId };
    case 'gate_started':
    case 'gate_finished':
      return { ...NOBODY, taskId: event.taskId, runId: event.runId };
    case 'decision_raised':
    case 'decision_answered':
      return { ...NOBODY, taskId: event.decision.taskId, runId: event.decision.runId, employeeId: event.decision.employeeId };
    case 'message_sent':
    case 'message_delivered':
      return { ...NOBODY, taskId: event.message.taskId };
    case 'grant_changed':
      return { ...NOBODY, taskId: event.grant.taskId };
    default:
      return NOBODY;
  }
}
