/**
 * Leases. A run must be heard from within its lease; the supervisor, a different process from
 * the one that may have hung, ends it when it is not.
 */
import { leaseEnd } from '../shared/project.ts';
import type { Run, RunRequest, Task, Team } from '../shared/types.ts';

export const leaseUntil = (now: Date, minutes: number): string => leaseEnd(now.toISOString(), minutes);

export const isExpired = (until: string, now: Date): boolean => now.getTime() > new Date(until).getTime();

/** The request may override (a retry with a longer lease), then the task, then the team. */
export function leaseMinutesFor(request: Pick<RunRequest, 'leaseMinutes'>, task: Pick<Task, 'leaseMinutes'>, team: Pick<Team, 'leaseMinutes'>): number {
  return request.leaseMinutes ?? task.leaseMinutes ?? team.leaseMinutes;
}

/** Failures that trying again can fix. A run that ended at a limit, or would not report, needs a person. */
const RETRYABLE_REASONS = new Set(['crashed', 'error_during_execution']);

/** One retry per failure, never more: a failed retry becomes a card. */
export function onFailure(run: Pick<Run, 'attempt' | 'outcome' | 'reason'>, task: Pick<Task, 'retryAllowed'>): 'retry' | 'card' {
  const retryable = run.outcome === 'expired' || (run.reason !== null && RETRYABLE_REASONS.has(run.reason));
  return task.retryAllowed && run.attempt === 1 && retryable ? 'retry' : 'card';
}
