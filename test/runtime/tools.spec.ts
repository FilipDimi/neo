import { describe, expect, it } from 'vitest';
import { engineToolDefinitions, engineToolServer, TOOL_DESCRIPTION } from '../../src/runtime/tools.ts';
import { ENGINE_TOOLS } from '../../src/worker/protocol.ts';

describe('the engine tool server', () => {
  it('offers exactly the named tools, each with a description', () => {
    const definitions = engineToolDefinitions({ names: ['report_done', 'set_status'], call: async () => ({ ok: true, text: 'ok' }) });
    expect(definitions.map((d) => d.name)).toEqual(['report_done', 'set_status']);
    for (const name of ENGINE_TOOLS) expect(TOOL_DESCRIPTION[name].length).toBeGreaterThan(40);
  });

  it("returns the supervisor's answer to the model, and marks a refusal as an error", async () => {
    const calls: unknown[] = [];
    const [reportDone] = engineToolDefinitions({
      names: ['report_done'],
      call: async (name, input) => {
        calls.push([name, input]);
        return (input as { summary: string }).summary === 'bad' ? { ok: false, text: 'Refused: overlap.' } : { ok: true, text: 'Recorded.' };
      },
    });
    expect(await reportDone!.handler({ summary: 'good' }, {})).toEqual({ content: [{ type: 'text', text: 'Recorded.' }], isError: false });
    expect(await reportDone!.handler({ summary: 'bad' }, {})).toEqual({ content: [{ type: 'text', text: 'Refused: overlap.' }], isError: true });
    expect(calls).toEqual([['report_done', { summary: 'good' }], ['report_done', { summary: 'bad' }]]);
  });

  it('is an in-process server named engine', () => {
    expect(engineToolServer({ names: ['report_done'], call: async () => ({ ok: true, text: '' }) })).toMatchObject({ type: 'sdk', name: 'engine' });
  });
});
