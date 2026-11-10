# Virtual Startup Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (Filip chose: one session implements every task, one review of the whole branch at the end). Steps use checkbox (`- [ ]`) syntax for tracking.

**Revised 2026-11-09** after the review (`docs/superpowers/reviews/`) and the spike (`docs/spike/2026-11-09-spike-findings.md`). Task 1 is built. Finding numbers such as P60 or D6 point into the review notes; "spike §4" points into the findings.

**Goal:** Build the engine of the virtual startup: a supervisor that runs AI employees as leased worker processes on the Claude Agent SDK, with teams, a task board, briefing and review, budgets and blast radius, decision cards, machine health, and the HTTP and WebSocket API the web app consumes.

**Architecture:** One Node supervisor process owns a SQLite file and a scheduling loop. Every reason to start a run is a row in `run_requests`; the scheduler is the only reader and the supervisor the only spawner. Each run is a child process hosting one Agent SDK session, speaking a typed protocol over IPC under a lease. State rows and their events are written in one transaction; every event carries the rows it changed, so the web app is a projection of the event stream. Git, gates, merges and limits are engine operations; an employee's session never has them.

**Tech Stack:** TypeScript (strict), Node 20.19 or newer, `@anthropic-ai/claude-agent-sdk` 0.3.321 (pinned), `better-sqlite3` (WAL), `zod`, `vitest`, `tsx` (the engine runs from source; workers are forked with `execArgv: ['--import', 'tsx']`), `fastify` with `@fastify/websocket`, `open`. Git through `execFile('git', …)`, no wrapper library. Each task installs the dependencies it introduces.

**Spec:** `docs/superpowers/specs/2026-11-08-virtual-startup-design.md`, as amended in its section 15. **Plan 2 (the screen):** `docs/superpowers/plans/2026-11-09-virtual-startup-screen.md`. Its event and API needs are designed into Tasks 2 and 14 here; it is built after Task 14 and before the dogfood.

## Global Constraints

- Local-first: everything runs on the user's machine; repositories are local paths; nothing leaves the machine except the SDK's model calls.
- Sessions run on the claude.ai login. `Company.auth` is `'subscription'` or `'api_key'`; in subscription mode the session's environment is `subscriptionEnv(process.env).env`. Switching to a key is Filip's decision, never a fallback in code.
- Every session goes through `startSession()` in `src/runtime/sdk.ts`: no setting sources, no connectors, its own environment, and a PreToolUse hook that puts every tool call to the supervisor. `allowedTools` stays empty (spike §4).
- A worker has no inbox and never waits. Silence past the lease is detected by the supervisor. Nothing retries forever. Nothing fails silently.
- Employees get no git write path to the user's repository. The engine commits, merges and pushes. Publish, send, pay and delete have no tool in this version: they are impossible, and asking for one is a decision card.
- Sibling briefs with overlapping ownership are refused at creation, and ownership is checked again after every work run.
- Merging into a branch other than the team's merge target is a decision card. The merge target defaults to none.
- Task states: `queued`, `briefing`, `running`, `review`, `blocked`, `done`, `failed`. Default lease: 15 minutes, with the Bash timeout set 2 minutes below it. Default concurrency: 3. One retry per failure. At most 3 review rounds per task.
- Memory: one folder per employee, an index read at every run start, capped by the supervisor at 8 KB.
- All state lives in a data directory outside the repository: `VS_DATA_DIR`, default `~/.virtual-startup`. One company per data directory.
- The product's folder keeps its working name, `startup`, until it is named; nothing inside depends on the name.
- Commit messages carry no attribution lines. There is no remote; never push.
- Live tests run only with `VS_LIVE=1`, one at a time, on `VS_LIVE_MODEL` (default `claude-haiku-5-5`).

## Filip's decisions

Answered on 2026-11-09 ("Go, as recommended") for 1 to 5. Question 6 is asked at Task 15.

| # | Question | Answer | Used by |
|---|---|---|---|
| 1 | Caps shown in dollars or tokens | Dollars at list price, as the SDK estimates and enforces them, with the plan's own weekly percentage beside | Task 11, plan 2 |
| 2 | Model for each preset tier (Receipts rule D-182) | `models: { lead: claude-opus-5-5, member: claude-sonnet-5-5, routine: claude-haiku-5-5 }` by default; the Receipts company sets `member` to `claude-opus-5-5` | Task 13 |
| 3 | The product's name and final folder | `startup`, provisional | any time |
| 4 | Can Filip be assigned tasks | No; the "you" card on the Board artboard is illustrative | plan 2 |
| 5 | Task folder: a clone (prevention) or a linked worktree (detect and repair) | A clone (spike §6) | Task 8 |
| 6 | Receipts: CLAUDE.md, role mapping, first task, the one-Xcode-run lock | not asked yet | Task 15 |

## Review Focus

1. A session that keeps emitting events and never finishes: the lease cannot catch it. `maxTurns` and the task's remaining budget end it, and the result is a card, not a retry (Task 6 test `reports failed with the SDK's reason when the turn limit is hit`; Task 11 test `an over-budget run blocks the task with a cap card and uses no retry`).
2. The supervisor restarts with runs in flight: each is expired and resumed through the scheduler; a leftover process is killed only when pid and start time both match (Task 12 tests `expires every in-flight run on restart and queues a resume` and `does not kill a process that merely reuses the pid`).
3. Two tasks with the same title, and two runs of one task: tasks get distinct folders and branches; the runs of one task reuse its folder (Task 8 tests `gives two tasks with one title distinct folders and branches` and `reuses the folder for a second run of the same task`).
4. A decision answered twice, or answered after its task finished: the second answer is recorded and ignored (Task 5 test `ignores a second answer and an answer for a finished task`).
5. A task that needs a run and has none, because a send-back, an integration, a resume or a retry was lost: the tick's invariant raises a card (Task 5 test `raises an invariant card for a running task with no run, no request and no open child`).

---

### Task 1: Repository bootstrap and the subscription-login spike — DONE (commit `9b49beb`)

Built: the toolchain; `subscriptionEnv` (`src/runtime/env.ts`); `sanitise` and `leaks` (`src/runtime/sanitise.ts`); `mapMessage` and `startSession` (`src/runtime/sdk.ts`); the spike (`scripts/spike-login.ts`); four sanitised fixtures in `test/fixtures/sdk/`; 38 tests. The README's Runtime table lists the SDK's names.

**Interfaces produced** (every later task consumes these, never SDK types):
- `subscriptionEnv(parent): { env: Record<string, string>; removed: string[] }`.
- `RuntimeEvent`: `session_started{sessionId, model, loginSource, tools}` | `assistant_text{text}` | `tool_call{id, tool, input}` | `tool_result{id, ok}` | `usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, sessionCostUsd}` (one per turn, that turn's own spend) | `turn_finished{sessionId, ok, reason, turns, denials}` | `plan_usage{status, window, utilization, resetsAt}` | `api_error{error}` | `finished{sessionId, ok, reason?}`.
- `SessionInput = { cwd; prompt; systemPrompt; model; env; tools; allowedTools?; disallowedTools?; maxTurns; maxBudgetUsd?; resumeSessionId?; skills?; plugins?; additionalDirectories?; sandbox?; mcpServers?; decideTool(call: ToolCall): Promise<ToolDecision> }`, `ToolCall = { id; tool; input }`, `ToolDecision = { allow; reason? }`.
- `startSession(input, queryFn?): SessionHandle`, `SessionHandle = { events; send(text); end(); stop() }`, `RuntimeFactory = (input: SessionInput) => SessionHandle`.

### Task 2: The data directory, the model, the event catalogue and the single write path

**Files:**
- Create: `src/shared/types.ts`, `src/shared/events.ts`, `src/db/dataDir.ts`, `src/db/open.ts`, `src/db/schema.sql`, `src/db/apply.ts`
- Test: `test/shared/events.spec.ts`, `test/db/apply.spec.ts`

`src/shared/` holds what the web app imports too: no Node imports there.

**Interfaces:**
- Produces (`types.ts`), every row type, camelCase; the schema mirrors them one to one in snake_case (P12):
  - `TaskState`; `RunMode = 'brief'|'work'|'review'|'integrate'|'route'`; `RunOutcome = 'running'|'done'|'failed'|'expired'|'stopped'|'refused'|'over_budget'|'usage_limit'`; `Capability = 'read_files'|'run_commands'|'write_code'|'web_search'|'git_push'|'send_messages'`; `ModelTier = 'lead'|'member'|'routine'`.
  - `Company { id; name; rules; auth: 'subscription'|'api_key'; concurrency; dailyCapUsd; models: Record<ModelTier, string>; denyRead: string[]; chiefOfStaffId: string|null; paused: { reason: 'usage_limit'|'health'|'user'; until: string|null } | null }`.
  - `Repo { id; path; gates: Gate[] }`, `Gate { name; command; timeoutMinutes; lock: string|null }` (gates are named per repository; a lock name serialises gates across runs, P59, P85).
  - `Team { id; name; purpose; leadId: string|null; selfManaged; dailyCapUsd; repos: { repoId; baseBranch; mergeTarget: string|null }[]; mayPush; mayOpenPr; mayPublish; maySend; mayPay; mayDelete; leaseMinutes; maxReviewRounds; sandboxWrite: string[] }` (D2; `sandboxWrite` is the build profile of spike §6).
  - `Employee { id; teamId; name; role; skills: string[]; capabilities: Capability[]; model: string; memoryDir; chatSessionId: string|null; fired }` (who leads is `Team.leadId` alone, P20).
  - `Task { id; teamId; assigneeId: string|null; reviewerId: string|null; parentId: string|null; createdBy: string; title; brief; priority: 1|2|3; state: TaskState; blockedFrom: TaskState|null; doneCondition; repoId: string|null; gates: string[]; ownership: string[]; capUsd; retryAllowed; leaseMinutes: number|null; reviewRounds; folder: string|null; branch: string|null; mergedInto: string|null; createdAt; updatedAt; blockedAt: string|null }` (`createdBy` is `'user'` or an employee id; `ownership` entries are directory prefixes or exact files, P63).
  - `Run { id; taskId; employeeId; mode: RunMode; attempt; sessionId: string|null; pid: number|null; pidStartedAt: string|null; leaseUntil; startedAt; endedAt: string|null; lastEventAt; outcome: RunOutcome; reason: string|null; activity: string|null; summary: string|null; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costUsd; commit: string|null; diffLines: number|null; gateResults: GateResult[] }`, `GateResult { name; command; exitCode; output; durationMs }` (output capped at 8 KB).
  - `RunRequest { id; taskId; mode: RunMode; employeeId; reason: 'new'|'send_back'|'integrate'|'review'|'resume'|'retry'; resumeSessionId: string|null; firstTurn: string|null; attempt; leaseMinutes: number|null; createdAt }`.
  - `Decision { id; taskId: string|null; runId: string|null; employeeId: string|null; kind: DecisionKind; text; options: DecisionOption[]; costSoFarUsd; answer: { optionId; text?: string } | null; askedAt; answeredAt: string|null }`, `DecisionKind = 'lease'|'cap'|'tool'|'merge'|'question'|'briefing'|'review'|'ownership'|'staffing'|'invariant'|'health'|'usage_limit'`, `DecisionOption { id; label; effect: Effect; params?: Record<string, unknown> }`, `Effect` as in the table of Task 5.
  - `Message { id; fromId: string; toEmployeeId; taskId: string|null; text; state: 'waiting'|'delivered'; at; deliveredAt: string|null }`, `Grant { id; taskId; tool; inputHash; used }`, and `HealthReport` (its fields are in Task 12; the type lives here so the catalogue can name it).
- Produces (`events.ts`): `EngineEvent`, a zod discriminated union on `kind`, and `EVENT_VERSION = 1`. Every kind carries the full rows it changed, so a reader only upserts by id (P39, P74, P83):
  `company_changed{company}` | `repo_changed{repo}` | `team_changed{team}` | `employee_changed{employee}` | `task_changed{task, cause: 'created'|'state'|'edited'}` | `run_requested{request}` | `run_started{run}` | `run_activity{runId, employeeId, text}` | `run_event{runId, event: RuntimeEvent}` (tool inputs trimmed to 2 KB) | `gate_started{runId, taskId, name}` | `gate_finished{runId, taskId, result}` | `run_ended{run}` | `decision_raised{decision}` | `decision_answered{decision}` | `message_sent{message}` | `message_delivered{message}` | `health_changed{report: HealthReport}` | `plan_usage{status, window, utilization, resetsAt}`.
  `EventRow = { id: number; at: string; taskId: string|null; runId: string|null; employeeId: string|null; event: EngineEvent }`.
- Produces (`dataDir.ts`): `dataDir(): string` (`VS_DATA_DIR` or `~/.virtual-startup`, created with mode 0700) and `paths(dir): { db; token; folders; memory; mounts; skills; logs }`.
- As built: each state table stores a row as the JSON of its zod schema, with generated columns for searching, so the schema cannot drift from the types; `apply(db, (tx) => { tx.emit(event) })` is the write path, and one shared function, `changesOf` in `src/shared/project.ts`, turns an event into row changes for the database and for the web app's store alike.
- Produces (`open.ts`): `openDb(path): Db` (WAL on, `schema.sql` applied idempotently). Tables: `company` (one row), `repos`, `teams`, `employees`, `tasks`, `runs`, `run_requests`, `decisions`, `messages`, `grants`, `events(id INTEGER PRIMARY KEY, at, task_id, run_id, employee_id, team_id, kind, payload)`. Indexes: `events(task_id)`, `events(run_id)`, `events(kind, at)`, `tasks(state)`, `runs(task_id)`, `runs(outcome)`.
- Produces (`apply.ts`): `apply(db, change: (tx: Tx) => EngineEvent[]): EventRow[]`: runs `change` in one transaction, where `Tx` exposes `upsert(table, row)` and `remove(table, id)`, validates each returned event against the catalogue, appends it, and commits rows and events together. It is the only function that writes state (P74). `readEvents(db, sinceId, limit?, taskId?)`; `replay(db, events): void` upserts the rows events carry into an empty database.

- [ ] **Step 1: Install.** Run: `npm i better-sqlite3 && npm i -D @types/better-sqlite3`

- [ ] **Step 2: Write the failing tests**

```ts
it('accepts every event kind with a full row and rejects an unknown kind', …);            // events.spec
it('writes the row and its event together, with increasing ids and ISO times', …);
it('rolls the row back when the event fails validation', () => { expect(() => apply(db, tx => { tx.upsert('tasks', t); return [{ kind: 'nope' } as any]; })).toThrow(); expect(count(db, 'tasks')).toBe(0); });
it('reads events after an id, in order, optionally for one task', …);
it('replaying the log into an empty database reproduces every table', () => { replay(empty, readEvents(db, 0)); expect(dump(empty)).toEqual(dump(db)); });
it('opening twice applies the schema once', …);
```

- [ ] **Step 3: Run them:** `npx vitest run test/shared test/db` — expected: FAIL, modules not found.
- [ ] **Step 4: Implement** the five files. Booleans as 0/1, arrays and objects as JSON text.
- [ ] **Step 5: Run them again** — expected: PASS. Then `npm test && npm run typecheck`.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "model: types, event catalogue, schema, one write path"`

### Task 3: The store and the task state machine

**Files:**
- Create: `src/supervisor/taskState.ts`, `src/db/store.ts`
- Test: `test/supervisor/taskState.spec.ts`, `test/db/store.spec.ts`

**Interfaces:**
- Produces (`taskState.ts`): `transition(task: Pick<Task, 'state'|'blockedFrom'>, event: TaskEvent): { state: TaskState; blockedFrom: TaskState|null }`, pure, throwing `IllegalTransition` on any pair not in this table (P13, P61):

| Event | From | To |
|---|---|---|
| `start_brief` | queued | briefing |
| `start_work` | queued | running |
| `subtasks_created` | briefing | running |
| `reported_done` | briefing, running | review |
| `approved` | review | done |
| `sent_back` | review | running |
| `complete` | briefing, running, review | done |
| `block` | queued, briefing, running, review | blocked, with `blockedFrom` = from |
| `unblock` | blocked | `blockedFrom` |
| `fail` | queued, briefing, running, review, blocked | failed |

  A parent whose children are in flight is `running`. A lead that does a small task itself ends its brief run with `report_done`: `reported_done` when a reviewer exists, else `complete`.
- Produces (`store.ts`): typed reads only (`getTask`, `listTasks(where)`, `openRequests()`, `liveRuns()`, `runsOf(taskId)`, `openDecisions()`, `spentOn(taskId)`, `spendToday(now): { company: number; byTeam: Map<string, number> }`, `waitingMessages(employeeId)` …) and row builders with defaults (`newTask(input)`, `newRun(request, now, leaseMinutes)` …). Writes go through `apply`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(TABLE)('%s from %s gives %s', (event, from, to) => expect(transition({ state: from, blockedFrom: null }, event).state).toBe(to));
it('remembers where a task was blocked from and returns there', () => { const b = transition({ state: 'review', blockedFrom: null }, 'block'); expect(b).toEqual({ state: 'blocked', blockedFrom: 'review' }); expect(transition(b, 'unblock')).toEqual({ state: 'review', blockedFrom: null }); });
it('throws on every pair outside the table', () => { expect(() => transition({ state: 'done', blockedFrom: null }, 'start_work')).toThrow(IllegalTransition); });
it('lists tasks by priority, then age', …);
it('sums a task\'s spend over all its runs', …);
it('sums today only, per team and for the company', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/supervisor/taskState.spec.ts test/db/store.spec.ts` — expected: FAIL.
- [ ] **Step 3: Implement.** The table is data; `transition` looks it up.
- [ ] **Step 4: Run** — expected: PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "model: store reads and the complete task state table"`

### Task 4: Run requests and the scheduler

**Files:**
- Create: `src/supervisor/scheduler.ts`, `src/supervisor/reviewer.ts`
- Test: `test/supervisor/scheduler.spec.ts`

**Interfaces:**
- Produces: `requestFor(task: Task, team: Team): Pick<RunRequest, 'mode'|'employeeId'> | { problem: 'no_lead'|'no_assignee'|'fired' }`: an unassigned task on a led team is briefed by the lead; an assigned task is worked by its assignee; an unassigned task on a self-managed team is `no_assignee` (refused at creation, P30).
- Produces: `reviewerFor(task: Task, parent: Task|null, team: Team, authorId: string): string|null`: `task.reviewerId` if set; else the team's lead when the task has a parent; never the author; else null, and the gates alone decide (P27).
- Produces: `pickNext(input: { requests: RunRequest[]; tasks: Map<string, Task>; teams: Map<string, Team>; employees: Map<string, Employee>; company: Company; runningEmployeeIds: Set<string>; runningCount: number; spend: { company: number; byTeam: Map<string, number> }; blockedRepoIds: Set<string> }): { request: RunRequest } | { problem: 'fired'|'no_lead'; request: RunRequest } | null`. Rules, in order: nothing while `company.paused`; nothing at concurrency; nothing when company spend has reached the company cap (P25); skip a team at its daily cap; skip a busy employee; skip a task whose repository is blocked by health; a request whose employee is fired or missing is returned as a problem (P26); then priority 1 before 2 before 3, the older task first, the older request first.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns null while the company is paused', …);  it('returns null at concurrency', …);
it('returns null when the company has spent its daily cap', …);  it('skips a team over its daily cap and picks another team', …);
it('never picks an employee who is already running', …);  it('skips a task whose repository health has blocked', …);
it('reports a request for a fired employee as a problem instead of skipping it', …);
it('orders by priority, then task age, then request age', …);
it('briefs with the lead, works with the assignee, refuses an unassigned task on a self-managed team', …);
it('the reviewer is the lead, never the author, and null when the lead is the author', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/supervisor/scheduler.spec.ts` — expected: FAIL.
- [ ] **Step 3: Implement.** Pure functions.
- [ ] **Step 4: Run** — expected: PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "supervisor: run requests and the scheduler"`

### Task 5: The supervisor loop: workers, leases, decisions, messages, the invariant

**Files:**
- Create: `src/worker/protocol.ts`, `src/supervisor/lease.ts`, `src/supervisor/decisions.ts`, `src/supervisor/supervisor.ts`, `test/fixtures/scriptedWorker.ts`
- Test: `test/supervisor/lease.spec.ts`, `test/supervisor/decisions.spec.ts`, `test/supervisor/supervisor.spec.ts`, `test/fixtures/scripts/*.json`

**Interfaces:**
- Produces (`protocol.ts`), zod-validated on both sides (P32):
  - worker to supervisor: `{ t: 'event'; event: RuntimeEvent }` | `{ t: 'decide'; askId; call: ToolCall }` | `{ t: 'tool'; askId; name: EngineTool; input: unknown }` | `{ t: 'exit'; outcome: 'done'|'failed'|'stopped'; reason: string|null; sessionId: string|null; summary: string|null }`.
  - supervisor to worker: `{ t: 'start'; job: WorkerJob }` | `{ t: 'decision'; askId; allow; reason?: string; stop?: boolean }` | `{ t: 'tool_result'; askId; ok; text }` | `{ t: 'message'; text }` | `{ t: 'stop' }`.
  - `EngineTool = 'propose_subtasks'|'report_done'|'submit_review'|'request_decision'|'set_status'|'run_gate'|'create_task'`.
  - `WorkerJob = { runId; mode: RunMode; cwd; systemPrompt; firstTurn; model; env: Record<string, string>; tools: string[]; engineTools: EngineTool[]; skills: string[]; plugins: string[]; additionalDirectories: string[]; sandbox: unknown; maxTurns; maxBudgetUsd?: number; resumeSessionId?: string; runtimeModule?: string }`. `runtimeModule` is the one test seam: the absolute path of a module exporting `startSession: RuntimeFactory`; absent means the SDK (P48).
- Produces (`lease.ts`): `leaseUntil(now, minutes): string`; `isExpired(leaseUntil, now): boolean`; `leaseMinutesFor(request, task, team): number` (request override, else task, else team); `onFailure(run: Run, task: Task): 'retry'|'card'` (`retry` when `task.retryAllowed` and `run.attempt === 1`; a retry request carries `attempt: 2`, P31).
- Produces (`decisions.ts`): `raise(tx, input): { decision: Decision; events: EngineEvent[] }` (blocks the task with `block` when it has one; one open card per task and kind); `answer(db, decisionId, answer: { optionId; text? }): 'applied'|'ignored'` (`ignored` when already answered or the task is done or failed; both are recorded as `decision_answered`); `optionsFor(kind, context): DecisionOption[]`; and the effects, applied inside `answer` as rows and requests only, never by spawning (P71, P72, D6):

| Card | Option | Effect |
|---|---|---|
| `lease` | Retry, N min (N = twice the lease) | `retry`: unblock, request `retry` with `leaseMinutes: N` |
| `cap` | Raise by $X (X = the cap) | `raise_cap`: `capUsd += X`, unblock, request `resume` |
| `tool` | Allow once | `allow_once`: store a `Grant`, unblock, request `resume` telling the session it may repeat the call |
| `tool` | Keep refused | `keep_refused`: unblock, request `resume` telling the session the call stays refused |
| `merge` | Merge | `merge`: the engine merges (Task 9), then `complete` |
| `merge` | Keep the branch | `complete` without merging |
| `question` | each option the employee gave, or free text | `resume_with_answer`: unblock, request `resume` with the answer as the first turn |
| `briefing`, `review`, `ownership` | Send back (with text) | `send_back`: unblock, request `send_back` |
| `review`, `ownership` | Accept as it is | `accept`: `approved` or continue the flow |
| `staffing`, `invariant`, `health` | Check again | `recheck`: unblock; the next tick decides |
| `usage_limit` | Resume now | `resume_company`: clear `company.paused` |
| every task card | Stop it | `stop_task`: `fail` |

  "Open diff", "Read it first" and "Not now" on the artboards are the screen's own actions and never reach the engine.
- Produces (`supervisor.ts`): `class Supervisor { constructor(opts: { db: Db; dataDir: string; workerEntry: string; now?: () => Date; tickMs?: number; runtimeModule?: string }); start(): void; stop(): Promise<void>; tick(): Promise<void>; send(to: { employeeId: string } | { taskId: string }, text: string, fromId: string): Message; stopRun(runId: string): void; createTask(input): Task; answer(decisionId, answer): 'applied'|'ignored' }`. `tick` is the loop body and tests call it directly: reap exits, expire leases, check the invariant, then `pickNext` until it returns null.
  - Spawning: `fork(workerEntry, { execArgv: ['--import', 'tsx'], detached: true, serialization: 'advanced' })`, so the worker leads its own process group; killing is `process.kill(-pid, 'SIGKILL')` (P35, P36). `pid` and its start time (`ps -o lstart= -p`) go on the run row.
  - Every message from a worker renews the lease and sets `lastEventAt`. `event` is appended as `run_event`; a `usage` event adds to the run's tokens and cost.
  - A worker that exits without `exit` is a crash: outcome `failed`, reason `crashed`, then `onFailure` (P38).
  - `send`: stores a `Message`; when the employee has a live run it is forwarded as `{ t: 'message' }` and marked delivered; otherwise it waits and becomes the first turn of that employee's next run (P37).
  - The invariant, each tick: a task in `briefing`, `running` or `review` has a live run, an open request, a gate in flight, or (in `running`) a child that is not done or failed. Otherwise an `invariant` card (P60).
- Produces (`scriptedWorker.ts`): a test child that speaks the protocol from a JSON script named in `VS_SCRIPT`: steps `{ send: <message>, afterMs }`, `{ hang: true }`, `{ crash: true }`.

- [ ] **Step 1: Write the failing lease and decision tests**

```ts
it('is not expired before leaseUntil and is after', …);
it('retries a first attempt of a retryable task and cards a second', …);
it('takes the lease from the request, then the task, then the team', …);
it('raising a card blocks the task and remembers its state', …);
it('raises one open card per task and kind', …);
it('Retry on a lease card unblocks the task and queues a retry with the longer lease', () => { … expect(request).toMatchObject({ reason: 'retry', leaseMinutes: 30 }); });
it('Stop it fails the task from blocked', …);
it('ignores a second answer and an answer for a finished task', …);                       // Review Focus 4
```

- [ ] **Step 2: Run:** `npx vitest run test/supervisor/lease.spec.ts test/supervisor/decisions.spec.ts` — FAIL. **Step 3: Implement** `lease.ts`, `decisions.ts`. **Step 4: Run** — PASS.

- [ ] **Step 5: Write the failing supervisor tests** (scripted worker, `now` injected and advanced by the test)

```ts
it('starts a worker for a request, deletes the request and records run_started', …);
it('renews the lease on every message from the worker', …);
it('kills the process group of a silent worker, marks the run expired and queues one retry', () => { … expect(runs.map(r => r.outcome)).toEqual(['expired']); expect(openRequests(db)[0]).toMatchObject({ reason: 'retry', attempt: 2 }); });
it('raises a lease card after the retry also expires, and blocks the task', …);
it('treats a worker that exits without reporting as a failed run', …);
it('respects concurrency across ticks', …);
it('delivers a message to a running employee and holds one for an idle employee until the next run', …);
it('raises a staffing card for a request whose employee was fired', …);
it('raises an invariant card for a running task with no run, no request and no open child', …);   // Review Focus 5
it('stopRun ends the run as stopped and uses no retry', …);
```

- [ ] **Step 6: Run:** `npx vitest run test/supervisor/supervisor.spec.ts` — FAIL. **Step 7: Implement** `protocol.ts`, `supervisor.ts`, `scriptedWorker.ts`. Run exits are handed to `onRunExit(run, exit)`, which in this task only closes the run and applies `complete` or `onFailure`; Task 9 replaces its body with the flow. **Step 8: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 9: Commit:** `git add -A && git commit -m "supervisor: workers, leases, decision cards, messages, the invariant"`

### Task 6: The worker, the engine tools, the definition, memory and the blast radius

**Files:**
- Create: `src/worker/worker.ts`, `src/runtime/tools.ts`, `src/supervisor/definition.ts`, `src/supervisor/memory.ts`, `src/supervisor/blastRadius.ts`, `test/fixtures/fakeRuntime.ts`
- Modify: `src/supervisor/supervisor.ts` (build the `WorkerJob` from `definition`, `memory` and `sessionShape`; answer `decide` with `judgeToolCall`)
- Test: `test/worker/worker.spec.ts`, `test/runtime/tools.spec.ts`, `test/supervisor/definition.spec.ts`, `test/supervisor/memory.spec.ts`, `test/supervisor/blastRadius.spec.ts`

**Interfaces:**
- Produces (`blastRadius.ts`): `CAPABILITIES: Record<Capability, { label: string; tools: string[] }>` (`read_files` → Read, Glob, Grep; `run_commands` → Bash; `write_code` → Write, Edit; `web_search` → WebSearch, WebFetch; `git_push` and `send_messages` → no tool, D1); `availableCapabilities(team): Capability[]` (`git_push` needs `team.mayPush`; `send_messages` is never available in this version); `sessionShape(team, employee, task, mode, company): { tools: string[]; sandbox: SessionInput['sandbox']; additionalDirectories: string[] }` (review and route modes drop `write_code` and `run_commands`; `Skill` joins when the employee has skills; the sandbox is `{ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: team.sandboxWrite, denyRead: company.denyRead } }`); `judgeToolCall(ctx: { task; team; employee; mode; folder; company; grants: Grant[] }, call: ToolCall): ToolDecision & { stop?: boolean; card?: string }` (the supervisor's answer to the session's `decideTool`):
  - `mcp__engine__*` → allow.
  - Write, Edit → allow inside the folder and inside the task's ownership; anything else is refused with `stop` and a card, unless a matching grant exists (then the grant is used up).
  - Read, Glob, Grep → refused, without a card, when the path matches `company.denyRead`.
  - Bash → allow for `run_commands`; the sandbox confines it. No decision rests on the text of a command (P69).
  - any other tool → refused with `stop` and a card.
  - Default `denyRead`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.claude`, and every `.env` file found under a registered repository at run start.
  - In the supervisor: a refusal with a card ends the run as `refused` and raises a `tool` card (P72).
- Produces (`tools.ts`): `engineToolServer(names: EngineTool[], call: (name: EngineTool, input: unknown) => Promise<{ ok: boolean; text: string }>): SessionInput['mcpServers']`: an in-process SDK server named `engine` built with `createSdkMcpServer` and `tool()`, `alwaysLoad: true`, so the model sees `mcp__engine__<name>` (P44, P62). Input shapes, in zod, exported as `TOOL_INPUT`:
  - `propose_subtasks { subtasks: { title; assigneeId; brief; ownership: string[]; doneCondition; gates: string[]; priority: 1|2|3; capUsd; retryAllowed }[] }`
  - `report_done { summary }`; `submit_review { verdict: 'approve'|'send_back'|'escalate'; notes }`; `request_decision { question; options: string[] }`; `set_status { text }` (at most 60 characters, D10); `run_gate { name }`; `create_task { teamId; assigneeId?; title; brief; priority; doneCondition; capUsd }`.
- Produces (`worker.ts`), the child entry. On `start`: build the tool server over IPC (`tool` / `tool_result`), call the runtime factory with `decideTool` answered over IPC (`decide` / `decision`, default deny after 60 s), forward every `RuntimeEvent`. On `message`: `handle.send`. On `stop`: `handle.stop()`, exit `stopped`. A decision with `stop: true` stops the session at once (a refused action stops with a card, P72). After a `turn_finished`: if a closing tool was called (`propose_subtasks`, `report_done`, `submit_review`, `request_decision`) or the mode is `route`, `handle.end()`; otherwise send one reminder to call the closing tool, and after a second turn without it exit `failed`, reason `no_report`. On `finished`: send `exit` (`failed` with the SDK's reason when not ok) and exit 0. It exits on IPC `disconnect` (P50).
- Produces (`definition.ts`): `buildSystemPrompt(input: { company; team; employee; teammates: Employee[]; memoryIndex: string }): string`: identity only, in this order: the company's rules; the team's purpose; each limit spelled out ("You may not …"; "The engine commits and merges your work; you never run git commit, merge or push"); the role sentence; the skills by name; the memory index verbatim; how each engine tool is used. `buildFirstTurn(input: { task; mode: RunMode; material?: { summary?; diffStat?; patch?; gateResults?; notes?; mergeState?; messages?: Message[] } }): string`: the brief, the done-condition, the gate names, the ownership, then the mode's instruction (P41, P47).
- Produces (`memory.ts`): `readIndex(dir, capBytes = 8192): string` (creates `index.md`; cuts on a UTF-8 boundary and ends with `… (index capped at <cap> bytes)`); `remember(dir, summary, now): void` (a dated file under `notes/`, one dated line appended to `index.md`, oldest lines dropped past the cap, P46).
- Produces (`fakeRuntime.ts`): `startSession` that plays a script from `VS_FAKE_SCRIPT`: events to emit, engine-tool calls to make, tool calls to put to `decideTool`, and what to do after each `send`.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers exactly the named tools and returns the supervisor\'s answer to the model', …);      // tools.spec
it('rejects a propose_subtasks input that breaks the schema before it reaches the supervisor', …);
it('spells out every limit of the team and that the engine owns git', () => { expect(p).toContain('You may not merge'); expect(p).toContain('never run git commit'); });
it('includes the memory index verbatim and the role sentence', …);
it('puts the brief, done-condition, gates and ownership in the first turn, not the system prompt', …);
it('the review turn carries the summary, the diff stat and the gate results', …);
it('creates an empty index, caps it on a character boundary, and names the cap in the marker', …);
it('remember adds a dated note and a line to the index', …);
it('forwards runtime events and exits done after report_done', …);                              // worker.spec, fake runtime
it('feeds a message as the next user turn', () => { … expect(turns).toEqual(['<first turn>', 'Filip: stop at the test step']); });
it('asks the supervisor about every tool call and denies when no answer comes', …);
it('stops the session when a decision says stop', …);
it('reminds once, then exits failed with no_report', …);
it('reports failed with the SDK\'s reason when the turn limit is hit', () => { … expect(exit).toMatchObject({ outcome: 'failed', reason: 'error_max_turns' }); });   // Review Focus 1
it('resumes with resumeSessionId when the job carries one', …);
it('exits when the supervisor\'s channel closes', …);
it('maps capabilities to tools and drops write and command tools in review mode', …);          // blastRadius.spec
it('offers git_push only on a team that may push, and never send_messages', …);
it('refuses a write outside the folder with a card, and outside the ownership with a card', …);
it('refuses reading a denied path without stopping the run', …);
it('uses a grant once', …);  it('allows the engine\'s own tools always', …);
it('a refused tool call ends the run as refused with a tool card, and Allow once lets the resumed session repeat it', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/worker test/runtime/tools.spec.ts test/supervisor/definition.spec.ts test/supervisor/memory.spec.ts test/supervisor/blastRadius.spec.ts` — FAIL.
- [ ] **Step 3: Implement.** `maxTurns` by mode: brief 40, review 40, route 20, work and integrate 150. The job's `env` gains `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` at lease minus 2 minutes (P34). Folders for tasks with no repository are plain directories, `<dataDir>/folders/<taskId>`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "worker: session host, engine tools, definition, memory, blast radius"`

### Task 7: Live: one real task end to end

**Files:**
- Create: `test/e2e/one-task.spec.ts` (skipped unless `VS_LIVE=1`; `testTimeout: 180_000`)

- [ ] **Step 1: Write the live test**

```ts
it.skipIf(!process.env.VS_LIVE)('runs one task with the real SDK on the login', async () => {
  // temp data dir; a self-managed team; one employee with read_files and write_code; a task with no repository:
  // "Create HELLO.md containing the word hello, then call report_done."
  expect(run.outcome).toBe('done');
  expect(fs.readFileSync(path.join(task.folder!, 'HELLO.md'), 'utf8')).toContain('hello');
  expect(run.inputTokens + run.cacheWriteTokens).toBeGreaterThan(0);  expect(run.costUsd).toBeGreaterThan(0);
  expect(started.loginSource).toBe('none');                            // the claude.ai login, spike §1
  expect(started.tools).toContain('mcp__engine__report_done');
  expect(started.tools.some(t => t.startsWith('mcp__') && !t.startsWith('mcp__engine__'))).toBe(false);   // no connectors, spike §3
  expect(claudeProcessesIn(task.folder!)).toEqual([]);                 // nothing left running after the run
});
it.skipIf(!process.env.VS_LIVE)('refuses a write outside the task folder and raises a card', async () => {
  // the same employee; a task: "Write the word x to <temp>/outside.txt."
  expect(run.outcome).toBe('refused');  expect(fs.existsSync(outside)).toBe(false);  expect(openDecisions(db)[0].kind).toBe('tool');
});
```

- [ ] **Step 2: Tell Filip one live run is starting, then run:** `VS_LIVE=1 npx vitest run test/e2e/one-task.spec.ts` — expected: PASS within 3 minutes. If it fails, fix the engine, not the test. Record in the README's Runtime table whether the Bash timeout variables took effect.
- [ ] **Step 3: Commit:** `git add -A && git commit -m "e2e: one real task on the login"`

### Task 8: Git belongs to the engine: task folders, commits, gates, ownership

**Ask Filip question 5 before this task.** Written for a clone. If he chooses a linked worktree: `createFolder` runs `git worktree add`, `publish` is a no-op, and a before-and-after snapshot of `git for-each-ref` joins `afterWorkRun` with a `refs` card; note that the snapshot cannot tell an employee's change from Filip's own commit made during the run.

**Files:**
- Create: `src/git/git.ts`, `src/git/folder.ts`, `src/git/commit.ts`, `src/git/gates.ts`, `src/git/ownership.ts`
- Modify: `src/supervisor/supervisor.ts`
- Test: `test/git/folder.spec.ts`, `test/git/commit.spec.ts`, `test/git/gates.spec.ts`, `test/git/ownership.spec.ts`, `test/supervisor/afterWorkRun.spec.ts`

**Interfaces:**
- Produces (`git.ts`): `git(cwd: string, args: string[]): Promise<{ code: number; out: string }>`, with a fixed environment and no prompts.
- Produces (`folder.ts`): `branchName(task): string` = `task/<slug(title)>-<taskId6>`; `createFolder(input: { repoPath; dir; branch; startPoint }): Promise<void>` (`git clone --shared --no-checkout`, then `git checkout -b <branch> <startPoint>`; refuses an existing `dir`); `publish(repoPath, dir, branch): Promise<void>` (`git fetch <dir> +<branch>:<branch>` in the user's repository, so the branch outlives the folder; refused with a card when that branch is checked out there); `removeFolder(dir): Promise<void>` (the folder only; the branch stays until merged or discarded on a card, P57). The start point is `origin/<team base branch>` for a top-level task and `origin/<parent branch>` for a child. Folders live in `<dataDir>/folders/<taskId>` (P55).
- Produces (`commit.ts`): `commitAll(dir, author: { name; email }, message): Promise<string|null>` (`git add -A` then commit; null when nothing changed, P58); `diffStat(dir, base): Promise<{ files: number; lines: number; text: string }>`; `patch(dir, base, capBytes): Promise<string>`; `changedFiles(dir, base): Promise<string[]>`.
- Produces (`gates.ts`): `runGate(gate: Gate, cwd: string, signal: AbortSignal): Promise<GateResult>` (`bash -lc`, the gate's timeout, output capped at 8 KB); `class GateQueue { run(gates: Gate[], cwd): Promise<GateResult[]> }` running one gate at a time per lock name and stopping at the first failure (P45, P59).
- Produces (`ownership.ts`): `overlaps(a: string[], b: string[]): boolean` (true when an entry of one is a path-segment prefix of an entry of the other); `outside(files: string[], ownership: string[]): string[]` (empty ownership owns everything, P63).
- Produces (supervisor): `afterWorkRun(run, task)`: commit, publish, check ownership (`ownership` card naming the files), run the task's gates through the queue with `gate_started` and `gate_finished` events, store the results and the diff's line count on the run. A failed gate queues a `send_back` to the same employee with the gate's output as the first turn and counts a review round. Then the flow continues (Task 9). The `run_gate` engine tool is the same `runGate` call.

- [ ] **Step 1: Write the failing tests** (temp repositories)

```ts
it('gives two tasks with one title distinct folders and branches', …);                       // Review Focus 3
it('reuses the folder for a second run of the same task', …);                                // Review Focus 3
it('starts a child from its parent\'s published branch', …);
it('a commit in the folder does not move any ref of the user\'s repository until publish', …);
it('publish creates the task branch in the user\'s repository and leaves its checkout alone', …);
it('removing the folder keeps the published branch', …);
it('commits everything with the employee as author and returns null when nothing changed', …);
it('runs gates in order, stops at the first failure and keeps the real exit code and output', …);
it('runs two gates that share a lock one after the other', …);
it('ends a gate at its timeout with a non-zero result', …);
it('treats src/api and src/api/routes.ts as overlapping, and src/api and src/apiary as separate', …);
it('lists the changed files outside a task\'s ownership', …);
it('a failed gate sends the work back with the output and counts a review round', …);       // afterWorkRun
it('a file changed outside the ownership raises an ownership card', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/git test/supervisor/afterWorkRun.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "git: task folders, engine commits, named gates, ownership"`

### Task 9: The led-team flow: briefing, review, send-back, integration, merge

**Files:**
- Create: `src/supervisor/briefing.ts`, `src/supervisor/flow.ts`, `src/git/merge.ts`
- Modify: `src/supervisor/supervisor.ts` (`onRunExit` and engine-tool calls go to `flow`)
- Test: `test/supervisor/briefing.spec.ts`, `test/supervisor/flow.spec.ts`, `test/git/merge.spec.ts`

**Interfaces:**
- Produces (`briefing.ts`): `validateProposal(parent: Task, team: Team, employees: Employee[], repo: Repo|null, subtasks: SubtaskProposal[]): { ok: true } | { ok: false; reasons: string[] }` with reasons `empty`, `too_many` (more than 8), `overlap`, `unknown_assignee`, `assignee_not_in_team`, `assignee_fired`, `missing_done_condition`, `unknown_gate`, `caps_exceed_parent` (the children's caps exceed what the parent has left), `parent_is_a_child` (children are worked, never briefed; work for another team goes through the chief of staff's `create_task`, P65, P66). The reasons go back to the model as the tool's answer; after a second refusal in one run the engine ends the run and raises a `briefing` card.
- Produces (`merge.ts`): `mergeInto(dir, otherBranch): Promise<{ ok: true; commit: string } | { ok: false; conflicts: string[] }>` (`git fetch origin <other>` then `git merge --no-ff`; a conflict is left in the folder for the integrate run); `landOn(repoPath, dir, branch, target): Promise<'landed'|'target_moved'|'checkout_dirty'>`: the task branch must already contain `target` (the engine merges `origin/<target>` into it first and re-runs the gates); then, when `target` is checked out in a worktree of the user's repository, `git merge --ff-only` there if that checkout is clean, and otherwise `git fetch <dir> <branch>:<target>`. Never an update under a checked-out branch (P67).
- Produces (`flow.ts`), each function one `apply`:
  - `onProposal(run, subtasks)`: valid → create the children (`createdBy` = the lead, `repoId` and remaining defaults from the parent), `subtasks_created`, a `new` request each.
  - `onWorkDone(run)` (after `afterWorkRun` passed): reviewer exists → `reported_done` and a `review` request for the reviewer in the task's folder with read-only tools; none → `complete`, then `onTaskDone`.
  - `onReview(run, verdict, notes)`: `approve` → `approved`, `onTaskDone`; `send_back` → `sent_back`, `reviewRounds + 1`, a `send_back` request resuming the author's session with the notes; past `team.maxReviewRounds` → a `review` card (P64); `escalate` → a `review` card.
  - `onTaskDone(task)`: remove a child's folder; when every child of its parent is done, queue `integrate` for the lead on the parent. A failed child raises a `question` card on the parent.
  - `beforeIntegrate(parent)`: the engine merges each child branch into the parent's branch in creation order and stops at the first conflict; the first turn tells the lead which merged and which files conflict.
  - `onIntegrated(run)`: `afterWorkRun` on the parent, then: the team's `mergeTarget` for this repository is set → `landOn`, set `mergedInto`, `complete`; not set, or `landOn` did not land → a `merge` card naming the target, the gate results and the diff size.
  - `onQuestion(run, question, options)`: end the run as `stopped`, raise a `question` card.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts a valid proposal', …);  it('refuses overlapping ownership between siblings', () => expect(v.reasons).toContain('overlap'));
it('refuses an assignee from another team, a fired one, an unknown gate and caps beyond the parent\'s', …);
it('refuses a proposal on a task that is itself a child', …);
it('merges a branch and reports the conflicting files when it cannot', …);                   // merge.spec
it('lands on a target nobody has checked out, and fast-forwards a clean checkout', …);
it('does not land on a dirty checkout', () => expect(await landOn(…)).toBe('checkout_dirty'));
it('creates children from a valid proposal, moves the parent to running and queues each child', …);   // flow.spec, scripted worker
it('raises a briefing card after two refused proposals in one run', …);
it('a lead that reports done from a brief run completes the task without review', …);
it('sends finished work to the lead for review, and straight to done on a self-managed team', …);
it('send_back resumes the author\'s session with the notes and counts a round', …);
it('raises a review card after the third round', …);
it('queues integrate for the lead when the last child is approved', …);
it('lands on the team\'s merge target after integration, and raises a merge card when there is none', …);
it('a question from an employee stops the run and becomes a card whose answer resumes the session', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/supervisor/briefing.spec.ts test/supervisor/flow.spec.ts test/git/merge.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "flow: briefing, review rounds, integration, merge within limits"`

### Task 10: Live: the led-team smoke test

**Files:**
- Create: `scripts/smoke-led-team.ts`

- [ ] **Step 1: Write the script.** A temp data directory and a temp repository with branches `main` and `team`, gates `greeting` (`test -f GREETING.md`) and `farewell` (`test -f FAREWELL.md`). One led team (base and merge target `team`) with a lead and two engineers. One task: "Add GREETING.md and FAREWELL.md, one file each, to two engineers." It runs the supervisor until the parent is done or 15 minutes pass, then prints each run (mode, employee, outcome, cost) and exits 0 only if: the parent and both children are `done`; both files are on `team`; `main` has not moved; every folder of a done child is gone; no card is open.
- [ ] **Step 2: Tell Filip this run takes about ten model sessions, then run:** `npx tsx scripts/smoke-led-team.ts` — expected: exit 0 within 15 minutes. Fix what it finds before going on.
- [ ] **Step 3: Commit:** `git add -A && git commit -m "smoke: a led team briefs, works, reviews and merges, live"`

### Task 11: Budgets and the usage limit

**Ask Filip question 1 before this task.**

**Files:**
- Create: `src/supervisor/budget.ts`, `src/shared/prices.ts`
- Modify: `src/supervisor/supervisor.ts`
- Test: `test/supervisor/budget.spec.ts`, `test/supervisor/limits.spec.ts`

**Interfaces:**
- Produces (`prices.ts`): `PRICES: Record<string, { input; output; cacheRead; cacheWrite }>` in dollars per million tokens, for the models in `Company.models`, used only when the SDK reports no cost.
- Produces (`budget.ts`): `costOf(usage, model): number` (the SDK's figure when above zero, else tokens times `PRICES`); `remaining(task, spent): number`; `budgetFor(task, spent): number | 'exhausted'` (the run's `maxBudgetUsd`; `exhausted` below one cent, P70); `isUsageLimit(event: RuntimeEvent): { until: string|null } | null` (a `plan_usage` with status `rejected`, or an `api_error` of `rate_limit`, P76).
  - The supervisor: a request for an exhausted task raises a `cap` card instead of starting; a run that ends with `error_max_budget_usd` is `over_budget`, blocks the task with a `cap` card and uses no retry; a usage-limit event ends every live run as `usage_limit`, sets `company.paused = { reason: 'usage_limit', until }`, raises one card, queues a `resume` for each ended run, and clears itself at `until`.
- [ ] **Step 1: Write the failing tests**

```ts
it('uses the SDK\'s cost when present and the price table when it is zero', …);
it('gives a run what the task has left, and exhausted when under a cent', …);
it('recognises a rejected plan window and an API rate limit, and nothing else', …);
it('raises a cap card instead of starting a run for an exhausted task', …);                          // limits.spec
it('an over-budget run blocks the task with a cap card and uses no retry', …);                       // Review Focus 1
it('Raise by doubles the cap and resumes the session', …);
it('the usage limit pauses the company, raises one card for three live runs, and uses no retry', …);
it('resumes by itself when the limit\'s reset time passes', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/supervisor/budget.spec.ts test/supervisor/limits.spec.ts` — FAIL. **Step 3: Implement** and wire. **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "limits: budgets and the usage limit"`

### Task 12: Machine health and restart recovery

**Files:**
- Create: `src/supervisor/health.ts`, `src/supervisor/recover.ts`
- Modify: `src/supervisor/supervisor.ts` (health every 60 s; `recover` on start)
- Test: `test/supervisor/health.spec.ts`, `test/supervisor/recover.spec.ts`

**Interfaces:**
- Produces (`health.ts`): `checkHealth(input: { repos: Repo[]; minFreeGb: number; auth: Company['auth']; services: Service[]; probe?: Probes }): Promise<HealthReport>`, `Service = { name; kind: 'http'|'tcp'|'cmd'; target: string }`, `HealthReport = { at; diskFreeGb; login: 'ok'|'missing'|'wrong_method'|'expiring'; repos: { repoId; ok; problem: string|null }[]; services: { name; ok }[]; failures: { key; scope: 'company'|{ repoId }; text }[] }`. Disk through `statfs`, default floor 5 GB. Login through `claude auth status` with the bundled binary and the session environment: exit 0 and, in subscription mode, `authMethod === 'claude.ai'`; `expiring` when `loginExpiresAt` is under 24 hours away (P75, spike §1). A repository fails when its path is missing, is not a repository, has a merge or rebase in progress or a stale `index.lock`; a dirty checkout is not a failure (P77). Disk and login failures pause the company (`reason: 'health'`); a repository failure blocks that repository. One `health` card per failure key while it lasts, closed by the engine when the check passes again.
- Produces (`recover.ts`): `recover(db, now, processes: { startedAt(pid): string|null; killGroup(pid): void }): { expired: string[]; killed: number[] }`: for every run still `running`: kill its group only when the pid is alive and its start time equals `pidStartedAt`; mark the run `expired`, reason `restart`; queue a `resume` with the stored session id and the same attempt (P73).

- [ ] **Step 1: Write the failing tests**

```ts
it('reports low disk as a company-wide failure', …);  it('reports a login that is missing or not claude.ai', …);
it('warns when the login expires within a day', …);
it('does not fail a repository for a dirty checkout, and fails one mid-merge', …);
it('checks http, tcp and command services', …);
it('raises one card per failure and closes it when the check passes', …);
it('expires every in-flight run on restart and queues a resume', …);                        // Review Focus 2
it('does not kill a process that merely reuses the pid', …);                                // Review Focus 2
it('kills the leftover group when pid and start time both match', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/supervisor/health.spec.ts test/supervisor/recover.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "supervisor: machine health and restart recovery"`

### Task 13: Hiring: presets, skills, and the chief of staff

**Ask Filip question 2 before this task.**

**Files:**
- Create: `src/presets/presets.ts`, `src/runtime/skills.ts`, `src/supervisor/hiring.ts`, `src/supervisor/chat.ts`
- Test: `test/presets/presets.spec.ts`, `test/runtime/skills.spec.ts`, `test/supervisor/hiring.spec.ts`, `test/supervisor/chat.spec.ts`

**Interfaces:**
- Produces (`presets.ts`): `PRESETS: Record<'chief_of_staff'|'engineering_lead'|'engineer'|'reviewer'|'marketing_writer'|'analyst', { label; role: string; capabilities: Capability[]; skills: string[]; tier: ModelTier; lead: boolean }>` (P84). The model comes from `company.models[tier]`.
- Produces (`skills.ts`): `listSkills(dirs: { userSkills; pluginCache; companySkills }): SkillRef[]`, `SkillRef = { id; label; description; source: 'bundled'|'user'|'plugin'|'company'; path: string|null }` (the description is the one in the skill's `SKILL.md`), ids `dataviz`, `user:postgresql`, `apple-skills:swiftui`, `company:privacy-rules`; `mountSkills(refs: SkillRef[], mountDir: string): { plugins: string[]; skills: string[] }`: rebuilds `<mountDir>/user` and `<mountDir>/company` as local plugins named `user` and `company` holding symlinks to the chosen skill folders, adds the cache folder of each chosen plugin, and returns the `plugins` and `skills` values for the session (spike §5, D4).
- Produces (`hiring.ts`): `hire(db, input: { name; teamId; role; model; lead: boolean; skills: string[]; capabilities: Capability[] } | { preset; name; teamId }): Employee` (every skill id must resolve; capabilities must be available to the team; hiring a lead sets `Team.leadId` and refuses a second lead); `fire(db, id)` (archives the memory folder; a fired lead leaves `leadId` null, which the scheduler reports); `edit(db, id, patch)` (takes effect at the next run).
- Produces (`chat.ts`): `chat(supervisor, text): Message`: stores the message and queues a `route` run for the chief of staff, resuming `employee.chatSessionId`. The route run has `read_files` and `create_task` only; its last assistant text becomes a `message_sent` from the chief of staff naming the tasks it created, and each `create_task` sets the run's activity to "writing N tasks from your chat" (P79, D14). `messageEmployee(supervisor, employeeId, text)`: delivered into a live run, else a new task assigned to that employee with the text as its brief and no review.

- [ ] **Step 1: Write the failing tests**

```ts
it('every preset names capabilities, a tier and a role', …);
it('lists bundled, user, plugin and company skills with stable ids', …);
it('mounts chosen user and company skills as local plugins and returns their session names', () => { expect(m.skills).toEqual(['user:postgresql', 'company:privacy-rules']); });
it('adds a chosen plugin\'s folder and only its chosen skills', …);
it('hires from a preset with the company\'s model for the tier', …);
it('refuses a skill that is not installed and a capability the team does not allow', …);
it('refuses a second lead, and firing the lead clears it', …);
it('chat queues a route run for the chief of staff and resumes its conversation', …);
it('create_task puts an unassigned task on a led team, and requires an assignee on a self-managed one', …);
it('the chief of staff\'s reply arrives as a message naming the tasks it created', …);
it('a message to an idle employee becomes a task assigned to them', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/presets test/runtime/skills.spec.ts test/supervisor/hiring.spec.ts test/supervisor/chat.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "hiring: presets, mounted skills, the chief of staff's chat"`

### Task 14: The HTTP and WebSocket API, the plain page, and one command to start

Plan 2 is the consumer this API is designed for: read its Interfaces before building.

**Files:**
- Create: `src/api/server.ts`, `src/api/security.ts`, `src/api/routes.ts`, `src/api/ws.ts`, `src/api/plain.html`, `src/shared/view.ts`, `src/main.ts`
- Test: `test/api/security.spec.ts`, `test/api/routes.spec.ts`, `test/api/ws.spec.ts`, `test/shared/view.spec.ts`

**Interfaces:**
- Produces (`security.ts`), on `127.0.0.1:4317` (P82): only `Host` `127.0.0.1:4317` or `localhost:4317`; on every write and on the WebSocket upgrade, `Origin` must be one of those two; a per-install token (`<dataDir>/token`, 32 random bytes, mode 0600) in `Authorization: Bearer` on every `/api` request and in the first WebSocket message; bodies are `application/json` only; no CORS headers. `GET /` serves the page with the token in a `<meta name="vs-token">` tag.
- Produces (`view.ts`, pure, shared with plan 2): `attention(task, liveRun, openDecisions, now): 'none'|'working'|'review'|'waiting_on_you'|'silent'|'over_budget'` (`silent`: a live run past its lease, or an open `lease` card; `over_budget`: an open `cap` card; `waiting_on_you`: any other open card; `review`; `working`, D5); `cardLine(task, runs, decisions, now): string` (the artboards' third line: "event 40 s ago · gates 2/3", "diff 412 lines · gates passed", "2 runs · lease expired twice · decision open 9 min", D7); `longestSilence(liveRuns, now): { runId; seconds } | null`.
- Produces (`routes.ts`), JSON:
  - `GET /api/snapshot` → `{ version: EVENT_VERSION, company, repos, teams, employees, tasks, runs, requests, decisions, messages, health, planUsage, spend: { company; byTeam; byEmployee }, lastEventId, now }` (open tasks, tasks done or failed today, every run of those tasks, open decisions, the last 50 chat messages). The client then streams from `lastEventId` (P83).
  - `POST /api/setup` `{ name, rules, auth, models }` (the first company and its chief of staff) · `PATCH /api/company` · `POST /api/repos` `{ path, gates }` · `PATCH /api/repos/:id`
  - `POST /api/teams` · `PATCH /api/teams/:id`
  - `GET /api/hire-options` → `{ presets, skills, models: { id; label; tier }[], capabilities: { id; label }[], availableByTeam: Record<teamId, Capability[]> }` (D1, D3, D4)
  - `POST /api/employees` (the hire form's fields, or `{ preset, name, teamId }`) · `GET /api/employees/:id` → `{ employee, memoryIndex, runs }` · `PATCH /api/employees/:id` · `POST /api/employees/:id/fire` · `POST /api/employees/:id/message` `{ text }`
  - `POST /api/tasks` `{ title, brief, teamId, assigneeId?, reviewerId?, priority?, doneCondition?, repoId?, gates?, ownership?, capUsd?, retryAllowed?, leaseMinutes? }` · `GET /api/tasks/:id` → `{ task, children, runs, events }` (the last 200) · `PATCH /api/tasks/:id` (`priority`, `assigneeId`, `cancel: true`) · `GET /api/tasks/:id/diff` → `{ stat, patch }` · `POST /api/tasks/:id/message` `{ text }` · `POST /api/runs/:id/stop`
  - `POST /api/decisions/:id/answer` `{ optionId, text? }` → `{ result: 'applied'|'ignored' }` · `GET /api/decisions?answered=1` (the decision log)
  - `POST /api/chat` `{ text }` → `{ message }`; the reply arrives as events · `GET /api/health`
- Produces (`ws.ts`): `ws://127.0.0.1:4317/api/events`; the first message from the client is `{ token, since, taskId? }`; the server replays `EventRow`s after `since` (at most 5,000; beyond that it answers `{ resync: true }` and the client takes a new snapshot), then streams each new one.
- Produces (`plain.html`): one static page, no build step: the board's columns, the open cards with their option buttons, a chat line. It is what `GET /` serves until `web/dist` exists (plan 2), and the manual check of this task (P78).
- Produces (`main.ts`): `npm start` opens the data directory, runs `recover`, starts the supervisor, the health timer and the API, then opens the browser at `http://127.0.0.1:4317/` (C5, P81). With no company yet, the page shows the setup form. `VS_RUNTIME_MODULE` passes a runtime module to the supervisor, for demos and tests without a model.

- [ ] **Step 1: Install.** Run: `npm i fastify @fastify/websocket open`
- [ ] **Step 2: Write the failing tests** (fastify `inject`, scripted worker)

```ts
it('refuses a request with a foreign Host', …);  it('refuses a write with a foreign or missing Origin', …);
it('refuses a request without the token, and a body that is not JSON', …);  it('sends no CORS headers', …);
it('refuses a WebSocket whose first message lacks the token', …);  it('creates the token file with mode 0600', …);
it('setup creates the company and its chief of staff, once', …);
it('creates a task and shows it queued in the snapshot', …);  it('refuses an unassigned task on a self-managed team', …);
it('answers a decision by option id and reports ignored the second time', …);
it('hire-options greys send_messages for every team', …);
it('returns a task\'s diff stat and patch', …);  it('cancel fails the task and stops its run', …);
it('replays events after since, then streams new ones, and asks for a resync past the cap', …);
it('silent for a run past its lease, waiting_on_you for an open question, over_budget for a cap card', …);   // view.spec
it('the card line names the last event\'s age and the gate count', …);
```

- [ ] **Step 3: Run:** `npx vitest run test/api test/shared/view.spec.ts` — FAIL. **Step 4: Implement.** **Step 5: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 6: Check by hand:** `npm start`, set up a company on the plain page, create a task with the scripted worker (`VS_RUNTIME_MODULE=test/fixtures/fakeRuntime.ts`), answer its card.
- [ ] **Step 7: Commit:** `git add -A && git commit -m "api: HTTP and WebSocket behind a token, the plain page, one command to start"`

Then build plan 2. Then one review of the whole branch.

### Task 15: The Receipts dogfood — only on Filip's explicit go

**Files:**
- Create: `docs/dogfood-receipts.md`

- [ ] **Step 1: Ask Filip question 6**, in one message with a recommendation for each part: whether employees load the Receipts `CLAUDE.md` (it tells every agent it is Neo, a PM or an engineer), how today's roster maps to presets, which task goes first, and how the gates' lock respects one Xcode run at a time. Nothing in `/Users/someone/Desktop/receipt` is read, written or run before his answer.
- [ ] **Step 2: Write the setup** from his answers: the company; the one registered repository; a team per track with its base branch and merge target; the named gates with their lock and timeouts; the build profile for the iOS team (spike §6); the caps; the first task; how "a week of carried work" is counted (P85).
- [ ] **Step 3: Commit:** `git add docs/dogfood-receipts.md && git commit -m "docs: dogfood plan for Receipts"`

---

## Self-review notes

- **The six decisions.** 1 Git belongs to the engine: Tasks 8, 9 (one folder and branch per task under the data directory; engine commits, merges, publishes; `Task.repoId`, team base branch and merge target; the merge procedure in `landOn`). 2 One starter of runs: Tasks 3, 4, 5 (`run_requests`, the full table with `blockedFrom`, the invariant, `reviewerFor`, `attempt`, review rounds, options as data with the effects table). 3 Structured tools and engine gates: Tasks 6, 8 (the `engine` tool server, named gates run by the engine, ownership checked after each run). 4 Permissions and sessions: Task 1 as built, Task 6 (the hook as the gate, streaming handle, sandbox, `Company.auth`, identity in the system prompt and the brief in the first turn). 5 Budgets: Task 11 (per-turn usage, a task-wide cap passed as each run's `maxBudgetUsd`, company cap, the usage limit as its own outcome). 6 Surface, safety, recovery: Tasks 5, 12, 14 and plan 2.
- **Where the spike changed the review's fix.** The gate is the PreToolUse hook, not `canUseTool` (spike §4). Connectors are switched off in every session (§3). `tools` lists `Skill` and skills arrive through mounted local plugins (§5). `maxBudgetUsd` works on the login and is per run (§2). The task folder is a clone, which makes the ref snapshot unnecessary; it returns if Filip chooses worktrees (§6, question 5). Simulator tests cannot run inside the sandbox, so they are gates, and `run_gate` lets an employee ask for one.
- **Not built, on purpose.** Nested briefing: children are always worked; the chief of staff's `create_task` covers work for another team (P66). Tools for publish, send, pay, delete, and opening pull requests: the flags are stored and shown, and a request is a card. Importing the Receipts agent files as presets: Task 15, after Filip's answers.
- **Spec coverage.** Section 3 → Task 2. Section 4 → Tasks 4, 5, 6. Section 5 → Tasks 9, 13. Section 6 → Tasks 5, 6, 11. Section 7 → Tasks 6, 13. Section 8 → Task 14 and plan 2. Section 9 → Tasks 8, 9, 11, 12. Section 10 → the fixtures of Task 1, the scripted worker and fake runtime, the live tests of Tasks 7 and 10, and plan 2's event-replay tests. Section 11 → Tasks 1, 14. Section 12 → steps 1 to 5 here, the screen in plan 2.
- **Names used across tasks.** `RuntimeEvent`, `SessionInput`, `startSession`, `RuntimeFactory` (Task 1) → 5, 6, 11. `EngineEvent`, `apply`, row types (2) → all. `transition` (3) → 5, 9. `requestFor`, `reviewerFor`, `pickNext` (4) → 5, 9, 14. `WorkerJob`, `EngineTool`, `raise`, `answer`, `onFailure` (5) → 6, 9, 11, 12. `buildSystemPrompt`, `buildFirstTurn`, `engineToolServer`, `sessionShape`, `judgeToolCall` (6) → 9, 13. `createFolder`, `publish`, `commitAll`, `GateQueue`, `afterWorkRun` (8) → 9, 10. `budgetFor`, `isUsageLimit` (11) → the job builder of 6. `attention`, `cardLine` (14) → plan 2.
