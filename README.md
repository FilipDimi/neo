# Virtual startup (the name is provisional)

A local-first web app that runs a software company of AI employees and shows it as an office. You set the teams, the roles and the headcount. Every piece of work is a task on a board. Each employee run is a Claude Agent SDK session on this machine's Claude login, started by a supervisor that enforces leases, budgets and limits. Anything beyond a team's limits becomes a decision card for you.

Status: built, and in use on Receipts since 2026-11-09 (engine plan task 15; `docs/dogfood-receipts.md`). The engine (plan tasks 1 to 14): supervisor, workers, leases, the team flow, git and gates run by the engine, budgets, health, hiring, chat, and the API. The screen (screen plan tasks 1 to 9): the office, the board and the hire view, with the decision deck and the chat line on each, served by the engine. The office needs WebGL; the board and the hire view do not. The whole branch was reviewed on 2026-11-09 and again on 2026-11-10, fifteen findings each time, all fixed; what is still open is in `docs/superpowers/reviews/2026-11-09-branch-review.md` and `docs/superpowers/reviews/2026-11-10-second-review.md`.

## Documents

| What | Where |
|---|---|
| The approved design, with its amendments of 2026-11-09 in section 15 | `docs/superpowers/specs/2026-11-08-virtual-startup-design.md` |
| The decisions behind it, in Filip's words | `docs/superpowers/specs/2026-11-08-virtual-startup-brainstorm-record.md` |
| The engine plan (15 tasks, revised after the review and the spike) | `docs/superpowers/plans/2026-11-08-virtual-startup-engine.md` |
| The screen plan (9 tasks: board, decision cards, chat, hiring, office) | `docs/superpowers/plans/2026-11-09-virtual-startup-screen.md` |
| The review of design and plan, its evidence, and the review of the built branch | `docs/superpowers/reviews/` |
| The three artboards: Office, Board, Hire | `docs/design/` (copies of https://claude.ai/artifact/T6Pf7v49PdieyCFQDWRgCb) |
| What the Agent SDK really does on this login | `docs/spike/2026-11-09-spike-findings.md` |

## Commands

```bash
npm run release     # copies the last commit to ~/.virtual-startup-app, installs, builds and tests it there, and makes it current
npm run live        # starts the real company from the current release: the code it runs is never this working folder
npm run stop        # stops the real company: asks every engine that runs from a release to end, as Ctrl-C would
npm run mcp         # the company's tools for a Claude session, as a server over stdio (a session starts this itself; see below)
npm start           # starts an engine from this working folder, for development; do not point it at a company that is at work
npm run demo        # a throwaway company on a scripted runtime: no model, nothing spent (see scripts/demo.ts for the words that make an employee hang, ask or be refused)
npm run build:web   # builds the screen into web/dist, which the engine serves; without it the engine serves a plain page
npm run watch:web   # rebuilds the screen on every save, for working on it against `npm run demo`; reload the page
npm run story       # records the company day the screen's tests replay (web/src/fixtures/story.json)
npm test            # unit and integration tests: no model, no network
npm run typecheck
npm run smoke       # live: a led team briefs, works, reviews and merges (about six short sessions; VS_LIVE_CONCURRENCY=1 runs them one at a time)
npm run spike       # live: what the Agent SDK does on this login (about 20 short sessions)
VS_LIVE=1 npx vitest run test/e2e/one-task.spec.ts   # live: one real task, and a refused write
```

Node 20.19 or newer. `npm run spike auth` checks the login with no model turn. The other probes are listed at the top of `scripts/spike-login.ts`.

## Where the real company runs

The company in `~/.virtual-startup` runs from a release, a copy of one commit under `~/.virtual-startup-app/releases/<commit>` with its own dependencies and built screen; `~/.virtual-startup-app/current` links to the one in use. Editing code here, running tests here, or breaking something here cannot touch a company at work. A fix reaches it in three steps: commit, `npm run release`, then stop the engine and `npm run live`. An engine that is running stays on the release it started from, and a release an engine is running from is never removed. The two newest releases are kept besides, so the one before is there to go back to: point `current` at it and start again. A page that was open across the change says so and asks to be reloaded.

## Tools for a Claude session

The company can be worked from any Claude session on this Mac, and so from a phone through one: `src/mcp/` is a small server with twenty tools. `now`, `tasks`, `task`, `cards` and `replies` read and cost nothing. `chat` talks to the chief of staff, `morpheus` to the admin and `message` to one employee by name; all three wait for the reply. `answer_card` presses a button on a card and `new_task` puts work on a team; a session is told to ask first for both. `start` starts the company when it is not running, as a process of its own that outlives the session.

The other nine are the setup tools: `company_setup` reads the whole setup, and `create_team`, `update_team`, `remove_team`, `hire`, `update_employee`, `fire`, `update_company` and `set_gates` change it at once. They take plain words (a team or a person by name, a model by its label, a set of skills by its name) and refuse in words that say what would work. They are the same nine the admin has inside the company (`src/supervisor/admin.ts`, reached over `POST /api/admin/<tool>`), where only the employee named as `adminId` is offered them, and only in a conversation.

## The admin, and who designs

Morpheus is the admin, in two places. Inside the company he is an employee on the Admin team who changes the setup when asked on his page or through the `morpheus` tool. In the Claude app there is a pinned chat called `morpheus`, which does the same with the setup tools and is also where the app's own code is changed: on a branch, tested, and merged, pushed and released only on the user's word, with the company restarted when nobody is running. Code is not changed from inside the company.

The design team is two more pinned chats, `designer-1` and `designer-2`. They are not employees of the engine, because only a session of the Claude desktop app is offered the tools that edit a design canvas (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`; measured). They work on the canvas itself, keep a copy of every board under `design-kit/` (ignored by git) for the people who build, and hand finished work to a team with `new_task`. The engine neither runs nor budgets them.

A team can be removed (`Team.removed`): its people are fired, it leaves every list and the screen, and it is refused while it has unfinished work. A team that builds with Xcode (`buildsWithXcode`, shown by its build folders) gets gates that can run `xcodebuild`: Swift's and Xcode's own sandboxes are switched off inside the gate's, and the test manager's socket, a pseudo-terminal and signals to the test runner are allowed (`src/git/gates.ts`).

The tools hold nothing and decide nothing: each is a call to the engine's own API on this machine, with the same token the screen uses. A session opened in this folder is offered them through `.mcp.json`. To have them in every session, as jarvis is, registered under the chief of staff's name so that "ask Neo" finds them:

```bash
claude mcp add --scope user neo -- bash -c 'cd "$HOME/.virtual-startup-app/current" && exec node_modules/.bin/tsx src/mcp/server.ts'
```

They run from the current release, like the company itself.

## Runtime

Later tasks take the SDK's names from here and from the spike findings, never from memory.

- `@anthropic-ai/claude-agent-sdk` 0.3.321, pinned exactly: the behaviour below was measured on this version and its bundled Claude Code 2.1.321. The native binary arrives as an optional dependency, so never install with `--omit=optional`.
- The company runs on the claude.ai login already on the machine. `subscriptionEnv()` (`src/runtime/env.ts`) builds the session's environment without any `ANTHROPIC_*` or `CLAUDE_*` variable or cloud-provider switch, because a key in the environment silently wins over the login. Using an API key instead is Filip's decision, never a fallback the code takes by itself.
- `startSession()` (`src/runtime/sdk.ts`) is the only place that calls the SDK. It returns `{ events, send, end, stop }` on streaming input and maps SDK messages to `RuntimeEvent`.

| Need | SDK option or field |
|---|---|
| Working folder | `cwd` |
| Identity of the employee | `systemPrompt` (a string) |
| Model | `model` |
| Which built-in tools exist | `tools` (list `Skill` here when skills are mounted) |
| Tools approved without asking | `allowedTools` (anything here skips every prompt) |
| Deny rules | `disallowedTools`, for example `Bash(git push *)` |
| The engine's say on every tool call | `hooks.PreToolUse`, answering `permissionDecision: 'allow' \| 'deny'` |
| The SDK's own prompt | `canUseTool`; the wrapper answers deny, since the hook decides first |
| Turn limit, spend limit | `maxTurns`, `maxBudgetUsd` (per run, not per session) |
| Resume | `resume: <session id>` |
| No user or project settings | `settingSources: []` |
| No claude.ai connectors | `strictMcpConfig: true` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
| Chosen skills | `plugins: [{ type: 'local', path }]` plus `skills: ['<plugin>:<skill>']` |
| Engine tools | `mcpServers` |
| The memory folder | `additionalDirectories` |
| Bash confinement | `sandbox` |
| The session's environment | `env` (replaces the environment; nothing is inherited) |
| Stop | `abortController` |
| Session id | `session_id` on the init message and on every result |
| A turn's spend | `model_usage_since_last_result` on the result |
| The session's running cost | `total_cost_usd` on the result (carries over a resume) |
| Why a turn ended | `subtype` on the result: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` |
| The plan's limit | the `rate_limit_event` message: `status`, `rateLimitType`, `resetsAt`, utilisation |
| Login check with no model turn | `claude auth status` with the bundled binary: exit 0 and `authMethod: "claude.ai"` |
