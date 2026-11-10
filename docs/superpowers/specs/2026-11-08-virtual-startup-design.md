# Virtual startup: design

Date: 2026-11-08. Author: Neo (fork), with Filip. Status: for Filip's review before any implementation plan.

## 1. Purpose

A product that runs a software company made of AI employees. The user composes teams and roles, hires employees with chosen skills, puts work on a board, and watches a visual company do it. It is a product in itself, something others could use, with the visual company as part of what they buy. Receipts is the first tenant and the proving ground: today's prompt-driven system (one orchestrator, two PMs, a dozen engineer definitions, hand-written briefs) is what it replaces, and it is not retired until the product has carried a week of Receipts work.

What today's system got right and the product must keep: written decisions, contract first, briefs with file ownership, review before anything merges, gates before merges, nothing invented. What it got wrong and the product must make impossible by construction: an agent waiting idle with orders unread (two outages of three and two and a half hours on 2026-11-08), silence nobody notices, limits that live only in a prompt.

## 2. Decisions taken in the brainstorm

1. A product in itself, not only a tool for Receipts.
2. Local-first: it runs on the user's machine, on repositories on their disk.
3. A local web app: a server on the machine, the UI in the browser; a Mac wrapper can come later.
4. The board is the backbone; every piece of work is a task whether typed to the chief of staff or created on the board; any employee can be talked to directly.
5. Employees run as Claude Agent SDK sessions. The SDK embeds Claude Code locally and uses its login, so Filip's subscription carries the dogfood now; a user later points the same runtime at their own key. No CLI driving, no adapter layer. This rests on one assumption to verify as the very first task of the implementation plan: that the SDK, which embeds Claude Code, runs on the subscription login already present on the machine. If it does not, the fallback is a thin runtime interface with a CLI-backed implementation for personal use, and the rest of this design does not change.
6. Engine first with a thin office: the office is drawn from the engine's own events, never bolted on.
7. Led teams by default (a lead briefs and reviews); a team can be marked self-managed.
8. Autonomous within per-team budgets and blast radius; anything beyond stops the task and becomes a decision card for the user.
9. Architecture: a supervisor process plus one worker process per run, TypeScript end to end.

## 3. Core objects

One SQLite file per company holds seven kinds of thing.

- **Company**: name, the registered repositories (local paths), top-level limits, the concurrency setting.
- **Team**: name, purpose, lead or the self-managed flag, limits: spend per day, repositories and branch patterns it may write, and whether it may merge to the main branch, open pull requests, publish, send messages to people, spend money, delete.
- **Employee**: a singleton: name, role sentence, Claude Code skills to load, tool allowlist, model, team, lead flag, memory folder. Lives until fired; firing archives the memory.
- **Task**: title, brief, team or assignee, priority, state, parent (sub-tasks point at their parent), done-condition (a branch merged, a file delivered, a message approved), spend cap, retry allowed.
- **Run**: one execution of a task by one employee in one SDK session: lease, session id, worktree, token spend, outcome, stored gate outputs.
- **Event**: the append-only log every run and every user action writes. The board, the office, the cost lines, the stuck detection and the audit are views over this one log.
- **Decision**: a card for the user: the task, the employee, what it wants, the options, the cost so far. The answer is an event that resumes the run.

Task states: queued, briefing, running, review, blocked, done, failed. A red cell is a run whose lease expired or a task blocked past the threshold; amber is over budget or waiting on a card.

## 4. Runtime

- **Supervisor**: one Node process. Owns the database, the board, the budgets, the websocket. Never runs a model session. One loop: next runnable task, pick the employee, start a worker, grant a lease, watch events, renew or revoke.
- **Worker**: one child process per run, hosting one Agent SDK session for one employee on one task, in the task's worktree, with the employee's generated definition, skills, tools and memory. Writes every SDK message as an event over the pipe, reports the outcome, exits. A worker has no inbox and never waits.
- **Lease**: every run must emit an event within N minutes (a team setting; a brief may raise it for a known long step). On silence the supervisor kills the worker, marks the run expired, turns the cell red, retries once if the task allows, else raises a card. Silence is detected by a process that cannot be the one that hung.
- **Interrupts**: a message to a busy employee is queued by the supervisor and delivered as the next user turn of the running session, or the first turn of the next run; the sender sees delivered or waiting, never silence.
- **Concurrency**: a company setting enforced by the supervisor's loop; start at three parallel runs.
- **Resume**: the SDK session id is stored on the run; review rounds and answered questions continue the same session.

## 5. Flow through a team

Led team: intake (a run for the lead with the brief and the team's limits); briefing (the lead does small work itself or writes sub-tasks, each with an assignee, a brief, the files or area it owns, a done-condition; overlapping ownership between siblings is refused at creation); work (each child in its own worker and worktree); review (a lead run with the diff and the report: approve, send back with notes which resumes the child's session, or escalate to a card); completion (the lead's final run does the integration the limits allow and reports). Merging to the main branch is a limit that defaults to off, so by default that merge is a decision card.

Self-managed team: no briefing and no review; the assignee runs the task and reports; a task may ask for a reviewer explicitly.

The chief of staff is the lead of a team of one whose members are the other leads. What the user types in the company chat becomes tasks on the right teams under the chief of staff's name; it keeps the decision log; it can be fired.

## 6. Budgets, blast radius, decision cards

Limits live on the team and are enforced by the supervisor, never trusted to the employee. Spend: usage per event, totals per run, task, employee, team and day; a team cap stops new runs and turns the team amber; a task cap ends the run with a card (raise or stop). Blast radius: the worktree is created only on an allowed branch; merge, push, publish, send, pay and delete are tools mounted only where allowed; a refused action becomes a card, not a success. Cards: one deck, newest first, with options and cost; answering resumes the run; an unanswered card keeps its task visibly blocked and never silently expires. Every answer is an event, so the log is the audit.

## 7. Hiring, skills, memory

Hiring is a form: name, team, role sentence, lead or member, model, skills (installed Claude Code skills, the company's own skills folder, later skills written in the app), tools. The definition the SDK receives per run is generated from company rules, team purpose and limits, role sentence, skill list, tool allowlist and memory pointer; it is never hand-edited. Memory is a folder per employee: a one-page index read at the start of every run, notes written at the end, capped by the supervisor. Edits take effect at the next run; firing stops nothing in flight. Presets: chief of staff, engineering lead, engineer, reviewer, marketing writer, analyst; the Receipts roster becomes the first preset set, which is the migration path.

## 8. Board and office

One React app, one websocket, one event stream; board and office are projections of the same events and cannot disagree.

- Board: columns by state; a card shows task, team, assignee, elapsed time, spend, colour; opening it shows children, runs, the live event feed, the diff, and a chat box to the assignee or lead (an interrupt).
- Company page: the org chart with per-person status and today's spend, the hire button; a person's page shows role, skills, memory index, run history, chat.
- Decision deck pinned at the top of every view when not empty.
- Office, first version: a flat 2D room (PixiJS), approved by Filip on the canvas at https://claude.ai/artifact/T6Pf7v49PdieyCFQDWRgCb ("Office" artboard, version 5): a dark wood floor with a rug per team, night windows along the back wall, wooden desks with chairs and monitors, people as small figures in team-coloured shirts with a name tag (a lead in white), a glass meeting room with a whiteboard and a round table, a couch under a red lamp as the stuck corner, the chief of staff's desk with a tray of envelopes for the decisions, a kitchen and plants for charm, and a wall board with the counts and the longest silence. States: idle at the desk with a dark screen; working at the desk with the screen lit amber and a speech bubble naming the work; in the meeting room during a review run; on the couch under the red lamp when a lease expired or the task is blocked, with a Decide button. The only chrome is a floating strip (company, spend, view pills, the decision tray) and the chat line to the chief of staff. Driven only by events. The look is a room, never a dashboard; artwork replaceable without touching the engine.
- Chief-of-staff chat on every view; what is typed there becomes board tasks.

## 9. Repositories, gates, failure, health

Registered local repositories; a worktree per run on a task branch, removed when the task is done; no two runs share a worktree. Gates are named in the brief (the commands that must pass); the done-report carries their exact output; the reviewer re-runs them; the supervisor stores the outputs with the run. Merging follows the blast radius. Failure: a crash or expired lease retries once from the stored session if allowed, else red cell and card; an over-cap run stops with a card; a refused action stops with a card; an invalid briefing is sent back once, then a card. Nothing retries forever, nothing fails silently. Machine health on a timer: disk space, the SDK login state, each repository's git state, any local service the company depends on; a failed check blocks new runs on the affected repositories and raises a card. Durability: SQLite with WAL; a supervisor restart rebuilds the board from events and re-attaches to or expires in-flight runs.

## 10. Testing

The supervisor's state machine (states, leases, budgets, blast radius, briefing validation) is pure code with unit tests. Workers are tested against a fake runtime replaying recorded SDK event streams (leases, interrupts, crashes, resumes without a model). One end-to-end test runs a tiny sample repository through a led team with the real SDK on the user's login: brief, two sub-tasks, review, merge to a team branch. The office is tested by replaying events and asserting positions.

## 11. Stack

TypeScript throughout: Node supervisor and workers, the Claude Agent SDK, SQLite, React with PixiJS for the office, Vite. One command starts it and opens the browser.

## 12. First cut, in order

1. Supervisor, SQLite, events, workers with leases.
2. Teams, employees, hiring from presets, the board.
3. Led-team flow: briefing, ownership check, review, merge within limits.
4. Budgets, blast radius, decision cards, machine health.
5. Chat with the chief of staff and with any employee.
6. The thin office.

All six are required for the dogfood. When 1 to 5 exist, the Receipts company is created from the presets, the repositories registered, and one real Receipts task run end to end beside the current system; the current system is retired only after a week of carried work.

## 13. Out of scope for this spec

Hosted mode, billing, multiple users, API keys for other users, a skills marketplace, the Mac wrapper, richer office art. Each is a later spec.

## 14. Home

A new repository of its own, outside Receipts; Filip names it. This file moves there with the first commit.
