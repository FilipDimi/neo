/**
 * What the supervisor does about runs that were in flight when it last stopped. Their workers
 * cannot be reached again (the pipe died with the old process), so every such run is expired and
 * resumed from its stored session through the scheduler.
 */
import { apply } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { Processes } from './link.ts';

export function recover(db: Db, now: Date, processes: Processes): { expired: string[]; killed: number[] } {
  const expired: string[] = [];
  const killed: number[] = [];
  for (const run of store.liveRuns(db)) {
    // A pid alone proves nothing: after a reboot another process may have it. Kill only when its start time matches too.
    if (run.pid !== null && run.pidStartedAt !== null && processes.startedAt(run.pid) === run.pidStartedAt) {
      processes.killGroup(run.pid);
      killed.push(run.pid);
    }
    const task = store.getTask(db, run.taskId);
    const teamId = store.getEmployee(db, run.employeeId)?.teamId ?? '';
    apply(
      db,
      (tx) => {
        tx.emit({ kind: 'run_ended', run: { ...run, outcome: 'expired', reason: 'restart', endedAt: now.toISOString() }, teamId });
        // A task waiting on a card resumes when the card is answered; a finished one needs nothing.
        if (!task || task.state === 'blocked' || task.state === 'done' || task.state === 'failed') return;
        const firstTurn = run.sessionId ? 'The engine restarted while you were working. The files in your folder are as you left them. Carry on with the task.' : null;
        tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: run.taskId, mode: run.mode, employeeId: run.employeeId, reason: 'resume', attempt: run.attempt, resumeSessionId: run.sessionId, firstTurn }, now) });
      },
      now,
    );
    expired.push(run.id);
  }
  return { expired, killed };
}
