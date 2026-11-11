/**
 * The HTTP API the web app uses. Reads come from the tables; every write goes through the
 * supervisor or the same write path it uses. The shape of what a screen needs was designed with
 * the screen plan in front of it (docs/superpowers/plans/2026-11-09-virtual-startup-screen.md).
 */
import { screenId } from './webBuild.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apply, lastEventId, readEvents } from '../db/apply.ts';
import { paths as pathsOf } from '../db/dataDir.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { git } from '../git/git.ts';
import { folderOf } from '../supervisor/jobs.ts';
import { diffOf } from './diff.ts';
import { writtenFiles } from './files.ts';
import { PRESETS } from '../presets/presets.ts';
import { EVENT_VERSION } from '../shared/events.ts';
import { EARLIER_SHOWN } from '../shared/view.ts';
import { EFFORT_LABELS, MODEL_LABELS } from '../shared/prices.ts';
import { Capability, Company, Effort, Gate, ModelTier, Repo, Service, type Task, Team, TeamRepo } from '../shared/types.ts';
import { availableCapabilities, CAPABILITIES } from '../supervisor/blastRadius.ts';
import { ADMIN_TOOLS } from '../shared/adminTools.ts';
import { adminTool, checkGates, checkRepo, checkTeam } from '../supervisor/admin.ts';
import { chat, messageEmployee } from '../supervisor/chat.ts';
import { companyNow } from '../supervisor/companyNow.ts';
import { edit, fire, hire, type HireCtx, removeTeam } from '../supervisor/hiring.ts';
import { readIndex } from '../supervisor/memory.ts';
import { AlreadySetUp, setupCompany, TEAM_DEFAULTS } from '../supervisor/setup.ts';
import type { Supervisor } from '../supervisor/supervisor.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const text = z.string().trim().min(1);
const priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const RepoBody = z.object({ path: text, gates: z.array(Gate).default([]) });
// A change names only what it changes. A default here would be written over what is there.
const RepoPatch = z.object({ path: text, gates: z.array(Gate) }).partial();
const SetupBody = z.object({ repo: RepoBody.optional(), name: text, rules: z.string().optional(), chiefName: z.string().optional(), auth: Company.shape.auth.optional(), models: Company.shape.models.partial().optional() });
const CompanyPatch = z
  .object({ name: text, rules: z.string(), concurrency: z.number(), dailyCapUsd: z.number(), adminId: z.string().nullable(), models: Company.shape.models, denyRead: z.array(z.string()), minFreeGb: z.number(), services: z.array(Service), paused: z.object({ reason: z.literal('user'), until: z.string().nullable() }).nullable() })
  .partial();
const TeamBody = z.object({ name: text, purpose: z.string().default(''), ...Team.omit({ id: true, name: true, purpose: true, leadId: true }).partial().shape });
const TeamPatch = TeamBody.extend({ purpose: z.string() }).partial();
const HireBody = z.union([
  z.object({ preset: z.enum(Object.keys(PRESETS) as [keyof typeof PRESETS, ...(keyof typeof PRESETS)[]]), name: text, teamId: text }),
  z.object({ name: text, teamId: text, role: text, model: text, effort: Effort.nullable().optional(), lead: z.boolean().default(false), skills: z.array(z.string()).default([]), capabilities: z.array(Capability).default([]) }),
]);
const EmployeePatch = z.object({ name: text, role: text, model: text, effort: Effort.nullable(), skills: z.array(z.string()), capabilities: z.array(Capability) }).partial();
const TaskBody = z.object({
  teamId: text,
  title: text,
  brief: text,
  assigneeId: z.string().nullable().optional(),
  reviewerId: z.string().nullable().optional(),
  priority: priority.optional(),
  doneCondition: z.string().optional(),
  repoId: z.string().nullable().optional(),
  gates: z.array(z.string()).optional(),
  ownership: z.array(z.string()).optional(),
  capUsd: z.number().positive().optional(),
  retryAllowed: z.boolean().optional(),
  leaseMinutes: z.number().positive().nullable().optional(),
});
const TaskPatch = z.object({ priority: priority.optional(), assigneeId: z.string().nullable().optional(), cancel: z.boolean().optional() });
const TextBody = z.object({ text });
const AnswerBody = z.object({ optionId: text, text: z.string().optional() });

const record = (map: Map<string, number>): Record<string, number> => Object.fromEntries(map);
const midnight = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

export function routes(app: FastifyInstance, options: { db: Db; dataDir: string; supervisor: Supervisor; webDir?: string }): void {
  const { db, supervisor } = options;
  const paths = pathsOf(options.dataDir);
  const now = () => supervisor.now();
  const hireCtx = (): HireCtx => ({ db, now: now(), paths, skills: supervisor.skills() });
  const found = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new HttpError(404, `There is no ${what}.`);
    return value;
  };
  const id = (request: { params: unknown }): string => (request.params as { id: string }).id;

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof AlreadySetUp) return reply.code(409).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') });
    // What the engine refuses, it refuses with a reason the screen can show.
    return reply.code(error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400).send({ error: error.message });
  });

  // ---------- one read to start from ----------

  app.get('/api/snapshot', async () => {
    const at = now();
    const company = store.getCompany(db) ?? null;
    const since = midnight(at);
    // Everything still open, what finished today, and the last few things that finished before today,
    // so that what they produced can still be opened. Work older than that is history, not the board.
    const all = store.listTasks(db);
    // A removed team is gone from the screen, and its work with it.
    const atWork = new Set(store.allTeams(db).map((team) => team.id));
    const over = (task: Task) => task.state === 'done' || task.state === 'failed';
    const earlier = all
      .filter((task) => task.kind === 'work' && over(task) && task.updatedAt < since)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, EARLIER_SHOWN);
    const tasks = [...all.filter((task) => !over(task) || task.updatedAt >= since), ...earlier].filter((task) => atWork.has(task.teamId));
    const shown = new Set(tasks.map((task) => task.id));
    const spend = store.spendToday(db, at);
    return {
      version: EVENT_VERSION,
      screen: screenId(options.webDir),
      company,
      repos: store.allRepos(db),
      teams: store.allTeams(db),
      employees: store.allEmployees(db),
      tasks,
      runs: store.allRuns(db).filter((run) => shown.has(run.taskId)),
      requests: store.openRequests(db),
      decisions: store.openDecisions(db),
      messages: store.recentMessages(db, 50),
      health: store.getHealth(db) ?? null,
      planUsage: store.getPlanUsage(db) ?? null,
      spend: { company: spend.company, byTeam: record(spend.byTeam), byEmployee: record(spend.byEmployee) },
      lastEventId: lastEventId(db),
      now: at.toISOString(),
    };
  });

  /** The same in words: every board, who is running, the cards waiting, today's spend. What the chief of staff is told, and what the tools for a Claude session read. */
  app.get('/api/now', async () => ({ text: companyNow(db, now()) }));

  // ---------- the setup, by tool: what Morpheus's conversations and the morpheus chat both call ----------

  app.post('/api/admin/:tool', async (request) => {
    const tool = (request.params as { tool: string }).tool;
    if (!(ADMIN_TOOLS as readonly string[]).includes(tool)) throw new HttpError(404, `There is no setup tool ${tool}.`);
    try {
      return { text: await adminTool(hireCtx(), tool, request.body ?? {}) };
    } catch (failure) {
      throw new HttpError(400, failure instanceof Error ? failure.message : String(failure));
    }
  });

  // ---------- the company ----------

  app.post('/api/setup', async (request) => {
    const { repo: named, ...body } = SetupBody.parse(request.body);
    if (store.getCompany(db)) throw new AlreadySetUp('This data directory already holds a company.');
    // A repository that cannot be used is said before anything is made: a company made without it could not be given it by the same form again.
    const repo = named ? await checkedRepo({ id: store.newId(), ...named }) : null;
    const company = setupCompany({ db, now: now(), paths }, body);
    if (repo) apply(db, (tx) => tx.emit({ kind: 'repo_changed', repo }), now());
    return { company, repo };
  });

  app.patch('/api/company', async (request) => {
    const company = found(store.getCompany(db), 'company yet');
    const next = Company.parse({ ...company, ...CompanyPatch.parse(request.body) });
    apply(db, (tx) => tx.emit({ kind: 'company_changed', company: next }), now());
    return { company: next };
  });

  async function checkedRepo(given: Repo): Promise<Repo> {
    try {
      return await checkRepo(db, given);
    } catch (failure) {
      throw new HttpError(400, (failure as Error).message);
    }
  }

  app.post('/api/repos', async (request) => {
    const repo = await checkedRepo({ id: store.newId(), ...RepoBody.parse(request.body) });
    apply(db, (tx) => tx.emit({ kind: 'repo_changed', repo }), now());
    return { repo };
  });

  app.patch('/api/repos/:id', async (request) => {
    const before = found(store.getRepo(db, id(request)), 'such repository');
    const repo = await checkedRepo({ ...before, ...RepoPatch.parse(request.body) });
    try {
      checkGates(db, before, repo.gates);
    } catch (failure) {
      throw new HttpError(400, (failure as Error).message);
    }
    apply(db, (tx) => tx.emit({ kind: 'repo_changed', repo }), now());
    return { repo };
  });

  /** A team may only name repositories that are registered and branches that exist in them. */
  async function checkedTeam(team: Team): Promise<Team> {
    return checkTeam(db, team);
  }

  app.post('/api/teams', async (request) => {
    const team = await checkedTeam({ ...TEAM_DEFAULTS, id: store.newId(), ...TeamBody.parse(request.body) });
    apply(db, (tx) => tx.emit({ kind: 'team_changed', team }), now());
    return { team };
  });

  app.post('/api/teams/:id/remove', async (request) => ({ team: removeTeam(hireCtx(), found(store.getTeam(db, id(request)), 'such team').id) }));

  app.patch('/api/teams/:id', async (request) => {
    const team = await checkedTeam({ ...found(store.getTeam(db, id(request)), 'such team'), ...TeamPatch.parse(request.body) });
    apply(db, (tx) => tx.emit({ kind: 'team_changed', team }), now());
    return { team };
  });

  // ---------- people ----------

  app.get('/api/hire-options', async () => {
    const company = found(store.getCompany(db), 'company yet');
    const tierOf = (model: string) => ModelTier.options.find((tier) => company.models[tier] === model) ?? null;
    const models = [...new Set([...Object.values(company.models), ...Object.keys(MODEL_LABELS)])].map((model) => ({ id: model, label: MODEL_LABELS[model] ?? model, tier: tierOf(model) }));
    return {
      presets: Object.entries(PRESETS).map(([presetId, preset]) => ({ id: presetId, ...preset, model: company.models[preset.tier] })),
      skills: supervisor.skills(),
      models,
      efforts: Effort.options.map((effort) => ({ id: effort, label: EFFORT_LABELS[effort] ?? effort })),
      capabilities: Capability.options.map((capability) => ({ id: capability, label: CAPABILITIES[capability].label })),
      availableByTeam: Object.fromEntries(store.allTeams(db).map((team) => [team.id, availableCapabilities(team)])),
    };
  });

  app.post('/api/employees', async (request) => ({ employee: hire(hireCtx(), HireBody.parse(request.body)) }));

  app.get('/api/employees/:id', async (request) => {
    const employee = found(store.getEmployee(db, id(request)), 'such employee');
    const runs = store
      .allRuns(db)
      .filter((run) => run.employeeId === employee.id)
      .slice(-30);
    return { employee, memoryIndex: employee.fired ? '' : readIndex(employee.memoryDir), runs, spentToday: store.spendToday(db, now()).byEmployee.get(employee.id) ?? 0 };
  });

  app.patch('/api/employees/:id', async (request) => ({ employee: edit(hireCtx(), found(store.getEmployee(db, id(request)), 'such employee').id, EmployeePatch.parse(request.body)) }));

  app.post('/api/employees/:id/fire', async (request) => {
    fire(hireCtx(), found(store.getEmployee(db, id(request)), 'such employee').id);
    return { ok: true };
  });

  app.post('/api/employees/:id/message', async (request) => ({ message: messageEmployee(supervisor, found(store.getEmployee(db, id(request)), 'such employee').id, TextBody.parse(request.body).text) }));

  // ---------- tasks ----------

  app.post('/api/tasks', async (request) => ({ task: supervisor.createTask(TaskBody.parse(request.body)) }));

  app.get('/api/tasks/:id', async (request) => {
    const task = found(store.getTask(db, id(request)), 'such task');
    const events = readEvents(db, 0, 100_000, task.id).slice(-200);
    return { task, children: store.listTasks(db, { parentId: task.id }), runs: store.runsOf(db, task.id), events, decisions: store.openDecisions(db, task.id) };
  });

  app.patch('/api/tasks/:id', async (request) => {
    const task = found(store.getTask(db, id(request)), 'such task');
    const patch = TaskPatch.parse(request.body);
    if (patch.cancel) supervisor.cancelTask(task.id);
    else supervisor.editTask(task.id, { ...(patch.priority !== undefined && { priority: patch.priority }), ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }) });
    return { task: store.getTask(db, task.id) };
  });

  /** What a task's branch changed, read from the user's repository, where the engine publishes it after every work run. */
  app.get('/api/tasks/:id/diff', async (request) => diffOf(db, found(store.getTask(db, id(request)), 'such task')));

  /** What a task without a repository wrote: the files in its folder. A task with one has its diff instead. */
  app.get('/api/tasks/:id/files', async (request) => {
    const task: Task = found(store.getTask(db, id(request)), 'such task');
    if (task.repoId || task.branch) return { folder: null, files: [], more: 0 };
    const folder = folderOf(paths, task);
    return { folder, ...writtenFiles(folder) };
  });

  app.post('/api/tasks/:id/message', async (request) => ({ message: supervisor.send({ taskId: found(store.getTask(db, id(request)), 'such task').id }, TextBody.parse(request.body).text, 'user') }));

  app.post('/api/runs/:id/stop', async (request) => {
    supervisor.stopRun(found(store.getRun(db, id(request)), 'such run').id);
    return { ok: true };
  });

  // ---------- decisions, chat, health ----------

  app.post('/api/decisions/:id/answer', async (request) => ({ result: supervisor.answer(found(store.getDecision(db, id(request)), 'such decision').id, AnswerBody.parse(request.body)) }));

  /** The decision log: every answered card, newest first. Each answer is also an event, so the log is the audit. */
  app.get('/api/decisions', async (request) => {
    const answered = (request.query as { answered?: string }).answered === '1';
    const all = answered
      ? store
          .allDecisions(db)
          .filter((decision) => decision.answeredAt !== null)
          .reverse()
          .slice(0, 200)
      : store.forUser(db); // what waits for the user: a card the chief of staff is deciding is not one of them
    return { decisions: all };
  });

  app.post('/api/chat', async (request) => ({ message: chat(supervisor, TextBody.parse(request.body).text) }));

  app.get('/api/health', async () => ({ report: await supervisor.checkHealth() }));
}
