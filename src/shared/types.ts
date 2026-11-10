/**
 * Every row the engine keeps, as a zod schema and the type inferred from it.
 * The database stores each row as the JSON of its schema, so the two cannot disagree.
 * Shared with the web app: no Node imports here.
 */
import { z } from 'zod';

const id = z.string().min(1);
const iso = z.string();

export const TaskState = z.enum(['queued', 'briefing', 'running', 'review', 'blocked', 'done', 'failed']);
export type TaskState = z.infer<typeof TaskState>;

export const RunMode = z.enum(['brief', 'work', 'review', 'integrate', 'route']);
export type RunMode = z.infer<typeof RunMode>;

export const RunOutcome = z.enum(['running', 'done', 'failed', 'expired', 'stopped', 'refused', 'over_budget', 'usage_limit']);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const Capability = z.enum(['read_files', 'run_commands', 'write_code', 'web_search', 'git_push', 'send_messages']);
export type Capability = z.infer<typeof Capability>;

export const ModelTier = z.enum(['lead', 'member', 'routine']);
export type ModelTier = z.infer<typeof ModelTier>;

/** A named command that must pass. `lock` serialises gates that cannot run side by side (one Xcode run at a time). */
export const Gate = z.object({ name: z.string().min(1), command: z.string().min(1), timeoutMinutes: z.number().positive(), lock: z.string().nullable() });
export type Gate = z.infer<typeof Gate>;

export const Repo = z.object({ id, path: z.string().min(1), gates: z.array(Gate) });
export type Repo = z.infer<typeof Repo>;

export const Service = z.object({ name: z.string(), kind: z.enum(['http', 'tcp', 'cmd']), target: z.string() });
export type Service = z.infer<typeof Service>;

export const Company = z.object({
  id,
  name: z.string().min(1),
  rules: z.string(),
  auth: z.enum(['subscription', 'api_key']),
  concurrency: z.number().int().positive(),
  dailyCapUsd: z.number().nonnegative(),
  models: z.object({ lead: z.string(), member: z.string(), routine: z.string() }),
  denyRead: z.array(z.string()),
  minFreeGb: z.number().nonnegative(),
  services: z.array(Service),
  chiefOfStaffId: id.nullable(),
  paused: z.object({ reason: z.enum(['usage_limit', 'health', 'user']), until: iso.nullable() }).nullable(),
});
export type Company = z.infer<typeof Company>;

export const TeamRepo = z.object({ repoId: id, baseBranch: z.string().min(1), mergeTarget: z.string().nullable() });
export type TeamRepo = z.infer<typeof TeamRepo>;

export const Team = z.object({
  id,
  name: z.string().min(1),
  purpose: z.string(),
  leadId: id.nullable(),
  selfManaged: z.boolean(),
  dailyCapUsd: z.number().nonnegative(),
  repos: z.array(TeamRepo),
  mayPush: z.boolean(),
  mayOpenPr: z.boolean(),
  mayPublish: z.boolean(),
  maySend: z.boolean(),
  mayPay: z.boolean(),
  mayDelete: z.boolean(),
  leaseMinutes: z.number().positive(),
  maxReviewRounds: z.number().int().positive(),
  /** Folders outside the task folder that this team's commands may write: the build profile. */
  sandboxWrite: z.array(z.string()),
});
export type Team = z.infer<typeof Team>;

export const Employee = z.object({
  id,
  teamId: id,
  name: z.string().min(1),
  role: z.string(),
  skills: z.array(z.string()),
  capabilities: z.array(Capability),
  model: z.string(),
  memoryDir: z.string(),
  chatSessionId: z.string().nullable(),
  fired: z.boolean(),
});
export type Employee = z.infer<typeof Employee>;

export const Task = z.object({
  id,
  teamId: id,
  assigneeId: id.nullable(),
  reviewerId: id.nullable(),
  parentId: id.nullable(),
  /** A chat task is a message to the chief of staff; the board leaves it out. */
  kind: z.enum(['work', 'chat']),
  /** 'user' or an employee id. */
  createdBy: z.string(),
  title: z.string().min(1),
  brief: z.string(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  state: TaskState,
  blockedFrom: TaskState.nullable(),
  doneCondition: z.string(),
  repoId: id.nullable(),
  gates: z.array(z.string()),
  /** Directory prefixes or exact files, relative to the repository. Empty means everything. */
  ownership: z.array(z.string()),
  capUsd: z.number().nonnegative(),
  retryAllowed: z.boolean(),
  leaseMinutes: z.number().positive().nullable(),
  reviewRounds: z.number().int().nonnegative(),
  folder: z.string().nullable(),
  branch: z.string().nullable(),
  mergedInto: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  blockedAt: iso.nullable(),
});
export type Task = z.infer<typeof Task>;

export const GateResult = z.object({ name: z.string(), command: z.string(), exitCode: z.number(), output: z.string(), durationMs: z.number() });
export type GateResult = z.infer<typeof GateResult>;

export const Run = z.object({
  id,
  taskId: id,
  employeeId: id,
  mode: RunMode,
  attempt: z.number().int().positive(),
  sessionId: z.string().nullable(),
  pid: z.number().nullable(),
  pidStartedAt: z.string().nullable(),
  leaseMinutes: z.number().positive(),
  leaseUntil: iso,
  startedAt: iso,
  endedAt: iso.nullable(),
  lastEventAt: iso,
  outcome: RunOutcome,
  reason: z.string().nullable(),
  activity: z.string().nullable(),
  summary: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  commit: z.string().nullable(),
  diffLines: z.number().nullable(),
  gateResults: z.array(GateResult),
});
export type Run = z.infer<typeof Run>;

export const RunRequest = z.object({
  id,
  taskId: id,
  mode: RunMode,
  employeeId: id,
  reason: z.enum(['new', 'send_back', 'integrate', 'review', 'resume', 'retry']),
  resumeSessionId: z.string().nullable(),
  firstTurn: z.string().nullable(),
  attempt: z.number().int().positive(),
  leaseMinutes: z.number().positive().nullable(),
  createdAt: iso,
});
export type RunRequest = z.infer<typeof RunRequest>;

export const Effect = z.enum(['retry', 'raise_cap', 'allow_once', 'keep_refused', 'merge', 'complete', 'resume_with_answer', 'send_back', 'accept', 'recheck', 'resume_company', 'stop_task', 'raise_daily_cap', 'wait']);
export type Effect = z.infer<typeof Effect>;

export const DecisionKind = z.enum(['lease', 'failed', 'cap', 'tool', 'merge', 'question', 'briefing', 'review', 'ownership', 'staffing', 'invariant', 'health', 'usage_limit']);
export type DecisionKind = z.infer<typeof DecisionKind>;

/** A button on a card. What it does is data, so "Retry, 30 min" can carry its lease. */
export const DecisionOption = z.object({ id: z.string().min(1), label: z.string().min(1), effect: Effect, params: z.record(z.string(), z.unknown()).optional() });
export type DecisionOption = z.infer<typeof DecisionOption>;

export const Decision = z.object({
  id,
  taskId: id.nullable(),
  runId: id.nullable(),
  employeeId: id.nullable(),
  kind: DecisionKind,
  text: z.string(),
  options: z.array(DecisionOption),
  /** A card that takes typed text as its answer (a question, a send-back with notes). */
  freeText: z.boolean().optional(),
  /** What the card is about, for the engine: the refused call, the merge target, the health key. */
  subject: z.record(z.string(), z.unknown()).optional(),
  costSoFarUsd: z.number(),
  answer: z.object({ optionId: z.string(), text: z.string().optional() }).nullable(),
  askedAt: iso,
  answeredAt: iso.nullable(),
});
export type Decision = z.infer<typeof Decision>;

export const Message = z.object({
  id,
  /** 'user' or an employee id, for both ends. */
  fromId: z.string(),
  toId: z.string(),
  taskId: id.nullable(),
  text: z.string(),
  state: z.enum(['waiting', 'delivered']),
  at: iso,
  deliveredAt: iso.nullable(),
});
export type Message = z.infer<typeof Message>;

/** A one-time permission for one exact tool call, given by answering a card with "Allow once". */
export const Grant = z.object({ id, taskId: id, tool: z.string(), inputHash: z.string(), used: z.boolean() });
export type Grant = z.infer<typeof Grant>;

export const HealthReport = z.object({
  at: iso,
  diskFreeGb: z.number(),
  login: z.enum(['ok', 'missing', 'wrong_method', 'expiring']),
  repos: z.array(z.object({ repoId: id, ok: z.boolean(), problem: z.string().nullable() })),
  services: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  failures: z.array(z.object({ key: z.string(), scope: z.union([z.literal('company'), z.literal('warning'), z.object({ repoId: id })]), text: z.string() })),
});
export type HealthReport = z.infer<typeof HealthReport>;

export const PlanUsage = z.object({ status: z.string(), window: z.string().nullable(), utilization: z.number().nullable(), resetsAt: z.number().nullable() });
export type PlanUsage = z.infer<typeof PlanUsage>;
