/** A runtime whose session starts and then never ends: for the test that a worker dies with its supervisor. */
import type { RuntimeEvent, SessionHandle, SessionInput } from '../../src/runtime/sdk.ts';

export function startSession(input: SessionInput): SessionHandle {
  async function* run(): AsyncGenerator<RuntimeEvent> {
    yield { kind: 'session_started', sessionId: 'sess-hang', model: input.model, loginSource: 'none', tools: [] };
    await new Promise(() => {});
  }
  return { events: run(), send: () => {}, end: () => {}, stop: () => {} };
}
