import { describe, expect, it } from 'vitest';
import { GateQueue, runGate } from '../../src/git/gates.ts';
import type { Gate } from '../../src/shared/types.ts';
import { tempDir } from '../helpers.ts';

const gate = (name: string, command: string, over: Partial<Gate> = {}): Gate => ({ name, command, timeoutMinutes: 1, lock: null, ...over });

describe('gates', () => {
  it('runs a command in the folder and keeps its real exit code and output', async () => {
    const dir = tempDir();
    const passed = await runGate(gate('pwd', 'pwd && echo to-stderr >&2'), dir);
    expect(passed).toMatchObject({ name: 'pwd', command: 'pwd && echo to-stderr >&2', exitCode: 0 });
    expect(passed.output).toContain(dir);
    expect(passed.output).toContain('to-stderr');
    expect(passed.durationMs).toBeGreaterThanOrEqual(0);
    expect(await runGate(gate('fails', 'echo boom; exit 7'), dir)).toMatchObject({ exitCode: 7, output: expect.stringContaining('boom') });
  });

  it('keeps the end of a long output, capped', async () => {
    const result = await runGate(gate('long', 'for i in $(seq 1 5000); do echo "line $i"; done; echo THE-END'), tempDir());
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(8192 + 64);
    expect(result.output).toContain('THE-END');
    expect(result.output).not.toContain('line 1\n');
  });

  it('ends a gate at its timeout with a non-zero result', async () => {
    const result = await runGate(gate('slow', 'sleep 30', { timeoutMinutes: 0.005 }), tempDir());
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('timed out');
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('runs gates in order and stops at the first failure', async () => {
    const seen: string[] = [];
    const results = await new GateQueue().run([gate('one', 'true'), gate('two', 'false'), gate('three', 'true')], tempDir(), { onStart: (g) => seen.push(`start ${g.name}`), onFinish: (r) => seen.push(`${r.name} ${r.exitCode}`) });
    expect(results.map((r) => [r.name, r.exitCode])).toEqual([['one', 0], ['two', 1]]);
    expect(seen).toEqual(['start one', 'one 0', 'start two', 'two 1']);
  });

  it('runs two gates that share a lock one after the other, and unlocked ones side by side', async () => {
    const queue = new GateQueue();
    const dir = tempDir();
    const stamp = 'date +%s%N >> order.txt; sleep 0.3; date +%s%N >> order.txt';
    const overlap = async (lock: string | null) => {
      const started = Date.now();
      await Promise.all([queue.run([gate('a', stamp, { lock })], dir), queue.run([gate('b', stamp, { lock })], dir)]);
      return Date.now() - started;
    };
    expect(await overlap('xcode')).toBeGreaterThanOrEqual(580);
    expect(await overlap(null)).toBeLessThan(580);
  });
});
