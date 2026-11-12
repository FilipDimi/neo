/**
 * What an event does to the rows. The engine's database and the web app's store both
 * apply this one function, so the board in the browser and the tables on disk cannot disagree,
 * and replaying the log reproduces the tables.
 * Shared with the web app: no Node imports here.
 */
import type { EventRow } from './events.ts';
import type { Run } from './types.ts';

export type TableName = 'company' | 'repos' | 'teams' | 'employees' | 'tasks' | 'runs' | 'run_requests' | 'decisions' | 'messages' | 'grants' | 'meta' | 'record' | 'contract_versions';
/** `row: null` removes the row. */
export type Change = { table: TableName; id: string; row: object | null };
export type Getter = (table: TableName, id: string) => unknown;

const put = <T extends { id: string }>(table: TableName, row: T): Change => ({ table, id: row.id, row });

export function leaseEnd(at: string, minutes: number): string {
  return new Date(new Date(at).getTime() + minutes * 60_000).toISOString();
}

/** A live run that was just heard from: its lease starts again. */
function heard(run: Run, at: string): Run {
  if (run.outcome !== 'running') return run;
  return { ...run, lastEventAt: at, leaseUntil: leaseEnd(at, run.leaseMinutes) };
}

export function changesOf(row: EventRow, get: Getter): Change[] {
  const event = row.event;
  switch (event.kind) {
    case 'company_changed':
      return [put('company', event.company)];
    case 'repo_changed':
      return [put('repos', event.repo)];
    case 'team_changed':
      return [put('teams', event.team)];
    case 'employee_changed':
      return [put('employees', event.employee)];
    case 'task_changed':
      return [put('tasks', event.task)];
    case 'run_requested':
      return [put('run_requests', event.request)];
    case 'request_dropped':
      return [{ table: 'run_requests', id: event.requestId, row: null }];
    case 'run_started':
      return [put('runs', event.run), ...(event.requestId ? [{ table: 'run_requests' as const, id: event.requestId, row: null }] : [])];
    case 'run_ended':
      return [put('runs', event.run)];
    case 'run_activity': {
      const run = get('runs', event.runId) as Run | undefined;
      return run ? [put('runs', { ...heard(run, row.at), activity: event.text })] : [];
    }
    case 'run_event': {
      const run = get('runs', event.runId) as Run | undefined;
      if (!run) return [];
      const next = heard(run, row.at);
      const inner = event.event;
      if (inner.kind === 'session_started') return [put('runs', { ...next, sessionId: inner.sessionId })];
      if (inner.kind !== 'usage') return [put('runs', next)];
      return [
        put('runs', {
          ...next,
          inputTokens: run.inputTokens + inner.inputTokens,
          outputTokens: run.outputTokens + inner.outputTokens,
          cacheReadTokens: run.cacheReadTokens + inner.cacheReadTokens,
          cacheWriteTokens: run.cacheWriteTokens + inner.cacheWriteTokens,
          costUsd: run.costUsd + inner.costUsd,
        }),
      ];
    }
    case 'gate_started':
      return [];
    case 'gate_finished': {
      const run = get('runs', event.runId) as Run | undefined;
      return run ? [put('runs', { ...run, gateResults: [...run.gateResults, event.result] })] : [];
    }
    case 'decision_raised':
    case 'decision_answered':
      return [put('decisions', event.decision)];
    case 'message_sent':
    case 'message_delivered':
      return [put('messages', event.message)];
    case 'grant_changed':
      return [put('grants', event.grant)];
    case 'record_changed':
      return [put('record', event.entry)];
    case 'contract_version_issued':
      return [put('contract_versions', event.issued)];
    case 'health_changed':
      return [{ table: 'meta', id: 'health', row: { id: 'health', ...event.report } }];
    case 'plan_usage': {
      const { kind: _kind, ...usage } = event;
      return [{ table: 'meta', id: 'planUsage', row: { id: 'planUsage', ...usage, at: row.at } }];
    }
  }
}
