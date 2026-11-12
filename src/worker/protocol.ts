/**
 * What a worker and the supervisor say to each other over IPC. Both sides validate what they receive.
 */
import { z } from 'zod';
import type { RuntimeEvent, ToolCall } from '../shared/runtime.ts';
import { ADMIN_INPUT, ADMIN_TOOLS } from '../shared/adminTools.ts';
import { Capability, Effort, Finding, RunMode } from '../shared/types.ts';

export const ENGINE_TOOLS = ['propose_subtasks', 'report_done', 'submit_review', 'request_decision', 'request_tools', 'set_status', 'run_gate', 'create_task', 'decide', 'read_decisions', 'record_decision', 'contract_version', ...ADMIN_TOOLS] as const;
export const EngineTool = z.enum(ENGINE_TOOLS);
export type EngineTool = z.infer<typeof EngineTool>;

/** A tool call that ends a run's work: after one of these is accepted, the session takes no further turn. */
export const CLOSING_TOOLS: ReadonlySet<EngineTool> = new Set(['propose_subtasks', 'report_done', 'submit_review', 'request_decision', 'request_tools']);

export const WorkerJob = z.object({
  runId: z.string(),
  mode: RunMode,
  cwd: z.string(),
  systemPrompt: z.string(),
  firstTurn: z.string(),
  model: z.string(),
  effort: Effort.optional(),
  env: z.record(z.string(), z.string()),
  tools: z.array(z.string()),
  engineTools: z.array(EngineTool),
  skills: z.array(z.string()),
  plugins: z.array(z.string()),
  additionalDirectories: z.array(z.string()),
  sandbox: z.unknown(),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().positive().optional(),
  resumeSessionId: z.string().optional(),
  /** The one test seam: a module exporting `startSession`. Absent means the SDK. */
  runtimeModule: z.string().optional(),
});
export type WorkerJob = z.infer<typeof WorkerJob>;

const runtimeEvent = z.custom<RuntimeEvent>((value) => typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string');
const toolCall = z.custom<ToolCall>((value) => typeof value === 'object' && value !== null && typeof (value as { tool?: unknown }).tool === 'string');

export const ToSupervisor = z.discriminatedUnion('t', [
  z.object({ t: z.literal('event'), event: runtimeEvent }),
  /** May this tool call run? Asked for every call, before the SDK's own rules. */
  z.object({ t: z.literal('decide'), askId: z.string(), call: toolCall }),
  /** The model called one of the engine's tools. */
  z.object({ t: z.literal('tool'), askId: z.string(), name: EngineTool, input: z.unknown() }),
  z.object({ t: z.literal('message_result'), id: z.string(), delivered: z.boolean() }),
  z.object({ t: z.literal('exit'), outcome: z.enum(['done', 'failed', 'stopped']), reason: z.string().nullable(), sessionId: z.string().nullable(), summary: z.string().nullable() }),
]);
export type ToSupervisor = z.infer<typeof ToSupervisor>;

export const ToWorker = z.discriminatedUnion('t', [
  z.object({ t: z.literal('start'), job: WorkerJob }),
  /** `stop` ends the session at once: a refused action stops the run, and a card takes over. */
  z.object({ t: z.literal('decision'), askId: z.string(), allow: z.boolean(), reason: z.string().optional(), stop: z.boolean().optional() }),
  z.object({ t: z.literal('tool_result'), askId: z.string(), ok: z.boolean(), text: z.string() }),
  /** A message for the employee: the next user turn of the running session. */
  z.object({ t: z.literal('message'), id: z.string(), text: z.string() }),
  z.object({ t: z.literal('stop') }),
]);
export type ToWorker = z.infer<typeof ToWorker>;

/** The input each engine tool takes. The worker validates before forwarding; the supervisor validates again. */
export const TOOL_INPUT = {
  request_tools: z.object({ capabilities: z.array(Capability).min(1), reason: z.string().min(1) }),
  propose_subtasks: z.object({
    subtasks: z
      .array(
        z.object({
          title: z.string().min(1),
          summary: z.string().max(300).optional(),
          assigneeId: z.string().min(1),
          brief: z.string().min(1),
          ownership: z.array(z.string()),
          doneCondition: z.string().min(1),
          gates: z.array(z.string()),
          priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
          capUsd: z.number().positive(),
          retryAllowed: z.boolean(),
          decisions: z.array(z.string().min(1)).optional(),
        }),
      )
      .min(1),
  }),
  report_done: z.object({ summary: z.string().min(1) }),
  submit_review: z.object({ verdict: z.enum(['approve', 'send_back', 'escalate']), notes: z.string(), findings: z.array(Finding).max(40).optional() }),
  request_decision: z.object({ question: z.string().min(1), options: z.array(z.string()).max(4) }),
  set_status: z.object({ text: z.string().min(1).max(60) }),
  run_gate: z.object({ name: z.string().min(1) }),
  create_task: z.object({
    teamId: z.string().min(1),
    assigneeId: z.string().optional(),
    title: z.string().min(1),
    summary: z.string().max(300).optional(),
    brief: z.string().min(1),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    doneCondition: z.string().min(1),
    capUsd: z.number().positive(),
    gates: z.array(z.string().min(1)).optional(),
    decisions: z.array(z.string().min(1)).optional(),
  }),
  decide: z.object({ option: z.string().min(1), notes: z.string() }),
  read_decisions: z.object({ ids: z.array(z.string().min(1)).max(20).optional(), search: z.string().optional() }),
  record_decision: z.object({ statement: z.string().trim().min(1).max(300), why: z.string(), replaces: z.string().min(1).optional(), onBehalfOfUser: z.boolean().optional() }),
  contract_version: z.object({ change: z.enum(['breaking', 'adds', 'wording']), summary: z.string().trim().min(1), decisions: z.array(z.string().min(1)).optional(), subtask: z.string().min(1).optional() }),
  ...ADMIN_INPUT,
} satisfies Record<EngineTool, z.ZodType>;

export type SubtaskProposal = z.infer<typeof TOOL_INPUT.propose_subtasks>['subtasks'][number];
