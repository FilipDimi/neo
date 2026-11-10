# Virtual startup (the name is provisional)

A local-first web app that runs a software company of AI employees and shows it as an office. You set the teams, the roles and the headcount. Every piece of work is a task on a board. Each employee run is a Claude Agent SDK session on this machine's Claude login, started by a supervisor that enforces leases, budgets and limits. Anything beyond a team's limits becomes a decision card for you.

Status: built, except the Receipts dogfood (engine plan task 15), which waits for Filip's go. The engine (plan tasks 1 to 14): supervisor, workers, leases, the team flow, git and gates run by the engine, budgets, health, hiring, chat, and the API. The screen (screen plan tasks 1 to 9): the office, the board and the hire view, with the decision deck and the chat line on each, served by the engine. The office needs WebGL; the board and the hire view do not.

## Documents

| What | Where |
|---|---|
| The approved design, with its amendments of 2026-11-09 in section 15 | `docs/superpowers/specs/2026-11-08-virtual-startup-design.md` |
| The decisions behind it, in Filip's words | `docs/superpowers/specs/2026-11-08-virtual-startup-brainstorm-record.md` |
| The engine plan (15 tasks, revised after the review and the spike) | `docs/superpowers/plans/2026-11-08-virtual-startup-engine.md` |
| The screen plan (9 tasks: board, decision cards, chat, hiring, office) | `docs/superpowers/plans/2026-11-09-virtual-startup-screen.md` |
| The review of design and plan, and its evidence | `docs/superpowers/reviews/` |
| The three artboards: Office, Board, Hire | `docs/design/` (copies of https://claude.ai/artifact/T6Pf7v49PdieyCFQDWRgCb) |
| What the Agent SDK really does on this login | `docs/spike/2026-11-09-spike-findings.md` |

## Commands

```bash
npm start           # the company in ~/.virtual-startup (or VS_DATA_DIR), at http://127.0.0.1:4317/; builds the screen first when it is missing or out of date
npm run demo        # a throwaway company on a scripted runtime: no model, nothing spent (see scripts/demo.ts for the words that make an employee hang, ask or be refused)
npm run build:web   # builds the screen into web/dist, which the engine serves; without it the engine serves a plain page
npm run watch:web   # rebuilds the screen on every save, for working on it against `npm run demo`; reload the page
npm run story       # records the company day the screen's tests replay (web/src/fixtures/story.json)
npm test            # unit and integration tests: no model, no network
npm run typecheck
npm run smoke       # live: a led team briefs, works, reviews and merges (about six short sessions)
npm run spike       # live: what the Agent SDK does on this login (about 20 short sessions)
VS_LIVE=1 npx vitest run test/e2e/one-task.spec.ts   # live: one real task, and a refused write
```

Node 20.19 or newer. `npm run spike auth` checks the login with no model turn. The other probes are listed at the top of `scripts/spike-login.ts`.

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
