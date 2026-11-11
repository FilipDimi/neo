import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapMessage, startSession, type RuntimeEvent, type SessionInput } from '../../src/runtime/sdk.ts';

/** Sanitised recordings of real sessions on the claude.ai login, made by scripts/spike-login.ts. */
const recording = (name: string): unknown[] => JSON.parse(readFileSync(new URL(`../fixtures/sdk/${name}.json`, import.meta.url), 'utf8')) as unknown[];
const hello = recording('helloStream');
const twoTurn = recording('twoTurnStream');
const maxTurns = recording('maxTurnsStream');
const denied = recording('deniedToolStream');

const events = (messages: unknown[]): RuntimeEvent[] => messages.flatMap(mapMessage);
const ofKind = <K extends RuntimeEvent['kind']>(list: RuntimeEvent[], kind: K) => list.filter((e): e is Extract<RuntimeEvent, { kind: K }> => e.kind === kind);

describe('mapMessage', () => {
  it('maps a one-turn recording to events in order', () => {
    const list = events(hello);
    expect(list.map((e) => e.kind)).toEqual(['session_started', 'plan_usage', 'assistant_text', 'usage_so_far', 'usage', 'turn_finished']);
    expect(list[0]).toEqual({ kind: 'session_started', sessionId: 'sess-1', model: 'claude-haiku-5-5', loginSource: 'none', tools: [] });
    expect(list[2]).toEqual({ kind: 'assistant_text', text: 'OK' });
    expect(list[3]).toMatchObject({ kind: 'usage_so_far', outputTokens: expect.any(Number) });
    expect(list[5]).toEqual({ kind: 'turn_finished', sessionId: 'sess-1', ok: true, reason: 'success', turns: 1, denials: [] });
  });

  it("reports each turn's own tokens and cost beside the session's running cost", () => {
    const [first, second] = ofKind(events(twoTurn), 'usage');
    expect(ofKind(events(twoTurn), 'usage')).toHaveLength(2);
    // The second turn re-sends almost nothing new: a running total would not be smaller than the first turn.
    expect(second!.inputTokens).toBeLessThan(first!.inputTokens);
    expect(first!.sessionCostUsd).toBeCloseTo(first!.costUsd, 10);
    expect(second!.sessionCostUsd).toBeCloseTo(first!.costUsd + second!.costUsd, 10);
    expect(second!.cacheWriteTokens).toBeGreaterThan(0);
  });

  it('pairs a tool call with its result by id', () => {
    const list = events(maxTurns);
    const [call] = ofKind(list, 'tool_call');
    expect(call).toMatchObject({ id: 'toolu-1', tool: 'Bash', input: { command: 'echo hi' } });
    expect(ofKind(list, 'tool_result')).toEqual([{ kind: 'tool_result', id: 'toolu-1', ok: true }]);
  });

  it("marks a turn that ran out of turns as not ok, with the SDK's reason", () => {
    expect(ofKind(events(maxTurns), 'turn_finished')).toEqual([{ kind: 'turn_finished', sessionId: 'sess-1', ok: false, reason: 'error_max_turns', turns: 2, denials: [] }]);
  });

  it('gives the reason of a turn the API ended, which the SDK files under "success"', () => {
    const [finished] = mapMessage({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded\nmore detail', session_id: 'sess-1', num_turns: 1, total_cost_usd: 0 }).filter((event) => event.kind === 'turn_finished');
    expect(finished).toMatchObject({ ok: false, reason: 'API Error: 529 Overloaded' });
    const [bare] = mapMessage({ type: 'result', subtype: 'success', is_error: true, session_id: 'sess-1', num_turns: 1, total_cost_usd: 0 }).filter((event) => event.kind === 'turn_finished');
    expect(bare).toMatchObject({ ok: false, reason: 'api_error' });
  });

  it('shows a refused tool call as a failed result and names it in the denials', () => {
    const list = events(denied);
    expect(ofKind(list, 'tool_result').map((e) => e.ok)).toEqual([true, false]);
    expect(ofKind(list, 'turn_finished')[0]).toMatchObject({ ok: true, denials: ['Bash'] });
  });

  it("maps the plan's rate-limit notice, reading utilisation from the named window", () => {
    const [notice] = ofKind(events(twoTurn), 'plan_usage');
    expect(notice).toMatchObject({ status: 'allowed', window: 'seven_day' });
    expect(notice!.utilization).toBeGreaterThan(0);
    expect(notice!.utilization).toBeLessThanOrEqual(1);
    expect(notice!.resetsAt).toBeGreaterThan(1_700_000_000);
  });

  it("falls back to the turn's main-model usage when the per-turn breakdown is missing", () => {
    const [usage] = ofKind(
      mapMessage({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's', total_cost_usd: 0.5, permission_denials: [], usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } }),
      'usage',
    );
    expect(usage).toEqual({ kind: 'usage', inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, costUsd: 0, sessionCostUsd: 0.5 });
  });

  it('reports what each answer of the model has used as it arrives, so a turn that never finishes can still be paid for', () => {
    const answer = { type: 'assistant', message: { id: 'msg_01', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56, cache_creation_input_tokens: 78 } } };
    expect(ofKind(mapMessage(answer), 'usage_so_far')).toEqual([{ kind: 'usage_so_far', messageId: 'msg_01', inputTokens: 12, outputTokens: 34, cacheReadTokens: 56, cacheWriteTokens: 78 }]);
    expect(ofKind(mapMessage({ type: 'assistant', message: { id: 'msg_02', content: [] } }), 'usage_so_far')).toEqual([]);
  });

  it('reports an API error carried by an assistant message', () => {
    expect(mapMessage({ type: 'assistant', error: 'rate_limit', message: { content: [] } })).toEqual([{ kind: 'api_error', error: 'rate_limit' }]);
  });

  it('ignores what it does not know', () => {
    expect(mapMessage({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 })).toEqual([]);
    expect(mapMessage({ type: 'something_new' })).toEqual([]);
    expect(mapMessage(null)).toEqual([]);
  });
});

// ---------- startSession, against a stand-in for the SDK's query() ----------

type Captured = { options: Record<string, any>; turns: string[] };

/** A stand-in for query(): records options and user turns, and replays one script entry per turn. */
function fakeQuery(script: (unknown[] | Error)[]): { queryFn: any; captured: Captured } {
  const captured: Captured = { options: {}, turns: [] };
  const queryFn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: Record<string, any> }) => {
    captured.options = options;
    return (async function* () {
      let turn = 0;
      for await (const message of prompt) {
        captured.turns.push(message.message.content);
        const step = script[turn++] ?? [];
        if (step instanceof Error) throw step;
        yield* step;
      }
    })();
  };
  return { queryFn, captured };
}

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  cwd: '/tmp/project',
  prompt: 'first',
  systemPrompt: 'You are Ada.',
  model: 'claude-haiku-5-5',
  env: { PATH: '/bin', HOME: '/Users/someone' },
  tools: ['Read', 'Bash'],
  maxTurns: 20,
  decideTool: async () => ({ allow: true }),
  ...over,
});

async function drain(handle: { events: AsyncIterable<RuntimeEvent> }, onEvent?: (e: RuntimeEvent) => void): Promise<RuntimeEvent[]> {
  const list: RuntimeEvent[] = [];
  for await (const event of handle.events) {
    list.push(event);
    onEvent?.(event);
  }
  return list;
}

const turnOne = twoTurn.slice(0, 4);
const turnTwo = twoTurn.slice(4);

describe('startSession', () => {
  it('sends the prompt as the first user turn and each send() as a later one', async () => {
    const { queryFn, captured } = fakeQuery([turnOne, turnTwo]);
    const handle = startSession(input(), queryFn);
    let finishedTurns = 0;
    await drain(handle, (e) => {
      if (e.kind !== 'turn_finished') return;
      if (++finishedTurns === 1) handle.send('second');
      else handle.end();
    });
    expect(captured.turns).toEqual(['first', 'second']);
  });

  it('announces the session once, though the SDK repeats its init message on every turn', async () => {
    const { queryFn } = fakeQuery([turnOne, turnTwo]);
    const handle = startSession(input(), queryFn);
    let finishedTurns = 0;
    const list = await drain(handle, (e) => {
      if (e.kind !== 'turn_finished') return;
      if (++finishedTurns === 1) handle.send('second');
      else handle.end();
    });
    expect(ofKind(events(twoTurn), 'session_started')).toHaveLength(2);
    expect(ofKind(list, 'session_started')).toHaveLength(1);
  });

  it('closes with a finished event once the input is ended', async () => {
    const { queryFn } = fakeQuery([hello]);
    const handle = startSession(input(), queryFn);
    const list = await drain(handle, (e) => e.kind === 'turn_finished' && handle.end());
    expect(list.at(-1)).toEqual({ kind: 'finished', sessionId: 'sess-1', ok: true });
  });

  it('still closes with finished, not ok, when the SDK throws after an error result', async () => {
    // What the spike recorded: the error result arrives, then the SDK's iterator throws.
    const queryFn: any = ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      (async function* () {
        for await (const _turn of prompt) {
          yield* maxTurns;
          throw new Error('Claude Code returned an error result: Reached maximum number of turns (1)');
        }
      })();
    const list = await drain(startSession(input(), queryFn));
    expect(list.at(-1)).toEqual({ kind: 'finished', sessionId: 'sess-1', ok: false, reason: 'error_max_turns' });
  });

  it('closes with the error text when the SDK fails before any result', async () => {
    const { queryFn } = fakeQuery([new Error('spawn claude ENOENT')]);
    const list = await drain(startSession(input(), queryFn));
    expect(list).toEqual([{ kind: 'finished', sessionId: null, ok: false, reason: 'spawn claude ENOENT' }]);
  });

  it('starts every session cut off from the machine: no setting sources, no connectors, only its own environment', async () => {
    const { queryFn, captured } = fakeQuery([hello]);
    const handle = startSession(input(), queryFn);
    await drain(handle, (e) => e.kind === 'turn_finished' && handle.end());
    expect(captured.options.settingSources).toEqual([]);
    expect(captured.options.strictMcpConfig).toBe(true);
    expect(captured.options.env).toEqual({ PATH: '/bin', HOME: '/Users/someone', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  });

  it("passes the session's shape through under the SDK's names", async () => {
    const { queryFn, captured } = fakeQuery([hello]);
    const handle = startSession(
      input({
        allowedTools: ['Read'],
        disallowedTools: ['Bash(git push *)'],
        maxBudgetUsd: 1.5,
        resumeSessionId: 'sess-9',
        skills: ['company:privacy-rules'],
        plugins: ['/data/mounts/ada'],
        additionalDirectories: ['/data/memory/ada'],
        sandbox: { enabled: true },
        engineTools: { names: ['report_done'], call: async () => ({ ok: true, text: 'ok' }) },
      }),
      queryFn,
    );
    await drain(handle, (e) => e.kind === 'turn_finished' && handle.end());
    expect(captured.options).toMatchObject({
      cwd: '/tmp/project',
      model: 'claude-haiku-5-5',
      systemPrompt: 'You are Ada.',
      tools: ['Read', 'Bash'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash(git push *)'],
      maxTurns: 20,
      maxBudgetUsd: 1.5,
      resume: 'sess-9',
      skills: ['company:privacy-rules'],
      plugins: [{ type: 'local', path: '/data/mounts/ada' }],
      additionalDirectories: ['/data/memory/ada'],
      sandbox: { enabled: true },
      mcpServers: { engine: { type: 'sdk', name: 'engine' } },
    });
  });

  it('puts every tool call to decideTool through the PreToolUse hook, the one place that sees them all', async () => {
    const { queryFn, captured } = fakeQuery([hello]);
    const asked: unknown[] = [];
    const handle = startSession(
      input({
        decideTool: async (call: { id: string; tool: string; input: unknown }) => {
          asked.push(call);
          return call.tool === 'Bash' ? { allow: false, reason: 'git push is the engine’s job' } : { allow: true };
        },
      }),
      queryFn,
    );
    await drain(handle, (e) => e.kind === 'turn_finished' && handle.end());
    const hook = captured.options.hooks.PreToolUse[0].hooks[0];
    const signal = new AbortController().signal;
    const refused = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu-7' }, 'toolu-7', { signal });
    const allowed = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu-8' }, 'toolu-8', { signal });
    expect(asked).toEqual([
      { id: 'toolu-7', tool: 'Bash', input: { command: 'git push' } },
      { id: 'toolu-8', tool: 'Read', input: { file_path: 'a.txt' } },
    ]);
    expect(refused).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'git push is the engine’s job' } });
    expect(allowed).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });

  it('refuses a tool call when the decision itself fails, and tells the SDK to block if the hook ever does', async () => {
    const { queryFn, captured } = fakeQuery([hello]);
    const handle = startSession(
      input({
        decideTool: async () => {
          throw new Error('the supervisor went away');
        },
      }),
      queryFn,
    );
    await drain(handle, (e) => e.kind === 'turn_finished' && handle.end());
    const matcher = captured.options.hooks.PreToolUse[0];
    expect(matcher.onFailure).toBe('block');
    const answer = await matcher.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu-9' }, 'toolu-9', { signal: new AbortController().signal });
    expect(answer).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
  });

  it("refuses anything that still reaches the SDK's own permission prompt", async () => {
    const { queryFn, captured } = fakeQuery([hello]);
    const handle = startSession(input(), queryFn);
    await drain(handle, (e) => e.kind === 'turn_finished' && handle.end());
    const answer = await captured.options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal });
    expect(answer.behavior).toBe('deny');
  });

  it('stop() aborts the session and closes it as stopped', async () => {
    const { queryFn, captured } = fakeQuery([turnOne, turnTwo]);
    const handle = startSession(input(), queryFn);
    const list = await drain(handle, (e) => e.kind === 'turn_finished' && handle.stop());
    expect(captured.options.abortController.signal.aborted).toBe(true);
    expect(list.at(-1)).toEqual({ kind: 'finished', sessionId: 'sess-1', ok: false, reason: 'stopped' });
  });
});
