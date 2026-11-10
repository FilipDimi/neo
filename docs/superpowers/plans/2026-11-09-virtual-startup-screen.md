# Virtual Startup Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (Filip chose: one session implements every task, one review of the whole branch at the end). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the one screen of the virtual startup: the board, the decision cards with their answer buttons, the chat, the hire form and the office, as three views of one event stream.

**Architecture:** A React app that holds one store. The store starts from `GET /api/snapshot` and then applies every event from the WebSocket with a pure reducer that only upserts the rows events carry. Every view is a pure selector over that store plus the clock, so the board and the office cannot disagree. The office is a pure scene model (rooms, desks, figures, bubbles, with positions) that a thin PixiJS layer draws; the artwork lives in one folder and can be replaced without touching the model. The header, the decision deck and the chat line are DOM, on every view.

**Tech Stack:** React 19, Vite, TypeScript, PixiJS 8, `vitest` with `jsdom` and `@testing-library/react`. The app lives in `web/`, imports the engine's `src/shared/` (types, events, `view.ts`), and builds to `web/dist`, which the engine serves.

**Spec:** `docs/superpowers/specs/2026-11-08-virtual-startup-design.md` section 8, as amended in section 15. **Design:** the three artboards in `docs/design/` (`Office.dc.html`, `Board.dc.html`, `Hire.dc.html`; 1440 × 900 each). **Engine:** `docs/superpowers/plans/2026-11-08-virtual-startup-engine.md`; this plan is built after its Task 14.

## Global Constraints

- The screen is driven only by the snapshot and the events. No view keeps state the engine does not have, except what is plainly local: the open drawer, a collapsed card, an unsent draft.
- The look is the artboards'. Colours, type and sizes are taken from them as tokens (Task 1); nothing is restyled by eye.
- The office is a room, never a dashboard. Its only chrome is the floating strip, the legend and the chat line.
- A decision card shows engine options as buttons. "Open diff", "Read it first" and "Not now" are the screen's own actions: they open or collapse, and never answer the card.
- The chief-of-staff chat line and the decision deck are on every view.
- When the engine cannot be reached, the screen says so in a banner and stops showing ages as if they were live. It never shows stale state as current.
- Real `<button>`, `<a>`, `<input>` with `<label>`; every icon-only button has an `aria-label`; text contrast as on the artboards.
- Money is shown as the engine reports it (question 1 of the engine plan decides dollars or tokens; the format lives in one function, `money()`).
- No test needs a model. The demo of Task 2 runs the real engine on a scripted runtime.

## What the screen needs from the engine

This table is the contract with the engine plan's Tasks 2 and 14. It also answers the artboard findings D1 to D16.

| On the screen | Comes from |
|---|---|
| Header: "Mon 18:40 · 3 of 3 seats busy" (D9) | the clock; live runs in the store; `company.concurrency` |
| Header: "Today $14.20 of $40"; footer and wall board: spend by team (D15) | `snapshot.spend`, then `usage` inside `run_event`; `company.dailyCapUsd`. One selector, `spendToday`, feeds all three places |
| Decision button and tray: "3 decisions", "3 on your desk", "3 for you" (D12) | open decisions in the store |
| Deck card: "Decision · 9 min · Engineering iOS", the text, the buttons (D6) | `Decision.askedAt`, its task's team, `text`, `options[]` (`label`, `id`); answered with `POST /api/decisions/:id/answer { optionId }` |
| Board columns, six of them; failed tasks (D9) | `Task.state`; a task failed today is shown at the top of "Done today" with a red edge and the word "failed" |
| Card line 2: "iOS · from Neo · P1 · cap $2", "iOS · MO · 41 min · $2.10", "C2 → PM ios" (D8) | `Task.createdBy`, `priority`, `capUsd`, assignee, the first run's `startedAt`, the task's runs' `costUsd`, `reviewerFor` |
| Card line 3: "event 40 s ago · gates 2/3", "diff 412 lines · gates passed", "splitting into 3 sub-tasks", "2 runs · lease expired twice · decision open 9 min", "merged track" (D7) | `cardLine()` from `src/shared/view.ts`: `Run.lastEventAt`, `gateResults` against `Task.gates`, `Run.diffLines`, `Run.activity`, the task's runs, open decisions, `Task.mergedInto` |
| Card colour and the legend: working, review, waiting on you, silent (D5) | `attention()` from `src/shared/view.ts` |
| Task drawer: children, runs, live feed, diff, chat box | `GET /api/tasks/:id`, `run_event` for that task, `GET /api/tasks/:id/diff`, `POST /api/tasks/:id/message` |
| Org chart: status per person, "led · $20/day · may merge: team branch" (D2) | `placement()` (Task 7); `Team.selfManaged`, `dailyCapUsd`, `repos[].mergeTarget`, `mayPublish` |
| Hire form: model picker (D3) | `hire-options.models` (`label`, `tier`); question 2 of the engine plan fills them |
| Hire form: skills, "+ 41 more installed", the "Selected:" line (D4) | `hire-options.skills` (`id`, `label`, `description`, `source`) |
| Hire form: tools, "send messages · off for this team" (D1) | `hire-options.capabilities` and `availableByTeam` |
| Presets line and "Start from a preset" | `hire-options.presets` |
| Office: who sits where (D11) | `placement()` over tasks, live runs and open decisions |
| Office: speech bubbles (D10) | `Run.activity` (`run_activity` events, set by the employee's `set_status` tool); without one, the mode and the task's title |
| Office: stuck corner, "silent 15 min · twice", Decide (D12) | the open `lease` card of that employee's task; its id opens the deck on that card |
| Office: chief of staff "writing 2 tasks from your chat", the tray (D14) | the route run's `activity`; open decisions |
| Office: wall board counts, "stuck", the longest silence (D13) | tasks by state (`blocked` is shown as "stuck"); failed today named in the sentence when above zero; `longestSilence()` |
| Office: kitchen line, legend (D16) | fixed copy; when `company.paused`, the kitchen line says why and until when |
| Chat line and replies | `POST /api/chat`; `message_sent` events |
| A task done by "you" (D8) | not in this version unless Filip says otherwise (question 4) |

## Review Focus

1. The connection drops or the engine restarts while the page is open: the screen must resync from a new snapshot, not keep counting "event 40 s ago" on dead data (Task 1 tests `takes a new snapshot when the server asks for a resync` and `marks the store offline when the socket closes`).
2. More people than the artboard shows: a team of nine, or six teams. Desks must not overlap and nobody may be drawn outside the floor (Task 7 test `fits one to six teams of one to twelve people without overlap`).
3. A long title, a long name, a long speech bubble: clipped with an ellipsis inside its card or bubble, never widening a column or leaving the room (Task 5 test `clips a long title to two lines`; Task 7 test `cuts a bubble at 40 characters`).
4. A card answered twice, by two tabs or a double click: the second answer comes back `ignored` and the card simply leaves; no error is shown (Task 4 test `a second click does not answer twice, and an ignored answer removes the card`).
5. An event kind or a field the screen does not know, from a newer engine: ignored, never a crash; a different `EVENT_VERSION` shows the "reload" banner (Task 1 test `ignores an unknown event kind and still upserts the rows it carries`).

---

### Task 1: The app's skeleton: tokens, the store, the live connection

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/tokens.css`, `web/src/tokens.ts`, `web/src/store/reduce.ts`, `web/src/store/store.ts`, `web/src/client/api.ts`, `web/src/client/live.ts`, `web/src/format.ts`
- Modify: `package.json` (scripts `watch:web`, `build:web`; there is no development server, since a second origin would need the token and a way past the Origin check), `vitest.config.ts` (a second project: `web/**/*.spec.{ts,tsx}` in `jsdom`), `tsconfig.json` (include `web`, `jsx: react-jsx`, `lib: DOM`)
- Test: `web/src/store/reduce.spec.ts`, `web/src/client/live.spec.ts`, `web/src/format.spec.ts`

**Interfaces:**
- Consumes: `EngineEvent`, `EventRow`, `EVENT_VERSION` and every row type from `src/shared/`; `GET /api/snapshot`; the WebSocket handshake `{ token, since }` and `{ resync: true }`.
- Produces (`tokens.ts` and `tokens.css`, the same values under the same names), from the artboards:
  - Ground `#0B0B0C`; surface `#151517`; raised `#1C1C1E`; line `#2A2A2E`; header line `#222226`; text `#F4F4F6`; soft `#C7C7CC`; muted `#9A9AA2`; dim `#6F6F78`.
  - States: working `#F5B700`; review `#76D3CC`; waiting on you `#F2C76B` (card ground `#1A1500`, edge `#6B5A1F`, text on it `#1A1200`); silent `#E0625A` (card ground `#1A0F0E`, edge `#6B2E2A`); done `#7CF0BF`; idle `#3A3A40`; lead `#F4F4F6`; chosen chip ground `#1A1F2E`, edge `#4A5B8A`.
  - Type: Inter 400, 500, 600, 700. 17/700 company name; 22/700 page title; 14 inputs; 13 body; 12 chips; 11/600 uppercase labels with 0.08em spacing; 10 in the office.
  - Shape: pills 999px; cards 12px; deck cards 14px; inputs 10px; header 64px; board gap 14px; a card's state edge 3px on the left.
- Produces (`reduce.ts`): `type Store = { version; online: boolean; company; repos; teams; employees; tasks; runs; requests; decisions; messages; health; planUsage; lastEventId; spend }`, each collection a `Map` by id; `fromSnapshot(snapshot): Store`; `reduce(store, row: EventRow): Store`, pure: upsert every row the event carries (`task`, `run`, `decision`, `employee`, `team`, `repo`, `company`, `message`, `request`), drop a request when its run starts, add a `usage` inside a `run_event` to `spend`, set `run.activity` on `run_activity`, ignore unknown kinds.
- Produces (`store.ts`): `createStore(initial)`, `useStore(selector)` on `useSyncExternalStore`, `useNow(ms = 1000)`.
- Produces (`api.ts`): `api.get(path)`, `api.post(path, body)`, `api.patch(path, body)`, each sending the token from `<meta name="vs-token">`; a failed call throws `ApiError { status; message }`.
- Produces (`live.ts`): `connect(store, { since }): { close() }`: sends `{ token, since }` first, applies rows in order, on `{ resync: true }` or a version mismatch refetches the snapshot, reconnects with backoff (1 s doubling to 15 s), and sets `store.online`.
- Produces (`format.ts`): `money(usd): string` (`$14.20`; `$0.40`); `ago(iso, now): string` (`5 s`, `41 min`, `1 h`); `clock(now): string` (`Mon 18:40`); `initials(name): string`.

- [ ] **Step 1: Install.** Run: `npm i react react-dom pixi.js && npm i -D vite @vitejs/plugin-react @types/react @types/react-dom jsdom @testing-library/react @testing-library/user-event`

- [ ] **Step 2: Write the failing tests**

```ts
it('builds maps from a snapshot', …);
it('upserts the task an event carries and keeps the others', …);
it('adds a turn\'s usage to the company, the team and the employee spend', …);
it('sets a run\'s activity from run_activity', …);
it('drops a request when its run starts', …);
it('ignores an unknown event kind and still upserts the rows it carries', …);            // Review Focus 5
it('sends the token and since as its first message', …);                                // live.spec, a fake socket
it('takes a new snapshot when the server asks for a resync', …);                        // Review Focus 1
it('marks the store offline when the socket closes, and online after it reconnects', …); // Review Focus 1
it('formats money, ages and the clock as the artboards do', () => { expect(money(14.2)).toBe('$14.20'); expect(ago(t0, plus(t0, 41 * 60))).toBe('41 min'); expect(clock(monday1840)).toBe('Mon 18:40'); });
```

- [ ] **Step 3: Run:** `npx vitest run web/src/store web/src/client web/src/format.spec.ts` — expected: FAIL, modules not found.
- [ ] **Step 4: Implement.** `vite.config.ts`: root `web`, a dev proxy of `/api` to `127.0.0.1:4317`, build to `web/dist`.
- [ ] **Step 5: Run** `npm test && npm run typecheck` — expected: PASS.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "web: tokens, the event store, the live connection"`

### Task 2: The story: a recorded company day, and a demo with no model

**Files:**
- Create: `scripts/story.ts`, `test/fixtures/story/script.json`, `web/src/fixtures/story.snapshot.json`, `web/src/fixtures/story.events.json`
- Modify: `package.json` (scripts `story`, `demo`)

**Interfaces:**
- Consumes: the engine with `VS_RUNTIME_MODULE=test/fixtures/fakeRuntime.ts` (engine Task 14).
- Produces: `npm run story` runs the real engine in a temp data directory on the scripted runtime through one company day, and writes the snapshot taken before the first task and every event after it. The day reaches every state the artboards draw: three teams (two led, one self-managed) and a chief of staff; a chat message that becomes two tasks; a briefing that splits into three; work with activity lines and gates; a review with a send-back and an approval; a lease that expires twice and its card; a merge card; a refused write and its card; a task done and merged; a failed task; a usage-limit pause that lifts.
- Produces: `npm run demo` starts the engine the same way with the story playing in real time (lease minutes shortened to seconds), so the whole screen can be looked at without spending anything.

- [ ] **Step 1: Write `script.json` and `story.ts`.**
- [ ] **Step 2: Run:** `npm run story` — expected: both fixture files written; the events file ends with no open request and at least one open decision of each kind listed above.
- [ ] **Step 3: Commit:** `git add -A && git commit -m "web: a recorded company day and a demo that needs no model"`

### Task 3: The selectors: what each view shows

**Files:**
- Create: `web/src/model/select.ts`
- Test: `web/src/model/select.spec.ts` (replays `story.events.json` up to named points)

**Interfaces:**
- Consumes: `Store`; `attention`, `cardLine`, `longestSilence` from `src/shared/view.ts`.
- Produces, all pure, all `(store, now)`:
  - `header(store, now): { company; clock; seatsBusy; seats; spentToday; capToday; openDecisions; paused: string|null }`.
  - `spendToday(store): { company; byTeam: { teamId; name; usd }[] }`.
  - `deck(store, now): { id; kind; age; team: string|null; text; options: { id; label; primary: boolean }[]; taskId: string|null; local: ('open_diff'|'read_first'|'not_now')[] }[]`, newest first; the first option is primary; `open_diff` is offered when the card has a task with a branch, `read_first` for a `question` or `tool` card with a task, `not_now` always.
  - `board(store, now): { key: 'queued'|'briefing'|'running'|'review'|'blocked'|'done'; title; count; cards: BoardCard[]; more: number }[]`, six columns in that order; "Done today" holds tasks done or failed since local midnight, failed first, at most 8 and the rest counted in `more`; within a column by priority, then age.
  - `BoardCard = { taskId; title; line2; line3: string|null; attention; failed: boolean }`.
  - `orgChart(store, now): { chief: Person|null; teams: { id; name; summary; lead: Person|null; members: Person[] }[] }`, `Person = { id; name; tag; status: 'working'|'reviewing'|'idle'|'stuck' }`; `summary` reads "led · $20/day · may merge: team" or "self-managed · $5/day · may publish: no".

- [ ] **Step 1: Write the failing tests**

```ts
it('counts seats busy from live runs against the company\'s concurrency', …);
it('the header\'s spend equals the sum of the teams\' spend', () => { const s = spendToday(store); expect(sum(s.byTeam.map(t => t.usd))).toBeCloseTo(s.company, 10); expect(header(store, now).spentToday).toBe(s.company); });   // D15
it('orders the deck newest first and marks the first option primary', …);
it('offers Open diff only for a card whose task has a branch', …);
it('puts every task in exactly one of six columns', …);
it('shows a task failed today at the top of Done today, marked failed', …);
it('a queued card reads "<team> · from <creator> · P1 · cap $2"', …);
it('a running card reads its assignee, its elapsed time and its spend', …);
it('a review card reads "<author> → <reviewer>" and its diff size', …);
it('limits Done today to eight cards and counts the rest', …);
it('summarises a led team and a self-managed team as the Hire artboard does', …);
it('marks a person stuck when their task has an open lease card', …);
```

- [ ] **Step 2: Run:** `npx vitest run web/src/model/select.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "web: selectors for the header, the deck, the board and the org chart"`

### Task 4: The frame: header, decision deck, chat line

**Files:**
- Create: `web/src/App.tsx`, `web/src/frame/Header.tsx`, `web/src/frame/Deck.tsx`, `web/src/frame/DecisionCard.tsx`, `web/src/frame/ChatLine.tsx`, `web/src/frame/Banner.tsx`, `web/src/frame/frame.css`
- Test: `web/src/frame/Deck.spec.tsx`, `web/src/frame/ChatLine.spec.tsx`, `web/src/frame/Header.spec.tsx`

**Interfaces:**
- Consumes: `header`, `deck` (Task 3); `api.post('/api/decisions/:id/answer')`; `api.post('/api/chat')`.
- Produces: `App` with three views behind the pills Office, Board, Hire (the view is in the URL hash; the office is the first); `Header` as on the Board artboard (company, "Mon 18:40 · 3 of 3 seats busy", the pills, "Today $14.20 of $40", the amber "3 decisions" button); on the office view the same content floats as the artboard's two pills. `Deck`: the strip of the Board artboard, cards 360px wide, pinned under the header on every view while a decision is open, and scrolled to a card by `openDeck(decisionId)`. `DecisionCard`: label line "Decision · <age> · <team>", the text at 14/600, the option buttons (primary amber, the rest raised), then the local actions as quiet buttons. A `question` card with no options shows a text field and "Answer". `ChatLine`: the artboard's pill input, placeholder "Tell <chief of staff's name> what to do next…", "Send"; the last reply shows above it for 20 seconds and stays in the drawer's history. `Banner`: "The engine is not answering. Trying again…" while offline; "The engine was updated. Reload." on a version mismatch.

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows one card per open decision with its options as buttons', …);
it('answers with the option\'s id', async () => { await user.click(screen.getByRole('button', { name: 'Retry, 30 min' })); expect(posted).toEqual(['/api/decisions/d1/answer', { optionId: 'retry' }]); });
it('a second click does not answer twice, and an ignored answer removes the card', …);      // Review Focus 4
it('Not now collapses the card without calling the engine', …);
it('Open diff opens the task\'s drawer on its diff without answering', …);
it('a question with no options takes typed text', …);
it('sends the chat text and clears the field', …);  it('shows the chief of staff\'s reply when it arrives', …);
it('shows the offline banner when the store is offline', …);
it('the decisions button opens the deck and reads its count', …);
```

- [ ] **Step 2: Run:** `npx vitest run web/src/frame` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Look at it:** `npm run demo` and `npm run watch:web`; compare the header and the deck with `docs/design/Board.dc.html` at 1440 × 900.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "web: the header, the decision deck with its answers, the chat line"`

### Task 5: The board

**Ask Filip question 4 (can he be assigned tasks) before this task.** Written for: no.

**Files:**
- Create: `web/src/board/Board.tsx`, `web/src/board/Card.tsx`, `web/src/board/TaskDrawer.tsx`, `web/src/board/NewTask.tsx`, `web/src/board/board.css`
- Test: `web/src/board/Board.spec.tsx`, `web/src/board/TaskDrawer.spec.tsx`, `web/src/board/NewTask.spec.tsx`

**Interfaces:**
- Consumes: `board`, `spendToday` (Task 3); `GET /api/tasks/:id`, `GET /api/tasks/:id/diff`, `POST /api/tasks/:id/message`, `PATCH /api/tasks/:id`, `POST /api/runs/:id/stop`, `POST /api/tasks`.
- Produces: `Board`: six equal columns, each a label line (uppercase, the count on the right, coloured for Running, Review and Blocked) over its cards; the footer with the colour legend ("working · review · waiting on you · silent past its lease") and "Spend today by team: …". `Card`: the artboard's card: title 13/600 in at most two lines, line 2 muted, line 3 in the state's colour, a 3px left edge in the attention colour; a blocked card on the red ground. `TaskDrawer` (a right-hand panel opened by a card, by a deck card's "Open diff" or by the office): the brief and done-condition; children; runs with mode, employee, outcome, cost and gate results; the live feed (assistant text and tool names from `run_event`, newest last, following unless scrolled up); the diff; a message box to the assignee or the lead, showing "delivered" or "waiting"; "Stop the run", "Cancel the task", priority and assignee. `NewTask`: title, brief, team, assignee (required on a self-managed team), priority, done-condition, repository, gates (the repository's named gates), cap.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders six columns with their counts', …);
it('clips a long title to two lines', …);                                                // Review Focus 3
it('colours a card\'s edge by its attention', …);
it('opens the drawer on click and loads the task', …);
it('appends live events for the open task and ignores other tasks\'', …);
it('sends a message and shows delivered or waiting', …);
it('asks before cancelling a task', …);
it('requires an assignee for a self-managed team and offers only that repository\'s gates', …);
it('posts a new task with the fields the engine expects', …);
```

- [ ] **Step 2: Run:** `npx vitest run web/src/board` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Look at it** against `docs/design/Board.dc.html`.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "web: the board, the task drawer, the new-task form"`

### Task 6: The company: org chart, hiring, teams, first setup

**Files:**
- Create: `web/src/company/Company.tsx`, `web/src/company/OrgChart.tsx`, `web/src/company/HireForm.tsx`, `web/src/company/TeamForm.tsx`, `web/src/company/PersonPage.tsx`, `web/src/company/Setup.tsx`, `web/src/company/company.css`
- Test: `web/src/company/HireForm.spec.tsx`, `web/src/company/OrgChart.spec.tsx`, `web/src/company/TeamForm.spec.tsx`, `web/src/company/Setup.spec.tsx`

**Interfaces:**
- Consumes: `orgChart` (Task 3); `GET /api/hire-options`; `POST /api/employees`; `GET`/`PATCH /api/employees/:id`; `POST /api/employees/:id/fire`; `POST /api/employees/:id/message`; `POST`/`PATCH /api/teams`; `POST /api/setup`; `POST /api/repos`; `PATCH /api/company`.
- Produces: the Hire artboard. Left, 420px: "Org chart"; the chief of staff's row; per team its name and `summary`, the lead's row, the members as chips with a status dot (amber working, teal reviewing, grey idle, red stuck on the red ground); "New team". Right: "Hire an employee" and its one-line explanation; Name; Team (with "New team…"); "Role, in one sentence"; Model (each option "<label> · <what the tier is for>"); Kind (Member or Lead; Lead is disabled when the team has one); "Skills · loaded first on every run" as chips, chosen ones first, then "+ N more installed" opening a searchable list, and the "Selected:" line built from the chosen skills' descriptions; "Tools · what the runtime mounts" as capability chips, an unavailable one dashed and reading "<label> · off for this team"; "Hire <name>"; "Start from a preset" (fills role, skills, tools, model and kind); the presets line.
- Produces: `TeamForm`: name, purpose, led or self-managed, the daily cap, repositories with base branch and merge target ("none" by default), the six permissions, the lease, and "Builds with Xcode", which sets the build profile's folders. `PersonPage` (opened from the org chart or the office): role, skills, tools, today's spend, the memory index, the run history, a message box, Edit and Fire (Fire asks first). `Setup` (shown when there is no company): name, rules, repositories with their named gates, the model for each tier.

- [ ] **Step 1: Write the failing tests**

```tsx
it('lists the chief of staff, then each team with its lead and members', …);
it('shows a stuck member on the red ground', …);
it('offers skills chosen first and counts the rest as "+ N more installed"', …);
it('builds the Selected line from the chosen skills\' descriptions', …);
it('shows an unavailable capability as "<label> · off for this team" and does not send it', …);
it('disables Lead when the team already has one', …);
it('a preset fills role, skills, tools, model and kind', …);
it('posts the hire form\'s fields and names the button after the person', …);
it('a new team has no merge target unless one is chosen', …);
it('"Builds with Xcode" sets the build profile', …);
it('setup posts the company, then each repository', …);
```

- [ ] **Step 2: Run:** `npx vitest run web/src/company` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Look at it** against `docs/design/Hire.dc.html`.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "web: the org chart, hiring, teams, first setup"`

### Task 7: The office as a model: rooms, seats, who is where

**Files:**
- Create: `web/src/office/layout.ts`, `web/src/office/placement.ts`, `web/src/office/scene.ts`
- Test: `web/src/office/layout.spec.ts`, `web/src/office/placement.spec.ts`, `web/src/office/scene.spec.ts`

**Interfaces:**
- Consumes: `Store`; `longestSilence`, `spendToday`.
- Produces (`placement.ts`): `placement(employeeId, store, now): { where: 'desk'|'meeting'|'stuck'; screen: 'dark'|'lit'; bubble: string|null; tone: 'plain'|'review'|'stuck'; decisionId: string|null }`, the first rule that holds (D11):
  1. Their task has an open `lease` card, or they are the assignee of a `blocked` task → `stuck`, on the couch under the red lamp, bubble "silent <lease> min · twice" (or the card's first words), tone `stuck`, with the decision's id.
  2. They are the assignee of a task in `review`, or have a live run in mode `review` → `meeting`; one label for the pair, "review · <title> · <n> lines", tone `review`.
  3. They have a live run → `desk`, screen `lit`, bubble = the run's activity, else "briefing <title>" in brief mode, else the title.
  4. Otherwise → `desk`, screen `dark`, no bubble.
  A bubble is cut at 40 characters with an ellipsis.
- Produces (`layout.ts`), on a 1440 × 900 floor as on the Office artboard: fixed rooms `MEETING { x: 970, y: 118, w: 380, h: 330 }`, `CHIEF { x: 430, y: 490, w: 360, h: 220 }`, `STUCK { x: 830, y: 490, w: 240, h: 220 }`, `KITCHEN { x: 1110, y: 490, w: 240, h: 220 }`, `WALL { x: 92, y: 740, w: 1258, h: 90 }`, floor `{ x: 40, y: 40, w: 1360, h: 820 }`; `rugs(teamCount): Rect[]`: team rugs share the top band (x 92 to 930, y 118, h 330, 38px apart) and the bottom-left slot (`{ x: 92, y: 490, w: 300, h: 220 }`): one to three teams as the artboard (two on top, the third bottom left), four and five put three and four on top, a sixth and later team share one rug that lists their names; `seats(rug, memberCount, hasLead): { desks: Rect[]; lead: Rect|null; scale: number }`: desks 120 × 56 on a 180 × 160 pitch from the rug's top left, the lead's desk 70 × 120 at the right edge, the whole group scaled down to fit when there are more than four members; `PALETTE`: rug, rug edge, label and shirt colours per team index (the artboard's three: `#1A2434`/`#1F2C40`/`#6C7A95`/`#4A7DE0`, `#2E1F1B`/`#3A2823`/`#9A6E62`/`#D94A48`, `#2A2A1A`/`#35351F`/`#8A8A5A`/`#F2C76B`; then three more in the same lightness: `#1B2A22`/`#223629`/`#6A9580`/`#4CB782`, `#251E33`/`#30273F`/`#857A9E`/`#9B7BE0`, `#172A2C`/`#1E3538`/`#6A9396`/`#3FB6C4`).
- Produces (`scene.ts`): `officeScene(store, now): SceneNode[]`, back to front, `SceneNode = { id; kind: 'floor'|'window'|'rug'|'label'|'desk'|'monitor'|'chair'|'person'|'tag'|'bubble'|'whiteboard'|'table'|'couch'|'lamp'|'tray'|'counter'|'plant'|'wallboard'|'button'; x; y; w; h; props }`: the artboard's furniture; one desk, monitor (lit or dark), chair, person (shirt in the team's colour, white for a lead, dark for the chief of staff; skin tone chosen from three by a hash of the id), and name tag per employee at the seat their placement gives; bubbles; the meeting room's whiteboard and table with the pair seated; the couch, lamp and a Decide button carrying `decisionId`; the chief of staff's tray with "N for you"; the wall board's six counts (queued, briefing, running, review, stuck, done) and its sentence: "Longest silence on the floor <age> against a <lease>-minute lease. Spend today <total> of <cap>: <team> <usd>, … <N> things on your desk."; the kitchen line "nobody here · everyone is at a desk", or "paused: <reason> until <time>" when the company is paused.

- [ ] **Step 1: Write the failing tests**

```ts
it('seats an idle employee at their desk with a dark screen and no bubble', …);
it('lights the screen and shows the activity while a run is live', …);
it('falls back to the task\'s title when the run has set no activity', …);
it('puts the author of a task in review in the meeting room before the review run starts', …);     // D11
it('brings the lead into the meeting room while its review run is live', …);
it('puts an employee whose lease card is open on the couch, with the decision\'s id', …);          // D12
it('stuck wins over review, and review over working', …);
it('cuts a bubble at 40 characters', …);                                                           // Review Focus 3
it('lays out one, two and three teams where the artboard has them', () => { expect(rugs(3)[0]).toEqual({ x: 92, y: 118, w: 470, h: 330 }); expect(rugs(3)[2]).toEqual({ x: 92, y: 490, w: 300, h: 220 }); });
it('fits one to six teams of one to twelve people without overlap', () => { /* every desk inside its rug, every rug inside the floor, no two rugs or desks intersect */ });   // Review Focus 2
it('gives every employee exactly one person node', …);
it('the tray reads the number of open decisions', …);
it('the wall board\'s counts match the board\'s columns', () => expect(wallCounts(scene)).toEqual(board(store, now).map(c => c.count)));
it('the wall board names the longest silence and the lease', …);
it('replaying the story moves NH from desk to couch when the lease expires twice', …);
```

- [ ] **Step 2: Run:** `npx vitest run web/src/office` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "web: the office as a scene: layout, placement, wall board"`

### Task 8: The office drawn: PixiJS and the artwork

**Files:**
- Create: `web/src/office/Office.tsx`, `web/src/office/draw.ts`, `web/src/office/art/index.ts`, `web/src/office/art/furniture.ts`, `web/src/office/art/people.ts`, `web/src/office/office.css`
- Test: `web/src/office/draw.spec.ts`

**Interfaces:**
- Consumes: `officeScene` (Task 7); `openDeck`, the person page, the task drawer.
- Produces (`art/`): `ART: Record<SceneNode['kind'], (node: SceneNode) => DisplayObject>`: one drawing function per node kind, in PixiJS `Graphics` and `Text`, with the artboard's colours: floor `#2B241F` with plank lines `#221C18` every 120px and an inner edge `#1C1714`; night windows `#0F1D33` to `#162A4A` with `#F2C76B` lights; desk `#8A6A4A` to `#6E5238` over a `#4A3626` shadow; monitor `#1A1A1E` in a `#2E2E33` frame, a lit screen `#F5B700` with a soft glow; chair `#3A2E28`; skin `#E8C39E`, `#8D5A3C`, `#C98B6B`; name tag on `rgba(11,11,12,0.8)`; bubble `#F4F4F6` with `#0B0B0C` text; the meeting room a `rgba(118,211,204,0.07)` glass with a `rgba(118,211,204,0.45)` edge; the stuck corner `#2A1715` with the `#E0625A` lamp and its glow; couch `#4A3A36`; tray `#F2C76B` with `#F4F4F6` envelopes; plants `#2E6B4A` and `#3A8A5C` in `#1E2A24` pots; kitchen `#1A1A1C`. This folder is the only place that knows how anything looks.
- Produces (`draw.ts`): `sync(stage, scene: SceneNode[], previous: Map<string, DisplayObject>): Map<string, DisplayObject>`: adds, updates and removes display objects by node id; a person whose position changed moves there over 600 ms; a newly lit screen fades in over 300 ms; nothing else animates.
- Produces (`Office.tsx`): the canvas scaled to fit the window with the 1440 × 900 floor centred on `#15120F`; the floating strip and pills (Task 4's header content), the legend at the bottom left ("lit screen = working", "meeting room = a review", "red lamp = stuck, needs you", "white shirt = a lead"), and the chat line on the wall board strip, as DOM over the canvas. Clicking a person opens the person page; a bubble or a desk with a live run opens that task's drawer; Decide and the tray call `openDeck`. Each clickable node has a DOM button of the same size and position over the canvas, with the person's name and status as its label, so the room works from the keyboard and for a screen reader.

- [ ] **Step 1: Write the failing tests** (a stub stage that records children; no WebGL)

```ts
it('adds one display object per scene node and removes those that left', …);
it('reuses the object of a node that stayed', …);
it('moves a person to a new seat instead of recreating them', …);
it('has a drawing function for every node kind', () => { for (const kind of ALL_KINDS) expect(ART[kind]).toBeTypeOf('function'); });
```

- [ ] **Step 2: Run:** `npx vitest run web/src/office/draw.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Look at it:** `npm run demo` and `npm run watch:web`; put the office beside `docs/design/Office.dc.html` at 1440 × 900 and fix every difference in position, colour and copy; then watch the story play: a screen lights, a pair walks to the meeting room, NH ends on the couch, the tray fills.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "web: the office drawn in PixiJS"`

### Task 9: Served by the engine, and the last look

**Files:**
- Modify: `src/api/server.ts` (serve `web/dist` when it exists, with the token meta tag; else `plain.html`), `src/main.ts` (build the web app on `npm start` when `web/dist` is missing or older than `web/src`), `package.json` (`start`), `README.md`
- Test: `test/api/static.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('serves the built app with the token in its meta tag', …);
it('serves the plain page when the app is not built', …);
it('serves the app\'s index for an unknown path that is not under /api', …);
```

- [ ] **Step 2: Run:** `npx vitest run test/api/static.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck && npm run build:web` — PASS.
- [ ] **Step 5: The last look.** `npm run demo`, then in the browser at `http://127.0.0.1:4317/`: each of the three views beside its artboard; answer a card on each view; send a chat line; hire from a preset; stop the engine and see the banner; start it and see the screen resync.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "web: served by the engine; one command starts everything"`

---

## Self-review notes

- **Spec section 8.** One app, one socket, one stream → Task 1. Board (columns, card, drawer with children, runs, feed, diff, chat box) → Tasks 3, 5. Company page (org chart with status and spend, hire button, person page) → Task 6. Decision deck pinned on every view → Task 4. Office (floor, rugs, windows, desks, figures, meeting room, couch and lamp, the chief of staff's tray, kitchen, plants, wall board; the four states; the floating strip and the chat line; driven only by events; artwork replaceable) → Tasks 7, 8. Chat on every view → Task 4. Section 10's "replaying events and asserting positions" → Task 7's tests over the story of Task 2.
- **Artboard findings.** D1, D3, D4 → Task 6 and `hire-options`. D2 → the team summary and `TeamForm`. D5, D7 → `attention` and `cardLine` in the engine's `view.ts`, used by Tasks 3 and 5. D6 → Task 4. D8 → `createdBy` on the card; "you" waits on question 4. D9 → Task 3's columns and header. D10, D11, D12, D13, D14, D16 → Task 7. D15 → one `spendToday` selector, with a test.
- **Added beyond the artboards, each needed by the spec or the review:** the task drawer, the new-task form, the team form, the person page, first setup, the offline banner, three more team colours, and the layout rule for more than three teams.
- **Names used across tasks.** `Store`, `reduce`, `useStore`, `useNow`, `api`, `money`, `ago`, `clock` (Task 1) → all. The story fixtures (2) → 3, 7. `header`, `deck`, `board`, `orgChart`, `spendToday` (3) → 4, 5, 6, 7. `openDeck` (4) → 5, 8. `placement`, `rugs`, `seats`, `officeScene`, `SceneNode` (7) → 8.
