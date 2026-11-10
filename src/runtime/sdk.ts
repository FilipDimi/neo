/**
 * The runtime: one Claude Agent SDK session, seen through the engine's own types.
 *
 * This is the only file that names the SDK. Everything else consumes RuntimeEvent and
 * SessionHandle, so tests can replay a recorded stream and a different runtime can be
 * swapped in. What the SDK really does on the claude.ai login was recorded by
 * scripts/spike-login.ts; docs/spike/2026-11-09-spike-findings.md has the results.
 */
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { engineToolServer, type EngineTools } from './tools.ts';

import type { RuntimeEvent, ToolCall, ToolDecision } from '../shared/runtime.ts';

export type { RuntimeEvent, ToolCall, ToolDecision };

export type SessionInput = {
  cwd: string;
  /** The first user turn. Later turns go through SessionHandle.send. */
  prompt: string;
  systemPrompt: string;
  model: string;
  /** The session's whole environment. Nothing is inherited from this process. */
  env: Record<string, string>;
  /** The built-in tools that exist in this session. */
  tools: string[];
  /** Tools approved without asking anyone. A tool listed here skips the SDK's permission prompt. */
  allowedTools?: string[];
  /** Deny rules, for example "Bash(git push *)". They hold even when decideTool allows. */
  disallowedTools?: string[];
  maxTurns: number;
  /** A cap on what this run spends. The SDK measures it from the start of the run, not from the session's carried total. */
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  skills?: string[];
  /** Folders of local plugins to mount; this is how chosen skills reach a session that loads no user settings. */
  plugins?: string[];
  additionalDirectories?: string[];
  sandbox?: Options['sandbox'];
  /** The engine's own tools (report_done and the rest), served to the session in-process as mcp__engine__<name>. */
  engineTools?: EngineTools;
  /** The engine's decision on every tool call, asked before the SDK's own permission rules. */
  decideTool: (call: ToolCall) => Promise<ToolDecision>;
};

export type SessionHandle = {
  events: AsyncIterable<RuntimeEvent>;
  /** Adds a user turn: the next turn of a running session. */
  send(text: string): void;
  /** No more turns: the session ends after the one in flight. */
  end(): void;
  stop(): void;
};

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown>;
export type RuntimeFactory = (input: SessionInput) => SessionHandle;

// ---------- one raw SDK message to zero or more events ----------

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const number = (value: unknown): number => (typeof value === 'number' ? value : 0);
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function mapMessage(raw: unknown): RuntimeEvent[] {
  const message = fields(raw);
  if (!message) return [];
  switch (message.type) {
    case 'system':
      if (message.subtype !== 'init') return [];
      return [
        {
          kind: 'session_started',
          sessionId: text(message.session_id),
          model: text(message.model),
          loginSource: text(message.apiKeySource),
          tools: list(message.tools).filter((tool): tool is string => typeof tool === 'string'),
        },
      ];
    case 'assistant': {
      const events: RuntimeEvent[] = [];
      for (const item of list(fields(message.message)?.content)) {
        const block = fields(item);
        if (block?.type === 'text') events.push({ kind: 'assistant_text', text: text(block.text) });
        if (block?.type === 'tool_use') events.push({ kind: 'tool_call', id: text(block.id), tool: text(block.name), input: block.input });
      }
      if (typeof message.error === 'string') events.push({ kind: 'api_error', error: message.error });
      const used = fields(fields(message.message)?.usage);
      if (used) events.push({ kind: 'usage_so_far', messageId: text(fields(message.message)?.id), inputTokens: number(used.input_tokens), outputTokens: number(used.output_tokens), cacheReadTokens: number(used.cache_read_input_tokens), cacheWriteTokens: number(used.cache_creation_input_tokens) });
      return events;
    }
    case 'user': {
      const events: RuntimeEvent[] = [];
      for (const item of list(fields(message.message)?.content)) {
        const block = fields(item);
        if (block?.type === 'tool_result') events.push({ kind: 'tool_result', id: text(block.tool_use_id), ok: block.is_error !== true });
      }
      return events;
    }
    case 'rate_limit_event': {
      const info = fields(message.rate_limit_info) ?? {};
      const window = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
      const named = window ? fields(fields(info.unifiedWindows)?.[window]) : null;
      return [{ kind: 'plan_usage', status: text(info.status), window, utilization: numberOrNull(info.utilization) ?? numberOrNull(named?.utilization), resetsAt: numberOrNull(info.resetsAt) }];
    }
    case 'result': {
      const reason = text(message.subtype);
      return [
        { kind: 'usage', ...turnSpend(message), sessionCostUsd: number(message.total_cost_usd) },
        {
          kind: 'turn_finished',
          sessionId: text(message.session_id),
          ok: reason === 'success' && message.is_error !== true,
          reason,
          turns: number(message.num_turns),
          denials: list(message.permission_denials).map((denial) => text(fields(denial)?.tool_name)),
        },
      ];
    }
    default:
      return [];
  }
}

type Spend = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };

/** A result's `usage` counts the main model's last turn only; the since-last-result breakdown also counts side calls. */
function turnSpend(result: Fields): Spend {
  const perModel = fields(result.model_usage_since_last_result);
  if (!perModel) {
    const usage = fields(result.usage) ?? {};
    return {
      inputTokens: number(usage.input_tokens),
      outputTokens: number(usage.output_tokens),
      cacheReadTokens: number(usage.cache_read_input_tokens),
      cacheWriteTokens: number(usage.cache_creation_input_tokens),
      costUsd: 0,
    };
  }
  const spend: Spend = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const value of Object.values(perModel)) {
    const model = fields(value) ?? {};
    spend.inputTokens += number(model.inputTokens);
    spend.outputTokens += number(model.outputTokens);
    spend.cacheReadTokens += number(model.cacheReadInputTokens);
    spend.cacheWriteTokens += number(model.cacheCreationInputTokens);
    spend.costUsd += number(model.costUSD);
  }
  return spend;
}

// ---------- a live session ----------

/** The user turns of a session, fed to the SDK as they arrive. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(content: string): void {
    this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
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

export function startSession(input: SessionInput, queryFn: QueryFn = query): SessionHandle {
  const inbox = new Inbox();
  inbox.push(input.prompt);
  const abortController = new AbortController();
  let stopped = false;

  const options: Options = {
    cwd: input.cwd,
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    allowedTools: input.allowedTools ?? [],
    disallowedTools: input.disallowedTools ?? [],
    maxTurns: input.maxTurns,
    ...(input.maxBudgetUsd !== undefined && { maxBudgetUsd: input.maxBudgetUsd }),
    ...(input.resumeSessionId !== undefined && { resume: input.resumeSessionId }),
    ...(input.skills !== undefined && { skills: input.skills }),
    ...(input.sandbox !== undefined && { sandbox: input.sandbox }),
    ...(input.engineTools !== undefined && { mcpServers: { engine: engineToolServer(input.engineTools) } }),
    plugins: (input.plugins ?? []).map((path) => ({ type: 'local' as const, path })),
    additionalDirectories: input.additionalDirectories ?? [],
    // Cut off from the machine: no user, project or local settings (so no CLAUDE.md, hooks or skills
    // that were not mounted), and none of the account's claude.ai connectors. Left alone, those
    // connectors attach to every session and add hundreds of tools to each request.
    settingSources: [],
    strictMcpConfig: true,
    env: { ...input.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    abortController,
    // The PreToolUse hook runs before every permission rule. canUseTool does not: the SDK approves
    // allowedTools, sandboxed Bash and commands it classes as read-only without asking it.
    hooks: {
      PreToolUse: [
        {
          // A limit never fails open. If this hook throws or answers nonsense the SDK blocks the call, and a
          // decision that cannot be reached is a refusal. The worker gives up asking well inside the timeout.
          onFailure: 'block',
          timeout: 120,
          hooks: [
            async (hookInput, toolUseId) => {
              if (hookInput.hook_event_name !== 'PreToolUse') return {};
              const decision = await input.decideTool({ id: toolUseId ?? hookInput.tool_use_id, tool: hookInput.tool_name, input: hookInput.tool_input }).catch((): ToolDecision => ({ allow: false, reason: 'No decision could be reached for this call, so it is refused.' }));
              return {
                hookSpecificOutput: decision.allow
                  ? { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
                  : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason ?? 'Refused by the supervisor.' },
              };
            },
          ],
        },
      ],
    },
    canUseTool: async () => ({ behavior: 'deny', message: 'No decision was reached for this call, so it is refused.' }),
  };

  async function* run(): AsyncGenerator<RuntimeEvent> {
    let sessionId: string | null = null;
    let lastTurn: { ok: boolean; reason: string } | null = null;
    let failure: string | null = null;
    try {
      for await (const raw of queryFn({ prompt: inbox, options })) {
        for (const event of mapMessage(raw)) {
          if (event.kind === 'session_started') {
            if (event.sessionId === sessionId) continue;
            sessionId = event.sessionId;
          }
          if (event.kind === 'turn_finished') lastTurn = event;
          yield event;
        }
      }
    } catch (error) {
      // After an error result the SDK's iterator throws; the result already said why.
      failure = error instanceof Error ? error.message : String(error);
    }
    if (stopped) yield { kind: 'finished', sessionId, ok: false, reason: 'stopped' };
    else if (lastTurn && !lastTurn.ok) yield { kind: 'finished', sessionId, ok: false, reason: lastTurn.reason };
    else if (failure !== null) yield { kind: 'finished', sessionId, ok: false, reason: failure };
    else if (!lastTurn) yield { kind: 'finished', sessionId, ok: false, reason: 'no_result' };
    else yield { kind: 'finished', sessionId, ok: true };
  }

  return {
    events: run(),
    send: (content) => inbox.push(content),
    end: () => inbox.close(),
    stop: () => {
      stopped = true;
      abortController.abort();
      inbox.close();
    },
  };
}
