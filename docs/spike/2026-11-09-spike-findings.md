# The subscription-login spike: what the Agent SDK really does

Date: 2026-11-09. Engine plan Task 1, extended by the review of the same day.
Script: `scripts/spike-login.ts`. Model for every probe: Claude Haiku 5.5 (the cheapest; the spike measures plumbing, not quality).
Measured on: `@anthropic-ai/claude-agent-sdk` 0.3.321 (pinned in `package.json`), bundled Claude Code 2.1.321, Node 20.19.0, macOS, Xcode 27.2, cargo stable.

**Verdict: the subscription login works. No API key and no CLI fallback are needed.**
Later tasks refer to this file, never to memory. Each line below was observed in a live run unless it says "from the types".

## 1. Which login answered

- The spike started inside a Claude desktop session, whose shell carries more than thirty `ANTHROPIC_*` and `CLAUDE_*` variables (a base URL among them; no API key and no auth token). `subscriptionEnv()` in `src/runtime/env.ts` removes all of them, and the cloud-provider switches, before anything starts.
- `claude auth status`, run with the SDK's bundled binary in that scrubbed environment, exits 0 and prints JSON: `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, and a `subscriptionType`. It also prints `loginExpiresAt` (three days ahead at the time), the account email and the organisation.
- The init message of every session has `apiKeySource: "none"`. That is what the claude.ai login looks like there. `Query.accountInfo()` agrees: `apiProvider: "firstParty"`, a subscription type, no key source.
- Every result's `modelUsage` entry has `provider: "firstParty"` and `costBasis: "list"`.

## 2. Cost and usage on the subscription

| Question | Answer |
|---|---|
| Is `total_cost_usd` filled in? | Yes. It is an estimate at list prices. A one-word reply cost $0.00025. |
| Is `usage` filled in? | Yes, but a result's `usage` counts only the main model's last turn (2 in, 4 out). |
| Where is a turn's real spend? | `model_usage_since_last_result`: per model, this turn only, side calls included. |
| What is `modelUsage`? | Per model, the running total of the session. |
| What does a two-turn streaming session return? | One `result` per user turn. A `system/init` message before each turn, same session id. |
| Is `total_cost_usd` per turn or a total? | A running total of the session: $0.000251 after turn 1, $0.000386 after turn 2. |
| Does cost restart on resume? | No. The resumed run reported $0.000414: the carried total plus its own turn. |
| Does `maxBudgetUsd` work here? | Yes. A cap of $0.000001 ended the session with `error_max_budget_usd` before the reply. |
| What does `maxBudgetUsd` measure on resume? | The new run's own spend. A cap below the carried total did not stop the run. |
| What happens at `maxTurns`? | A result with `subtype: "error_max_turns"`, then the SDK's iterator throws. Same after a budget stop. |
| Does resume need the same folder? | No. Resuming from another folder worked, with the context intact. |

Other facts:

- Every process makes one small start-up call of its own (about 1,200 input tokens on Haiku, whatever the session's model). A cap smaller than that call stops the session before it answers.
- Per-step usage on assistant messages is a placeholder (1 output token where the result says 4).
- With streaming input the session ends about 0.4 s after the input is closed, not before.
- Transcripts are saved under `~/.claude/projects/<folder>/<session>.jsonl`. Resume needs them. `persistSession: false` skips them.

## 3. What a session loads when the setting sources are empty

- `settingSources: []` keeps out user and project settings, `CLAUDE.md`, user skills and user plugins. What remains is built in: 20 bundled skills, 4 built-in plugins, 5 built-in agents.
- **It does not keep out the account's claude.ai connectors.** Within seconds of start, every connector server on the account attached, with hundreds of tools between them. In the first two-turn run the second request carried 742,492 tokens, nearly all of them tool definitions: $0.74 at Haiku list prices for one request whose answer was the word "TWO". That one request is nearly all of what the spike spent.
- Two switches keep them out, each checked with no model turn: the option `strictMcpConfig: true`, and the environment variable `ENABLE_CLAUDEAI_MCP_SERVERS=false`. `startSession()` sets both.

## 4. Who gets to decide a tool call

| Case | `canUseTool` asked? | PreToolUse hook saw it? |
|---|---|---|
| Bash `echo hi` (the SDK classes it read-only) | No. It ran. | Yes |
| Bash `touch probe.txt`, not in `allowedTools` | Yes. Denied, file not created. | Yes |
| Bash `touch probe.txt`, Bash in `allowedTools` | No. It ran. | Yes |
| Sandboxed Bash with `autoAllowBashIfSandboxed` | No | Yes |
| The Skill tool | No | Yes |

- So the callback is not a gate. The PreToolUse hook is the one place that sees every call. Through `startSession()`, live: a hook answer of "deny" refused `touch a.txt` (no file), and "allow" let `touch b.txt` run with no prompt.
- A refused call comes back to the model as a failed tool result with the reason, and is listed in the result's `permission_denials`. The session carries on. If a refusal must stop the run, the engine has to stop it.

## 5. Mounting chosen skills without the user's settings

- `skills: [...]` with `tools: []` gives no Skill tool at all. `tools` must list `Skill`.
- A local plugin folder (`.claude-plugin/plugin.json` plus `skills/<name>/SKILL.md`), passed in `plugins`, makes its skills available as `<plugin>:<name>`.
- A user skill mounted into that folder by symlink loads. So does a copy.
- An installed plugin, mounted from where Claude Code cached it (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`), loads under its own name with all its skills.
- The `skills` list is the filter: the listed skill loaded and was obeyed; a mounted but unlisted one was refused by the Skill tool. The init message lists everything discovered, not the filtered set.
- Consequence: a user skill reaches an employee under the mount's name (`<mount>:postgresql`), not its bare name. Bundled skills such as `dataviz` keep their bare names.

## 6. The sandbox: builds, and what an employee can write

Three runs on throwaway projects: a Rust crate, a Swift package and a throwaway git repository. One Bash call each, inside the SDK sandbox with `autoAllowBashIfSandboxed: true` and `allowUnsandboxedCommands: false`. A control run with no sandbox came first and passed every build.

| Step | No sandbox | Default sandbox, worktree | Cache folder only, worktree | Cache folder only, clone | Build profile, clone |
|---|---|---|---|---|---|
| Write inside the task folder | ok | ok | ok | ok | ok |
| Write into the user's checkout | ok | refused | refused | refused | refused |
| Write to another folder | ok | refused | refused | refused | refused |
| `git commit` in the task folder | ok | ok | ok | ok | ok |
| Change the user's repository through git | ok | **yes: wrote a new branch** | **yes: moved `main`** | no | no |
| `git push` to the user's repository | no remote | no remote | no remote | refused | refused |
| `cargo build` | ok | (probe error) | ok | ok | ok |
| `xcodebuild` for macOS | ok | fails | fails | fails | ok |
| `xcodebuild` for iOS Simulator (generic) | ok | not run | fails | fails | ok |

The columns are runs 1, 2, 2 and 3. Run 1 also tried a worktree with all of `/private/var/folders` writable: xcodebuild for macOS passed, but the throwaway repository sat inside that folder, so that run says nothing about writes.

What it means:

- **The sandbox can host both builds.** cargo needs nothing special. xcodebuild needs a build profile: write access to `~/Library/Developer/Xcode`, `~/Library/Caches`, `~/Library/org.swift.swiftpm` and the two per-user system folders (`getconf DARWIN_USER_CACHE_DIR` and `DARWIN_USER_TEMP_DIR`), and SwiftPM's inner sandbox switched off with `-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES`. With the cache folder but not the temp folder it fails saving its result bundle.
- **Writes outside the task folder are refused** in every sandboxed run.
- **A linked worktree is the hole.** The sandbox lets git write the shared `.git` of a linked worktree, so a sandboxed employee can commit, and can move any branch of the user's repository. In run 2 the probe moved `main`. The before-and-after ref snapshot caught it, so detection works.
- **A clone closes the hole.** Its `.git` is inside the task folder. Commits stay there, a push to the user's repository is refused, and nothing in the user's repository changed.
- Inside the sandbox `TMPDIR` is `/tmp/claude-<uid>`.

Not shown: tests on a booted simulator (xcodebuild logged that it could not reach the CoreSimulator service from inside the sandbox, though the builds passed); builds that fetch dependencies from the network; which of the three `~/Library` allowances are strictly needed. The "probe error" cell is the probe's own mistake (rustc was not on the PATH; the control run failed the same way), fixed in run 2.

## 7. The usage limit

Not provoked, and not reached. What was seen:

- Every session sends a `rate_limit_event` right after init: `{ status: "allowed", rateLimitType: "seven_day", resetsAt: <epoch seconds>, unifiedWindows: { seven_day: { utilization: 0.38 } }, overageStatus: … }`. From the types, `status` is `allowed`, `allowed_warning` or `rejected`, and the window can also be `five_hour` or a per-model week.
- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` returned the plan's windows with no model turn: the seven-day window at 38 to 39 percent with its reset time, and a per-model window. The name says how far to trust it.
- From the types only: an assistant message can carry `error: "rate_limit"` (also `billing_error`, `authentication_failed`, `overloaded`).

What the SDK returns at the limit itself is still unrecorded. The engine should treat `status: "rejected"` or an assistant `error: "rate_limit"` as "the company is paused", and keep the raw message the first time it happens.

## 8. Fixtures

Sanitised recordings in `test/fixtures/sdk/`, written only after a leak check (`src/runtime/sanitise.ts`): `helloStream`, `twoTurnStream`, `maxTurnsStream`, `deniedToolStream`. Session ids are `sess-N`, other ids are numbered placeholders, the folder is `/tmp/project`, and the lists that describe the machine are empty. Raw recordings never enter the repository.

## 9. What the spike cost

About 36 model calls across 22 short sessions, each with a small start-up call of its own: $0.76 at list prices, of which $0.74 was the single connector-laden request of section 3.
