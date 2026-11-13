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
export const Gate = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  timeoutMinutes: z.number().positive(),
  lock: z.string().nullable(),
  /**
   * Its result depends on nothing but the files in the folder: not on what is committed, not on anything running
   * beside it. Only then does a pass the employee's own run got on exactly the committed files stand at the commit,
   * without the gate being run a second time.
   */
  byFiles: z.boolean().optional().describe('true only for a gate whose result depends on nothing but the files in the folder (not on git history, not on a running service): a pass on exactly the committed files is then not run again at the commit'),
});
export type Gate = z.infer<typeof Gate>;

export const Repo = z.object({
  id,
  path: z.string().min(1),
  gates: z.array(Gate),
  /** Where the engine writes one file per decision when work lands, from the top of the repository. Absent or null: it writes none. */
  decisionsDir: z.string().min(1).nullable().optional(),
  /** The folders or files that are the contract between its teams. A change to them needs a version the engine handed out. Absent or null: no contract. */
  contract: z.object({ paths: z.array(z.string().min(1)).min(1) }).nullable().optional(),
});
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
  /** The admin: the one who changes the company's setup and the app itself from a conversation (Morpheus). Absent in rows written before there was one. */
  adminId: id.nullable().optional(),
  /**
   * Whether cost counts here. 'off' is for a company on a subscription, where the figures are list prices and not a
   * bill: no cap stops work, no card asks about one, and no spend is shown. The plan's own limit still pauses the
   * company. Absent means 'on'.
   */
  costs: z.enum(['on', 'off']).optional(),
  /** Who is asked first when a card is raised: the user, or the chief of staff on the user's behalf. Absent means the user. */
  decider: z.enum(['user', 'chief']).optional(),
  paused: z.object({ reason: z.enum(['usage_limit', 'health', 'user']), until: iso.nullable() }).nullable(),
});
export type Company = z.infer<typeof Company>;

/** `owns`: the folders of the repository that are this team's. A task made for the team without files of its own gets them. */
export const TeamRepo = z.object({ repoId: id, baseBranch: z.string().min(1), mergeTarget: z.string().nullable(), owns: z.array(z.string().min(1)).optional() });
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
  /** The team was removed: its people were fired and it is in no list. The record stays, so its old work can still be named. */
  removed: z.boolean().optional(),
});
export type Team = z.infer<typeof Team>;

/** How hard a model works on a turn. Not chosen means the model's own. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const Employee = z.object({
  id,
  teamId: id,
  name: z.string().min(1),
  role: z.string(),
  skills: z.array(z.string()),
  capabilities: z.array(Capability),
  model: z.string(),
  /** Absent in rows written before effort could be chosen: the same as null. */
  effort: Effort.nullable().optional(),
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
  /** On the chief of staff's small task of deciding a card for the user: the card. */
  decisionId: id.nullable().optional(),
  /** 'user' or an employee id. */
  createdBy: z.string(),
  title: z.string().min(1),
  /** What the task delivers, in a sentence or two, for someone who will not read the brief. Absent on tasks written before there was one. */
  summary: z.string().optional(),
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
  /** The commit its branch began at, and, once landed, what it landed on and as what: its diff is read between these. */
  startedFrom: z.string().optional(),
  landed: z.object({ over: z.string(), tip: z.string() }).optional(),
  /** The decisions its maker named for it (its parent's with them), and the contract's version when it was made. */
  builtOn: z.object({ decisions: z.array(z.string()), contract: z.string().nullable(), at: iso.optional() }).optional(),
  /** What its author was last shown of what moved under it, when a report was held for that: the next report is taken if nothing more has moved. */
  shownMoved: z.string().optional(),
  /** The contract version the engine handed this ticket: it may change the contract, and must state this version there. */
  contractVersion: z.string().optional(),
  /** The files it has changed and not landed, from the top of the repository: held until it is done or stopped. */
  claims: z.array(z.string()).optional(),
  /** The tasks this one waits for: it is not started until they are done. */
  after: z.array(id).optional(),
  /** Of the sub-tasks it waited for, those whose work was merged into its folder when the folder was made. */
  takenIn: z.array(id).optional(),
  /** Of the sub-tasks it waited for, those whose work could not be merged into its folder cleanly: it reads them on their branches. */
  unmerged: z.array(id).optional(),
  /** A ticket its lead closed as not needed, and why: nothing was done on it, and the whole goes on without it. */
  dropped: z.object({ by: id, why: z.string() }).optional(),
  /**
   * On a design meeting: what it is about, who called it, the teams in it (the author's first), and the teams whose
   * lead has approved its design since it was last sent back.
   */
  meeting: z.object({ topic: z.string(), question: z.string(), calledBy: z.string(), teams: z.array(id), approvedBy: z.array(id) }).optional(),
  /** On one team's position in a design meeting: written alone, and never committed, gated, reviewed or merged. */
  meetingRole: z.literal('position').optional(),
  createdAt: iso,
  updatedAt: iso,
  blockedAt: iso.nullable(),
});
export type Task = z.infer<typeof Task>;

/**
 * One decision in the company's record: a default the chief of staff took, a clarification the user gave, a
 * choice a lead made. Numbered by the engine, never deleted: a reversal is a new entry that points back.
 * (A `Decision` is something else: a card waiting for an answer.)
 */
export const RecordEntry = z.object({
  /** "D-232". */
  id: z.string().min(1),
  n: z.number().int().positive(),
  at: iso,
  statement: z.string().min(1),
  why: z.string(),
  /** Who decided: the user; the chief of staff on the user's behalf; a team's lead. */
  by: z.object({ kind: z.enum(['user', 'chief', 'lead']), employeeId: id.nullable() }),
  taskId: id.nullable(),
  /** The repository it is about. Null: the whole company. */
  repoId: id.nullable(),
  replaces: z.string().nullable(),
  replacedBy: z.string().nullable(),
  /** For one filed from a card: the question and the answer, whole. */
  detail: z.string().optional(),
  /** Who decided and on which ticket, in the words of the day it was recorded. Its file is written from these, so a later rename changes no file. */
  byName: z.string().optional(),
  taskTitle: z.string().optional(),
  /** Imported from a log kept by hand: it lives in that file and is never written as a file of its own. */
  archived: z.boolean().optional(),
  /** Where an import found it, when it had to be given a new number. */
  importedFrom: z.string().optional(),
  /** The number it had before an import of a log kept by hand made room for the log's own numbers. */
  movedFrom: z.string().optional(),
});
export type RecordEntry = z.infer<typeof RecordEntry>;

/** One version of a repository's contract, handed out by the engine. `start` says where counting begins. */
export const ContractVersion = z.object({
  id,
  repoId: id,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  change: z.enum(['breaking', 'adds', 'wording', 'start']),
  summary: z.string(),
  taskId: id.nullable(),
  decisions: z.array(z.string()),
  by: z.string().nullable(),
  at: iso,
  /** When the work that changed the contract under this version landed. Absent: handed out, and not (or not yet) in the contract's files anywhere. */
  landedAt: iso.optional(),
  /** The branches whose contract files are at this version: where it landed, and where the engine carried it. */
  on: z.array(z.string()).optional(),
});
export type ContractVersion = z.infer<typeof ContractVersion>;

/**
 * `at`: when it finished, as the engine recorded it. Absent on results recorded before there was one.
 * `tree`: exactly the files it ran on, and `treeAfter` what it left there, each as the hash of what a commit of the
 * folder would hold. `reused`: the engine did not run it again at the commit, because the run had passed it on
 * exactly the committed files.
 */
export const GateResult = z.object({ name: z.string(), command: z.string(), exitCode: z.number(), output: z.string(), durationMs: z.number(), at: iso.optional(), tree: z.string().optional(), treeAfter: z.string().optional(), reused: z.boolean().optional() });
export type GateResult = z.infer<typeof GateResult>;

/**
 * One thing a reviewer found. Blocking means it must be fixed before the work lands; minor is worth
 * knowing and holds nothing up. Each says where, why it matters and what would fix it, so its author
 * can act on it and the next review can check it.
 */
/**
 * Something a report or a review said was checked, that the engine found to hold against its own record: a command
 * the run ran after its last change, and that succeeded; a file of the work, and a line in it. Gates are not here:
 * their proof is the engine's own result, in `gateResults`.
 */
export const VerifiedCheck = z.object({ kind: z.enum(['command', 'file']), what: z.string(), line: z.number().int().positive().optional(), shown: z.string() });
export type VerifiedCheck = z.infer<typeof VerifiedCheck>;

export const Finding = z.object({
  severity: z.enum(['blocking', 'minor']),
  file: z.string(),
  line: z.number().int().positive().nullable().optional(),
  title: z.string().min(1),
  why: z.string(),
  fix: z.string(),
});
export type Finding = z.infer<typeof Finding>;

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
  /** On a review: what the reviewer found. Absent on runs from before reviews gave findings. */
  findings: z.array(Finding).optional(),
  /** What its report or review said was checked and the engine found to hold. */
  checks: z.array(VerifiedCheck).optional(),
  /** The gates its report or review claimed; the engine runs each one itself. */
  claimedGates: z.array(z.string()).optional(),
  /** Of those, the ones only named as passing in the prose, not listed: the author is told so if one fails. */
  claimedFromProse: z.array(z.string()).optional(),
  /** Gates it asked the engine to run while it worked (run_gate). Kept apart from the engine's own: for an author they came before the commit. */
  askedGates: z.array(GateResult).optional(),
  /** What it is waiting for, when it waits for the engine: its turn behind a lock, or a gate that is running. On a run that has ended: the engine is running its gates. */
  waiting: z.object({ on: z.enum(['lock', 'gate']), what: z.string(), since: iso }).optional(),
  /** On the draft of a design meeting's design: the decisions and the tickets it proposes, acted on only once it is agreed. */
  proposals: z.object({ decisions: z.array(z.object({ statement: z.string(), why: z.string() })), followUps: z.array(z.object({ teamId: id, title: z.string(), brief: z.string(), doneCondition: z.string() })) }).optional(),
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

export const Effect = z.enum(['retry', 'raise_cap', 'allow_once', 'keep_refused', 'merge', 'complete', 'resume_with_answer', 'send_back', 'accept', 'recheck', 'resume_company', 'stop_task', 'raise_daily_cap', 'wait', 'grant_capabilities', 'carry']);
export type Effect = z.infer<typeof Effect>;

export const DecisionKind = z.enum(['lease', 'failed', 'cap', 'tool', 'merge', 'question', 'briefing', 'review', 'ownership', 'staffing', 'invariant', 'health', 'usage_limit', 'capability']);
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
  /** The employee deciding this card on the user's behalf right now. While it is set, the card is not on the user's desk. */
  deciderId: id.nullable().optional(),
  /** `by` is the employee who answered on the user's behalf, and `why` its reason; absent when the user answered. */
  answer: z.object({ optionId: z.string(), text: z.string().optional(), by: z.string().optional(), why: z.string().optional() }).nullable(),
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
