# Review of the whole branch, 2026-11-09

One independent reviewer read the branch after the engine (tasks 1 to 14) and the screen (tasks 1 to 9) were built. It verified each finding with a throwaway script. Every finding below was then reproduced as a failing test and fixed. The last column says what is still open.

## The fifteen findings

| # | Finding | What changed | Still open |
|---|---|---|---|
| 1 | A gate ran what an employee wrote outside any sandbox, with the engine's full environment, and a session could start one at will. | Every gate runs under `sandbox-exec`: it writes to the task folder, its own temp folder and the team's build folders; it cannot read a secret; it reaches this machine but not the network, and not the engine's port. It gets a short environment. A gate that cannot be confined is not run. (`src/git/gates.ts`) | A gate has no network, so a gate that downloads dependencies fails. `xcodebuild` inside it needs the same flags as in a session. |
| 2 | A link to a file that did not exist yet let Write leave the task folder. | Paths are followed link by link without asking the file system to do it (`src/git/paths.ts`). | Whether the SDK's Write tool follows such a link was not tested live; the engine now refuses it either way. |
| 3 | The engine ran git in a folder whose hooks and settings a session controlled. | Engine git runs no hooks, no file watcher, no signing, no outside diff program. Write and Edit into any `.git` are refused. Commands cannot write the folder's `.git` (checked live). A folder whose `.git` was replaced or re-pointed is refused. | |
| 4 | The read check compared spellings, not files. | Paths are resolved, case-folded and stripped of the `/System/Volumes/Data` alias. Grep and Glob search only inside the task folder and the memory folder. More credential files are on the list, and the engine's own token and database. | The Read tool still works from a list of what is refused, not a list of what is allowed. |
| 5 | Every secret in the engine's shell reached every session. | Sessions and gates get a short list of names (`src/runtime/env.ts`). Checked live: the login still works. | A team cannot yet add a name of its own to that list. |
| 6 | Work committed on another branch was reviewed, reported as landed, and lost. | The engine commits on the task's branch whatever the folder was switched to; a session's commands cannot switch it in the first place. | |
| 7 | A run the engine ended mid-turn cost $0 on every cap. | The run is charged for what its answers had used by then, at list prices. | It is an estimate, as every dollar figure on the subscription is. |
| 8 | A split task with no repository could never finish (and could hardly be split). | It finishes when the lead has put it together; files are owned only where there is a repository. | |
| 9 | A parent whose brief failed after its split was accepted never integrated. | The second brief checks whether the children are through. | |
| 10 | The staffing card asked for something the engine refused. | A task waiting for someone to be assigned can be reassigned; the card closes and the new assignee starts afresh. | |
| 11 | Two sessions could run on one task; a cancelled task could start. | One live run per task. A start is dropped when the task changed while its folder was being made. | |
| 12 | A run waiting on its own gate was killed as silent. | The run says it is waiting, every minute, and that renews its lease. | |
| 13 | The token check could be skipped with an encoded address. | The token is asked for by the route that answers. The screen never answers an address that is the API's under any spelling. | |
| 14 | The ownership check missed moves and misread names that are not plain ASCII. | Both ends of a move are named; names come back as they are. | |
| 15 | The office could freeze when the window was resized during a walk. | A redraw forgets the walks in flight. | |

Also fixed from the reviewer's shorter list: the tool-call hook now fails closed (`onFailure: 'block'`, and a decision that cannot be reached is a refusal); a team's or the company's daily cap that stops work raises one card a day, with a way to raise the cap; the page's "today" starts again at midnight.

## Checked live after the fixes

`VS_LIVE=1 npx vitest run --project engine test/e2e/one-task.spec.ts`: three short sessions on Haiku, all passing. One task done on the claude.ai login with the short environment and the stricter hook; a write outside the folder refused with a card; a session's commands could write its folder but not its `.git`, and reached neither a server on this machine nor the network.

## Not fixed

- `task/*` branches and the folders of failed tasks are never removed.
- A message to an employee whose run is just ending, or about a task with no live run, starts no run.
- When the user has a task's branch checked out in their own repository, publishing that branch fails with an engine-error card.
- A skill is delivered by mounting the whole plugin it belongs to; what else a plugin brings (hooks, agents) was not reviewed.
- The app's page sends no Content-Security-Policy header.
- An employee with the web search capability can send what it reads to the web. That is what the capability is.
