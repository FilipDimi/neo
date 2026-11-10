# Virtual Startup Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the engine of the virtual startup: a supervisor that runs AI employees as leased worker processes on the Claude Agent SDK, with teams, a task board, briefing and review, budgets and blast radius, decision cards, machine health, and the HTTP and WebSocket API the web app will consume.

**Architecture:** One Node supervisor process owns a SQLite file (state plus an append-only event log) and a scheduling loop; every task run is a child process hosting exactly one Agent SDK session, reporting events over IPC under a lease the supervisor enforces. Everything the UI shows is a projection of the event log. Pure modules (scheduler, lease, budget, blast radius, briefing validation, task state machine) carry the logic and the unit tests; the supervisor wires them to processes, git and the SDK.

**Tech Stack:** TypeScript (strict), Node 22, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3` (WAL), `vitest`, `tsx`, `zod`, `fastify` with `@fastify/websocket`, `simple-git`. The web app (React, PixiJS, Vite) is plan 2.

**Spec:** `docs/superpowers/specs/2026-11-08-virtual-startup-design.md` (moves with this plan into the product's repository in Task 1).

## Global Constraints

- Local-first: everything runs on the user's machine; repositories are local paths; nothing about the user leaves the machine except the SDK's model calls.
- Employees run as Agent SDK sessions on the login already present on the machine (subscription now, keys later); verified in Task 1; the fallback named in the spec applies only if Task 1 fails.
- A worker has no inbox and never waits; silence past the lease is detected by the supervisor; nothing retries forever; nothing fails silently.
- Limits (spend, repositories, branches, merge to main, pull requests, publish, send, pay, delete) are enforced by the supervisor and the SDK's tool permissions, never trusted to the employee.
- Sibling briefs with overlapping file ownership are refused at creation.
- Merging to the main branch defaults to off per team.
- Task states: `queued`, `briefing`, `running`, `review`, `blocked`, `done`, `failed`. Default lease: 10 minutes. Default concurrency: 3. Retry on expiry: once, if the task allows.
- Memory: one folder per employee, an index file read at every run start, capped by the supervisor (the cap: 8 KB).
- The product lives in its own repository; provisional folder `/Users/someone/Desktop/startup` until Filip names it (the folder is renamed, nothing inside depends on the name).
- Commit messages carry no attribution lines.

## Review Focus

1. A worker that emits events but never finishes (an SDK session looping on tool calls): the lease must not be the only guard; `maxTurns` on the session and the task spend cap end it with a card (Task 6 test `ends a session that exceeds maxTurns with outcome "failed" and a card`).
2. The supervisor restarts while runs are in flight: a worker whose process is gone must be expired, not shown as running forever (Task 11 test `expires runs whose worker pid is gone on restart`).
3. Two runs on the same repository at once: worktrees must never collide, including when two tasks share a branch name prefix (Task 8 test `creates distinct worktrees for two runs of the same task name`).
4. A lead's briefing that nests (a sub-task that itself proposes sub-tasks): depth is capped at 2 and a deeper proposal is sent back once, then a card (Task 9 test `refuses a sub-task proposal below depth 2`).
5. A decision answered twice, or answered for a run that already finished: the second answer is recorded as an event and ignored, never resuming a dead session (Task 10 test `ignores a second answer and an answer to a finished run`).

---

### Task 1: Repository bootstrap and the subscription-login spike

**Files:**
- Create: `/Users/someone/Desktop/startup/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `docs/superpowers/specs/2026-11-08-virtual-startup-design.md` (moved from the Receipts repo), `docs/superpowers/plans/2026-11-08-virtual-startup-engine.md` (this file)
- Create: `src/runtime/sdk.ts`, `scripts/spike-login.ts`
- Test: `test/runtime/sdk.spec.ts`

**Interfaces:**
- Produces: `runSession(input: SessionInput): AsyncIterable<RuntimeEvent>` in `src/runtime/sdk.ts`, where `SessionInput = { cwd: string; prompt: string; systemPrompt: string; allowedTools: string[]; maxTurns: number; resumeSessionId?: string; canUseTool: (tool: string, input: unknown) => Promise<{ allow: boolean; reason?: string }> }` and `RuntimeEvent = { kind: 'session_started'; sessionId: string } | { kind: 'assistant_text'; text: string } | { kind: 'tool_call'; tool: string; input: unknown } | { kind: 'tool_result'; tool: string; ok: boolean } | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd: number } | { kind: 'finished'; sessionId: string; ok: boolean; reason?: string }`. This wrapper is the only file that names SDK types; every later task consumes `RuntimeEvent`.
- Produces: `RuntimeFactory = (input: SessionInput) => AsyncIterable<RuntimeEvent>` type, so tests substitute a fake.

- [ ] **Step 1: Create the repository**

Run: `mkdir -p /Users/someone/Desktop/startup && cd /Users/someone/Desktop/startup && git init -b main && npm init -y`
Expected: an empty repository on `main`.

- [ ] **Step 2: Install the toolchain and dependencies**

Run: `npm i @anthropic-ai/claude-agent-sdk better-sqlite3 zod fastify @fastify/websocket simple-git && npm i -D typescript tsx vitest @types/node @types/better-sqlite3`
Then write `tsconfig.json` (strict, `module: NodeNext`, `target: ES2022`, `outDir: dist`, `rootDir: .`) and `vitest.config.ts` (`test.include: ['test/**/*.spec.ts']`), `.gitignore` (`node_modules`, `dist`, `*.db`, `*.db-wal`, `*.db-shm`, `data/`), and copy the spec and this plan into `docs/superpowers/`.

- [ ] **Step 3: Write the spike script**

`scripts/spike-login.ts`: calls the SDK's `query` with the prompt `Reply with the single word OK.` and `cwd` = the repo, no `ANTHROPIC_API_KEY` in the environment (`delete process.env.ANTHROPIC_API_KEY` first), `maxTurns: 1`; prints every message's `type`, and for the result message its `session_id`, `total_cost_usd` and the text. It exits 0 only if a result message with a `session_id` arrived.

- [ ] **Step 4: Run the spike**

Run: `npx tsx scripts/spike-login.ts`
Expected: exit 0, a `session_id` printed, the text `OK`. If it fails with an authentication error, STOP: record the exact error in `README.md` under "Runtime", and the spec's fallback (a runtime interface with a CLI-backed implementation) replaces the SDK body of `src/runtime/sdk.ts` in Task 6; the interface below does not change.

- [ ] **Step 5: Record the SDK's names**

In `README.md` under "Runtime", write the installed SDK version and the exact option names the spike used for: working directory, system prompt, allowed tools, max turns, resume, the permission callback, and the fields of the result message (session id, cost, usage). Later tasks refer to this list, never to memory.

- [ ] **Step 6: Write the failing wrapper test**

`test/runtime/sdk.spec.ts`:
```ts
it('maps a recorded SDK stream to RuntimeEvents in order', async () => {
  const events = await collect(runSessionFromMessages(recorded.helloStream));
  expect(events[0]).toEqual({ kind: 'session_started', sessionId: 'sess-1' });
  expect(events.at(-1)).toEqual({ kind: 'finished', sessionId: 'sess-1', ok: true });
  expect(events.filter(e => e.kind === 'usage')).toHaveLength(1);
});
```
with `test/fixtures/sdk/helloStream.json`, a recording of the spike's message list captured by adding `--record test/fixtures/sdk/helloStream.json` to the spike script (write each raw message as a JSON array).

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run test/runtime/sdk.spec.ts`
Expected: FAIL, `runSessionFromMessages is not defined`.

- [ ] **Step 8: Implement `src/runtime/sdk.ts`**

Export `mapMessage(raw: unknown): RuntimeEvent[]` (pure: one raw SDK message to zero or more events, using the names recorded in Step 5), `runSessionFromMessages(messages: unknown[]): AsyncIterable<RuntimeEvent>` (for tests and replays), and `runSession(input: SessionInput): AsyncIterable<RuntimeEvent>` (calls `query` with `input`, passing `canUseTool` through, and yields `mapMessage` of each message).

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run test/runtime/sdk.spec.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "bootstrap: toolchain, spec, plan, SDK wrapper and the login spike"
```

### Task 2: Schema and the event log

**Files:**
- Create: `src/db/open.ts`, `src/db/schema.sql`, `src/db/events.ts`
- Test: `test/db/events.spec.ts`

**Interfaces:**
- Produces: `openDb(path: string): Db` (better-sqlite3 database with WAL on, schema applied idempotently); `appendEvent(db: Db, e: NewEvent): EventRow` where `NewEvent = { runId?: string; taskId?: string; employeeId?: string; kind: string; payload: unknown }` and `EventRow = NewEvent & { id: number; at: string }`; `readEvents(db: Db, sinceId: number, limit?: number): EventRow[]`; `lastEventAt(db: Db, runId: string): string | null`.
- Tables (in `schema.sql`): `companies`, `teams`, `employees`, `tasks`, `runs`, `decisions`, `events` (`id INTEGER PRIMARY KEY`, `at TEXT`, `run_id`, `task_id`, `employee_id`, `kind`, `payload TEXT`), with indexes on `events(run_id)`, `events(task_id)`, `tasks(state)`, `runs(task_id)`. Column sets follow the spec's section 3 field lists one to one, snake_case.

- [ ] **Step 1: Write the failing tests**

```ts
it('appends events with increasing ids and ISO timestamps', () => { … expect(b.id).toBe(a.id + 1); expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T/); });
it('reads events after a given id in order', () => { … expect(readEvents(db, a.id).map(e => e.id)).toEqual([b.id, c.id]); });
it('lastEventAt returns null for an unknown run', () => { expect(lastEventAt(db, 'nope')).toBeNull(); });
it('opening twice applies the schema once', () => { openDb(p); expect(() => openDb(p)).not.toThrow(); });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/db`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `schema.sql`, `open.ts`, `events.ts`**

`openDb` runs `PRAGMA journal_mode=WAL` and executes `schema.sql` (every statement `CREATE TABLE IF NOT EXISTS`). Payload stored as JSON text; `appendEvent` returns the row with `at` from `new Date().toISOString()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db test/db && git commit -m "db: schema and append-only event log"
```

### Task 3: The model, the store and the task state machine

**Files:**
- Create: `src/model/types.ts`, `src/model/taskState.ts`, `src/model/store.ts`
- Test: `test/model/taskState.spec.ts`, `test/model/store.spec.ts`

**Interfaces:**
- Produces (`types.ts`): `TaskState = 'queued'|'briefing'|'running'|'review'|'blocked'|'done'|'failed'`; `Company { id; name; repos: string[]; concurrency: number; dailyCapUsd: number }`; `Team { id; companyId; name; purpose; leadId: string|null; selfManaged: boolean; dailyCapUsd: number; repos: string[]; branchPatterns: string[]; mayMergeMain: boolean; mayOpenPr: boolean; mayPublish: boolean; maySend: boolean; mayPay: boolean; mayDelete: boolean; leaseMinutes: number }`; `Employee { id; companyId; teamId; name; role; skills: string[]; tools: string[]; model: string; isLead: boolean; memoryDir: string; fired: boolean }`; `Task { id; companyId; teamId; assigneeId: string|null; parentId: string|null; title; brief; priority: 1|2|3; state: TaskState; doneCondition; ownership: string[]; capUsd: number; retryAllowed: boolean; depth: number }`; `Run { id; taskId; employeeId; sessionId: string|null; worktree: string|null; branch: string|null; pid: number|null; leaseUntil: string; startedAt; endedAt: string|null; outcome: 'running'|'done'|'failed'|'expired'|'stopped'; costUsd: number; gateOutput: string|null }`; `Decision { id; taskId; runId: string|null; kind: 'limit'|'question'|'merge'|'hire'|'lease'; text; options: string[]; answer: string|null; askedAt; answeredAt: string|null }`.
- Produces (`taskState.ts`): `transition(from: TaskState, event: TaskEvent): TaskState` (pure; throws `IllegalTransition` on an undefined pair) with `TaskEvent = 'start_briefing'|'subtasks_created'|'start_run'|'run_done'|'review_approved'|'review_sent_back'|'blocked'|'unblocked'|'completed'|'failed'`.
- Produces (`store.ts`): typed CRUD per table (`insertTeam`, `getTask`, `listTasks(where)`, `updateTask`, `insertRun`, `updateRun`, `insertDecision`, `answerDecision`, `listOpenDecisions`, …), each one statement, no business logic.

- [ ] **Step 1: Write the failing state-machine tests**

```ts
it.each([
  ['queued','start_briefing','briefing'], ['queued','start_run','running'], ['briefing','subtasks_created','running'],
  ['running','run_done','review'], ['review','review_approved','done'], ['review','review_sent_back','running'],
  ['running','blocked','blocked'], ['blocked','unblocked','running'], ['running','failed','failed'],
])('%s + %s -> %s', (from, ev, to) => expect(transition(from, ev)).toBe(to));
it('throws on an illegal transition', () => expect(() => transition('done', 'start_run')).toThrow(IllegalTransition));
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/model/taskState.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `taskState.ts` and `types.ts`**

A table of allowed pairs; nothing else.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/model/taskState.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing store tests**

```ts
it('round-trips a team with its limits', () => { … expect(getTeam(db, id)).toMatchObject({ mayMergeMain: false, leaseMinutes: 10 }); });
it('lists tasks by state in priority then creation order', () => { … expect(listTasks(db, { state: 'queued' }).map(t => t.id)).toEqual([p1, p2a, p2b]); });
it('answering a decision sets answer and answeredAt once', () => { … expect(answerDecision(db, d.id, 'retry')).toBe(true); expect(answerDecision(db, d.id, 'stop')).toBe(false); });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run test/model/store.spec.ts`
Expected: FAIL.

- [ ] **Step 7: Implement `store.ts`**

Prepared statements; booleans as 0/1; arrays as JSON text; `answerDecision` returns false when `answered_at` is already set.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/model`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/model test/model && git commit -m "model: types, task state machine, store"
```

### Task 4: The scheduler

**Files:**
- Create: `src/supervisor/scheduler.ts`
- Test: `test/supervisor/scheduler.spec.ts`

**Interfaces:**
- Produces: `pickNext(input: { runnable: Task[]; runningCount: number; concurrency: number; spendToday: Map<string, number>; teams: Map<string, Team>; employees: Map<string, Employee> }): Pick | null` where `Pick = { task: Task; employeeId: string; mode: 'brief'|'work'|'review' }`. Rules: nothing when `runningCount >= concurrency`; skip a team whose `spendToday >= dailyCapUsd`; a `queued` task on a led team with no assignee picks the lead in mode `brief`; a `queued` task with an assignee, or on a self-managed team (assignee required), picks the assignee in mode `work`; a `review` task picks the team's lead in mode `review`; priority 1 before 2 before 3, then older first; never an employee already running.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns null at concurrency', …);
it('skips a team over its daily cap', …);
it('briefs with the lead on a led team', () => expect(pick.mode).toBe('brief'));
it('works with the assignee on a self-managed team', …);
it('reviews with the lead when the task is in review', …);
it('orders by priority then age', …);
it('never picks an employee who is already running', …);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/supervisor/scheduler.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `pickNext`**

Pure; takes a `runningEmployeeIds: Set<string>` field added to the input for the last rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/supervisor/scheduler.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/scheduler.ts test/supervisor/scheduler.spec.ts && git commit -m "supervisor: scheduler"
```

### Task 5: Leases and the supervisor loop with a fake worker

**Files:**
- Create: `src/supervisor/lease.ts`, `src/supervisor/supervisor.ts`, `src/worker/protocol.ts`, `src/worker/fakeWorker.ts`
- Test: `test/supervisor/lease.spec.ts`, `test/supervisor/supervisor.spec.ts`, `test/fixtures/streams/*.json`

**Interfaces:**
- Produces (`lease.ts`): `leaseUntil(now: Date, minutes: number): string`; `isExpired(leaseUntil: string, now: Date): boolean`; `onExpiry(run: Run, task: Task): 'retry'|'card'` (`retry` when `task.retryAllowed` and the run is the task's first).
- Produces (`protocol.ts`): IPC messages, worker to supervisor: `{ t: 'event'; event: RuntimeEvent }`, `{ t: 'report'; outcome: 'done'|'failed'; summary: string; gateOutput?: string }`; supervisor to worker: `{ t: 'start'; job: WorkerJob }`, `{ t: 'interrupt'; text: string }`, `{ t: 'stop' }`; `WorkerJob = { runId; taskId; employee: Employee; team: Team; task: Task; worktree: string; systemPrompt: string; allowedTools: string[]; maxTurns: number; resumeSessionId?: string; replayFile?: string }`.
- Produces (`supervisor.ts`): `class Supervisor { constructor(opts: { db: Db; workerEntry: string; now?: () => Date; tickMs?: number }); start(): void; stop(): Promise<void>; tick(): Promise<void>; onMessage(runId: string, text: string): 'delivered'|'queued' }`. `tick` is the loop body (schedule, spawn, check leases, reap) and is called directly by tests.
- Produces (`fakeWorker.ts`): a child entry that replays `job.replayFile` (a recorded `RuntimeEvent[]` with per-event delays in ms) and then sends a `report`; a replay file may end with `{ "hang": true }` to simulate silence.

- [ ] **Step 1: Write the failing lease tests**

```ts
it('isExpired is false before and true after leaseUntil', …);
it('onExpiry retries a first run of a retryable task and cards otherwise', …);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/supervisor/lease.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lease.ts`**

- [ ] **Step 4: Run them to verify they pass**

- [ ] **Step 5: Write the failing supervisor tests (fake worker)**

```ts
it('spawns a worker for a queued task and records run_started', …);
it('renews the lease on every event', () => { … expect(new Date(run.leaseUntil) > before).toBe(true); });
it('kills a silent worker after the lease, marks the run expired and retries once', () => { … expect(runs.map(r => r.outcome)).toEqual(['expired', 'running']); });
it('raises a lease decision after the second expiry and blocks the task', () => { … expect(task.state).toBe('blocked'); expect(decision.kind).toBe('lease'); });
it('respects concurrency across ticks', …);
it('onMessage returns delivered for a running run and queued otherwise', …);
```
Each uses `now` injected and advanced by the test; replay files `test/fixtures/streams/quick-done.json` (two events, report done) and `hangs.json` (one event then hang).

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run test/supervisor/supervisor.spec.ts`
Expected: FAIL.

- [ ] **Step 7: Implement `supervisor.ts`, `protocol.ts`, `fakeWorker.ts`**

`child_process.fork(workerEntry)` with `serialization: 'advanced'`; on `event` append to the log and renew the lease; on `report` close the run and apply `transition`; `tick` kills (`SIGKILL`) expired workers and applies `onExpiry`; interrupts forwarded with `{ t: 'interrupt' }`, or stored on the task as `pendingMessages` when no run is live.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/supervisor`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/supervisor src/worker test/supervisor test/fixtures && git commit -m "supervisor: leases, loop, fake worker, interrupts"
```

### Task 6: The real worker: definition, memory, SDK session, resume

**Files:**
- Create: `src/worker/worker.ts`, `src/worker/definition.ts`, `src/worker/memory.ts`
- Test: `test/worker/definition.spec.ts`, `test/worker/memory.spec.ts`, `test/worker/worker.spec.ts`

**Interfaces:**
- Produces (`definition.ts`): `buildSystemPrompt(input: { company: Company; team: Team; employee: Employee; task: Task; mode: 'brief'|'work'|'review'; memoryIndex: string; reportFormat: string }): string`. Fixed sections in this order: company rules, team purpose and limits (every `may*` flag spelled out as "You may / may not …"), the role sentence, the skill list with `Load these skills with the Skill tool before anything else`, the tool allowlist, the memory index verbatim, the task brief and done-condition, and the mode's instructions (brief: propose sub-tasks in the JSON shape of Task 9; work: do the task, run the named gates, end with the report format; review: approve, send back with notes, or escalate).
- Produces (`memory.ts`): `readIndex(dir: string, capBytes: number): string` (creates `index.md` when missing; truncates at the cap with a trailing line `… (index capped at 8 KB)`), `appendNote(dir: string, text: string): void` (dated file under `notes/`).
- Produces (`worker.ts`): the child entry: on `start`, builds the prompt via `buildSystemPrompt`, calls the runtime factory (`runSession`, or the replay when `job.replayFile` is set), forwards each `RuntimeEvent` as `{ t: 'event' }`, feeds an `interrupt` as the next user turn of the session, passes `canUseTool` through to the supervisor's answer (Task 10), writes the final note to memory, and sends `report`. Exits 0 after `report`, 1 on an unhandled error (after sending `report` with `failed`).

- [ ] **Step 1: Write the failing definition tests**

```ts
it('spells out every limit of the team', () => { expect(p).toContain('You may not merge to the main branch'); expect(p).toContain('You may open pull requests'); });
it('lists skills with the load-first instruction', …);
it('includes the memory index verbatim', …);
it('ends with the mode instructions for review', …);
```

- [ ] **Step 2: Run, verify FAIL. Step 3: Implement `definition.ts`. Step 4: Run, verify PASS.**

- [ ] **Step 5: Write the failing memory tests**

```ts
it('creates an empty index on first read', …);
it('caps the index at capBytes with the trailing marker', …);
it('appends a dated note file', …);
```

- [ ] **Step 6: Run, verify FAIL. Step 7: Implement `memory.ts`. Step 8: Run, verify PASS.**

- [ ] **Step 9: Write the failing worker tests**

```ts
it('forwards runtime events and a report over IPC from a replay', …);
it('feeds an interrupt as the next user turn', () => { … expect(turns).toEqual(['<task>', 'Neo says: stop at the test step']); });
it('ends a session that exceeds maxTurns with outcome "failed" and a card', …);  // Review Focus 1
it('resumes with resumeSessionId when the job carries one', …);
```
The last three use a fake runtime factory injected through an environment variable `VS_RUNTIME=fake` that loads `test/fixtures/fakeRuntime.ts`.

- [ ] **Step 10: Run, verify FAIL. Step 11: Implement `worker.ts`. Step 12: Run, verify PASS.**

- [ ] **Step 13: Commit**

```bash
git add src/worker test/worker && git commit -m "worker: definition, memory, SDK session, interrupts, resume"
```

### Task 7: Live run end to end (one real session)

**Files:**
- Create: `scripts/run-one.ts`
- Test: `test/e2e/one-task.spec.ts` (tagged `live`, skipped unless `VS_LIVE=1`)

**Interfaces:**
- Consumes: Tasks 2 to 6.

- [ ] **Step 1: Write the live test**

```ts
it.skipIf(!process.env.VS_LIVE)('runs one task on a sample repo with the real SDK', async () => {
  // company with one self-managed team, one employee (skills: none, tools: Read, Glob, Grep, Write), task: "Create HELLO.md containing the word hello" on a temp git repo
  … expect(run.outcome).toBe('done'); expect(fs.existsSync(path.join(run.worktree, 'HELLO.md'))).toBe(true); expect(run.costUsd).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it: `VS_LIVE=1 npx vitest run test/e2e`**

Expected: PASS within 3 minutes, on the subscription login (no API key in the environment). If it fails, fix the worker, not the test.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-one.ts test/e2e && git commit -m "e2e: one real task on a sample repository"
```

### Task 8: Repositories, worktrees and gate outputs

**Files:**
- Create: `src/git/worktree.ts`, `src/git/branch.ts`
- Modify: `src/supervisor/supervisor.ts` (create the worktree before spawning, remove it when the task is done)
- Test: `test/git/worktree.spec.ts`

**Interfaces:**
- Produces: `branchName(task: Task, runId: string): string` = `task/<slug(title)>-<taskId6>-<runId6>` (always unique per run); `createWorktree(repo: string, branch: string, base: string): Promise<string>` returning the worktree path under `<repo>/.vs-worktrees/<branch>`; `removeWorktree(repo: string, path: string): Promise<void>`; `allowedBranch(team: Team, branch: string): boolean` (glob match against `team.branchPatterns`).
- Produces: `Run.gateOutput` is set from the worker's `report.gateOutput`; the reviewer prompt (Task 9) receives it.

- [ ] **Step 1: Write the failing tests**

```ts
it('creates distinct worktrees for two runs of the same task name', …);  // Review Focus 3
it('refuses a branch outside the team patterns', () => expect(allowedBranch(team, 'main')).toBe(false));
it('removes a worktree and its branch', …);
```

- [ ] **Step 2: Run, verify FAIL. Step 3: Implement with `simple-git`. Step 4: Run, verify PASS.**

- [ ] **Step 5: Wire the supervisor**

Before spawning: `createWorktree(repo, branchName(task, run.id), team's base branch)`; refuse (card of kind `limit`) when `!allowedBranch`. On task done: `removeWorktree`.

- [ ] **Step 6: Run the whole suite: `npx vitest run`**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/git src/supervisor test/git && git commit -m "git: worktrees per run, branch rules, gate outputs"
```

### Task 9: The led-team flow: briefing, ownership, review, completion

**Files:**
- Create: `src/supervisor/briefing.ts`, `src/supervisor/flow.ts`
- Modify: `src/supervisor/supervisor.ts` (call `flow` on run reports)
- Test: `test/supervisor/briefing.spec.ts`, `test/supervisor/flow.spec.ts`

**Interfaces:**
- Produces (`briefing.ts`): `SubtaskProposal = { title: string; assigneeId: string; brief: string; ownership: string[]; doneCondition: string; gates: string[] }`; `parseProposal(text: string): SubtaskProposal[] | ProposalError` (the lead's run ends its last message with a fenced ```json block holding `{ "subtasks": [...] }`; absent = the lead did the task itself); `validateProposal(parent: Task, team: Team, employees: Employee[], proposal: SubtaskProposal[]): ValidationResult` with reasons `overlap` (two sub-tasks share a path or glob), `unknown_assignee`, `assignee_not_in_team`, `missing_done_condition`, `depth` (parent.depth >= 2).
- Produces (`flow.ts`): `onRunReport(ctx, run, report): void` applying: brief mode → create children (`depth = parent.depth + 1`, `state queued`) and parent `subtasks_created`, or send back once (`briefing_sent_back` event, new brief run with the reasons) then card; work mode → `run_done` (task to `review`) on a led team or `completed` on a self-managed team; review mode → the reviewer's last message holds a fenced ```json block `{ "verdict": "approve"|"send_back"|"escalate", "notes": string }` → `review_approved` / `review_sent_back` (a new work run with `resumeSessionId` and the notes as the first turn) / card of kind `question`; when every child is done, a final lead run in mode `work` with the integration brief (merge into the team branch if allowed, else card of kind `merge`).

- [ ] **Step 1: Write the failing briefing tests**

```ts
it('parses a proposal from the trailing json block', …);
it('refuses overlapping ownership between siblings', () => expect(v.reasons).toContain('overlap'));
it('refuses a sub-task proposal below depth 2', …);  // Review Focus 4
it('refuses an assignee from another team', …);
```

- [ ] **Step 2: Run, verify FAIL. Step 3: Implement `briefing.ts`. Step 4: Run, verify PASS.**

- [ ] **Step 5: Write the failing flow tests (fake worker replays)**

```ts
it('creates children from a valid proposal and moves the parent to running', …);
it('sends an invalid proposal back once, then cards', …);
it('moves a done work run to review on a led team and to done on a self-managed team', …);
it('resumes the child session with the notes on send_back', …);
it('starts the integration run when every child is approved and cards the main merge', …);
```

- [ ] **Step 6: Run, verify FAIL. Step 7: Implement `flow.ts` and wire it. Step 8: Run `npx vitest run`, verify PASS.**

- [ ] **Step 9: Commit**

```bash
git add src/supervisor test/supervisor && git commit -m "flow: briefing with ownership checks, review rounds, completion"
```

### Task 10: Budgets, blast radius and decision cards

**Files:**
- Create: `src/supervisor/budget.ts`, `src/supervisor/blastRadius.ts`, `src/supervisor/decisions.ts`
- Modify: `src/supervisor/supervisor.ts`, `src/worker/worker.ts` (the `canUseTool` round trip over IPC: `{ t: 'ask_tool'; tool; input; askId }` / `{ t: 'tool_answer'; askId; allow; reason }`)
- Test: `test/supervisor/budget.spec.ts`, `test/supervisor/blastRadius.spec.ts`, `test/supervisor/decisions.spec.ts`

**Interfaces:**
- Produces (`budget.ts`): `spendToday(db, teamId, now): number` (sum of `usage` events' `costUsd` since local midnight); `checkRunCap(run, task): 'ok'|'over'`; the supervisor stops a run over `task.capUsd` with a card of kind `limit` (options `['raise cap', 'stop']`) and skips scheduling a team over its daily cap.
- Produces (`blastRadius.ts`): `toolsFor(team: Team, employee: Employee): string[]` (the employee's tools minus every tool a flag forbids: `git push`/`gh pr create` need `mayOpenPr`, a `send_*` tool needs `maySend`, a `pay_*` tool needs `mayPay`, `rm`-class deletes need `mayDelete`); `decideTool(team: Team, task: Task, tool: string, input: unknown): { allow: boolean; reason?: string }` for the runtime's permission callback: a Bash `git push` or `git merge` onto a branch outside `branchPatterns` or onto main without `mayMergeMain` is refused with the reason; a refusal appends a `tool_refused` event and raises a card of kind `limit`.
- Produces (`decisions.ts`): `raise(db, input: Omit<Decision,'id'|'askedAt'|'answer'|'answeredAt'>): Decision` (blocks the task: `blocked` transition); `answer(db, supervisor, decisionId, answer: string): 'resumed'|'ignored'` (records an `decision_answered` event; resumes the run by starting a new run with `resumeSessionId` and the answer as the first turn; `ignored` when already answered or the run is finished — Review Focus 5).

- [ ] **Step 1: Write the failing tests**

```ts
it('sums today only', …); it('stops a run over its cap with a limit card', …);
it('removes forbidden tools from the allowlist', () => expect(toolsFor(team, emp)).not.toContain('send_email'));
it('refuses a push to main without mayMergeMain and cards it', …);
it('answering resumes the run with the answer as the first turn', …);
it('ignores a second answer and an answer to a finished run', …);  // Review Focus 5
```

- [ ] **Step 2: Run, verify FAIL. Step 3: Implement the three modules and the IPC round trip. Step 4: Run `npx vitest run`, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/supervisor src/worker test/supervisor && git commit -m "limits: budgets, blast radius, decision cards"
```

### Task 11: Machine health and durability

**Files:**
- Create: `src/supervisor/health.ts`, `src/supervisor/recover.ts`
- Modify: `src/supervisor/supervisor.ts` (health on a timer; `recover` on start)
- Test: `test/supervisor/health.spec.ts`, `test/supervisor/recover.spec.ts`

**Interfaces:**
- Produces (`health.ts`): `checkHealth(input: { repos: string[]; minFreeGb: number; services: { name: string; url: string }[] }): Promise<HealthReport>` with `HealthReport = { diskFreeGb: number; sdkLogin: 'ok'|'missing'; repos: { path: string; clean: boolean; branch: string }[]; services: { name: string; ok: boolean }[]; failures: string[] }`; a failure blocks new runs on the affected repos and raises one card of kind `question` per distinct failure (deduplicated while open). Disk via `statfs`; login via the presence of Claude Code's credentials file or a 1-turn probe once an hour; services via HTTP GET within 5 s.
- Produces (`recover.ts`): `recover(db, now): { reattached: string[]; expired: string[] }`: for every run with `outcome 'running'`, if `process.kill(pid, 0)` succeeds, re-attach (the supervisor adopts the pid and lease); else mark `expired` and apply `onExpiry` (Review Focus 2). The board is rebuilt from the tables, which are always consistent with the event log because every write happens in one transaction with its event.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports a low disk as a failure', …); it('reports a missing service', …);
it('expires runs whose worker pid is gone on restart', …);  // Review Focus 2
it('re-attaches a run whose worker is alive', …);
```

- [ ] **Step 2: Run, verify FAIL. Step 3: Implement. Step 4: Run `npx vitest run`, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/supervisor test/supervisor && git commit -m "supervisor: machine health and restart recovery"
```

### Task 12: Presets, the chief of staff, and the HTTP and WebSocket API

**Files:**
- Create: `src/presets/presets.ts`, `src/api/server.ts`, `src/api/routes.ts`, `src/api/ws.ts`, `src/main.ts`
- Test: `test/api/routes.spec.ts`, `test/api/ws.spec.ts`, `test/e2e/led-team.spec.ts` (live, skipped unless `VS_LIVE=1`)

**Interfaces:**
- Produces (`presets.ts`): `PRESETS: Record<'chief_of_staff'|'engineering_lead'|'engineer'|'reviewer'|'marketing_writer'|'analyst', Omit<Employee,'id'|'companyId'|'teamId'|'memoryDir'|'fired'>>`; the chief of staff preset's role: writes tasks from the company chat onto the right teams and keeps the decision log; `hireFromPreset(db, companyId, teamId, preset, name): Employee`.
- Produces (`routes.ts`), JSON over fastify on `127.0.0.1:4317`: `GET /api/company`, `GET /api/board` (tasks grouped by state with elapsed, spend, colour `green|amber|red`), `GET /api/tasks/:id` (children, runs, last 200 events), `POST /api/tasks` (`{ title, brief, teamId, assigneeId?, priority?, doneCondition?, capUsd? }`), `POST /api/tasks/:id/message` (`{ text }` → `delivered|queued`), `GET /api/decisions`, `POST /api/decisions/:id/answer` (`{ answer }`), `GET /api/employees`, `POST /api/employees` (the hire form's fields or `{ preset, name, teamId }`), `POST /api/employees/:id/fire`, `POST /api/teams`, `PATCH /api/teams/:id`, `POST /api/chat` (`{ text }` → creates a task on the chief of staff's team with the text as the brief; returns the task), `GET /api/health`.
- Produces (`ws.ts`): `ws://127.0.0.1:4317/events?since=<id>`: replays events after `since`, then streams every new event as JSON; the web app (plan 2) is a projection of this stream.
- Produces (`main.ts`): `npm start` opens the db at `./data/company.db`, runs `recover`, starts the supervisor, the health timer (every 60 s) and the API.

- [ ] **Step 1: Write the failing route tests (fastify `inject`, fake worker)**

```ts
it('creates a task and shows it queued on the board', …);
it('chat creates a task on the chief of staff team', …);
it('answers a decision through the API', …);
it('hires from a preset', () => expect(res.json().isLead).toBe(true));
it('colours a run past its lease red on the board', …);
```

- [ ] **Step 2: Run, verify FAIL. Step 3: Implement routes, ws, presets, main. Step 4: Run `npx vitest run`, verify PASS.**

- [ ] **Step 5: Write the live led-team test**

```ts
it.skipIf(!process.env.VS_LIVE)('briefs, works, reviews and merges to the team branch on a sample repo', async () => {
  // one led team: lead (engineering_lead preset) + two engineers; task "Add a GREETING.md and a FAREWELL.md" with gates ["test -f GREETING.md", "test -f FAREWELL.md"]
  … expect(parent.state).toBe('done'); expect(children.every(c => c.state === 'done')).toBe(true); expect(await branchExists(repo, team.branch)).toBe(true);
});
```

- [ ] **Step 6: Run it: `VS_LIVE=1 npx vitest run test/e2e/led-team.spec.ts`**

Expected: PASS within 15 minutes; two child worktrees were created and removed; the merge landed on the team branch, not main.

- [ ] **Step 7: Commit**

```bash
git add src/presets src/api src/main.ts test/api test/e2e && git commit -m "api: presets, chief of staff chat, board and decisions over HTTP and WebSocket; live led-team test"
```

### Task 13: Dogfood setup for Receipts (no code)

**Files:**
- Create: `docs/dogfood-receipts.md`

- [ ] **Step 1: Write the setup**

The company "Receipts" from presets: Neo as chief of staff; teams Engineering iOS and Engineering Rust (led; repos the two track worktrees; branch patterns `ios/*` and `rust/*`; `mayMergeMain: false`; daily caps $20 and $15; lease 10 min, 30 min for gate steps); the engineer and reviewer presets named as today's roster. One real task to run first beside the current system: a small, self-contained one the current ios-pm is not touching. The retirement rule from the spec: a week of carried work.

- [ ] **Step 2: Commit**

```bash
git add docs/dogfood-receipts.md && git commit -m "docs: dogfood plan for Receipts"
```

---

## Self-review notes

- Spec coverage: section 3 → Tasks 2, 3; section 4 → Tasks 5, 6, 7; section 5 → Task 9; section 6 → Task 10; section 7 → Tasks 6 (definition, memory), 12 (presets, hiring); section 8 (board, company, chat, office) → the API in Task 12 here, the screens in plan 2; section 9 → Tasks 8, 10, 11; section 10 → the fake runtime (Task 1), fake worker (Task 5), live tests (Tasks 7, 12); section 11 → Task 1; section 12 → steps 1 to 5 here, step 6 in plan 2; section 13, 14 → Task 1 and the provisional folder.
- Names used across tasks: `RuntimeEvent`, `SessionInput`, `runSession` (Task 1) consumed by 5, 6, 10; `transition` (Task 3) used by 5, 9; `pickNext` (Task 4) by 5; `onExpiry` (Task 5) by 11; `buildSystemPrompt` (Task 6) by 9's mode instructions; `branchName`, `allowedBranch` (Task 8) by 10; `raise`, `answer` (Task 10) by 11, 12.
