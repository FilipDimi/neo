/**
 * A runtime with no model: a session whose every turn is played by a function.
 * It behaves as the SDK was recorded to (docs/spike): one init, then per turn its events,
 * a usage and a turn_finished; every tool call is put to decideTool first.
 */
import type { RuntimeEvent, RuntimeFactory, SessionHandle, SessionInput } from '../../src/runtime/sdk.ts';
import type { EngineTool } from '../../src/worker/protocol.ts';

export type Turn = {
  /** 0 for the first user turn. */
  index: number;
  text: string;
  input: SessionInput;
  say(text: string): void;
  /** A built-in tool call. Resolves to whether it was allowed. */
  tool(name: string, toolInput: unknown): Promise<boolean>;
  /** A call to one of the engine's tools. */
  engine(name: string, toolInput: unknown): Promise<{ ok: boolean; text: string }>;
  /** Ends the session with an error result, as the SDK does at a limit. */
  fail(reason: string): never;
};

class Failed extends Error {}

export type FakeRuntime = RuntimeFactory & { sessions: SessionInput[]; turns: string[] };

export function fakeRuntime(onTurn: (turn: Turn) => Promise<void> | void = () => {}, options: { costPerTurn?: number } = {}): FakeRuntime {
  let sessionCount = 0;
  const factory = ((input: SessionInput): SessionHandle => {
    factory.sessions.push(input);
    const sessionId = input.resumeSessionId ?? `sess-${++sessionCount}`;
    const inbox: string[] = [input.prompt];
    let closed = false;
    let stopped = false;
    let wake: (() => void) | null = null;
    let stopNow = () => {};
    const whenStopped = new Promise<void>((resolve) => (stopNow = resolve));
    let calls = 0;
    let sessionCost = 0;

    async function* run(): AsyncGenerator<RuntimeEvent> {
      const out: RuntimeEvent[] = [];
      yield { kind: 'session_started', sessionId, model: input.model, loginSource: 'none', tools: [...input.tools, ...(input.engineTools?.names ?? []).map((name) => `mcp__engine__${name}`)] };
      for (let index = 0; ; index++) {
        while (inbox.length === 0 && !closed && !stopped) await new Promise<void>((resolve) => (wake = resolve));
        if (stopped) return void (yield { kind: 'finished', sessionId, ok: false, reason: 'stopped' });
        const text = inbox.shift();
        if (text === undefined) return void (yield { kind: 'finished', sessionId, ok: true });
        factory.turns.push(text);
        const call = async (tool: string, toolInput: unknown, perform: () => Promise<{ ok: boolean; text: string }>) => {
          const id = `toolu-${sessionId}-${++calls}`;
          out.push({ kind: 'tool_call', id, tool, input: toolInput });
          const decision = await input.decideTool({ id, tool, input: toolInput });
          const result = decision.allow ? await perform() : { ok: false, text: decision.reason ?? 'refused' };
          out.push({ kind: 'tool_result', id, ok: result.ok });
          return result;
        };
        let failure: string | null = null;
        const playing = Promise.resolve()
          .then(() =>
          onTurn({
            index,
            text,
            input,
            say: (said) => void out.push({ kind: 'assistant_text', text: said }),
            tool: async (name, toolInput) => (await call(name, toolInput, async () => ({ ok: true, text: '' }))).ok,
            engine: (name, toolInput) => call(`mcp__engine__${name}`, toolInput, () => input.engineTools?.call(name as EngineTool, toolInput) ?? Promise.resolve({ ok: false, text: 'no such tool' })),
            fail: (reason) => {
              failure = reason;
              throw new Failed(reason);
            },
          }),
          )
          .then(() => {})
          .catch((error) => {
          if (!(error instanceof Failed)) throw error;
        });
        // A stop does not wait for the turn: the SDK aborts mid-call.
        await Promise.race([playing, whenStopped]);
        yield* out.splice(0);
        if (stopped) return void (yield { kind: 'finished', sessionId, ok: false, reason: 'stopped' });
        const cost = options.costPerTurn ?? 0.01;
        sessionCost += cost;
        yield { kind: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, sessionCostUsd: sessionCost };
        yield { kind: 'turn_finished', sessionId, ok: failure === null, reason: failure ?? 'success', turns: 1, denials: [] };
        if (failure !== null) return void (yield { kind: 'finished', sessionId, ok: false, reason: failure });
      }
    }

    return {
      events: run(),
      send: (text) => {
        inbox.push(text);
        wake?.();
      },
      end: () => {
        closed = true;
        wake?.();
      },
      stop: () => {
        stopped = true;
        stopNow();
        wake?.();
      },
    };
  }) as FakeRuntime;
  factory.sessions = [];
  factory.turns = [];
  return factory;
}
