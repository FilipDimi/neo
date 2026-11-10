/**
 * The supervisor: one loop that owns the database, starts one worker per run, enforces leases
 * and limits, and turns everything it may not decide into a card. It never runs a model session.
 */
import os from 'node:os';
import path from 'node:path';
import { apply, type Tx } from '../db/apply.ts';
import { engineFiles, paths as pathsOf, type Paths } from '../db/dataDir.ts';
import { leadsTo } from '../git/paths.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { listSkills, mountSkills, type SkillDirs, type SkillRef } from '../runtime/skills.ts';
import type { RuntimeEvent } from '../shared/runtime.ts';
import type { HealthReport, Message, Run, RunOutcome, RunRequest, Task, Team } from '../shared/types.ts';
import { TOOL_INPUT, ToSupervisor, type EngineTool } from '../worker/protocol.ts';
import { GateQueue, type GateLimits } from '../git/gates.ts';
import { availableCapabilities, CAPABILITIES, commandLimits, envFilesUnder, grantKey, judgeToolCall } from './blastRadius.ts';
import { budgetFor, costOf, isUsageLimit } from './budget.ts';
import * as decisions from './decisions.ts';
import type { TeamView } from './definition.ts';
import { Flow } from './flow.ts';
import { checkHealth, realProbes, type Probes } from './health.ts';
import { companyNow } from './companyNow.ts';
import { buildJob, folderOf, sessionEnv } from './jobs.ts';
import { canTransition } from './taskState.ts';
import { remember } from './memory.ts';
import { recover } from './recover.ts';
import { isExpired, leaseMinutesFor, onFailure } from './lease.ts';
import { forkSpawn, processes, type Processes, type Spawn, type WorkerLink } from './link.ts';
import { pickNext, requestFor } from './scheduler.ts';

type Tokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type SupervisorOptions = {
  db: Db;
  dataDir: string;
  now?: () => Date;
  tickMs?: number;
  /** How a worker is started. Defaults to a child process per run. */
  spawn?: Spawn;
  workerEntry?: string;
  /** A module exporting `startSession`, for running the engine without a model. */
  runtimeModule?: string;
  processes?: Processes;
  /** How machine health is measured. Tests substitute these. */
  probes?: Probes;
  /** Where installed skills are looked for. Defaults to Claude Code's folders and the company's own. */
  skillDirs?: SkillDirs;
  /** The port the API listens on. Gates are kept away from it. */
  apiPort?: number;
  /** How often a run waiting for a gate renews its lease. */
  gateHeartbeatMs?: number;
};

export type NewTaskInput = Pick<Task, 'teamId' | 'title' | 'brief'> &
  Partial<Pick<Task, 'createdBy' | 'assigneeId' | 'reviewerId' | 'parentId' | 'kind' | 'priority' | 'doneCondition' | 'repoId' | 'gates' | 'ownership' | 'capUsd' | 'retryAllowed' | 'leaseMinutes'>>;

type ToolReply = { ok: boolean; text: string };
const DEFAULT_WORKER = new URL('../worker/worker.ts', import.meta.url).pathname;
const TOOL_INPUT_LIMIT = 2048;

/** The local day, as it is written into the key of a daily cap's card. */
const dayKey = (at: Date): string => `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

export class Supervisor {
  readonly db: Db;
  readonly paths: Paths;
  readonly now: () => Date;
  private readonly tickMs: number;
  /** Per live run: what each answer of its unfinished turn has used. */
  private readonly unpaid = new Map<string, Map<string, Tokens>>();
  /** Per live run: the writes that were allowed and are not yet done. */
  private readonly allowedWrites = new Map<string, Map<string, { id: string; tool: string; input: unknown }>>();
  private readonly apiPort: number;
  private readonly spawn: Spawn;
  private readonly runtimeModule: string | undefined;
  protected readonly processes: Processes;
  /** Workers of live runs, by run id. A run with no entry here is over as far as this process knows. */
  private readonly links = new Map<string, WorkerLink>();
  /** How a run will be recorded when its worker exits, when the supervisor already knows (a question, a refusal). */
  private readonly planned = new Map<string, { outcome: RunOutcome; reason: string }>();
  private readonly reports = new Map<string, string>();
  /** Engine work in flight per task (commits, gates, merges): such a task is not idle. */
  private readonly busy = new Map<string, number>();
  private readonly work = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  protected readonly flow: Flow;
  private readonly probes: Probes;
  private readonly dataDir: string;
  private healthTimer: NodeJS.Timeout | undefined;
  private blockedRepos = new Set<string>();
  private readonly skillDirs: SkillDirs;
  private skillCache: { at: number; refs: SkillRef[] } | undefined;
  /** Tasks a route run has created so far, for its status line. */
  private readonly routed = new Map<string, number>();

  constructor(options: SupervisorOptions) {
    this.db = options.db;
    this.paths = pathsOf(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.tickMs = options.tickMs ?? 2000;
    this.apiPort = options.apiPort ?? 4317;
    this.runtimeModule = options.runtimeModule;
    this.processes = options.processes ?? processes;
    this.dataDir = options.dataDir;
    this.skillDirs = options.skillDirs ?? { userSkills: path.join(os.homedir(), '.claude', 'skills'), pluginCache: path.join(os.homedir(), '.claude', 'plugins', 'cache'), companySkills: pathsOf(options.dataDir).skills };
    this.probes = options.probes ?? realProbes(() => sessionEnv(store.getCompany(this.db) ?? { auth: 'subscription' }));
    this.spawn = options.spawn ?? forkSpawn(options.workerEntry ?? DEFAULT_WORKER, { logDir: this.paths.logs });
    this.flow = new Flow({
      db: this.db,
      paths: this.paths,
      now: this.now,
      gates: new GateQueue(),
      gateLimits: (folder, team) => this.gateLimits(folder, team),
      ...(options.gateHeartbeatMs !== undefined ? { gateHeartbeatMs: options.gateHeartbeatMs } : {}),
      engineWork: (taskId, work) => this.engineWork(taskId, work),
      planRunEnd: (runId, outcome, reason) => void this.planned.set(runId, { outcome, reason }),
    });
  }

  /** Picks up after whatever the last process left, then starts the loop and the health checks. */
  start(): void {
    if (this.timer) return;
    recover(this.db, this.now(), this.processes);
    void this.settleStaleCards();
    const health = () => void this.checkHealth().catch((error) => console.error('health check failed:', error));
    health();
    this.healthTimer = setInterval(health, 60_000);
    this.timer = setInterval(() => void this.tick().catch((error) => console.error('tick failed:', error)), this.tickMs);
  }

  /** Cards that ask about nothing (a merge with nothing to merge, raised by an older engine) are taken away and their tasks finished. */
  async settleStaleCards(): Promise<void> {
    for (const card of store.openDecisions(this.db)) if (card.kind === 'merge' && card.taskId) this.engineWork(card.taskId, () => this.flow.settleEmptyMerge(card));
    await this.settle();
  }

  /** Stops the loop and every worker. Runs left in flight are picked up by recovery at the next start. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.healthTimer);
    this.timer = undefined;
    // A run cut off here is ended by the next start, which cannot know what its unfinished turn had used: it is put on the books now.
    const decided: (() => void)[] = [];
    for (const [runId, link] of this.links) {
      const run = store.getRun(this.db, runId);
      link.kill();
      if (run?.outcome !== 'running') continue;
      // A run whose end was already decided (a verdict given, a question asked, a call refused) is written down as it
      // would have ended: the next start would otherwise call it lost and forget what it had said.
      const planned = this.planned.get(runId);
      if (planned) decided.push(() => this.finishRun(runId, planned.outcome, planned.reason, { summary: this.reports.get(runId) ?? run.summary }));
      else this.chargeUnfinishedTurn(run);
    }
    this.links.clear();
    for (const finish of decided) finish();
    await this.settle();
  }

  /** Waits for engine work in flight (commits, gates, merges) to finish. */
  async settle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  /** The loop body: end silent runs, check that nothing is idle, start what can start. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.liftPauseIfDue();
      this.closeCapCardsOfEarlierDays();
      this.expireLeases();
      this.checkInvariant();
      await this.startRuns();
    } finally {
      this.ticking = false;
    }
  }

  // ---------- tasks, messages, answers: what the outside may ask for ----------

  createTask(input: NewTaskInput): Task {
    const team = store.getTeam(this.db, input.teamId);
    if (!team) throw new Error(`no team ${input.teamId}`);
    if (team.removed) throw new Error(`the team ${team.name} was removed`);
    if (input.assigneeId) {
      const assignee = store.getEmployee(this.db, input.assigneeId);
      if (!assignee || assignee.fired) throw new Error(`no employee ${input.assigneeId}`);
      if (assignee.teamId !== team.id) throw new Error(`${assignee.name} is not on the team ${team.name}`);
    }
    const repoId = input.repoId === undefined ? (team.repos[0]?.repoId ?? null) : input.repoId;
    const repo = repoId ? store.getRepo(this.db, repoId) : undefined;
    if (repoId && (!repo || !team.repos.some((r) => r.repoId === repoId))) throw new Error(`the team ${team.name} does not work in repository ${repoId}`);
    const unknownGate = (input.gates ?? []).find((name) => !repo?.gates.some((gate) => gate.name === name));
    if (unknownGate) throw new Error(`no gate named "${unknownGate}" in this task's repository`);

    const now = this.now();
    const task = store.newTask({ createdBy: 'user', ...input, repoId }, now);
    const who = requestFor(task, team);
    if ('problem' in who && who.problem === 'no_assignee') throw new Error(`a task on the self-managed team ${team.name} needs an assignee`);
    apply(
      this.db,
      (tx) => {
        tx.emit({ kind: 'task_changed', task, cause: 'created' });
        if ('problem' in who) decisions.raise(tx, this.db, now, { taskId: task.id, kind: 'staffing', text: decisions.staffingText(task, who.problem), options: decisions.optionsFor('staffing') });
        else tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, ...who, reason: 'new' }, now) });
      },
      now,
    );
    return store.getTask(this.db, task.id)!;
  }

  /**
   * A message to an employee. It reaches a running session as its next turn; otherwise it waits
   * and opens that employee's next run. The sender sees which, never silence.
   */
  send(to: { employeeId: string } | { taskId: string }, text: string, fromId: string): Message {
    const task = 'taskId' in to ? store.getTask(this.db, to.taskId) : undefined;
    const toId = 'employeeId' in to ? to.employeeId : (task?.assigneeId ?? (task && store.getTeam(this.db, task.teamId)?.leadId));
    if (!toId || !store.getEmployee(this.db, toId)) throw new Error('there is nobody to deliver this message to');
    const now = this.now();
    const message: Message = { id: store.newId(), fromId, toId, taskId: task?.id ?? null, text, state: 'waiting', at: now.toISOString(), deliveredAt: null };
    apply(this.db, (tx) => tx.emit({ kind: 'message_sent', message }), now);
    const live = store.liveRuns(this.db).find((run) => run.employeeId === toId);
    this.links.get(live?.id ?? '')?.send({ t: 'message', id: message.id, text: `Message from ${this.nameOf(fromId)}: ${text}` });
    return message;
  }

  /** Stops a task for good: it fails, with everything under it, and its runs end. */
  cancelTask(taskId: string): void {
    const task = store.getTask(this.db, taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    this.change((tx, now) => decisions.failTree(tx, this.db, now, task));
    for (const run of store.liveRuns(this.db)) if (store.getTask(this.db, run.taskId)?.state === 'failed') this.endRunNow(run, 'stopped', 'task_stopped');
    if (task.parentId) this.flow.checkParent(task.parentId);
  }

  /** Reprioritises a task at any time; reassigns one that has not started. */
  editTask(taskId: string, patch: { priority?: Task['priority']; assigneeId?: string | null }): Task {
    const task = store.getTask(this.db, taskId);
    const team = task && store.getTeam(this.db, task.teamId);
    if (!task || !team) throw new Error(`no task ${taskId}`);
    const reassigned = patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId;
    // A task can change hands before it starts, or while it waits on a card that says nobody can do it.
    const cards = store.openDecisions(this.db).filter((card) => card.taskId === task.id);
    const staffing = cards.filter((card) => card.kind === 'staffing');
    if (reassigned && task.state !== 'queued' && staffing.length === 0) throw new Error('only a task that has not started, or one waiting for someone to be assigned, can be reassigned');
    if (reassigned && patch.assigneeId) {
      const assignee = store.getEmployee(this.db, patch.assigneeId);
      if (!assignee || assignee.fired || assignee.teamId !== team.id) throw new Error(`${patch.assigneeId} is not on the team ${team.name}`);
    }
    this.change((tx, now) => {
      let base = task;
      if (reassigned && staffing.length > 0) {
        // The card asked for exactly this. It is closed, and the task carries on unless another card still holds it.
        for (const card of staffing) decisions.close(tx, card, now);
        if (cards.length === staffing.length && canTransition(task, 'unblock')) base = decisions.move(tx, task, 'unblock', now);
      }
      const next: Task = { ...base, priority: patch.priority ?? task.priority, assigneeId: patch.assigneeId === undefined ? task.assigneeId : patch.assigneeId, updatedAt: now.toISOString() };
      tx.emit({ kind: 'task_changed', task: next, cause: 'edited' });
      if (!reassigned || next.state === 'blocked') return;
      for (const request of store.requestsOf(this.db, task.id)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: task.id });
      const who = requestFor(next, team);
      if ('problem' in who) decisions.raise(tx, this.db, now, { taskId: task.id, kind: 'staffing', text: decisions.staffingText(next, who.problem), options: decisions.optionsFor('staffing') });
      else tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, ...who, reason: 'new' }, now) });
    });
    return store.getTask(this.db, taskId)!;
  }

  /** Every skill installed on this machine that an employee could be given. Scanned at most every half minute. */
  skills(): SkillRef[] {
    if (!this.skillCache || Date.now() - this.skillCache.at > 30_000) this.skillCache = { at: Date.now(), refs: listSkills(this.skillDirs) };
    return this.skillCache.refs;
  }

  stopRun(runId: string): void {
    const run = store.getRun(this.db, runId);
    if (run?.outcome === 'running') this.endRunNow(run, 'stopped', 'stopped_by_user');
  }

  answer(decisionId: string, given: decisions.Answer): 'applied' | 'ignored' {
    const answered = decisions.answer(this.db, this.now(), decisionId, given);
    if (answered.result === 'applied') this.afterAnswer(answered);
    return answered.result;
  }

  protected afterAnswer(answered: decisions.Answered): void {
    // A stopped task takes its live runs with it.
    if (answered.effect === 'stop_task') {
      for (const run of store.liveRuns(this.db)) {
        const state = store.getTask(this.db, run.taskId)?.state;
        if (state === 'failed') this.endRunNow(run, 'stopped', 'task_stopped');
      }
    }
    // "Check again" on a health card: check now, and raise it again if it still fails.
    if (answered.decision.kind === 'health') void this.checkHealth().catch(() => {});
    this.flow.afterAnswer(answered);
  }

  // ---------- the loop ----------

  private expireLeases(): void {
    const now = this.now();
    for (const run of store.liveRuns(this.db)) {
      if (!isExpired(run.leaseUntil, now)) continue;
      const link = this.links.get(run.id);
      this.links.delete(run.id);
      link?.kill();
      this.finishRun(run.id, 'expired', 'silent');
    }
  }

  /** Every task that is under way has something working on it. One that does not is exactly the silent idle this product exists to prevent. */
  private checkInvariant(): void {
    const working = new Set([...store.liveRuns(this.db).map((run) => run.taskId), ...store.openRequests(this.db).map((request) => request.taskId), ...this.busy.keys()]);
    const now = this.now();
    for (const state of ['briefing', 'running', 'review'] as const) {
      for (const task of store.listTasks(this.db, { state })) {
        if (working.has(task.id)) continue;
        if (state === 'running' && store.listTasks(this.db, { parentId: task.id }).some((child) => child.state !== 'done' && child.state !== 'failed')) continue;
        apply(
          this.db,
          (tx) => decisions.raise(tx, this.db, now, { taskId: task.id, kind: 'invariant', text: `"${task.title}" is marked ${state}, but nobody is working on it and nothing is queued for it.`, options: decisions.optionsFor('invariant') }),
          now,
        );
      }
    }
  }

  private async startRuns(): Promise<void> {
    for (;;) {
      const company = store.getCompany(this.db);
      if (!company) return;
      const live = store.liveRuns(this.db);
      const spend = store.spendToday(this.db, this.now());
      const picked = pickNext({
        requests: store.openRequests(this.db),
        tasks: new Map(store.listTasks(this.db).map((task) => [task.id, task])),
        teams: new Map(store.allTeams(this.db).map((team) => [team.id, team])),
        employees: new Map(store.allEmployees(this.db).map((employee) => [employee.id, employee])),
        company,
        runningEmployeeIds: new Set(live.map((run) => run.employeeId)),
        runningTaskIds: new Set(live.map((run) => run.taskId)),
        runningCount: live.length,
        spend,
        blockedRepoIds: this.blockedRepoIds(),
      });
      if (!picked) return this.sayWhichCapStoppedWork(spend);
      if ('problem' in picked) this.dropRequest(picked.request, picked.problem);
      else await this.startRun(picked.request);
    }
  }

  /**
   * Work that waits because a daily cap is spent waits behind a card, not in silence. One card a
   * day for each cap at each amount: answered "wait", it does not come back until the cap or the day changes.
   */
  private sayWhichCapStoppedWork(spend: store.Spend): void {
    const company = store.getCompany(this.db);
    if (!company || company.paused) return;
    const waiting = store.openRequests(this.db).map((request) => store.getTask(this.db, request.taskId)).filter((task): task is Task => task !== undefined && task.state !== 'blocked' && task.state !== 'done' && task.state !== 'failed');
    if (waiting.length === 0) return;
    const now = this.now();
    const day = dayKey(now);
    const asked = new Set(store.allDecisions(this.db).map((decision) => decision.subject?.key));
    const count = (tasks: Task[]) => `${tasks.length} task${tasks.length === 1 ? ' is' : 's are'} waiting`;
    const more = (capUsd: number) => Math.max(1, Math.ceil(capUsd / 4));
    const card = (key: string, text: string, capUsd: number, teamId?: string) => {
      if (asked.has(key)) return;
      const options = [
        { id: 'raise', label: `Raise the daily cap by $${more(capUsd)}`, effect: 'raise_daily_cap' as const, params: { usd: more(capUsd), ...(teamId ? { teamId } : {}) } },
        { id: 'wait', label: 'Wait until tomorrow', effect: 'wait' as const },
      ];
      this.change((tx, at) => void decisions.raise(tx, this.db, at, { taskId: null, kind: 'cap', text, options, subject: { key } }));
    };
    if (company.dailyCapUsd > 0 && spend.company >= company.dailyCapUsd) {
      return card(`daily:company:${day}:${company.dailyCapUsd}`, `${company.name} has spent $${spend.company.toFixed(2)} of today's $${company.dailyCapUsd.toFixed(2)} cap, and ${count(waiting)}. Nothing more starts today unless the cap is raised.`, company.dailyCapUsd);
    }
    for (const team of store.allTeams(this.db)) {
      const spent = spend.byTeam.get(team.id) ?? 0;
      const theirs = waiting.filter((task) => task.teamId === team.id);
      if (team.dailyCapUsd <= 0 || spent < team.dailyCapUsd || theirs.length === 0) continue;
      card(`daily:${team.id}:${day}:${team.dailyCapUsd}`, `The team ${team.name} has spent $${spent.toFixed(2)} of today's $${team.dailyCapUsd.toFixed(2)} cap, and ${count(theirs)}. Nothing more of theirs starts today unless the cap is raised.`, team.dailyCapUsd, team.id);
    }
  }

  /** Repositories that machine health has blocked. */
  protected blockedRepoIds(): Set<string> {
    return this.blockedRepos;
  }

  private dropRequest(request: RunRequest, problem: 'fired' | 'stale'): void {
    const now = this.now();
    apply(
      this.db,
      (tx) => {
        tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: request.taskId });
        const task = store.getTask(this.db, request.taskId);
        if (problem === 'fired' && task) decisions.raise(tx, this.db, now, { taskId: task.id, employeeId: request.employeeId, kind: 'staffing', text: decisions.staffingText(task, 'fired'), options: decisions.optionsFor('staffing') });
      },
      now,
    );
  }

  private async startRun(asked: RunRequest): Promise<void> {
    let request = asked;
    const task = store.getTask(this.db, request.taskId)!;
    const team = store.getTeam(this.db, task.teamId)!;
    const employee = store.getEmployee(this.db, request.employeeId)!;
    const company = store.getCompany(this.db)!;
    try {
      // A task that has spent its cap does not start another run: the user decides.
      const budget = budgetFor(task, store.spentOn(this.db, task.id));
      if (budget === 'exhausted') {
        this.change((tx) => tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: task.id }));
        return this.raiseCap(task, store.runsOf(this.db, task.id).at(-1));
      }
      // The engine readies the task's folder first; for an integration it also merges the children.
      const ready = await this.flow.prepare(task, request);
      const readied = Object.keys(ready.task).length > 0;
      // Making the folder took a moment. If the task was cancelled, blocked or given to someone else meanwhile, this start is off.
      const current = store.getTask(this.db, task.id);
      const stillAsked = store.openRequests(this.db).some((open) => open.id === asked.id);
      const over = !current || current.state === 'done' || current.state === 'failed';
      if (over || !stillAsked || current.state === 'blocked') {
        return this.change((tx, at) => {
          if (current && readied) tx.emit({ kind: 'task_changed', task: { ...current, ...ready.task, updatedAt: at.toISOString() }, cause: 'edited' });
          if (over && stillAsked) tx.emit({ kind: 'request_dropped', requestId: asked.id, taskId: task.id });
        });
      }
      const prepared: Task = { ...current, ...ready.task };
      if (ready.firstTurn) request = { ...request, firstTurn: ready.firstTurn };
      // The chief of staff keeps one conversation going, as long as it is recent.
      if (request.mode === 'route' && !request.resumeSessionId && employee.chatSessionId) {
        const last = store.allRuns(this.db).filter((r) => r.employeeId === employee.id && r.mode === 'route' && r.endedAt).at(-1);
        if (last?.endedAt && this.now().getTime() - new Date(last.endedAt).getTime() < 2 * 3600_000) request = { ...request, resumeSessionId: employee.chatSessionId };
      }
      const mounted = employee.skills.length > 0 ? mountSkills(this.skills().filter((skill) => employee.skills.includes(skill.id)), path.join(this.paths.mounts, employee.id)) : { skills: [], plugins: [] };
      const now = this.now();
      const run = store.newRun(request, now, leaseMinutesFor(request, task, team));
      const messages = store.waitingMessages(this.db, employee.id);
      const everyone = store.allEmployees(this.db).filter((e) => !e.fired);
      const teams: TeamView[] = store.allTeams(this.db).map((t) => ({ team: t, lead: everyone.find((e) => e.id === t.leadId) ?? null, members: everyone.filter((e) => e.teamId === t.id) }));
      const job = this.jobFor({
        paths: this.paths,
        run,
        request,
        task: prepared,
        team,
        employee,
        company,
        repo: (prepared.repoId && store.getRepo(this.db, prepared.repoId)) || null,
        teammates: everyone.filter((e) => e.teamId === team.id),
        teams,
        board: request.mode === 'route' ? companyNow(this.db, now) : undefined,
        remainingUsd: Math.max(0, task.capUsd - store.spentOn(this.db, task.id)),
        envFiles: store.allRepos(this.db).flatMap((repo) => envFilesUnder(repo.path)),
        maxBudgetUsd: budget,
        mounted,
        messages,
        nameOf: (id) => this.nameOf(id),
        ...(this.runtimeModule ? { runtimeModule: this.runtimeModule } : {}),
      });
      const link = this.spawn(job);
      run.pid = link.pid;
      run.pidStartedAt = link.pid === null ? null : this.processes.startedAt(link.pid);
      this.links.set(run.id, link);
      apply(
        this.db,
        (tx) => {
          if (prepared.state === 'queued') decisions.move(tx, prepared, request.mode === 'brief' ? 'start_brief' : 'start_work', now);
          else if (readied) tx.emit({ kind: 'task_changed', task: { ...prepared, updatedAt: now.toISOString() }, cause: 'edited' });
          tx.emit({ kind: 'run_started', run, requestId: request.id, teamId: team.id });
          for (const message of messages) tx.emit({ kind: 'message_delivered', message: { ...message, state: 'delivered', deliveredAt: now.toISOString() } });
        },
        now,
      );
      link.onMessage((raw) => this.onWorkerMessage(run.id, raw));
      link.onExit(() => this.onWorkerGone(run.id));
    } catch (error) {
      const now = this.now();
      const reason = error instanceof Error ? error.message : String(error);
      apply(
        this.db,
        (tx) => {
          tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: task.id });
          decisions.raise(tx, this.db, now, { taskId: task.id, employeeId: employee.id, kind: 'failed', text: `${employee.name}'s run on "${task.title}" could not start: ${reason}`, options: decisions.optionsFor('failed') });
        },
        now,
      );
    }
  }

  protected jobFor(input: Parameters<typeof buildJob>[0]) {
    return buildJob(input);
  }

  // ---------- what a worker says ----------

  private onWorkerMessage(runId: string, raw: unknown): void {
    const parsed = ToSupervisor.safeParse(raw);
    const link = this.links.get(runId);
    const run = store.getRun(this.db, runId);
    if (!parsed.success || !link || !run || run.outcome !== 'running') return;
    const message = parsed.data;
    switch (message.t) {
      case 'event':
        return this.onRuntimeEvent(run, message.event);
      case 'decide':
        return link.send({ t: 'decision', askId: message.askId, ...this.judge(run, message.call) });
      case 'tool':
        return void this.onTool(run, message.name, message.input)
          .catch((error): ToolReply => ({ ok: false, text: error instanceof Error ? error.message : String(error) }))
          .then((reply) => link.send({ t: 'tool_result', askId: message.askId, ...reply }));
      case 'message_result': {
        const waiting = store.waitingMessages(this.db, run.employeeId).find((m) => m.id === message.id);
        const now = this.now();
        if (waiting && message.delivered) apply(this.db, (tx) => tx.emit({ kind: 'message_delivered', message: { ...waiting, state: 'delivered', deliveredAt: now.toISOString() } }), now);
        return;
      }
      case 'exit': {
        this.links.delete(runId);
        link.kill(); // Nothing the session started may outlive the run.
        const planned = this.planned.get(runId);
        // The SDK stopped the session at the run's budget: not a failure to retry, a cap for the user to decide on.
        const outcome = planned?.outcome ?? (message.reason === 'error_max_budget_usd' ? 'over_budget' : message.outcome);
        return this.finishRun(runId, outcome, planned?.reason ?? message.reason, { sessionId: message.sessionId ?? run.sessionId, summary: this.reports.get(runId) ?? message.summary });
      }
    }
  }

  /** The worker process is gone. If it never said goodbye, it crashed. */
  private onWorkerGone(runId: string): void {
    if (!this.links.delete(runId)) return;
    this.finishRun(runId, 'failed', 'crashed');
  }

  private onRuntimeEvent(run: Run, event: RuntimeEvent): void {
    // An estimate, kept until the turn's own account arrives. If the run is ended first, this is what it is charged.
    if (event.kind === 'usage_so_far') {
      const answers = this.unpaid.get(run.id) ?? new Map<string, Tokens>();
      answers.set(event.messageId, event);
      return void this.unpaid.set(run.id, answers);
    }
    if (event.kind === 'usage') this.unpaid.delete(run.id);
    if (event.kind === 'tool_result') this.checkWriteLanded(run, event.id);
    const now = this.now();
    const teamId = store.getEmployee(this.db, run.employeeId)?.teamId ?? '';
    const recorded = event.kind === 'tool_call' ? { ...event, input: trimmed(event.input) } : event;
    apply(
      this.db,
      (tx) => {
        tx.emit({ kind: 'run_event', runId: run.id, taskId: run.taskId, employeeId: run.employeeId, teamId, event: this.priced(run, recorded) });
        if (event.kind === 'plan_usage') tx.emit({ kind: 'plan_usage', status: event.status, window: event.window, utilization: event.utilization, resetsAt: event.resetsAt });
      },
      now,
    );
    this.afterRuntimeEvent(run, event);
  }

  /** A turn's usage with its cost filled in when the SDK reported none. */
  protected priced(run: Run, event: RuntimeEvent): RuntimeEvent {
    if (event.kind !== 'usage' || event.costUsd > 0) return event;
    return { ...event, costUsd: costOf(event, store.getEmployee(this.db, run.employeeId)?.model ?? '') };
  }

  /** Reactions to what a session reported, beyond recording it. */
  protected afterRuntimeEvent(_run: Run, event: RuntimeEvent): void {
    const limit = isUsageLimit(event);
    if (limit) this.pauseForUsageLimit(limit.until);
  }

  /**
   * The subscription's own limit was reached. That is nobody's failure: every live run is ended
   * without spending a retry, the company pauses with one card, and each run resumes afterwards.
   */
  private pauseForUsageLimit(until: string | null): void {
    const company = store.getCompany(this.db);
    if (!company || company.paused?.reason === 'usage_limit') return;
    const when = until ? `until ${new Date(until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, and resumes by itself then` : 'until you resume it';
    this.change((tx, now) => {
      tx.emit({ kind: 'company_changed', company: { ...company, paused: { reason: 'usage_limit', until } } });
      decisions.raise(tx, this.db, now, { taskId: null, kind: 'usage_limit', text: `The Claude plan's usage limit was reached. Every run is paused ${when}. Nothing was lost and no retry was spent.`, options: decisions.optionsFor('usage_limit'), subject: { key: 'usage_limit' } });
    });
    for (const live of store.liveRuns(this.db)) {
      this.endRunNow(live, 'usage_limit', 'usage_limit');
      const ended = store.getRun(this.db, live.id)!;
      const firstTurn = ended.sessionId ? 'You were paused because the plan\'s usage limit was reached. The files in your folder are as you left them. Carry on with the task.' : null;
      this.change((tx, now) => tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: ended.taskId, mode: ended.mode, employeeId: ended.employeeId, reason: 'resume', attempt: ended.attempt, resumeSessionId: ended.sessionId, firstTurn }, now) }));
    }
  }

  /** A pause for the usage limit ends by itself at the reset time, if the limit gave one. */
  /** A daily cap's card is about one day. When that day is over its buttons mean nothing: the spend has started again from zero. */
  private closeCapCardsOfEarlierDays(): void {
    const today = dayKey(this.now());
    const stale = store.openDecisions(this.db).filter((card) => {
      const key = card.kind === 'cap' && typeof card.subject?.key === 'string' ? card.subject.key.split(':') : [];
      return key[0] === 'daily' && key[2] !== today;
    });
    if (stale.length > 0) this.change((tx, now) => stale.forEach((card) => decisions.close(tx, card, now)));
  }

  private liftPauseIfDue(): void {
    const company = store.getCompany(this.db);
    if (company?.paused?.reason !== 'usage_limit' || !company.paused.until || this.now() < new Date(company.paused.until)) return;
    this.change((tx, now) => {
      tx.emit({ kind: 'company_changed', company: { ...company, paused: null } });
      for (const card of store.openDecisions(this.db).filter((d) => d.kind === 'usage_limit')) decisions.close(tx, card, now);
    });
  }

  private raiseCap(task: Task, run: Run | undefined): void {
    const spent = store.spentOn(this.db, task.id);
    this.change((tx, now) =>
      decisions.raise(tx, this.db, now, {
        taskId: task.id,
        runId: run?.id ?? null,
        employeeId: run?.employeeId ?? null,
        kind: 'cap',
        text: `"${task.title}" has spent $${spent.toFixed(2)} of its $${task.capUsd.toFixed(2)} cap. Raise the cap, or stop the task?`,
        options: decisions.optionsFor('cap', { capUsd: task.capUsd }),
      }),
    );
  }

  /** Checks the machine. A company-wide failure pauses the company; a repository's failure blocks its tasks; each raises one card while it lasts. */
  async checkHealth(): Promise<HealthReport | null> {
    const company = store.getCompany(this.db);
    if (!company) return null;
    const report = await checkHealth({ repos: store.allRepos(this.db), minFreeGb: company.minFreeGb, auth: company.auth, services: company.services, dataDir: this.dataDir, now: this.now(), probe: this.probes });
    this.blockedRepos = new Set(report.failures.flatMap((failure) => (typeof failure.scope === 'object' ? [failure.scope.repoId] : [])));
    const companyWide = report.failures.some((failure) => failure.scope === 'company');
    const same = (a: HealthReport | undefined, b: HealthReport) => a !== undefined && JSON.stringify([a.diskFreeGb, a.login, a.repos, a.services, a.failures]) === JSON.stringify([b.diskFreeGb, b.login, b.repos, b.services, b.failures]);
    this.change((tx, now) => {
      if (!same(store.getHealth(this.db), report)) tx.emit({ kind: 'health_changed', report });
      const current = store.getCompany(this.db)!;
      if (companyWide && !current.paused) tx.emit({ kind: 'company_changed', company: { ...current, paused: { reason: 'health', until: null } } });
      if (!companyWide && current.paused?.reason === 'health') tx.emit({ kind: 'company_changed', company: { ...current, paused: null } });
      for (const card of store.openDecisions(this.db).filter((d) => d.kind === 'health')) if (!report.failures.some((failure) => failure.key === card.subject?.key)) decisions.close(tx, card, now);
      for (const failure of report.failures) decisions.raise(tx, this.db, now, { taskId: null, kind: 'health', text: failure.text, options: decisions.optionsFor('health'), subject: { key: failure.key } });
    });
    return report;
  }

  /** May this tool call run? Asked for every call of every session. A refusal that needs the user stops the run and raises a card. */
  protected judge(run: Run, call: { id: string; tool: string; input: unknown }): { allow: boolean; reason?: string; stop?: boolean } {
    const task = store.getTask(this.db, run.taskId);
    const employee = store.getEmployee(this.db, run.employeeId);
    const team = task && store.getTeam(this.db, task.teamId);
    const company = store.getCompany(this.db);
    if (!task || !employee || !team || !company) return { allow: false, reason: 'Refused: this run has lost its task.', stop: true };
    const folder = folderOf(this.paths, task);
    const verdict = judgeToolCall({ task, team, employee, mode: run.mode, folder, company, grants: store.grantsOf(this.db, task.id), protect: engineFiles(this.paths) }, call);
    const now = this.now();
    if (verdict.useGrant) {
      const grant = store.grantsOf(this.db, task.id).find((g) => g.id === verdict.useGrant)!;
      apply(this.db, (tx) => tx.emit({ kind: 'grant_changed', grant: { ...grant, used: true } }), now);
    }
    if (verdict.card) {
      const card = verdict.card;
      apply(
        this.db,
        (tx) =>
          decisions.raise(tx, this.db, now, {
            taskId: task.id,
            runId: run.id,
            employeeId: employee.id,
            kind: 'tool',
            text: `${employee.name} ${card}, while working on "${task.title}".`,
            options: decisions.optionsFor('tool'),
            subject: { tool: call.tool, inputHash: grantKey(call, folder) },
          }),
        now,
      );
      this.planned.set(run.id, { outcome: 'refused', reason: 'refused' });
    }
    // A write is judged here, and done a moment later by the session's own process. Its path is looked at again once it is done.
    if (verdict.allow && !verdict.useGrant && (call.tool === 'Write' || call.tool === 'Edit')) {
      const allowed = this.allowedWrites.get(run.id) ?? new Map<string, { id: string; tool: string; input: unknown }>();
      allowed.set(call.id, call);
      this.allowedWrites.set(run.id, allowed);
    }
    return { allow: verdict.allow, ...(verdict.reason !== undefined && { reason: verdict.reason }), ...(verdict.stop && { stop: true }) };
  }

  /**
   * A write that was allowed has been done. If its path no longer leads where it did when it was
   * judged (a link was put in its way in between), the file may be outside the task folder. That
   * cannot be undone from here, so the run stops and the user is told exactly which path.
   */
  private checkWriteLanded(run: Run, callId: string): void {
    const call = this.allowedWrites.get(run.id)?.get(callId);
    if (!call) return;
    this.allowedWrites.get(run.id)!.delete(callId);
    const task = store.getTask(this.db, run.taskId);
    const employee = store.getEmployee(this.db, run.employeeId);
    const team = task && store.getTeam(this.db, task.teamId);
    const company = store.getCompany(this.db);
    if (!task || !employee || !team || !company) return;
    const folder = folderOf(this.paths, task);
    if (judgeToolCall({ task, team, employee, mode: run.mode, folder, company, grants: [], protect: engineFiles(this.paths) }, call).allow) return;
    const named = String((call.input as { file_path?: unknown } | null)?.file_path ?? '');
    const now = this.now();
    apply(
      this.db,
      (tx) =>
        decisions.raise(tx, this.db, now, {
          taskId: task.id,
          runId: run.id,
          employeeId: employee.id,
          kind: 'tool',
          text: `${employee.name} wrote ${named} while working on "${task.title}", and that path was changed while it was being written. The file may have landed at ${leadsTo(path.isAbsolute(named) ? named : path.join(folder, named)) ?? 'a place that cannot be followed'}, outside the task folder. Look there before anything else runs.`,
          options: [
            { id: 'stop', label: 'Stop it', effect: 'stop_task' },
            { id: 'carry', label: 'I looked: carry on', effect: 'recheck' },
          ],
          subject: { key: `moved:${run.id}:${callId}` },
        }),
      now,
    );
    this.endRunNow(run, 'refused', 'path_moved');
  }

  /** The model called one of the engine's tools. */
  protected async onTool(run: Run, name: EngineTool, input: unknown): Promise<ToolReply> {
    const now = this.now();
    switch (name) {
      case 'set_status': {
        const { text } = TOOL_INPUT.set_status.parse(input);
        apply(this.db, (tx) => tx.emit({ kind: 'run_activity', runId: run.id, taskId: run.taskId, employeeId: run.employeeId, text }), now);
        return { ok: true, text: 'Noted.' };
      }
      case 'report_done': {
        this.reports.set(run.id, TOOL_INPUT.report_done.parse(input).summary);
        return { ok: true, text: 'Recorded. End your turn now: the engine takes it from here.' };
      }
      case 'request_tools': {
        const { capabilities, reason } = TOOL_INPUT.request_tools.parse(input);
        const employee = store.getEmployee(this.db, run.employeeId);
        const task = store.getTask(this.db, run.taskId);
        const team = task && store.getTeam(this.db, task.teamId);
        if (!employee || !task || !team) return { ok: false, text: 'This run has lost its task.' };
        const offered = availableCapabilities(team).filter((capability) => !employee.capabilities.includes(capability));
        const wanted = [...new Set(capabilities)];
        // A review only reads, whoever does it: those two tools are held back for the run, not missing from the employee.
        if (run.mode === 'review' && wanted.some((capability) => capability === 'write_code' || capability === 'run_commands')) {
          return { ok: false, text: 'Not in this run: a review only reads, whoever does it. To check something by running it, call mcp__engine__run_gate with the name of a gate. If the work cannot be judged without more, say so in your verdict. If you need another kind of tool as well, ask for that one alone.' };
        }
        const has = wanted.filter((capability) => employee.capabilities.includes(capability));
        if (has.length === wanted.length) return { ok: false, text: `You already have ${decisions.capabilityNames(has)}. Use it.` };
        const missing = wanted.filter((capability) => !employee.capabilities.includes(capability));
        const refused = missing.filter((capability) => !offered.includes(capability));
        if (refused.length > 0) return { ok: false, text: `Nobody on your team can be given ${decisions.capabilityNames(refused)}. What you can be given: ${offered.map((capability) => CAPABILITIES[capability].label).join(', ') || 'nothing more'}.` };
        const names = decisions.capabilityNames(missing);
        apply(
          this.db,
          (tx) =>
            decisions.raise(tx, this.db, now, {
              taskId: task.id,
              runId: run.id,
              employeeId: employee.id,
              kind: 'capability',
              text: `${employee.name} cannot do "${task.title}" with the tools it has. It asks for ${names}: ${reason.trim()}`,
              options: [
                { id: 'grant', label: `Give ${employee.name} ${names}`, effect: 'grant_capabilities', params: { employeeId: employee.id, capabilities: missing } },
                { id: 'without', label: 'Carry on without', effect: 'resume_with_answer', params: { text: `The user decided you will not get ${names}. Do what you can without, and say in your report what you could not do.` } },
                { id: 'stop', label: 'Stop it', effect: 'stop_task' },
              ],
            }),
          now,
        );
        this.planned.set(run.id, { outcome: 'stopped', reason: 'tools' });
        return { ok: true, text: 'Your request is on the user\'s desk. End your turn now: you will be resumed with the answer.' };
      }
      case 'request_decision': {
        const { question, options } = TOOL_INPUT.request_decision.parse(input);
        const employee = store.getEmployee(this.db, run.employeeId);
        const task = store.getTask(this.db, run.taskId);
        // An employee that keeps asking is missing something an answer cannot give it. The third question in a row says so,
        // and the buttons it wrote itself go: they have been pressed twice and changed nothing.
        // A lead's answer in between does not break the row: it is the asking that repeats.
        const earlier = store.runsOf(this.db, run.taskId).filter((other) => other.id !== run.id && other.endedAt !== null && other.mode !== 'review');
        let inARow = 1;
        for (const other of earlier.reverse()) {
          if (other.reason !== 'question') break;
          inARow += 1;
        }
        const looping = inARow >= 3;
        // On a led team a member's question goes to its lead first: most are about what a brief means, and the lead wrote it.
        const team = task && store.getTeam(this.db, task.teamId);
        const lead = team && !team.selfManaged && team.leadId && team.leadId !== run.employeeId ? store.getEmployee(this.db, team.leadId) : undefined;
        if (task && lead && !lead.fired && lead.capabilities.includes('read_files') && run.mode === 'work' && !looping) {
          this.flow.askLead(run, task, lead, question, options);
          this.planned.set(run.id, { outcome: 'stopped', reason: 'question' });
          return { ok: true, text: `Your question has gone to your lead, ${lead.name}. End your turn now: you will be resumed with the answer.` };
        }
        apply(
          this.db,
          (tx) =>
            decisions.raise(tx, this.db, now, {
              taskId: run.taskId,
              runId: run.id,
              employeeId: run.employeeId,
              kind: 'question',
              text: looping
                ? `${employee?.name ?? 'An employee'} has asked ${inARow} times in a row about "${task?.title ?? 'a task'}" and done no work in between. It is probably missing something an answer cannot give it: a tool, a file, or a clearer task. Its question this time: ${question}`
                : `${employee?.name ?? 'An employee'} asks about "${task?.title ?? 'a task'}": ${question}`,
              freeText: true,
              options: decisions.optionsFor('question', { choices: looping ? [] : options }),
            }),
          now,
        );
        this.planned.set(run.id, { outcome: 'stopped', reason: 'question' });
        return { ok: true, text: 'Your question is on the user\'s desk. End your turn now: you will be resumed with the answer.' };
      }
      case 'create_task': {
        const wanted = TOOL_INPUT.create_task.parse(input);
        // The chief of staff routes work to any team. Anyone else who is written to puts work on its own team's board and nowhere else.
        const author = store.getEmployee(this.db, run.employeeId);
        const chiefId = store.getCompany(this.db)?.chiefOfStaffId ?? null;
        if (author && author.id !== chiefId && wanted.teamId !== author.teamId) {
          return { ok: false, text: `You can put work on your own team's board only (teamId: ${author.teamId}). For another team, tell the user to ask ${chiefId ? this.nameOf(chiefId) : 'the chief of staff'}.` };
        }
        let created: Task;
        try {
          created = this.createTask({ ...wanted, createdBy: run.employeeId });
        } catch (failure) {
          return { ok: false, text: `That task could not be created: ${failure instanceof Error ? failure.message : String(failure)}.` };
        }
        const count = (this.routed.get(run.id) ?? 0) + 1;
        this.routed.set(run.id, count);
        apply(this.db, (tx) => tx.emit({ kind: 'run_activity', runId: run.id, taskId: run.taskId, employeeId: run.employeeId, text: `writing ${count} task${count === 1 ? '' : 's'} from your chat` }), now);
        const team = store.getTeam(this.db, created.teamId);
        return { ok: true, text: `Created "${created.title}" on ${team?.name ?? created.teamId}${created.assigneeId ? ` for ${this.nameOf(created.assigneeId)}` : '; its lead will brief it'}.` };
      }
      case 'propose_subtasks':
        return this.flow.onProposal(run, input);
      case 'submit_review':
        return this.flow.onReview(run, input);
      case 'run_gate':
        return this.flow.runGateTool(run, input);
      default:
        return { ok: false, text: `The tool ${name} is not available in this run.` };
    }
  }

  // ---------- how a run ends ----------

  /** Ends a live run at once, with the outcome the supervisor has decided. */
  protected endRunNow(run: Run, outcome: RunOutcome, reason: string): void {
    const link = this.links.get(run.id);
    this.links.delete(run.id);
    link?.send({ t: 'stop' });
    link?.kill();
    this.finishRun(run.id, outcome, reason);
  }

  /** A turn that was cut short never reported its account. What its answers had used by then is charged, at list prices. */
  private chargeUnfinishedTurn(run: Run): void {
    const answers = [...(this.unpaid.get(run.id)?.values() ?? [])];
    this.unpaid.delete(run.id);
    if (answers.length === 0) return;
    const sum = (pick: (tokens: Tokens) => number) => answers.reduce((total, tokens) => total + pick(tokens), 0);
    const used = { inputTokens: sum((t) => t.inputTokens), outputTokens: sum((t) => t.outputTokens), cacheReadTokens: sum((t) => t.cacheReadTokens), cacheWriteTokens: sum((t) => t.cacheWriteTokens), costUsd: 0 };
    const teamId = store.getEmployee(this.db, run.employeeId)?.teamId ?? '';
    const event = this.priced(run, { kind: 'usage', ...used, sessionCostUsd: 0 });
    apply(this.db, (tx) => tx.emit({ kind: 'run_event', runId: run.id, taskId: run.taskId, employeeId: run.employeeId, teamId, event }), this.now());
  }

  private finishRun(runId: string, outcome: RunOutcome, reason: string | null, patch: Partial<Run> = {}): void {
    const live = store.getRun(this.db, runId);
    if (!live || live.outcome !== 'running') return;
    this.chargeUnfinishedTurn(live);
    const run = store.getRun(this.db, runId)!;
    const now = this.now();
    const ended: Run = { ...run, ...patch, outcome, reason, endedAt: now.toISOString() };
    const teamId = store.getEmployee(this.db, run.employeeId)?.teamId ?? '';
    apply(this.db, (tx) => tx.emit({ kind: 'run_ended', run: ended, teamId }), now);
    this.planned.delete(runId);
    this.reports.delete(runId);
    this.routed.delete(runId);
    this.allowedWrites.delete(runId);
    this.engineWork(ended.taskId, () => this.afterRun(ended));
  }

  /** A gate is confined as the team's own commands are, and kept away from this engine's API. */
  private gateLimits(folder: string, team: Team): GateLimits {
    const company = store.getCompany(this.db);
    const limits = commandLimits({ folder, team, company: company ?? { denyRead: [] }, envFiles: store.allRepos(this.db).flatMap((repo) => envFilesUnder(repo.path)), protect: engineFiles(this.paths) });
    // A team that may write Xcode's build folders builds with Xcode: its gates get what Xcode needs inside the sandbox.
    return { ...limits, blockPorts: [this.apiPort], xcode: team.sandboxWrite.includes('~/Library/Developer/Xcode') };
  }

  /** Runs a piece of engine work for a task. While it runs the task is not idle; if it throws, a card says so. */
  protected engineWork(taskId: string, work: () => Promise<void>): void {
    this.busy.set(taskId, (this.busy.get(taskId) ?? 0) + 1);
    const promise: Promise<void> = work()
      .catch((error) => {
        const now = this.now();
        const task = store.getTask(this.db, taskId);
        const reason = error instanceof Error ? error.message : String(error);
        if (task) apply(this.db, (tx) => decisions.raise(tx, this.db, now, { taskId, kind: 'failed', text: `The engine could not finish its own step on "${task.title}": ${reason}`, options: decisions.optionsFor('failed') }), now);
      })
      .finally(() => {
        const left = (this.busy.get(taskId) ?? 1) - 1;
        if (left > 0) this.busy.set(taskId, left);
        else this.busy.delete(taskId);
        this.work.delete(promise);
      });
    this.work.add(promise);
  }

  private async afterRun(run: Run): Promise<void> {
    const task = store.getTask(this.db, run.taskId);
    if (!task || task.state === 'done' || task.state === 'failed') return;
    switch (run.outcome) {
      case 'done': {
        const employee = store.getEmployee(this.db, run.employeeId);
        if (employee && run.summary && run.mode !== 'route') remember(employee.memoryDir, `${task.title}: ${run.summary}`, this.now());
        // The chief of staff's last words are its reply in the chat, and its conversation carries on from here.
        if (employee && run.mode === 'route') {
          this.change((tx, now) => {
            const at = now.toISOString();
            tx.emit({ kind: 'message_sent', message: { id: store.newId(), fromId: employee.id, toId: 'user', taskId: task.id, text: run.summary ?? 'Done.', state: 'delivered', at, deliveredAt: at } });
            tx.emit({ kind: 'employee_changed', employee: { ...store.getEmployee(this.db, employee.id)!, chatSessionId: run.sessionId } });
          });
        }
        return this.onRunDone(run, task);
      }
      case 'failed':
      case 'expired':
        return this.onRunFailed(run, task);
      case 'stopped':
        if (run.reason === 'stopped_by_user') this.raiseForRun(run, task, 'failed', (name) => `You stopped ${name}'s run on "${task.title}". Run it again, or stop the task?`);
        return;
      case 'over_budget':
        return this.raiseCap(store.getTask(this.db, task.id)!, run);
      default:
        return; // refused, usage limit: the card was raised when it happened.
    }
  }

  /** A run finished its part. What happens next depends on its mode and its team: that is the flow. */
  protected async onRunDone(run: Run, task: Task): Promise<void> {
    await this.flow.onRunDone(run, task);
  }

  private onRunFailed(run: Run, task: Task): void {
    const now = this.now();
    // A chat that could not be resumed starts fresh next time.
    const chief = run.mode === 'route' ? store.getEmployee(this.db, run.employeeId) : undefined;
    if (chief?.chatSessionId) apply(this.db, (tx) => tx.emit({ kind: 'employee_changed', employee: { ...chief, chatSessionId: null } }), now);
    if (onFailure(run, task) === 'retry') {
      const firstTurn = run.sessionId ? 'Your last run was cut short. The files in your folder are as you left them. Carry on with the task.' : null;
      const request = store.newRequest({ taskId: task.id, mode: run.mode, employeeId: run.employeeId, reason: 'retry', attempt: run.attempt + 1, resumeSessionId: run.sessionId, firstTurn }, now);
      return void apply(this.db, (tx) => tx.emit({ kind: 'run_requested', request }), now);
    }
    if (run.outcome === 'expired') {
      const times = store.runsOf(this.db, task.id).filter((r) => r.outcome === 'expired').length;
      const count = times === 1 ? 'once' : times === 2 ? 'twice' : `${times} times`;
      const longer = run.leaseMinutes * 2;
      return this.raiseForRun(run, task, 'lease', (name) => `${name}'s run on "${task.title}" went silent past its ${run.leaseMinutes}-minute lease ${count}. Retry with a ${longer}-minute lease, or stop the task?`, { leaseMinutes: run.leaseMinutes });
    }
    this.raiseForRun(run, task, 'failed', (name) => `${name}'s run on "${task.title}" failed: ${explain(run.reason)}. Retry, or stop the task?`);
  }

  protected raiseForRun(run: Run, task: Task, kind: 'lease' | 'failed', text: (employeeName: string) => string, context: { leaseMinutes?: number } = {}): void {
    const now = this.now();
    const name = store.getEmployee(this.db, run.employeeId)?.name ?? 'An employee';
    apply(this.db, (tx) => decisions.raise(tx, this.db, now, { taskId: task.id, runId: run.id, employeeId: run.employeeId, kind, text: text(name), options: decisions.optionsFor(kind, context) }), now);
  }

  protected nameOf(id: string): string {
    return id === 'user' ? 'the user' : (store.getEmployee(this.db, id)?.name ?? id);
  }

  /** For subclasses and helpers that write several events as one change. */
  protected change(write: (tx: Tx, now: Date) => void): void {
    const now = this.now();
    apply(this.db, (tx) => write(tx, now), now);
  }
}

function trimmed(input: unknown): unknown {
  const json = JSON.stringify(input) ?? '';
  return json.length <= TOOL_INPUT_LIMIT ? input : { trimmed: `${json.slice(0, TOOL_INPUT_LIMIT)}…` };
}

function explain(reason: string | null): string {
  switch (reason) {
    case 'crashed':
      return 'its process died';
    case 'error_max_turns':
      return 'it reached its turn limit without finishing';
    case 'no_report':
      return 'it stopped without reporting what it did';
    case 'error_during_execution':
      return 'the session ended with an error';
    default:
      return reason ?? 'no reason was given';
  }
}
