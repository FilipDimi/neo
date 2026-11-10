/**
 * A real child process that speaks the worker protocol from a script, for the tests that need
 * a process: killing a silent worker's whole group, and a worker that dies without reporting.
 * VS_SCRIPT is JSON: [{ "send": <message>, "afterMs": 0 }, { "hang": true }, { "crash": true }]
 */
import { spawn } from 'node:child_process';

type Step = { send?: unknown; afterMs?: number; hang?: boolean; crash?: boolean };
const steps = JSON.parse(process.env.VS_SCRIPT ?? '[]') as Step[];

process.on('disconnect', () => process.exit(1));
process.on('message', async (message: { t?: string }) => {
  if (message.t !== 'start') return;
  for (const step of steps) {
    if (step.afterMs) await new Promise((resolve) => setTimeout(resolve, step.afterMs));
    if (step.send) process.send!(step.send);
    if (step.crash) process.exit(3);
    if (step.hang) {
      // A grandchild, as a session's shell commands would be: killing only this pid would leave it running.
      const child = spawn('sleep', ['600'], { stdio: 'ignore' });
      process.send!({ t: 'event', event: { kind: 'assistant_text', text: `grandchild ${child.pid}` } });
      await new Promise(() => {});
    }
  }
});
