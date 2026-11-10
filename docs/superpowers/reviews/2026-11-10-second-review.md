# Second review, and what live use showed, 2026-11-10

Filip was away and asked for reviews to be run and every finding fixed, so that the company could be used that evening without trouble. This is the record of that afternoon: one more independent review of the whole branch (fifteen findings, all fixed), a third review of the fixes themselves, and three defects that no review found but live runs on a throwaway repository did.

Every finding was first reproduced as a failing test, then fixed. `npm test`: 589 passed, 3 skipped (the live ones). `npx tsc --noEmit`: clean.

## The fifteen findings of the second review

| # | Finding | What changed | Still open |
|---|---|---|---|
| 1 | A gate could move the task folder away and put another in its place; a session could change the folder's git settings so that the engine's own git ran a program. | The gate's sandbox refuses to rename or remove the folder itself. The engine records a hash of the folder's `.git/config` when it makes the folder and will not run git there if the file has changed (`src/git/git.ts`). | |
| 2 | The list of unreadable files was matched by spelling: a long s for an s, or a file named by its number under `/.vol`, got past it. | Paths are compared in the spelling the disk itself stores (`onDisk` in `src/supervisor/blastRadius.ts`); anything under `/.vol` is refused. Applies to Read, Write, Edit and the roots of Grep and Glob. | |
| 3 | A lead could give a sub-task files the task itself did not own. | A split is refused when a part owns anything outside its parent. After integration the whole change is held to what the task owns, with a card if it is not. | |
| 4 | A run in flight when the engine stopped cost nothing. | It is charged for what its unfinished turn had used, at the moment of stopping. | An engine that is killed outright (no clean stop) still loses that turn's cost. |
| 5 | Making a release could delete the release a running company was using. | An engine started from a release leaves a file named after its process there; `npm run release` never removes a release with a live one. | |
| 6 | A gate could reach the name service, which carries whatever is put in a name out to the network. | The rule that allowed it is gone; `localhost` resolves without it. | |
| 7 | A gate could signal other processes, change another program's preferences, send Apple Events and launch applications. | All four are refused in the gate's sandbox. Checked through the engine's own path with a control case each. | |
| 8 | A write was judged on a path that could be changed before the write was done. | An allowed Write or Edit is looked at again when its result arrives. If its path no longer leads into the folder the run is stopped and a card says where the file may have landed. | The write itself cannot be undone from here; the card says so. |
| 9 | The merge card said "reviewed" when the reviewer had not approved, and for a split task whose integration nobody reviewed. | A review's verdict is kept on its run. The card says "Approved by X" only for an approval; otherwise it says who sent it back or could not decide, or that nobody reviewed it. For a split task it says the parts were approved and the putting together was not reviewed. | |
| 10 | A reviewer was told it had tools that a review does not get, and asking for them was answered "you already have them". | A review run is told it only reads and how to have a gate run. Asking for those tools is answered in words. | |
| 11 | On a team with no repository the integrating lead was told nothing about where the parts were. | It is told each part's folder, its files and what its author reported. | |
| 12 | Yesterday's daily-cap card stayed open with buttons about a day that was over. | It is closed at the first tick of the new day. | |
| 13 | A page left open across a new release kept running the old screen. | The page carries the name of the screen it is; the snapshot carries the name of the screen the engine serves; when they differ the page asks to be reloaded. | |
| 14 | A folder with a git repository of its own inside a task folder (what `cargo new` leaves) was committed as a pointer, without its files. | The engine does not commit around it. The work goes back to its author with the one command that fixes it. | |
| 15 | A proxy address with a user name and password in it was passed to every session and gate. | The address is passed on without the login. | A company behind a proxy that needs a login would have to be given another way to reach the model. Not Filip's setup: no proxy variable is set on this Mac. |

Also done, not from the review: the usual toolchain folders (`~/.cargo/bin`, Homebrew's) are on the path of sessions and gates when this Mac has them, because the engine is often started from somewhere with a short path and `cargo` was then not found. Employees are told that their commands cannot reach the network and to build offline, and to carry on when a skill cannot be loaded.

## What live runs showed that no review had

Run on Haiku, one session at a time, in a throwaway repository under the system's temp folder (eight small functions, each wrong, each with tests). Nothing was run on Receipts.

1. A lead that split an open-ended task ("review the code and fix what is wrong") gave each half the test suite of the whole as its gate. Neither half could pass alone, so one engineer was sent back, could not fix it, and stopped to ask the user. Fixed in two places. The lead is told that a part's gates run on that part alone and to name only gates the part can pass. And where a lead gets that wrong anyway, a sub-task whose gate still fails after one send-back goes to its lead to judge, with the failure shown, instead of back to its author again. The gates of the whole task are the user's and hold as before: they are run when the parts are put together.
2. An engineer found its sub-task's brief contradicting the tests and asked the user. On a led team that question now goes to the lead first: the lead answers and the engineer carries on with the answer, or the lead says the user must decide and the card then shows what both said. A question the lead answers is not a review round. A member who keeps asking still reaches the user on the third question in a row.
3. On a tiny repository (three functions, a six-line fix) the lead did the work itself instead of splitting it. A teammate reviewed it and the gate passed, so nothing was wrong with the result. With eight functions the lead split the work in two. Whether a lead splits is the lead's judgement; what the engine guarantees is that a lead's own work is reviewed by someone else.

After those fixes the same open-ended task ran from start to finish with nobody stopped: split in two, each part worked and approved, put together, the whole suite passing, and a merge card that said "Its 2 sub-tasks were each approved by a reviewer, nobody reviewed how they were put together, gates green (all)". Six runs, about two cents at list prices.

Also run live: `VS_LIVE=1 npx vitest run --project engine test/e2e/one-task.spec.ts` (3 passed), and `npm run smoke` with `VS_LIVE_CONCURRENCY=1` (all eight checks ok).

## The third review

Placeholder: filled in below once it reported.

## What is not covered

- The part of the third review that was to try to get past the sandbox and the path rules was stopped by the model's own safety filter before it reported anything. It was not done. The second review did test those, and its findings are items 1, 2, 6, 7 and 8 above.
- No lead on Opus has yet split a real task in the Receipts repository under these rules. The first one tonight is worth watching.
- A self-managed team has no lead: its questions go straight to the user and its work is reviewed only when the task names a reviewer.
- If the engine restarts while a lead is reading a member's question, the lead still answers, but a card raised from it afterwards has the lead's words and not the member's original ones.
