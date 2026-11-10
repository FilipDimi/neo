import { describe, expect, it } from 'vitest';
import { pickNext, requestFor, reviewerFor, type PickInput } from '../../src/supervisor/scheduler.ts';
import { company, employee, plus, request, T0, task, team } from '../helpers.ts';

const byId = <T extends { id: string }>(...rows: T[]) => new Map(rows.map((r) => [r.id, r]));

function input(over: Partial<PickInput> = {}): PickInput {
  return {
    requests: [request()],
    tasks: byId(task()),
    teams: byId(team()),
    employees: byId(employee()),
    company: company(),
    runningEmployeeIds: new Set(),
    runningTaskIds: new Set(),
    runningCount: 0,
    spend: { company: 0, byTeam: new Map() },
    blockedRepoIds: new Set(),
    ...over,
  };
}

describe('pickNext', () => {
  it('picks the only request', () => {
    expect(pickNext(input())).toEqual({ request: request() });
  });

  it('returns null while the company is paused', () => {
    expect(pickNext(input({ company: company({ paused: { reason: 'usage_limit', until: null } }) }))).toBeNull();
  });

  it('returns null at concurrency', () => {
    expect(pickNext(input({ runningCount: 3 }))).toBeNull();
  });

  it('returns null when the company has spent its daily cap', () => {
    expect(pickNext(input({ spend: { company: 40, byTeam: new Map() } }))).toBeNull();
  });

  it('skips a team over its daily cap and picks another team', () => {
    const picked = pickNext(
      input({
        requests: [request({ id: 'r1' }), request({ id: 'r2', taskId: 'task2', employeeId: 'emp2' })],
        tasks: byId(task(), task({ id: 'task2', teamId: 'team2' })),
        teams: byId(team(), team({ id: 'team2' })),
        employees: byId(employee(), employee({ id: 'emp2', teamId: 'team2' })),
        spend: { company: 20, byTeam: new Map([['team1', 20]]) },
      }),
    );
    expect(picked).toMatchObject({ request: { id: 'r2' } });
  });

  it('never picks an employee who is already running', () => {
    // One run on a task at a time, whoever it is for: two sessions never share a folder.
    expect(pickNext(input({ runningTaskIds: new Set(['task1']) }))).toBeNull();
    expect(pickNext(input({ runningEmployeeIds: new Set(['emp1']) }))).toBeNull();
  });

  it('skips a task whose repository health has blocked', () => {
    expect(pickNext(input({ tasks: byId(task({ repoId: 'repo1' })), blockedRepoIds: new Set(['repo1']) }))).toBeNull();
  });

  it('waits for a blocked task instead of starting its request', () => {
    expect(pickNext(input({ tasks: byId(task({ state: 'blocked', blockedFrom: 'running' })) }))).toBeNull();
  });

  it('reports a request for a fired employee as a problem instead of skipping it', () => {
    expect(pickNext(input({ employees: byId(employee({ fired: true })) }))).toEqual({ problem: 'fired', request: request() });
  });

  it('reports a request whose task is finished or gone as stale', () => {
    expect(pickNext(input({ tasks: byId(task({ state: 'failed' })) }))).toEqual({ problem: 'stale', request: request() });
    expect(pickNext(input({ tasks: new Map() }))).toEqual({ problem: 'stale', request: request() });
  });

  it('orders by priority, then task age, then request age', () => {
    const requests = [
      request({ id: 'p2', taskId: 'p2', employeeId: 'a' }),
      request({ id: 'p1-new', taskId: 'p1-new', employeeId: 'b' }),
      request({ id: 'p1-old-late', taskId: 'p1-old', employeeId: 'c', createdAt: plus(T0, 9).toISOString() }),
      request({ id: 'p1-old-early', taskId: 'p1-old', employeeId: 'd' }),
    ];
    const tasks = byId(task({ id: 'p2', priority: 2 }), task({ id: 'p1-new', priority: 1, createdAt: plus(T0, 60).toISOString() }), task({ id: 'p1-old', priority: 1 }));
    const employees = byId(employee({ id: 'a' }), employee({ id: 'b' }), employee({ id: 'c' }), employee({ id: 'd' }));
    const order: string[] = [];
    let rest = requests;
    for (;;) {
      const picked = pickNext(input({ requests: rest, tasks, employees }));
      if (!picked || 'problem' in picked) break;
      order.push(picked.request.id);
      rest = rest.filter((r) => r.id !== picked.request.id);
    }
    expect(order).toEqual(['p1-old-early', 'p1-old-late', 'p1-new', 'p2']);
  });
});

describe('requestFor', () => {
  it('briefs with the lead when a task on a led team has no assignee', () => {
    expect(requestFor(task(), team({ leadId: 'lead' }))).toEqual({ mode: 'brief', employeeId: 'lead' });
  });

  it('works with the assignee, and routes a chat task', () => {
    expect(requestFor(task({ assigneeId: 'emp1' }), team({ leadId: 'lead' }))).toEqual({ mode: 'work', employeeId: 'emp1' });
    expect(requestFor(task({ assigneeId: 'cos', kind: 'chat' }), team())).toEqual({ mode: 'route', employeeId: 'cos' });
  });

  it('refuses an unassigned task on a self-managed team, and a led team with no lead', () => {
    expect(requestFor(task(), team({ selfManaged: true }))).toEqual({ problem: 'no_assignee' });
    expect(requestFor(task(), team())).toEqual({ problem: 'no_lead' });
  });
});

describe('reviewerFor', () => {
  it('is the lead on a led team', () => {
    expect(reviewerFor(task(), team({ leadId: 'lead' }), 'emp1')).toBe('lead');
  });

  it('is never the author: null when the lead did the work', () => {
    expect(reviewerFor(task(), team({ leadId: 'lead' }), 'lead')).toBeNull();
  });

  it("is the task's named reviewer when it has one, even on a self-managed team", () => {
    expect(reviewerFor(task({ reviewerId: 'rev' }), team({ selfManaged: true }), 'emp1')).toBe('rev');
    expect(reviewerFor(task({ reviewerId: 'emp1' }), team({ selfManaged: true }), 'emp1')).toBeNull();
  });

  it('is nobody on a self-managed team', () => {
    expect(reviewerFor(task(), team({ selfManaged: true, leadId: null }), 'emp1')).toBeNull();
  });
});
