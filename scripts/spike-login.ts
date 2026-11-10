/**
 * The subscription-login spike (engine plan, Task 1, extended by the review of 2026-11-09).
 *
 * Runs a few short live sessions on the claude.ai login and records what the Agent SDK does.
 * Usage:  npx tsx scripts/spike-login.ts [probe ...]     (no probe = all, in order)
 * Probes: auth connectors hello two-turn resume max-turns budget deny allow-rule skills hook-gate sandbox
 *
 * Raw recordings name the account and this machine, so they go to a folder outside the
 * repository (--out, default under the system temp dir). Only sanitised copies are written
 * to test/fixtures/sdk/, and only after a leak check.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { subscriptionEnv } from '../src/runtime/env.ts';
import { startSession, type RuntimeEvent } from '../src/runtime/sdk.ts';
import { leaks, sanitise } from '../src/runtime/sanitise.ts';

const MODEL = 'claude-haiku-5-5';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const OUT = path.resolve(flag('--out') ?? path.join(os.tmpdir(), 'vs-spike-out'));
// Throwaway projects live in a temp folder. VS_SPIKE_ROOT_BASE moves them (run 3 of the sandbox probe used /private/tmp,
// because xcodebuild needs the per-user temp folder writable and the projects must not sit inside what is writable).
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(process.env.VS_SPIKE_ROOT_BASE ?? os.tmpdir(), 'vs-spike-')));
const ALL = ['auth', 'connectors', 'hello', 'two-turn', 'resume', 'max-turns', 'budget', 'deny', 'allow-rule', 'skills', 'hook-gate', 'sandbox'];
const wanted = args.length > 0 ? args : ALL;

const { env, removed } = subscriptionEnv(process.env);
const identity: string[] = [os.userInfo().username, os.hostname()];
const findings: Record<string, unknown> = { sdkModel: MODEL, removedFromEnv: removed };
fs.mkdirSync(OUT, { recursive: true });

// ---------- helpers ----------

type Recording = { messages: SDKMessage[]; thrown: string | null; toolAsks: string[]; hookSaw: string[]; stderr: string };
type Result = Extract<SDKMessage, { type: 'result' }>;

class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(text: string): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.closed) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

function options(cwd: string, extra: Partial<Options>, rec: Recording, verdict: 'allow' | 'deny' = 'allow'): Options {
  return {
    cwd,
    env,
    model: MODEL,
    settingSources: [],
    // Without this the account's claude.ai connectors attach to every session (see the connectors probe).
    strictMcpConfig: true,
    tools: [],
    systemPrompt: 'You are a probe in an automated test. Follow each instruction exactly and add nothing.',
    stderr: (data) => (rec.stderr += data),
    // A PreToolUse hook runs before every permission rule, so it sees calls canUseTool never does.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name === 'PreToolUse') {
                const command = (input.tool_input as { command?: unknown } | undefined)?.command;
                rec.hookSaw.push(typeof command === 'string' ? `${input.tool_name}: ${command.slice(0, 60)}` : input.tool_name);
              }
              return {};
            },
          ],
        },
      ],
    },
    canUseTool: async (toolName) => {
      rec.toolAsks.push(toolName);
      return verdict === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Refused by the supervisor: this is a test.' };
    },
    ...extra,
  };
}

/** Runs one session to the end of its stream and keeps every message, even when the SDK throws. */
async function record(
  name: string,
  prompt: string | Inbox,
  build: (rec: Recording) => Options,
  onMessage?: (message: SDKMessage, q: ReturnType<typeof query>) => void | Promise<void>,
  timeoutMs = 180_000,
): Promise<Recording> {
  const rec: Recording = { messages: [], thrown: null, toolAsks: [], hookSaw: [], stderr: '' };
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const q = query({ prompt, options: { ...build(rec), abortController } });
  try {
    for await (const message of q) {
      rec.messages.push(message);
      await onMessage?.(message, q);
    }
  } catch (error) {
    rec.thrown = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  fs.writeFileSync(path.join(OUT, `${name}.raw.json`), JSON.stringify(rec, null, 2));
  return rec;
}

const results = (rec: Recording): Result[] => rec.messages.filter((m): m is Result => m.type === 'result');
const init = (rec: Recording) => rec.messages.find((m) => m.type === 'system' && m.subtype === 'init') as Extract<SDKMessage, { type: 'system'; subtype: 'init' }> | undefined;
const types = (rec: Recording): string[] => rec.messages.map((m) => ('subtype' in m && m.subtype ? `${m.type}/${m.subtype}` : m.type));

function text(rec: Recording): string {
  const parts: string[] = [];
  for (const m of rec.messages) {
    if (m.type !== 'assistant') continue;
    for (const block of m.message.content) if (block.type === 'text') parts.push(block.text);
  }
  return parts.join(' ').trim();
}

function toolUses(rec: Recording): string[] {
  const names: string[] = [];
  for (const m of rec.messages) {
    if (m.type !== 'assistant') continue;
    for (const block of m.message.content) if (block.type === 'tool_use') names.push(block.name);
  }
  return names;
}

function resultFacts(r: Result | undefined): Record<string, unknown> | null {
  if (!r) return null;
  return {
    subtype: r.subtype,
    is_error: r.is_error,
    num_turns: r.num_turns,
    total_cost_usd: r.total_cost_usd,
    usage: {
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens,
      cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
    },
    modelUsage: r.modelUsage,
    errors: 'errors' in r ? r.errors : undefined,
    permission_denials: r.permission_denials.map((d) => d.tool_name),
  };
}

function rateLimitEvents(rec: Recording): unknown[] {
  return rec.messages.filter((m) => m.type === 'rate_limit_event').map((m) => (m as { rate_limit_info: unknown }).rate_limit_info);
}

/** Writes a sanitised fixture, refusing if anything identifying survives. */
function writeFixture(name: string, rec: Recording, paths: Record<string, string>): void {
  const clean = sanitise(rec.messages, { homeDir: os.homedir(), paths });
  const json = JSON.stringify(clean, null, 2);
  const found = leaks(json, identity);
  if (found.length > 0) throw new Error(`fixture ${name} still leaks ${found.length} item(s); not written`);
  const file = path.join(REPO, 'test/fixtures/sdk', `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${json}\n`);
}

function tempDir(name: string): string {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function bundledClaude(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
  return path.join(path.dirname(pkg), 'claude');
}

// ---------- probes ----------

let twoTurn: { sessionId: string; cwd: string; lastCost: number } | null = null;

const probes: Record<string, () => Promise<void>> = {
  /** No model turn: which login does the bundled Claude Code report in the scrubbed environment? */
  async auth() {
    const bin = bundledClaude();
    const run = spawnSync(bin, ['auth', 'status'], { env, encoding: 'utf8' });
    const status = JSON.parse(run.stdout) as Record<string, unknown>;
    for (const key of ['email', 'orgName', 'orgId']) if (typeof status[key] === 'string') identity.push(status[key] as string);
    findings.auth = {
      exitCode: run.status,
      bundledVersion: execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim(),
      loggedIn: status.loggedIn,
      authMethod: status.authMethod,
      apiProvider: status.apiProvider,
      subscriptionType: status.subscriptionType,
      loginExpiresAt: status.loginExpiresAt,
      keys: Object.keys(status),
    };
    if (status.loggedIn !== true || status.authMethod !== 'claude.ai') {
      throw new Error(`STOP: the login is not the claude.ai subscription (authMethod=${String(status.authMethod)})`);
    }
  },

  /**
   * No model turn. The first two-turn run showed the account's claude.ai connectors attaching a few
   * seconds after start, even with settingSources [], and adding 764 tools (742k tokens) to the next
   * request. Which switch keeps them out? Opens a session, sends nothing, and asks for the server list.
   */
  async connectors() {
    const variants: Record<string, { extra: Partial<Options>; env?: Record<string, string> }> = {
      settingSourcesEmptyOnly: { extra: { strictMcpConfig: false } },
      strictMcpConfig: { extra: { strictMcpConfig: true } },
      envSwitch: { extra: { strictMcpConfig: false }, env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } },
    };
    const report: Record<string, unknown> = {};
    for (const [name, variant] of Object.entries(variants)) {
      const inbox = new Inbox();
      const rec: Recording = { messages: [], thrown: null, toolAsks: [], hookSaw: [], stderr: '' };
      const q = query({ prompt: inbox, options: { ...options(tempDir(`connectors-${name}`), { persistSession: false, ...variant.extra }, rec), ...(variant.env ? { env: variant.env } : {}) } });
      const seen: number[] = [];
      try {
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          seen.push((await q.mcpServerStatus()).length);
        }
        const statuses = await q.mcpServerStatus();
        report[name] = { serversOverTwentySeconds: seen, scopes: [...new Set(statuses.map((s) => s.scope))], toolCount: statuses.reduce((n, s) => n + (s.tools?.length ?? 0), 0) };
      } catch (error) {
        report[name] = { error: error instanceof Error ? error.message : String(error), seen };
      }
      inbox.close();
      q.close();
    }
    findings.connectors = report;
  },

  /** One-shot string prompt: the init message, the result's cost and usage, what loads with settingSources []. */
  async hello() {
    const cwd = tempDir('hello');
    let account: Record<string, unknown> = {};
    const rec = await record(
      'hello',
      'Reply with the single word OK.',
      (r) => options(cwd, { maxTurns: 1, persistSession: false }, r),
      async (m, q) => {
        if (m.type === 'system' && m.subtype === 'init') {
          const info = await q.accountInfo();
          for (const value of [info.email, info.organization]) if (value) identity.push(value);
          account = { tokenSource: info.tokenSource, apiKeySource: info.apiKeySource, apiProvider: info.apiProvider, subscriptionType: info.subscriptionType };
        }
      },
    );
    const i = init(rec);
    const assistant = rec.messages.find((m) => m.type === 'assistant');
    findings.hello = {
      types: types(rec),
      thrown: rec.thrown,
      text: text(rec),
      init: i && {
        apiKeySource: i.apiKeySource,
        model: i.model,
        claude_code_version: i.claude_code_version,
        permissionMode: i.permissionMode,
        tools: i.tools.filter((t) => !t.startsWith('mcp__')),
        connectorTools: i.tools.filter((t) => t.startsWith('mcp__')).length,
        mcpServers: i.mcp_servers.length,
        skills: i.skills.length,
        plugins: i.plugins.length,
        slashCommands: i.slash_commands.length,
        agents: i.agents?.length ?? 0,
      },
      accountInfo: account,
      assistantUsage: assistant?.type === 'assistant' ? { input: assistant.message.usage.input_tokens, output: assistant.message.usage.output_tokens } : null,
      result: resultFacts(results(rec)[0]),
      rateLimitEvents: rateLimitEvents(rec),
    };
    writeFixture('helloStream', rec, { [cwd]: '/tmp/project' });
  },

  /** Streaming input, two user turns in one session: one result per turn? is cost per turn or running total? */
  async 'two-turn'() {
    const cwd = tempDir('two-turn');
    const inbox = new Inbox();
    inbox.push('Reply with the single word ONE.');
    let seen = 0;
    let planUsage: unknown = null;
    const closedAt: { ms: number | null } = { ms: null };
    const rec = await record(
      'two-turn',
      inbox,
      (r) => options(cwd, {}, r),
      async (m, q) => {
        if (m.type !== 'result') return;
        seen += 1;
        if (seen === 1) {
          try {
            const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
            planUsage = { rate_limits_available: usage.rate_limits_available, subscription_type: usage.subscription_type, rate_limits: usage.rate_limits };
          } catch (error) {
            planUsage = { error: error instanceof Error ? error.message : String(error) };
          }
          inbox.push('Reply with the single word TWO.');
        } else {
          closedAt.ms = Date.now();
          inbox.close();
        }
      },
    );
    const rs = results(rec);
    const last = rs.at(-1);
    findings.twoTurn = {
      types: types(rec),
      thrown: rec.thrown,
      text: text(rec),
      initMessages: rec.messages.filter((m) => m.type === 'system' && m.subtype === 'init').length,
      sessionIds: [...new Set(rec.messages.map((m) => m.session_id))].length,
      results: rs.map(resultFacts),
      streamEndedAfterCloseMs: closedAt.ms === null ? null : Date.now() - closedAt.ms,
      planUsage,
      rateLimitEvents: rateLimitEvents(rec),
    };
    if (last) twoTurn = { sessionId: last.session_id, cwd, lastCost: last.total_cost_usd };
    writeFixture('twoTurnStream', rec, { [cwd]: '/tmp/project' });
  },

  /** Resume by session id: is the context there, does the id change, does cost restart? Same cwd, then another cwd. */
  async resume() {
    if (!twoTurn) throw new Error('resume needs the two-turn probe in the same invocation');
    const ask = 'Which two single words have you replied with in this conversation? Reply with exactly those two words separated by a space.';
    const same = await record('resume-same-cwd', ask, (r) => options(twoTurn!.cwd, { resume: twoTurn!.sessionId, maxTurns: 1 }, r));
    const other = await record('resume-other-cwd', ask, (r) => options(tempDir('elsewhere'), { resume: twoTurn!.sessionId, maxTurns: 1 }, r));
    const facts = (rec: Recording) => ({
      thrown: rec.thrown,
      text: text(rec),
      sameSessionId: results(rec)[0]?.session_id === twoTurn!.sessionId,
      result: resultFacts(results(rec)[0]),
      stderrTail: rec.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300),
    });
    // Cost carries over on resume. So is maxBudgetUsd measured against the carried total or this run's spend?
    // A cap below the carried total but above a start-up call tells: stopped before any reply = carried total.
    const carried = results(other)[0]?.total_cost_usd ?? results(same)[0]?.total_cost_usd ?? twoTurn.lastCost;
    const cap = Math.max(carried / 2, 0.0003);
    const capped = await record('resume-with-budget', 'Reply with the single word THREE.', (r) => options(twoTurn!.cwd, { resume: twoTurn!.sessionId, maxTurns: 1, maxBudgetUsd: cap }, r));
    findings.resume = {
      costBeforeResume: twoTurn.lastCost,
      sameCwd: facts(same),
      otherCwd: facts(other),
      withBudget: { carriedTotal: carried, cap, repliedBeforeStopping: capped.messages.some((m) => m.type === 'assistant'), ...facts(capped) },
    };
  },

  /** maxTurns reached: the error result's shape, and whether the iterator throws after it. */
  async 'max-turns'() {
    const cwd = tempDir('max-turns');
    const rec = await record('max-turns', 'Run `echo hi` with the Bash tool, then reply DONE.', (r) => options(cwd, { tools: ['Bash'], maxTurns: 1, persistSession: false }, r));
    findings.maxTurns = { types: types(rec), thrown: rec.thrown, toolAsks: rec.toolAsks, result: resultFacts(results(rec)[0]) };
    writeFixture('maxTurnsStream', rec, { [cwd]: '/tmp/project' });
  },

  /** Does maxBudgetUsd stop a session on the subscription login? It can only bite if cost is computed. */
  async budget() {
    const cwd = tempDir('budget');
    const rec = await record('budget', 'Reply with the single word OK.', (r) => options(cwd, { maxBudgetUsd: 0.000001, persistSession: false }, r));
    findings.budget = { types: types(rec), thrown: rec.thrown, text: text(rec), result: resultFacts(results(rec)[0]) };
  },

  /** A tool that is not auto-approved reaches canUseTool; a refusal comes back to the model as an error. */
  async deny() {
    const cwd = tempDir('deny');
    // The max-turns run showed `echo hi` running with no ask: Claude Code approves commands it classes as
    // read-only by itself. So this asks for one of those and one that writes, and counts who saw which.
    const rec = await record(
      'deny',
      'Make two separate Bash tool calls, in this order: first `echo hi`, then `touch probe.txt`. Do not retry a refused call. Then reply with exactly: FIRST=<ran or refused> SECOND=<ran or refused>',
      (r) => options(cwd, { tools: ['Bash'], maxTurns: 4, persistSession: false }, r, 'deny'),
    );
    findings.deny = {
      types: types(rec),
      thrown: rec.thrown,
      hookSaw: rec.hookSaw,
      toolAsks: rec.toolAsks,
      toolUses: toolUses(rec),
      text: text(rec),
      fileCreated: fs.existsSync(path.join(cwd, 'probe.txt')),
      result: resultFacts(results(rec)[0]),
    };
    writeFixture('deniedToolStream', rec, { [cwd]: '/tmp/project' });
  },

  /** The review's first finding, live: a tool in allowedTools never reaches canUseTool. */
  async 'allow-rule'() {
    const cwd = tempDir('allow-rule');
    const rec = await record(
      'allow-rule',
      'Run `touch probe.txt` with the Bash tool. Reply with exactly RAN if it ran, or REFUSED if it was refused.',
      (r) => options(cwd, { tools: ['Bash'], allowedTools: ['Bash'], maxTurns: 3, persistSession: false }, r, 'deny'),
    );
    findings.allowRule = {
      hookSaw: rec.hookSaw,
      toolAsks: rec.toolAsks,
      toolUses: toolUses(rec),
      text: text(rec),
      fileCreated: fs.existsSync(path.join(cwd, 'probe.txt')),
      thrown: rec.thrown,
      result: resultFacts(results(rec)[0]),
    };
  },

  /** With no 'user' setting source: are user skills hidden, and can chosen skills be mounted through a local plugin? */
  async skills() {
    const cwd = tempDir('skills');
    const mount = tempDir('mount');
    fs.mkdirSync(path.join(mount, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(mount, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'vsmount', version: '0.0.1', description: 'Skills mounted for one employee' }));
    fs.mkdirSync(path.join(mount, 'skills/spike-probe'), { recursive: true });
    fs.writeFileSync(
      path.join(mount, 'skills/spike-probe/SKILL.md'),
      '---\nname: spike-probe\ndescription: A probe skill for an automated test. Load it when asked for spike-probe.\n---\n\nWhen this skill is loaded, reply with exactly this token and nothing else: PROBE-7391\n',
    );
    // A user skill, mounted by symlink, and one copied, to see which of the two the loader accepts.
    const userSkills = path.join(os.homedir(), '.claude/skills');
    const pick = ['postgresql', 'rust-skills'].filter((name) => fs.existsSync(path.join(userSkills, name, 'SKILL.md')));
    if (pick[0]) fs.symlinkSync(path.join(userSkills, pick[0]), path.join(mount, 'skills', pick[0]));
    if (pick[1]) fs.cpSync(path.join(userSkills, pick[1]), path.join(mount, 'skills', pick[1]), { recursive: true });
    // An installed plugin, mounted from where Claude Code cached it.
    const cache = path.join(os.homedir(), '.claude/plugins/cache/indie-apple-stack/apple-skills');
    const version = fs.existsSync(cache) ? fs.readdirSync(cache).find((entry) => fs.existsSync(path.join(cache, entry, 'skills'))) : undefined;
    const plugins = [{ type: 'local' as const, path: mount }, ...(version ? [{ type: 'local' as const, path: path.join(cache, version) }] : [])];
    const wantedSkills = ['vsmount:spike-probe', ...pick.map((name) => `vsmount:${name}`), ...(version ? ['apple-skills:performance'] : [])];

    const rec = await record(
      'skills',
      // First run: with tools [] there was no Skill tool at all, whatever `skills` said. So it is listed here.
      // apple-skills:swiftui is mounted (its whole plugin is) but not in `skills`: is it refused?
      'Make two Skill tool calls, in this order: first load "vsmount:spike-probe", then try to load "apple-skills:swiftui". Do not retry. Then reply with exactly: TOKEN=<the token the first skill told you to reply with> SECOND=<loaded or rejected>',
      (r) => options(cwd, { tools: ['Skill'], plugins, skills: wantedSkills, maxTurns: 5, persistSession: false }, r),
    );
    const i = init(rec);
    findings.skills = {
      asked: wantedSkills,
      mountedBySymlink: pick[0] ?? null,
      mountedByCopy: pick[1] ?? null,
      initSkills: i?.skills,
      initPlugins: i?.plugins.map((p) => p.name),
      pluginErrors: i?.plugin_errors?.map((e) => `${e.plugin}: ${e.type}`),
      initTools: i?.tools.filter((t) => !t.startsWith('mcp__')),
      hookSaw: rec.hookSaw,
      toolAsks: rec.toolAsks,
      toolUses: toolUses(rec),
      text: text(rec),
      thrown: rec.thrown,
      result: resultFacts(results(rec)[0]),
    };
  },

  /**
   * The engine's own wrapper, live: does a PreToolUse hook's "deny" stop a call, and does its "allow"
   * let one through without the SDK's permission prompt? This is the gate the limits rest on.
   */
  async 'hook-gate'() {
    const cwd = tempDir('hook-gate');
    const asked: string[] = [];
    const handle = startSession({
      cwd,
      prompt: 'Make two separate Bash tool calls, in this order: `touch a.txt`, then `touch b.txt`. Do not retry a refused call. Then reply with exactly: A=<ran or refused> B=<ran or refused>',
      systemPrompt: 'You are a probe in an automated test. Follow each instruction exactly and add nothing.',
      model: MODEL,
      env,
      tools: ['Bash'],
      maxTurns: 5,
      decideTool: async (call) => {
        const command = String((call.input as { command?: unknown }).command ?? '');
        asked.push(`${call.tool}: ${command}`);
        return command.includes('a.txt') ? { allow: false, reason: 'a.txt is outside what this task owns.' } : { allow: true };
      },
    });
    const events: RuntimeEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.kind === 'turn_finished') handle.end();
    }
    findings.hookGate = {
      kinds: events.map((e) => e.kind),
      asked,
      toolResults: events.filter((e) => e.kind === 'tool_result').map((e) => (e.kind === 'tool_result' ? e.ok : null)),
      text: events.filter((e) => e.kind === 'assistant_text').map((e) => (e.kind === 'assistant_text' ? e.text : '')).join(' '),
      aCreated: fs.existsSync(path.join(cwd, 'a.txt')),
      bCreated: fs.existsSync(path.join(cwd, 'b.txt')),
      usage: events.filter((e) => e.kind === 'usage'),
      turn: events.find((e) => e.kind === 'turn_finished'),
      finished: events.at(-1),
    };
  },

  /**
   * Can the SDK sandbox host one cargo build and one xcodebuild, and does it keep an employee's
   * writes inside the task's folder? Throwaway projects only. A control run with no sandbox comes first.
   *
   * The first run (2026-11-09) used a linked worktree with the default sandbox, then with wide write
   * access. It showed: writes outside the folder are refused, but `git commit` and `git update-ref`
   * succeed, because the sandbox lets git reach the shared .git of a linked worktree; and xcodebuild
   * needs Xcode's own folders and SwiftPM's inner sandbox switched off. This run narrows the write
   * access and compares a linked worktree with a plain clone, where .git lives inside the folder.
   */
  async sandbox() {
    const toolchainBin = path.dirname(spawnSync('/opt/homebrew/bin/rustup', ['which', 'cargo'], { env, encoding: 'utf8' }).stdout.trim());
    const userDir = (name: string) => execFileSync('getconf', [name], { encoding: 'utf8' }).trim().replace(/\/$/, '');
    // Run 2 allowed the cache folder only and xcodebuild failed saving into the temp folder; run 3 allows both.
    const userDirs = [userDir('DARWIN_USER_CACHE_DIR'), ...(process.env.VS_SPIKE_ALLOW_USER_TEMP ? [userDir('DARWIN_USER_TEMP_DIR')] : [])];
    const outsideDir = path.join(REPO, 'data/spike-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, encoding: 'utf8' });
    const refs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').trim().split('\n').sort();
    const xcflags = '-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES';

    const setup = (name: string, kind: 'worktree' | 'clone'): { repo: string; work: string; refsBefore: string[] } => {
      const repo = tempDir(`${name}-repo`);
      git(repo, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'README.md'), 'throwaway\n');
      git(repo, 'add', '-A');
      git(repo, '-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', 'commit', '-q', '-m', 'init');
      const work = path.join(ROOT, `${name}-work`);
      if (kind === 'worktree') {
        git(repo, 'worktree', 'add', '-q', '-b', 'task/probe', work);
      } else {
        git(ROOT, 'clone', '-q', '--no-hardlinks', repo, work);
        git(work, 'checkout', '-q', '-b', 'task/probe');
      }
      const refsBefore = refs(repo);
      fs.mkdirSync(path.join(work, 'crate/src'), { recursive: true });
      fs.writeFileSync(path.join(work, 'crate/Cargo.toml'), '[package]\nname = "throwaway"\nversion = "0.1.0"\nedition = "2021"\n');
      fs.writeFileSync(path.join(work, 'crate/src/main.rs'), 'fn main() { println!("hello"); }\n');
      fs.mkdirSync(path.join(work, 'swiftpkg/Sources/Throwaway'), { recursive: true });
      fs.writeFileSync(
        path.join(work, 'swiftpkg/Package.swift'),
        '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Throwaway", products: [.library(name: "Throwaway", targets: ["Throwaway"])], targets: [.target(name: "Throwaway")])\n',
      );
      fs.writeFileSync(path.join(work, 'swiftpkg/Sources/Throwaway/Throwaway.swift'), 'public func hello() -> String { "hello" }\n');
      fs.writeFileSync(
        path.join(work, 'probe.sh'),
        `#!/bin/bash
# Each step: output to probe-results/<step>.out, exit code to probe-results/<step>.code, one line to stdout.
R=probe-results; mkdir -p "$R"
step() { n="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$1" "\${@:2}" >"$R/$n.out" 2>&1; c=$?; echo "$c" >"$R/$n.code"; echo "$n exit $c"; }
step write_inside 20 sh -c 'echo inside > inside.txt'
step write_tmpdir 20 sh -c 'echo "TMPDIR=$TMPDIR"; echo t > "$TMPDIR/vs-probe.txt"'
step git_commit 20 git -c user.name=probe -c user.email=probe@example.invalid commit --allow-empty -m "probe commit"
step git_move_main 20 git update-ref refs/heads/main HEAD
step git_push_origin 20 git push origin HEAD:refs/heads/pushed-by-probe
step write_main_checkout 20 sh -c 'echo x > "${repo}/intruder.txt"'
step write_outside 20 sh -c 'echo x > "${outsideDir}/${name}.txt"'
step cargo_build 120 sh -c 'cd crate && PATH="${toolchainBin}:$PATH" cargo build'
step xcodebuild_macos 200 sh -c 'cd swiftpkg && xcodebuild -scheme Throwaway -destination "platform=macOS" -derivedDataPath .dd ${xcflags} build'
step xcodebuild_ios_sim 200 sh -c 'cd swiftpkg && xcodebuild -scheme Throwaway -destination "generic/platform=iOS Simulator" -derivedDataPath .dd-ios ${xcflags} build'
`,
      );
      return { repo, work, refsBefore };
    };

    const collect = (work: string): Record<string, { code: number; tail: string }> => {
      const dir = path.join(work, 'probe-results');
      const out: Record<string, { code: number; tail: string }> = {};
      if (!fs.existsSync(dir)) return out;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.code'))) {
        const step = file.replace(/\.code$/, '');
        const lines = fs.readFileSync(path.join(dir, `${step}.out`), 'utf8').trim().split('\n');
        const tail = lines.filter((l) => /error:|denied|not permitted|FAILED|SUCCEEDED|Finished|TMPDIR|fatal/i.test(l)).slice(-3).join(' | ') || lines.slice(-1).join('');
        out[step] = { code: Number(fs.readFileSync(path.join(dir, file), 'utf8').trim()), tail: tail.split(os.homedir()).join('~').slice(0, 360) };
      }
      return out;
    };

    /** What the ref snapshot of Decision 1 would see: did anything in the user's repository move? */
    const repoDamage = (repo: string, refsBefore: string[]) => {
      const after = refs(repo);
      return {
        mainMoved: after.find((r) => r.startsWith('refs/heads/main ')) !== refsBefore.find((r) => r.startsWith('refs/heads/main ')),
        newRefs: after.map((r) => r.split(' ')[0]).filter((name) => !refsBefore.some((b) => b.startsWith(`${name} `))),
        strayFile: fs.existsSync(path.join(repo, 'intruder.txt')),
      };
    };

    // Control: the same script on a worktree, no sandbox. A build that fails here says nothing about the sandbox.
    const report: Record<string, unknown> = {};
    if (!process.env.VS_SPIKE_SKIP_CONTROL) {
      const control = setup('control', 'worktree');
      spawnSync('bash', ['probe.sh'], { cwd: control.work, env, encoding: 'utf8', timeout: 900_000 });
      report.control = { steps: collect(control.work), repo: repoDamage(control.repo, control.refsBefore) };
    }

    const home = os.homedir();
    const sandbox: NonNullable<Options['sandbox']> = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [`${home}/Library/Developer/Xcode`, `${home}/Library/Caches`, `${home}/Library/org.swift.swiftpm`, `${home}/.cargo`, ...userDirs] },
    };
    report.allowWrite = sandbox.filesystem?.allowWrite?.map((p) => p.split(home).join('~').replace(/\/var\/folders\/[^/]+\/[^/]+/, '/var/folders/xx/yy'));
    const kinds = (process.env.VS_SPIKE_SANDBOX_KINDS ?? 'worktree,clone').split(',') as ('worktree' | 'clone')[];
    for (const kind of kinds) {
      const { repo, work, refsBefore } = setup(kind, kind);
      const rec = await record(
        `sandbox-${kind}`,
        'Run this exact command with the Bash tool, once, with a timeout of 600000 ms: bash ./probe.sh\nThen reply with exactly DONE. Do not run anything else and do not retry.',
        (r) => options(work, { tools: ['Bash'], sandbox, maxTurns: 4, persistSession: false }, r),
        undefined,
        900_000,
      );
      report[kind] = {
        steps: collect(work),
        repo: repoDamage(repo, refsBefore),
        strayFileOutside: fs.existsSync(path.join(outsideDir, `${kind}.txt`)),
        hookSaw: rec.hookSaw,
        toolAsks: rec.toolAsks,
        toolUses: toolUses(rec),
        text: text(rec),
        thrown: rec.thrown,
        result: resultFacts(results(rec)[0]),
      };
    }
    fs.rmSync(outsideDir, { recursive: true, force: true });
    findings[`sandbox_${process.env.VS_SPIKE_RUN_LABEL ?? 'run2'}`] = report;
  },
};


// ---------- main ----------

let failed = false;
for (const name of wanted) {
  const probe = probes[name];
  if (!probe) throw new Error(`unknown probe ${name}; known: ${ALL.join(' ')}`);
  process.stderr.write(`probe ${name} …\n`);
  try {
    await probe();
  } catch (error) {
    failed = true;
    findings[`${name}Error`] = error instanceof Error ? error.message : String(error);
    if (name === 'auth') break;
  }
}
const printed = JSON.stringify(findings, null, 2).split(os.homedir()).join('~').split(ROOT).join('<spike-root>');
const stillThere = leaks(printed, identity.filter((value) => value.length > 3));
// Probes can be run a few at a time; each run adds to what earlier runs found.
const findingsFile = path.join(OUT, 'findings.raw.json');
const earlier = fs.existsSync(findingsFile) ? (JSON.parse(fs.readFileSync(findingsFile, 'utf8')) as Record<string, unknown>) : {};
fs.writeFileSync(findingsFile, JSON.stringify({ ...earlier, ...findings }, null, 2));
console.log(stillThere.filter((v) => identity.includes(v)).length > 0 ? '{"error":"findings name the account; read findings.raw.json instead"}' : printed);
console.error(`raw recordings: ${OUT}\nthrowaway projects: ${ROOT}`);
process.exit(failed ? 1 : 0);
