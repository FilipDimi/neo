import { describe, expect, it } from 'vitest';
import { EngineEvent, subjectsOf } from '../../src/shared/events.ts';
import { changesOf } from '../../src/shared/project.ts';
import { company, decision, employee, message, plus, repo, request, run, T0, task, team } from '../helpers.ts';

const samples: EngineEvent[] = [
  { kind: 'company_changed', company: company() },
  { kind: 'repo_changed', repo: repo() },
  { kind: 'team_changed', team: team() },
  { kind: 'employee_changed', employee: employee() },
  { kind: 'task_changed', task: task(), cause: 'created' },
  { kind: 'run_requested', request: request() },
  { kind: 'request_dropped', requestId: 'req1', taskId: 'task1' },
  { kind: 'run_started', run: run(), requestId: 'req1', teamId: 'team1' },
  { kind: 'run_activity', runId: 'run1', taskId: 'task1', employeeId: 'emp1', text: 'docking the glass row' },
  { kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'assistant_text', text: 'hi' } },
  { kind: 'gate_started', runId: 'run1', taskId: 'task1', name: 'tests' },
  { kind: 'run_waiting', runId: 'run1', taskId: 'task1', waiting: { on: 'lock', what: 'the xcode lock, held by "Another task"', since: T0.toISOString() } },
  { kind: 'gate_finished', runId: 'run1', taskId: 'task1', result: { name: 'tests', command: 'npm test', exitCode: 0, output: 'ok', durationMs: 12 } },
  { kind: 'run_ended', run: run({ outcome: 'done', endedAt: T0.toISOString() }), teamId: 'team1' },
  { kind: 'decision_raised', decision: decision() },
  { kind: 'decision_answered', decision: decision({ answer: { optionId: 'stop' }, answeredAt: T0.toISOString() }), result: 'applied' },
  { kind: 'message_sent', message: message() },
  { kind: 'message_delivered', message: message({ state: 'delivered', deliveredAt: T0.toISOString() }) },
  { kind: 'grant_changed', grant: { id: 'g1', taskId: 'task1', tool: 'Write', inputHash: 'abc', used: false } },
  { kind: 'health_changed', report: { at: T0.toISOString(), diskFreeGb: 80, login: 'ok', repos: [], services: [], failures: [] } },
  { kind: 'plan_usage', status: 'allowed', window: 'seven_day', utilization: 0.38, resetsAt: 1794355200 },
  { kind: 'record_changed', entry: { id: 'D-1', n: 1, at: T0.toISOString(), statement: 'The API speaks JSON.', why: '', by: { kind: 'lead', employeeId: 'emp1' }, taskId: 'task1', repoId: null, replaces: null, replacedBy: null } },
  { kind: 'contract_version_issued', issued: { id: 'cv1', repoId: 'repo1', version: '0.2.0', change: 'adds', summary: 'A new endpoint.', taskId: 'task1', decisions: ['D-1'], by: 'emp1', at: T0.toISOString() } },
];

describe('the event catalogue', () => {
  it('accepts every event kind with a full row', () => {
    for (const sample of samples) expect(EngineEvent.safeParse(sample).success, sample.kind).toBe(true);
    expect(new Set(samples.map((s) => s.kind)).size).toBe(EngineEvent.options.length);
  });

  it('rejects an unknown kind and a row with a missing field', () => {
    expect(EngineEvent.safeParse({ kind: 'nope' }).success).toBe(false);
    const { title: _title, ...untitled } = task();
    expect(EngineEvent.safeParse({ kind: 'task_changed', task: untitled, cause: 'created' }).success).toBe(false);
  });

  it('names the task, run, employee and team an event is about', () => {
    expect(subjectsOf({ kind: 'task_changed', task: task({ assigneeId: 'emp1' }), cause: 'state' })).toEqual({ taskId: 'task1', runId: null, employeeId: 'emp1', teamId: 'team1' });
    expect(subjectsOf({ kind: 'run_started', run: run(), requestId: null, teamId: 'team1' })).toEqual({ taskId: 'task1', runId: 'run1', employeeId: 'emp1', teamId: 'team1' });
    expect(subjectsOf({ kind: 'company_changed', company: company() })).toEqual({ taskId: null, runId: null, employeeId: null, teamId: null });
  });
});

describe('changesOf', () => {
  const row = (event: EngineEvent, at = T0) => ({ id: 1, at: at.toISOString(), ...subjectsOf(event), event });
  const none = () => undefined;

  it('upserts the row a changed-event carries', () => {
    expect(changesOf(row({ kind: 'task_changed', task: task(), cause: 'created' }), none)).toEqual([{ table: 'tasks', id: 'task1', row: task() }]);
  });

  it('a started run replaces its request', () => {
    expect(changesOf(row({ kind: 'run_started', run: run(), requestId: 'req1', teamId: 'team1' }), none)).toEqual([
      { table: 'runs', id: 'run1', row: run() },
      { table: 'run_requests', id: 'req1', row: null },
    ]);
  });

  it('every event of a live run renews its lease and records when it was last heard', () => {
    const later = plus(T0, 60);
    const [change] = changesOf(row({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'assistant_text', text: 'hi' } }, later), () => run());
    expect(change!.row).toMatchObject({ lastEventAt: later.toISOString(), leaseUntil: plus(later, 15 * 60).toISOString() });
  });

  it("adds a turn's usage to the run and keeps the session id", () => {
    const get = () => run({ inputTokens: 10, costUsd: 0.5 });
    const usage = { kind: 'usage' as const, inputTokens: 5, outputTokens: 7, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: 0.25, sessionCostUsd: 0.75 };
    const [afterUsage] = changesOf(row({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: usage }), get);
    expect(afterUsage!.row).toMatchObject({ inputTokens: 15, outputTokens: 7, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: 0.75 });
    const started = { kind: 'session_started' as const, sessionId: 'sess-1', model: 'm', loginSource: 'none', tools: [] };
    const [afterStart] = changesOf(row({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: started }), get);
    expect(afterStart!.row).toMatchObject({ sessionId: 'sess-1' });
  });

  it('does not renew the lease of a run that has ended', () => {
    const ended = run({ outcome: 'done', endedAt: T0.toISOString() });
    const [change] = changesOf(row({ kind: 'run_activity', runId: 'run1', taskId: 'task1', employeeId: 'emp1', text: 'x' }, plus(T0, 60)), () => ended);
    expect(change!.row).toMatchObject({ activity: 'x', leaseUntil: ended.leaseUntil });
  });

  it('appends a gate result to its run', () => {
    const result = { name: 'tests', command: 'npm test', exitCode: 1, output: 'boom', durationMs: 3 };
    const [change] = changesOf(row({ kind: 'gate_finished', runId: 'run1', taskId: 'task1', result }), () => run({ outcome: 'done' }));
    // With when it finished, as the engine recorded it.
    expect((change!.row as { gateResults: unknown[] }).gateResults).toEqual([{ ...result, at: T0.toISOString() }]);
    // One the run asked for while it worked is kept apart from the engine's own.
    const [asked] = changesOf(row({ kind: 'gate_finished', runId: 'run1', taskId: 'task1', result, asked: true }), () => run({ outcome: 'running' }));
    expect(asked!.row).toMatchObject({ gateResults: [], askedGates: [{ ...result, at: T0.toISOString() }] });
  });

  it('changes nothing for a run it has never seen', () => {
    expect(changesOf(row({ kind: 'run_activity', runId: 'ghost', taskId: 'task1', employeeId: 'emp1', text: 'x' }), none)).toEqual([]);
  });
});
