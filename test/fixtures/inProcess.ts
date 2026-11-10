/** Runs the real worker logic in this process, on a given runtime: fast, and no child to clean up. */
import type { RuntimeFactory } from '../../src/runtime/sdk.ts';
import type { Spawn } from '../../src/supervisor/link.ts';
import type { ToSupervisor, ToWorker, WorkerJob } from '../../src/worker/protocol.ts';
import { runWorker } from '../../src/worker/worker.ts';

export type InProcess = { spawn: Spawn; jobs: WorkerJob[]; toWorker: ToWorker[]; idle(): Promise<void> };

export function inProcess(runtime: RuntimeFactory): InProcess {
  const jobs: WorkerJob[] = [];
  const toWorker: ToWorker[] = [];
  const running = new Set<Promise<void>>();
  let nextPid = 2000;
  const spawn: Spawn = (job) => {
    jobs.push(job);
    const supervisorSide: ((message: unknown) => void)[] = [];
    const workerSide: ((message: unknown) => void)[] = [];
    const exits: (() => void)[] = [];
    let dead = false;
    const later = (fn: () => void) => setImmediate(() => !dead && fn());
    const done = runWorker(job, { send: (message: ToSupervisor) => later(() => supervisorSide.forEach((l) => l(message))), onMessage: (l) => workerSide.push(l) }, runtime)
      .catch((error) => console.error('worker failed:', error))
      .finally(() => {
        running.delete(done);
        later(() => exits.forEach((l) => l()));
      });
    running.add(done);
    return {
      pid: nextPid++,
      send: (message) => {
        toWorker.push(message);
        later(() => workerSide.forEach((l) => l(message)));
      },
      kill: () => {
        if (!dead) workerSide.forEach((l) => l({ t: 'stop' }));
        dead = true;
      },
      onMessage: (l) => supervisorSide.push(l),
      onExit: (l) => exits.push(l),
    };
  };
  return {
    spawn,
    jobs,
    toWorker,
    idle: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
