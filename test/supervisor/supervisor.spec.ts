import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, readEvents } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { forkSpawn } from '../../src/supervisor/link.ts';
import type { ToSupervisor } from '../../src/worker/protocol.ts';
import { exit, scripted, text } from '../fixtures/scriptedLink.ts';
import { employee, team, world, type World } from '../helpers.ts';

const SCRIPTED_WORKER = new URL('../fixtures/scriptedWorker.ts', import.meta.url).pathname;
const started: ToSupervisor = { t: 'event', event: { kind: 'session_started', sessionId: 'sess-1', model: 'm', loginSource: 'none', tools: [] } };
const newTask = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', title: 'Write the note', brief: 'Write it.', assigneeId: 'emp1', ...over });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let open: World | undefined;
const track = (w: World) => (open = w);
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

describe('Supervisor', () => {
  it('starts a worker for a request, deletes the request and records run_started', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    expect(store.openRequests(w.db)).toMatchObject([{ taskId: task.id, mode: 'work', employeeId: 'emp1', reason: 'new' }]);
    await w.sup.tick();
    const [run] = store.liveRuns(w.db);
    expect(fake.workers).toHaveLength(1);
    expect(fake.workers[0]!.job).toMatchObject({ runId: run!.id, mode: 'work' });
    expect(run).toMatchObject({ taskId: task.id, employeeId: 'emp1', attempt: 1, pid: 1000, leaseMinutes: 15 });
    expect(store.openRequests(w.db)).toHaveLength(0);
    expect(store.getTask(w.db, task.id)?.state).toBe('running');
    expect(readEvents(w.db, 0).map((e) => e.event.kind)).toContain('run_started');
  });

  it('refuses an unassigned task on a self-managed team, and an assignee from another team', () => {
    const w = track(world(scripted().spawn, { employees: [employee(), employee({ id: 'stranger', teamId: 'elsewhere' })] }));
    expect(() => newTask(w, { assigneeId: undefined })).toThrow(/assignee/);
    expect(() => newTask(w, { assigneeId: 'stranger' })).toThrow(/team/);
  });

  it('a finished run ends as done and completes its task', async () => {
    const fake = scripted((worker) => {
      worker.say(started);
      worker.say({ t: 'tool', askId: 'a1', name: 'report_done', input: { summary: 'Wrote the note.' } });
      worker.say(exit('done'));
    });
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await w.sup.settle();
    expect(store.runsOf(w.db, task.id)[0]).toMatchObject({ outcome: 'done', sessionId: 'sess-1', summary: 'Wrote the note.' });
    expect(store.getTask(w.db, task.id)?.state).toBe('done');
    expect(fake.workers[0]!.received).toContainEqual(expect.objectContaining({ t: 'tool_result', askId: 'a1', ok: true }));
  });

  it("records a run's usage on the run and in today's spend", async () => {
    const fake = scripted((worker) => worker.say({ t: 'event', event: { kind: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 5, costUsd: 0.3, sessionCostUsd: 0.3 } }));
    const w = track(world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    await Promise.resolve();
    expect(store.liveRuns(w.db)[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 5, costUsd: 0.3 });
    expect(store.spendToday(w.db, w.clock.now()).byTeam.get('team1')).toBe(0.3);
  });

  it('renews the lease on every message from the worker', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    w.clock.advance(10 * 60);
    fake.workers[0]!.say(text('still here'));
    w.clock.advance(10 * 60);
    await w.sup.tick();
    expect(store.liveRuns(w.db)).toHaveLength(1);
    expect(fake.workers[0]!.killed).toBe(false);
  });

  it('kills a silent worker, marks the run expired and queues one retry that resumes its session', async () => {
    const fake = scripted((worker) => worker.say(started));
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await Promise.resolve();
    w.clock.advance(16 * 60);
    await w.sup.tick();
    await w.sup.settle();
    expect(fake.workers[0]!.killed).toBe(true);
    // The retry is a request like any other, and the same tick starts it.
    expect(store.runsOf(w.db, task.id).map((r) => [r.outcome, r.attempt])).toEqual([['expired', 1], ['running', 2]]);
    expect(store.openRequests(w.db)).toHaveLength(0);
    expect(fake.workers[1]!.job).toMatchObject({ resumeSessionId: 'sess-1', firstTurn: expect.stringContaining('cut short') });
  });

  it('raises a lease card after the retry also expires, and blocks the task', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    for (let round = 0; round < 2; round++) {
      await w.sup.tick();
      w.clock.advance(16 * 60);
      await w.sup.tick();
      await w.sup.settle();
    }
    expect(store.runsOf(w.db, task.id).map((r) => [r.outcome, r.attempt])).toEqual([['expired', 1], ['expired', 2]]);
    expect(store.getTask(w.db, task.id)).toMatchObject({ state: 'blocked', blockedFrom: 'running' });
    const [card] = store.openDecisions(w.db);
    expect(card).toMatchObject({ kind: 'lease', taskId: task.id, employeeId: 'emp1' });
    expect(card!.text).toContain('twice');
    expect(card!.options.map((o) => o.label)).toEqual(['Retry, 30 min', 'Stop it']);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
  });

  it('respects concurrency across ticks', async () => {
    const fake = scripted();
    const employees = [employee(), employee({ id: 'emp2' }), employee({ id: 'emp3' })];
    const w = track(world(fake.spawn, { company: { concurrency: 2 }, employees }));
    for (const e of employees) newTask(w, { assigneeId: e.id });
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
    fake.workers[0]!.say(exit('done'));
    await w.sup.settle();
    await w.sup.tick();
    expect(fake.workers).toHaveLength(3);
    expect(store.liveRuns(w.db)).toHaveLength(2);
  });

  it('never gives one employee two runs at once', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    newTask(w);
    newTask(w, { title: 'A second task' });
    await w.sup.tick();
    await w.sup.tick();
    expect(fake.workers).toHaveLength(1);
  });

  it('delivers a message to a running employee and holds one for an idle employee until the next run', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    const toBusy = w.sup.send({ employeeId: 'emp1' }, 'stop at the test step', 'user');
    const sent = fake.workers[0]!.received.find((m) => m.t === 'message');
    expect(sent).toMatchObject({ id: toBusy.id, text: expect.stringContaining('stop at the test step') });
    fake.workers[0]!.say({ t: 'message_result', id: toBusy.id, delivered: true });
    expect(store.waitingMessages(w.db, 'emp1')).toHaveLength(0);

    const toIdle = w.sup.send({ employeeId: 'emp2' }, 'use the new template', 'user');
    expect(toIdle.state).toBe('waiting');
    expect(store.waitingMessages(w.db, 'emp2')).toHaveLength(1);
    newTask(w, { assigneeId: 'emp2' });
    await w.sup.tick();
    expect(fake.workers[1]!.job.firstTurn).toContain('use the new template');
    expect(store.waitingMessages(w.db, 'emp2')).toHaveLength(0);
  });

  it('keeps a message waiting when the worker could not take it', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    const message = w.sup.send({ employeeId: 'emp1' }, 'too late', 'user');
    fake.workers[0]!.say({ t: 'message_result', id: message.id, delivered: false });
    expect(store.waitingMessages(w.db, 'emp1')).toHaveLength(1);
  });

  it('raises a staffing card for a request whose employee was fired', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    apply(w.db, (tx) => tx.emit({ kind: 'employee_changed', employee: { ...store.getEmployee(w.db, 'emp1')!, fired: true } }));
    await w.sup.tick();
    expect(fake.workers).toHaveLength(0);
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'staffing', taskId: task.id }]);
    expect(store.getTask(w.db, task.id)).toMatchObject({ state: 'blocked', blockedFrom: 'queued' });
    expect(store.openRequests(w.db)).toHaveLength(0);
  });

  it('raises a staffing card at once for a task on a led team with no lead', () => {
    const w = track(world(scripted().spawn, { teams: [team()] }));
    const task = newTask(w, { assigneeId: undefined });
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'staffing', taskId: task.id }]);
  });

  it('raises an invariant card for a running task with no run, no request and no open child', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    apply(w.db, (tx) => {
      tx.emit({ kind: 'request_dropped', requestId: store.openRequests(w.db)[0]!.id, taskId: task.id });
      tx.emit({ kind: 'task_changed', task: { ...task, state: 'running' }, cause: 'state' });
    });
    await w.sup.tick();
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'invariant', taskId: task.id }]);
    expect(store.getTask(w.db, task.id)?.state).toBe('blocked');
  });

  it('leaves a running parent alone while a child is still open', async () => {
    const w = track(world(scripted().spawn));
    const parent = newTask(w);
    apply(w.db, (tx) => {
      tx.emit({ kind: 'request_dropped', requestId: store.openRequests(w.db)[0]!.id, taskId: parent.id });
      tx.emit({ kind: 'task_changed', task: { ...parent, state: 'running' }, cause: 'state' });
    });
    newTask(w, { parentId: parent.id, assigneeId: 'emp2' });
    apply(w.db, (tx) => tx.emit({ kind: 'company_changed', company: { ...store.getCompany(w.db)!, paused: { reason: 'user', until: null } } }));
    await w.sup.tick();
    expect(store.openDecisions(w.db)).toHaveLength(0);
  });

  it('stopRun ends the run as stopped, uses no retry, and asks what to do with the task', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    w.sup.stopRun(store.liveRuns(w.db)[0]!.id);
    await w.sup.settle();
    expect(fake.workers[0]!.received).toContainEqual({ t: 'stop' });
    expect(fake.workers[0]!.killed).toBe(true);
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'stopped', reason: 'stopped_by_user' }]);
    expect(store.openRequests(w.db)).toHaveLength(0);
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'failed', taskId: task.id }]);
  });

  it('a question from an employee stops the run and becomes a card whose answer resumes the session', async () => {
    const fake = scripted((worker) => {
      if (worker.job.resumeSessionId) return;
      worker.say(started);
      worker.say({ t: 'tool', askId: 'q1', name: 'request_decision', input: { question: 'Blue or green?', options: ['Blue', 'Green'] } });
      worker.say(exit('done'));
    });
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await w.sup.settle();
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'stopped', reason: 'question' }]);
    const [card] = store.openDecisions(w.db);
    expect(card).toMatchObject({ kind: 'question', text: expect.stringContaining('Blue or green?'), freeText: true });
    expect(w.sup.answer(card!.id, { optionId: 'choice2' })).toBe('applied');
    await w.sup.tick();
    expect(fake.workers[1]!.job).toMatchObject({ resumeSessionId: 'sess-1', firstTurn: expect.stringContaining('Green') });
    expect(store.getTask(w.db, task.id)?.state).toBe('running');
  });

  it('Stop it on a card fails the task and ends its live run', async () => {
    const fake = scripted((worker) => worker.say({ t: 'tool', askId: 'q1', name: 'request_decision', input: { question: 'Which?', options: [] } }));
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await Promise.resolve();
    w.sup.answer(store.openDecisions(w.db)[0]!.id, { optionId: 'stop' });
    await w.sup.settle();
    expect(store.getTask(w.db, task.id)?.state).toBe('failed');
    expect(store.liveRuns(w.db)).toHaveLength(0);
    expect(fake.workers[0]!.killed).toBe(true);
    expect(store.openDecisions(w.db)).toHaveLength(0);
  });

  it("shows an employee's status line as the run's activity", async () => {
    const fake = scripted((worker) => worker.say({ t: 'tool', askId: 's1', name: 'set_status', input: { text: 'docking the glass row' } }));
    const w = track(world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    await Promise.resolve();
    expect(store.liveRuns(w.db)[0]?.activity).toBe('docking the glass row');
  });

  it('drops a request whose task has already finished', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    apply(w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...task, state: 'failed' }, cause: 'state' }));
    await w.sup.tick();
    expect(fake.workers).toHaveLength(0);
    expect(store.openRequests(w.db)).toHaveLength(0);
  });
});

describe('Supervisor with real worker processes', () => {
  const forked = (script: unknown[]) => forkSpawn(SCRIPTED_WORKER, { env: { ...process.env, VS_SCRIPT: JSON.stringify(script) } });

  it('kills the whole process group of a silent worker', async () => {
    const w = track(world(forked([{ hang: true }])));
    const task = newTask(w);
    await w.sup.tick();
    const workerPid = store.liveRuns(w.db)[0]!.pid!;
    expect(store.liveRuns(w.db)[0]!.pidStartedAt).toBeTruthy();
    const grandchild = await vi.waitFor(() => {
      const said = readEvents(w.db, 0).flatMap((e) => (e.event.kind === 'run_event' && e.event.event.kind === 'assistant_text' ? [e.event.event.text] : []));
      const pid = Number(said.find((s) => s.startsWith('grandchild'))?.split(' ')[1]);
      expect(pid).toBeGreaterThan(0);
      return pid;
    }, 10_000);
    expect(alive(grandchild)).toBe(true);
    w.clock.advance(16 * 60);
    await w.sup.tick();
    await vi.waitFor(() => expect(alive(workerPid) || alive(grandchild)).toBe(false), 5_000);
    expect(store.runsOf(w.db, task.id)[0]).toMatchObject({ outcome: 'expired' });
  }, 20_000);

  it('treats a worker that exits without reporting as a failed run, and retries it once', async () => {
    const w = track(world(forked([{ send: text('about to die') }, { crash: true }])));
    const task = newTask(w);
    await w.sup.tick();
    await vi.waitFor(() => expect(store.runsOf(w.db, task.id)[0]).toMatchObject({ outcome: 'failed', reason: 'crashed' }), 10_000);
    await w.sup.settle();
    expect(store.openRequests(w.db)).toMatchObject([{ reason: 'retry', attempt: 2 }]);
  }, 20_000);
});
