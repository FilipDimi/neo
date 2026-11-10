# Virtual startup: final review before building

Date: 2026-11-09. Reviewer: Neo, from the fork. Scope: the design spec, the office canvas and the engine plan.
Nothing in the spec or the plan was edited. Nothing was built, installed or committed.

Reviewed:

- Spec: `docs/superpowers/specs/2026-11-08-virtual-startup-design.md`, 101 lines.
- Plan: `docs/superpowers/plans/2026-11-08-virtual-startup-engine.md`, 581 lines, 13 tasks.
- Office canvas: the Office, Board and Hire artboards, read as text labels.
- Claude Agent SDK behaviour: checked against the documentation in an earlier pass, quoted where it matters.

Finding numbers such as P53 or D6 refer to the full notes beside this file: `2026-11-09-virtual-startup-review-notes.md`.

## 1. Verdict

**The design stands.** It needs nine small amendments, listed in section 6. None changes what you approved.

**The plan is not ready to build as written.** It needs one revision pass, not a rewrite. The review produced 86 numbered points on the plan and 16 on the artboards. About two dozen are serious. They reduce to six decisions, in section 3.

If the plan were built exactly as written, three things would go wrong first:

1. **The limits would not bite.** Each employee's tool list is passed to the SDK as the auto-approve list. A tool on that list never reaches the permission callback, so the blast-radius check never runs for the tools that matter. The check itself matches text inside shell commands, which is easy to bypass.
2. **A led task could not finish.** Each run gets a fresh worktree and branch, nobody commits, the branch is deleted when the task is done, and the scheduler never picks up send-backs, the integration run, resumes or retries. The plan's own live test cannot pass.
3. **You would have nothing to look at, and the engine would be open to any web page.** This plan delivers no screen, the plan for the web app is not written, and the local API has no token and no origin check.

## 2. What is sound

- The subscription-login spike is the first task, as the spec requires. If it fails, little is wasted.
- A supervisor plus one worker process per run, with the lease enforced by a process that cannot be the one that hung, matches the spec and removes the outage class of 2026-11-08.
- The pure modules and the fake runtime replaying recorded streams are the right test strategy.
- Every Review Focus line has a test in the task that owns the code.
- The three artboards agree with each other. The office header shows $14.20 today, which equals the board's spend by team: 9.10 plus 4.70 plus 0.40.

## 3. The six decisions

Each decision gives what the plan says, why it fails, and the fix.

### Decision 1. Git belongs to the engine

**The plan says.** A new worktree and a new branch for every run, through `branchName(task, runId)`. Worktrees are created inside the user's repository under `.vs-worktrees`. The worktree "and its branch" are removed when the task is done. No step commits anything. A task names no repository and a team names no base branch. Merging is left to the lead's session.

**Why it fails.**

- Review, send-back, retry and resume all need the files the previous run left. A fresh worktree per run starts each of them from the base branch with nothing in it. The SDK also finds a session to resume by its working directory. Findings: P33, P53.
- Nobody commits, so the reviewer has no diff and there is nothing to merge. Finding: P58.
- Deleting the branch at done deletes unmerged work whenever the merge is waiting on a decision card, which is the default. Finding: P57.
- `Team.repos` is plural, but a task names no repository and a team names no base branch, so `createWorktree` cannot be called. Findings: P14, P54.
- The branch check is circular, because the engine generates the name it then checks. Finding: P56.

**The fix.**

- One worktree and one branch per task, created at the first run and reused by every later run of that task. Worktrees live outside the repository, under the data directory.
- The engine commits after each work run, with the employee as author. The engine performs merges and pushes. Employees get no git write commands.
- The engine records the repository's refs before and after each run and raises a card if anything outside the task branch moved.
- Add `Task.repo`, `Team.baseBranch` and a merge target per team. The Hire artboard already shows one: "may merge: team branch" and "may merge: track".
- The worktree is removed at done. The branch is kept until it is merged or you discard it on a card.
- The merge procedure is written down: who merges children into the parent branch, in what order, and what happens on a conflict.

Findings: P14, P19, P33, P53 to P58, P67, P69, D1, D2.

### Decision 2. The scheduler is the only thing that starts runs

**The plan says.** `pickNext` chooses among `queued` and `review` tasks. Everything else that needs a run starts somewhere else or nowhere: a send-back, a brief sent back once, the lead's integration run, a resume after a card is answered, a retry after an expired lease. `answer()` starts a run directly.

**Why it fails.**

- Those runs either bypass the concurrency limit and the budget check or never start. A task can sit in `running` with no run and no card. That is the silent idle this product exists to prevent. Findings: P28, P60, P71.
- The transition table is incomplete. There is no path from briefing or review to blocked, none from blocked to failed, none for a lead doing small work itself, and `completed` has no pair for a led parent. Task 5's own test blocks a task on a second expiry, which would throw `IllegalTransition` inside the tick for a brief or review run. Unblocking always returns to `running`, so a task blocked during review loses its place. Findings: P13, P61.
- The reviewer is "the team's lead". When the assignee is the lead, that is self-review. Finding: P27.
- A retry is decided by "the run is the task's first", but a task has many runs and nothing counts attempts. Finding: P31.
- Review rounds are unbounded. Finding: P64.
- The company daily cap is stored and never enforced. A fired assignee, or a led team without a lead, is never picked and never reported. Findings: P25, P26, P30.
- A card answer is a bare string, but the board shows answers with parameters, such as "Retry, 20 min". Findings: D6, P72.

**The fix.**

- A `run_requests` table. Every reason to start a run is a row: brief, work, review, send-back, integrate, resume, retry. The scheduler is the only reader and the supervisor is the only spawner.
- A complete transition table, written in the plan as a table, with `blockedFrom` stored so that unblocking returns to the right state.
- An invariant checked on every tick: every task that is not queued, blocked, done or failed has a live run or a pending request. A violation raises a card.
- The reviewer is the briefer of the parent task, never the author.
- `Run.attempt`, with one retry per failure. A maximum number of review rounds per task, default three, then a card.
- Card options as data: `{ id, label, effect, params }`. A table in the plan maps each card kind and option to its effect.

Findings: P13, P25 to P31, P60, P61, P64, P71, P72, D6.

### Decision 3. Structured tools and engine-run gates

**The plan says.** A brief, a review verdict and a done report are parsed from free assistant text or a fenced JSON block. Gate output is whatever the employee writes in its report. The IPC protocol carries `event` and `report` upward, and `report.outcome` is done or failed.

**Why it fails.**

- Parsing prose is fragile, and a missing block is read as "the lead did it itself". Findings: P44, P61, P62.
- Self-reported gate output is the invention risk the spec forbids. Findings: P45, P59.
- A worker cannot propose sub-tasks, ask for a decision, report a refused action or return a verdict, because the protocol has no message for any of them. Finding: P32.
- Ownership is checked once at creation, with an undefined rule for overlapping globs, and never enforced afterwards. Finding: P63.

**The fix.**

- An in-process SDK tool server in the worker, always loaded, with `propose_subtasks`, `submit_review`, `report_done`, `request_decision` and, for the chief of staff, `create_task`. Inputs are validated with zod. The worker forwards each call over IPC.
- `Task.gates: string[]`. After `report_done`, the engine runs the gates in the task's worktree and stores the real exit code and output with the run. The reviewer's re-run is the same engine call.
- Ownership is enforced after each work run: the engine compares the changed files with the task's globs and raises a card when a file outside them changed.
- `SubtaskProposal` gains priority, cap, retry and repository. A sub-task may itself be briefed when its assignee is a lead, which the chief of staff needs.

Findings: P15, P32, P44, P45, P59, P61 to P63, P65, P66, D7, D10.

### Decision 4. A permission and session model that bites

**The plan says.** Plan line 45 gives `SessionInput` an `allowedTools` list beside a `canUseTool` callback, and a `prompt` that is one string. No task sets `settingSources`. Skills reach an employee as a sentence in the system prompt. `decideTool` judges a Bash call by the text of its command. `toolsFor` removes commands such as `git push` from a list of tool names. Nothing states which login a session uses.

**Why it fails.**

- The SDK evaluates permissions in a fixed order: hooks, deny rules, ask rules, the permission mode, allow rules, and only then the callback. `allowedTools` is the allow rule. A tool listed there is approved before `canUseTool` is asked. Findings: P1, P68.
- The documentation says that omitting `settingSources` loads user, project and local settings. An employee working in a Receipts worktree would load the Receipts `CLAUDE.md` and your personal settings, hooks and MCP servers. An earlier pass found the default stated differently in two versions of the documentation, so it must be set explicitly either way. Finding: P2.
- A message to a running employee needs streaming input. A string prompt cannot receive one, so the spec's interrupt rule cannot be built on this interface. Findings: P11, P43.
- Naming a skill in the prompt does not mount it. Skills come from the setting sources or from the `plugins` and `skills` options. Findings: P42, D4.
- Matching command text is bypassed by a script file, a shell wrapper, an alias or a variable. Finding: P69.
- `toolsFor` subtracts command strings from tool names, which removes nothing. The `send_*` and `pay_*` tools it mentions are defined by no task. Finding: P68.
- If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present in the supervisor's environment, every employee bills the API instead of your subscription, silently. The Receipts backend keeps an Anthropic key in its `.env`, so this is a live risk on this machine whenever a shell has loaded that file. The spike clears only one of the two variables and does not check which login answered. Findings: P6, P51.
- `SessionInput` has no model, although the Hire form has a model picker. Findings: P3, D3.

**The fix.**

- `SessionInput` gains `tools` for what exists, `allowedTools` for read-only tools only, `disallowedTools` for scoped deny rules, and `settingSources`, `skills`, `plugins`, `model`, `maxBudgetUsd`, `mcpServers`, `additionalDirectories`, `env` and an abort signal.
- The runtime returns a session handle, `{ events, send(text), stop() }`, built on streaming input. The worker closes the input after a result so that the session ends.
- An adapter turns the engine's `{ allow, reason }` into the SDK's allow or deny shape. It still yields `finished` when the SDK throws after an error result. Finding: P9.
- Employee Bash runs inside the SDK sandbox, with deny rules for git writes. The spike must prove that the sandbox can host one xcodebuild run and one cargo run. If it cannot, the fallback is the ref snapshot from Decision 1, which detects and repairs instead of preventing.
- `Company.auth` is `subscription` or `api_key`. In subscription mode the worker passes an environment without the key variables. The health check confirms the login with `claude auth status`.
- The system prompt carries identity: company rules, team limits, role, skills and the memory index. The first user turn carries the brief, the done-condition, the gates and the mode. `Company` gains a `rules` field. Findings: P41, P47.

Findings: P1 to P3, P6, P9, P11, P41 to P43, P47, P51, P56, P68, P69, D3, D4.

### Decision 5. Budgets that work on a subscription login

**The plan says.** Plan line 469: `spendToday` sums `costUsd` over `usage` events, and `checkRunCap(run, task)` compares a run with the task's cap. Task 7 asserts `run.costUsd > 0`.

**Why it fails.**

- The SDK reports usage on the result message, once per run. No cap can stop a run in flight by watching events. Finding: P4.
- `total_cost_usd` is the SDK's own estimate. Whether it is filled in on a subscription login is not documented. If it is zero, every cap is inert and the Task 7 assertion fails. Findings: P5, P52, P70.
- `checkRunCap` compares one run with a cap that belongs to the task. A task with five runs may spend five times its cap. Finding: P70.
- The company daily cap is never checked. Finding: P25.
- A run stores dollars only, while the spec asks for token spend. Finding: P16.
- Nothing handles the subscription's usage limit. Three parallel sessions will reach it. As planned, every running task would fail, use its one retry and raise its own card. I found no documented shape for that error, so the spike must capture it. Finding: P76.

**The fix.**

- Each run records input and output tokens from the result. Cost is the SDK's figure when present, otherwise tokens times a price table kept in configuration.
- The cap applies to the task's total across its runs. Each run starts with `maxBudgetUsd` set to what remains, so the SDK stops the run itself.
- `pickNext` enforces the company cap as well as the team cap.
- A usage-limit result is its own outcome. It pauses the whole company, raises one card, consumes no retry, and resumes on your answer or when the limit resets.
- You decide whether caps are shown in dollars or in tokens. See section 8.

Findings: P4, P5, P16, P25, P52, P70, P76.

### Decision 6. Surface, safety and recovery

**Nothing to look at.**

- Plan line 527 calls the web app "plan 2" and describes it as a projection of the event stream. Plan 2 is not written. Task 13 starts the dogfood anyway. Spec line 93 allows the dogfood "when 1 to 5 exist", and steps 2 and 5 include the board and the chat. Finding: P78.
- `npm start` opens no browser, against spec line 82. The database path is relative and inside the repository. No route creates the first company or registers a repository. Finding: P81.
- `POST /api/chat` creates one task on the chief of staff's own team and returns no reply. The office artboard shows "writing 2 tasks from your chat". Findings: P79, D14.
- Event kinds are free strings. The board and the office are projections of events, so the kinds and their payloads are the contract with the web app. Finding: P39.
- The fix: this plan serves one plain page with the board columns, the decision cards with their answer buttons, and the chat line. Plan 2 is written before Task 12, so the API and a typed event catalogue are designed against a real consumer. The chat gets a `route` mode that calls `create_task` and returns `{ taskIds, reply }`. The routes listed under P83 are added.

**The local API is open.**

- The plan has no token and no `Origin` or `Host` check on `127.0.0.1:4317`. Finding: P82.
- Browsers do not apply the same-origin policy to WebSocket connections. Any page open in your browser could connect to `ws://127.0.0.1:4317/events` and read every event, including briefs and code.
- With DNS rebinding a hostile page becomes same-origin with the engine. It could then create a task, and an agent would run commands on your machine.
- The fix: a `Host` allowlist, an `Origin` check on every write and on the WebSocket upgrade, and a per-install token kept in a file with mode 0600. The token travels in a header or in the first WebSocket message, never in the query string. JSON bodies only, no CORS headers, and one test for each rule.

**Processes and recovery.**

- Killing the worker's pid leaves the Claude binary and its shell children alive. They keep writing to the worktree and spending. The fix is to start each worker as its own process group and kill the group. Finding: P35.
- A worker must exit when its channel to the supervisor closes. Otherwise a supervisor crash leaves sessions spending with nobody recording them. Finding: P50.
- Plan lines 500 and 507 re-attach to a live worker after a restart. A forked worker's channel dies with the supervisor, so there is nothing to attach to. `process.kill(pid, 0)` also succeeds for an unrelated process that reused the pid, which the supervisor might later kill. The fix: on restart, in-flight runs are marked expired and resume through the scheduler, and a kill needs the pid and the start time to match. Finding: P73.
- The login check reads a credentials file. On macOS the login lives in the Keychain. Use `claude auth status`. Finding: P75.
- The default lease of 10 minutes equals the Bash tool's longest timeout, so a long silent command races the lease. The fix: a 15 minute default, a per-task override, and a Bash timeout set below the lease. Finding: P34.
- State rows and events are written separately. One transaction per change should write both. Finding: P74.

**The plan's own live test cannot pass.** It needs a team branch, commits, engine-run gates and a scheduled integration run, none of which exist. A live led-team smoke test belongs directly after Task 9, not in Task 12. Finding: P80.

Findings: P34 to P36, P38, P39, P50, P73 to P75, P77 to P83, D5, D11, D14.

