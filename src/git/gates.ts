/**
 * Gates: named commands that must pass, registered per repository and run by the engine.
 * The result an employee could report is never used: the engine keeps the real exit code and output.
 */
import { spawn } from 'node:child_process';
import type { Gate, GateResult } from '../shared/types.ts';

export const GATE_OUTPUT_CAP = 8192;

export function runGate(gate: Gate, cwd: string): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Its own process group, so a timeout ends everything the gate started.
    const child = spawn('bash', ['-c', gate.command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`;
      if (output.length > GATE_OUTPUT_CAP * 2) output = output.slice(-GATE_OUTPUT_CAP); // the end is what explains a failure
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, gate.timeoutMinutes * 60_000);
    const finish = (code: number) => {
      clearTimeout(timer);
      const tail = Buffer.from(output).subarray(-GATE_OUTPUT_CAP).toString('utf8');
      resolve({
        name: gate.name,
        command: gate.command,
        exitCode: timedOut ? 124 : code,
        output: timedOut ? `${tail}\n(timed out after ${gate.timeoutMinutes} min)` : tail,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (error) => {
      output += String(error);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export type GateHooks = { onStart?: (gate: Gate) => void; onFinish?: (result: GateResult) => void };

/** Runs a task's gates in order, stopping at the first failure. Gates that share a lock never run side by side. */
export class GateQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run(gates: Gate[], cwd: string, hooks: GateHooks = {}): Promise<GateResult[]> {
    const results: GateResult[] = [];
    for (const gate of gates) {
      const once = async () => {
        hooks.onStart?.(gate);
        const result = await runGate(gate, cwd);
        hooks.onFinish?.(result);
        return result;
      };
      const result = gate.lock ? await this.locked(gate.lock, once) : await once();
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    return results;
  }

  private locked<T>(lock: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(lock) ?? Promise.resolve()).then(work, work);
    this.tails.set(
      lock,
      next.catch(() => {}),
    );
    return next;
  }
}
