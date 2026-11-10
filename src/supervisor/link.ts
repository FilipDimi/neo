/**
 * The supervisor's handle on one worker. The real one is a child process leading its own
 * process group; tests substitute an in-process one.
 */
import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToWorker, WorkerJob } from '../worker/protocol.ts';

export type WorkerLink = {
  pid: number | null;
  send(message: ToWorker): void;
  /** Kills the worker and everything it started. */
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  /** The worker is gone, whether or not it said goodbye. */
  onExit(listener: () => void): void;
};

export type Spawn = (job: WorkerJob) => WorkerLink;

export type Processes = {
  /** When a pid was started, as `ps` prints it; null when there is no such process. */
  startedAt(pid: number): string | null;
  killGroup(pid: number): void;
};

export const processes: Processes = {
  startedAt(pid) {
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  },
  killGroup(pid) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  },
};

/**
 * Starts a worker as a child process in its own process group, so that killing the group also
 * kills the Claude binary and every command the session started.
 */
export function forkSpawn(workerEntry: string, options: { logDir?: string; env?: NodeJS.ProcessEnv } = {}): Spawn {
  return (job) => {
    let log: number | 'ignore' = 'ignore';
    if (options.logDir) {
      fs.mkdirSync(options.logDir, { recursive: true });
      log = fs.openSync(path.join(options.logDir, `${job.runId}.log`), 'a');
    }
    const child = fork(workerEntry, [], {
      execArgv: ['--import', 'tsx'],
      detached: true,
      serialization: 'advanced',
      stdio: ['ignore', log, log, 'ipc'],
      env: options.env ?? process.env,
    });
    if (typeof log === 'number') fs.closeSync(log);
    child.send({ t: 'start', job } satisfies ToWorker);
    return {
      pid: child.pid ?? null,
      send: (message) => {
        if (child.connected) child.send(message);
      },
      kill: () => {
        if (child.pid) processes.killGroup(child.pid);
      },
      onMessage: (listener) => void child.on('message', listener),
      onExit: (listener) => void child.on('exit', listener),
    };
  };
}
