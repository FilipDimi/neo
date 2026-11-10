/** An in-process stand-in for a worker process: tests script what it says and see what it is told. */
import type { Spawn } from '../../src/supervisor/link.ts';
import type { ToSupervisor, ToWorker, WorkerJob } from '../../src/worker/protocol.ts';

export type FakeWorker = {
  job: WorkerJob;
  received: ToWorker[];
  killed: boolean;
  /** Says something to the supervisor, as the worker would over IPC. */
  say(message: ToSupervisor): void;
  /** The process dies without a word. */
  die(): void;
};

export function scripted(onStart?: (worker: FakeWorker) => void): { spawn: Spawn; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  let nextPid = 1000;
  const spawn: Spawn = (job) => {
    const messageListeners: ((message: unknown) => void)[] = [];
    const exitListeners: (() => void)[] = [];
    const worker: FakeWorker = {
      job,
      received: [],
      killed: false,
      say: (message) => messageListeners.forEach((listener) => listener(message)),
      die: () => exitListeners.forEach((listener) => listener()),
    };
    workers.push(worker);
    if (onStart) queueMicrotask(() => onStart(worker));
    return {
      pid: nextPid++,
      send: (message) => worker.received.push(message),
      kill: () => (worker.killed = true),
      onMessage: (listener) => messageListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
    };
  };
  return { spawn, workers };
}

export const text = (value: string): ToSupervisor => ({ t: 'event', event: { kind: 'assistant_text', text: value } });
export const exit = (outcome: 'done' | 'failed' | 'stopped' = 'done', reason: string | null = null, sessionId: string | null = 'sess-1'): ToSupervisor => ({ t: 'exit', outcome, reason, sessionId, summary: null });
