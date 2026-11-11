import type { Team } from '../../src/shared/types.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, readEvents } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { costOf } from '../../src/supervisor/budget.ts';
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

  it('charges a run that is ended mid-turn for what the model had already used', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee({ model: 'claude-haiku-5-5' }), employee({ id: 'emp2', name: 'Grace' })] }));
    const task = newTask(w);
    await w.sup.tick();
    const soFar = (messageId: string, inputTokens: number, outputTokens: number): ToSupervisor => ({ t: 'event', event: { kind: 'usage_so_far', messageId, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    fake.workers[0]!.say(started);
    fake.workers[0]!.say(soFar('msg-1', 100_000, 1_000));
    fake.workers[0]!.say(soFar('msg-1', 100_000, 4_000)); // the same answer, reported again as it grows
    fake.workers[0]!.say(soFar('msg-2', 200_000, 6_000));
    w.sup.stopRun(store.liveRuns(w.db)[0]!.id);
    await w.sup.settle();

    const [run] = store.runsOf(w.db, task.id);
    expect(run).toMatchObject({ outcome: 'stopped', inputTokens: 300_000, outputTokens: 10_000 });
    expect(run!.costUsd).toBeCloseTo(costOf({ inputTokens: 300_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, 'claude-haiku-5-5'), 6);
    expect(run!.costUsd).toBeGreaterThan(0);
    expect(store.spentOn(w.db, task.id)).toBeCloseTo(run!.costUsd, 6);
    // What was only an estimate is not written down as events of its own.
    expect(readEvents(w.db, 0, 1000).some((row) => row.event.kind === 'run_event' && row.event.event.kind === 'usage_so_far')).toBe(false);
  });

  it('charges a run that is in flight when the engine stops for what the model had already used', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee({ model: 'claude-haiku-5-5' }), employee({ id: 'emp2', name: 'Grace' })] }));
    const task = newTask(w);
    await w.sup.tick();
    fake.workers[0]!.say(started);
    fake.workers[0]!.say({ t: 'event', event: { kind: 'usage_so_far', messageId: 'msg-1', inputTokens: 100_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    await w.sup.stop();

    // The run is still the next start's to recover, but what it used is on the books already.
    const [run] = store.runsOf(w.db, task.id);
    expect(run).toMatchObject({ outcome: 'running', inputTokens: 100_000, outputTokens: 4_000 });
    expect(run!.costUsd).toBeCloseTo(costOf({ inputTokens: 100_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, 'claude-haiku-5-5'), 6);
    expect(store.spentOn(w.db, task.id)).toBeCloseTo(run!.costUsd, 6);
    expect(store.spentOn(w.db, task.id)).toBeGreaterThan(0);
  });

  it("does not charge twice when the turn finishes and reports its own account", async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee({ model: 'claude-haiku-5-5' }), employee({ id: 'emp2', name: 'Grace' })] }));
    const task = newTask(w);
    await w.sup.tick();
    fake.workers[0]!.say(started);
    fake.workers[0]!.say({ t: 'event', event: { kind: 'usage_so_far', messageId: 'msg-1', inputTokens: 100_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    fake.workers[0]!.say({ t: 'event', event: { kind: 'usage', inputTokens: 100_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, sessionCostUsd: 0.25 } });
    fake.workers[0]!.say(exit('done'));
    await w.sup.settle();
    expect(store.runsOf(w.db, task.id)[0]).toMatchObject({ costUsd: 0.25, inputTokens: 100_000 });
  });

  // Making a task's folder takes a moment (a clone). These stand in for that moment and change the task during it.
  const slowFolder = (w: World) => {
    const flow = (w.sup as unknown as { flow: { prepare: (...args: unknown[]) => Promise<unknown> } }).flow;
    const real = flow.prepare.bind(flow);
    flow.prepare = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return real(...args);
    };
  };

  it('does not start a task that was cancelled while its folder was being made', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    slowFolder(w);
    const task = newTask(w);
    const tick = w.sup.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    w.sup.cancelTask(task.id);
    await tick;
    await w.sup.tick();
    await w.sup.settle();
    expect(store.getTask(w.db, task.id)!.state).toBe('failed');
    expect(store.liveRuns(w.db)).toHaveLength(0);
    expect(fake.workers).toHaveLength(0);
  });

  it('starts only the new assignee when a task was reassigned while its folder was being made', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    slowFolder(w);
    const task = newTask(w);
    const tick = w.sup.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    w.sup.editTask(task.id, { assigneeId: 'emp2' });
    await tick;
    await w.sup.tick();
    await w.sup.settle();
    expect(store.getTask(w.db, task.id)!.assigneeId).toBe('emp2');
    expect(store.liveRuns(w.db).map((run) => run.employeeId)).toEqual(['emp2']);
    expect(fake.workers).toHaveLength(1);
  });

  it('integrates a split task even when the brief run failed after its split was accepted', async () => {
    const said = (name: 'propose_subtasks' | 'report_done' | 'submit_review', input: unknown): ToSupervisor => ({ t: 'tool', askId: name, name, input });
    let briefs = 0;
    const fake = scripted((worker) => {
      const { mode } = worker.job;
      worker.say({ ...started, event: { ...started.event, sessionId: `sess-${mode}` } } as ToSupervisor);
      if (mode === 'brief' && ++briefs === 1) {
        // The split is accepted; then the lead's turn ends in an error.
        worker.say(said('propose_subtasks', { subtasks: [{ title: 'Part one', assigneeId: 'emp2', brief: 'Do it.', ownership: [], doneCondition: 'Done.', gates: [], priority: 2, capUsd: 0.5, retryAllowed: true }] }));
        return worker.say(exit('failed', 'error_max_turns', 'sess-brief'));
      }
      if (mode === 'review') worker.say(said('submit_review', { verdict: 'approve', notes: '' }));
      else worker.say(said('report_done', { summary: `${mode} done` }));
      worker.say(exit('done', null, `sess-${mode}`));
    });
    const w = track(world(fake.spawn, { teams: [team({ leadId: 'lead' })], employees: [employee({ id: 'lead', name: 'Lead' }), employee(), employee({ id: 'emp2', name: 'Grace' })] }));
    const parent = w.sup.createTask({ teamId: 'team1', title: 'Build the thing', brief: 'Split it.' });
    const pump = async () => {
      for (let i = 0; i < 10; i++) {
        await w.sup.tick();
        await new Promise((resolve) => setTimeout(resolve, 2));
        await w.sup.settle();
      }
    };
    await pump();
    // The child is through; the parent waits on the card about its failed brief.
    expect(store.listTasks(w.db, { parentId: parent.id }).map((child) => child.state)).toEqual(['done']);
    const card = store.openDecisions(w.db).find((d) => d.taskId === parent.id)!;
    expect(card.kind).toBe('failed');
    w.sup.answer(card.id, { optionId: card.options[0]!.id });
    await pump();

    expect(store.openDecisions(w.db).map((d) => [d.kind, d.text])).toEqual([]);
    expect(store.runsOf(w.db, parent.id).map((run) => run.mode)).toEqual(['brief', 'brief', 'integrate']);
    expect(store.getTask(w.db, parent.id)!.state).toBe('done');
  });

  it('lets a task waiting for someone to be assigned be given to a teammate, who starts afresh', async () => {
    const fake = scripted((worker) => {
      if (worker.job.resumeSessionId || fake.workers.length > 1) return;
      worker.say(started);
      worker.say({ t: 'tool', askId: 'q', name: 'request_decision', input: { question: 'Which way?', options: ['Left', 'Right'] } });
      worker.say(exit('stopped', 'asked', 'sess-1'));
    });
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await w.sup.settle();
    // Ada asked a question and was then let go. Answering it sends the work back to nobody.
    apply(w.db, (tx) => tx.emit({ kind: 'employee_changed', employee: { ...store.getEmployee(w.db, 'emp1')!, fired: true } }));
    const question = store.openDecisions(w.db).find((d) => d.kind === 'question')!;
    w.sup.answer(question.id, { optionId: question.options[0]!.id });
    await w.sup.tick();
    await w.sup.settle();
    const staffing = store.openDecisions(w.db);
    expect(staffing).toMatchObject([{ kind: 'staffing', taskId: task.id }]);
    expect(store.getTask(w.db, task.id)!.state).toBe('blocked');

    // "Check again" with nobody new assigned asks again, and says so.
    w.sup.answer(staffing[0]!.id, { optionId: staffing[0]!.options.find((option) => option.effect === 'recheck')!.id });
    await w.sup.tick();
    await w.sup.settle();
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'staffing', taskId: task.id }]);
    expect(fake.workers).toHaveLength(1);

    // Giving it to a teammate is what the card asks for, and it works.
    expect(w.sup.editTask(task.id, { assigneeId: 'emp2' }).assigneeId).toBe('emp2');
    expect(store.openDecisions(w.db)).toEqual([]);
    await w.sup.tick();
    await w.sup.settle();
    expect(fake.workers).toHaveLength(2);
    expect(fake.workers[1]!.job.resumeSessionId).toBeUndefined();
    expect(store.liveRuns(w.db).map((run) => run.employeeId)).toEqual(['emp2']);
    expect(store.getTask(w.db, task.id)!.state).toBe('running');
  });

  it('still refuses to reassign a task that is being worked on', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    expect(() => w.sup.editTask(task.id, { assigneeId: 'emp2' })).toThrow(/reassigned/);
  });

  it('stops a run and says so when the path of a write it allowed led somewhere else by the time the write was done', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee({ capabilities: ['read_files', 'run_commands', 'write_code'] }), employee({ id: 'emp2', name: 'Grace' })] }));
    const task = newTask(w);
    await w.sup.tick();
    const worker = fake.workers[0]!;
    const folder = worker.job.cwd;
    const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vs-elsewhere-'));
    try {
      fs.mkdirSync(path.join(folder, 'a'));
      worker.say(started);
      // The call is judged while `a` is an ordinary folder inside the task folder, and allowed.
      worker.say({ t: 'decide', askId: 'w1', call: { id: 'toolu-1', tool: 'Write', input: { file_path: path.join(folder, 'a/x.txt'), content: 'x' } } });
      expect(worker.received.find((m) => m.t === 'decision')).toMatchObject({ allow: true });
      // Before the write is done, a command of the same session swaps `a` for a link that leads out.
      fs.rmdirSync(path.join(folder, 'a'));
      fs.symlinkSync(elsewhere, path.join(folder, 'a'));
      worker.say({ t: 'event', event: { kind: 'tool_result', id: 'toolu-1', ok: true } });
      await w.sup.settle();

      expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'refused', reason: 'path_moved' }]);
      expect(worker.killed).toBe(true);
      const [card] = store.openDecisions(w.db);
      expect(card).toMatchObject({ kind: 'tool', taskId: task.id });
      expect(card!.text).toMatch(/Ada wrote .*a\/x\.txt.* changed while it was being written.* may have landed .*vs-elsewhere-/);
      expect(card!.options.map((option) => option.label)).toEqual(['Stop it', 'I looked: carry on']);
      // Carrying on says so. No call was refused: the write was done, and the user has looked at where it went.
      w.sup.answer(card!.id, { optionId: 'carry' });
      await w.sup.tick();
      expect(fake.workers[1]!.job.firstTurn).toBe('Carry on with the task where you left off.');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('leaves a write alone when its path still leads where it did', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee({ capabilities: ['read_files', 'write_code'] }), employee({ id: 'emp2', name: 'Grace' })] }));
    newTask(w);
    await w.sup.tick();
    const worker = fake.workers[0]!;
    worker.say(started);
    worker.say({ t: 'decide', askId: 'w1', call: { id: 'toolu-1', tool: 'Write', input: { file_path: path.join(worker.job.cwd, 'x.txt'), content: 'x' } } });
    worker.say({ t: 'event', event: { kind: 'tool_result', id: 'toolu-1', ok: true } });
    await w.sup.settle();
    expect(store.liveRuns(w.db)).toHaveLength(1);
    expect(store.openDecisions(w.db)).toEqual([]);
  });

  /** A task Ada wrote and Grace now reviews; returns Grace's review session. */
  async function underReview(fake: ReturnType<typeof scripted>, w: World) {
    const task = newTask(w, { reviewerId: 'emp2' });
    await w.sup.tick();
    fake.workers[0]!.say(started);
    fake.workers[0]!.say({ t: 'tool', askId: 'a1', name: 'report_done', input: { summary: 'Done.' } });
    fake.workers[0]!.say(exit('done'));
    await w.sup.settle();
    await w.sup.tick();
    const reviewer = fake.workers[1]!;
    expect(reviewer.job.mode).toBe('review');
    reviewer.say(started);
    return { task, reviewer };
  }

  it('tells a reviewer that asks for commands together with another tool that a review only reads', async () => {
    const fake = scripted();
    const all = ['read_files', 'run_commands', 'write_code', 'web_search'] as const;
    const w = track(world(fake.spawn, { employees: [employee({ capabilities: [...all] }), employee({ id: 'emp2', name: 'Grace', capabilities: ['read_files', 'run_commands'] })] }));
    const { task, reviewer } = await underReview(fake, w);
    reviewer.say({ t: 'tool', askId: 'r1', name: 'request_tools', input: { capabilities: ['run_commands', 'web_search'], reason: 'to run the tests and look something up' } });
    await new Promise((resolve) => setImmediate(resolve));
    const reply = reviewer.received.find((message) => message.t === 'tool_result');
    expect(reply).toMatchObject({ ok: false, text: expect.stringMatching(/a review only reads/) });
    expect(reply).not.toMatchObject({ text: expect.stringMatching(/already have/) });
    expect(store.openDecisions(w.db).filter((card) => card.taskId === task.id)).toEqual([]);
    expect(store.liveRuns(w.db)).toHaveLength(1);
  });

  it('keeps a verdict that was given when the engine stops before the reviewer has gone', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee(), employee({ id: 'emp2', name: 'Grace' })] }));
    const { task, reviewer } = await underReview(fake, w);
    reviewer.say({ t: 'tool', askId: 'r1', name: 'submit_review', input: { verdict: 'approve', notes: '' } });
    await new Promise((resolve) => setImmediate(resolve));
    await w.sup.stop();
    // The run was over in all but name. It is written down as it would have ended, not left for the next start to call lost.
    expect(store.runsOf(w.db, task.id).at(-1)).toMatchObject({ mode: 'review', outcome: 'done', reason: 'approved' });
    expect(store.liveRuns(w.db)).toEqual([]);
  });

  it('keeps a verdict that was given when the reviewer is cut off before it has gone, by a crash or by the plan\'s limit', async () => {
    for (const cut of ['crash', 'limit'] as const) {
      const fake = scripted();
      const w = track(world(fake.spawn, { employees: [employee(), employee({ id: 'emp2', name: 'Grace' })] }));
      const { task, reviewer } = await underReview(fake, w);
      reviewer.say({ t: 'tool', askId: 'r1', name: 'submit_review', input: { verdict: 'approve', notes: '' } });
      await new Promise((resolve) => setImmediate(resolve));
      if (cut === 'crash') reviewer.die();
      else (w.sup as unknown as { pauseForUsageLimit(until: string | null): void }).pauseForUsageLimit(null);
      await w.sup.settle();
      expect(store.runsOf(w.db, task.id).at(-1), cut).toMatchObject({ mode: 'review', outcome: 'done', reason: 'approved' });
      // It is not asked for its verdict a second time.
      expect(store.openRequests(w.db).filter((request) => request.mode === 'review'), cut).toEqual([]);
      await w.sup.stop();
    }
  });

  it('gives every run its lease again when the machine wakes from sleep, and still ends one that stays silent after that', async () => {
    const fake = scripted();
    let wall = 1_000_000;
    const w = track(world(fake.spawn, { options: { wallClock: () => wall } }));
    const task = newTask(w);
    const pass = async (seconds: number) => {
      w.clock.advance(seconds);
      wall += seconds * 1000;
      await w.sup.tick();
    };
    await w.sup.tick();
    await pass(8 * 3600); // the lid was closed for the night
    expect(store.liveRuns(w.db)).toHaveLength(1);
    expect(fake.workers[0]!.killed).toBe(false);
    for (let i = 0; i < 20; i++) await pass(50);
    expect(store.runsOf(w.db, task.id)[0]).toMatchObject({ outcome: 'expired', reason: 'silent' });
  });

  it('takes an answer in the making as a sign of life', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    w.clock.advance(10 * 60);
    fake.workers[0]!.say({ t: 'event', event: { kind: 'usage_so_far', messageId: 'm1', inputTokens: 10, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    w.clock.advance(10 * 60);
    await w.sup.tick();
    expect(store.liveRuns(w.db)).toHaveLength(1);
    expect(fake.workers[0]!.killed).toBe(false);
  });

  it('starts afresh after a session that could not be resumed twice, where the same retry would fail for ever', async () => {
    const gone = 'Claude Code process exited with code 1';
    const fake = scripted((worker) => {
      if (fake.workers.length === 1) {
        worker.say(started);
        return worker.say(exit('failed', 'crashed', 'sess-1'));
      }
      // The session's record is gone: resuming it fails before it has begun, each time.
      if (worker.job.resumeSessionId) worker.say(exit('failed', gone, worker.job.resumeSessionId));
    });
    const w = track(world(fake.spawn));
    newTask(w);
    for (let i = 0; i < 4; i++) {
      await w.sup.tick();
      await new Promise((resolve) => setImmediate(resolve));
      await w.sup.settle();
    }
    expect(fake.workers.map((worker) => worker.job.resumeSessionId ?? null)).toEqual([null, 'sess-1']);
    const [card] = store.openDecisions(w.db);
    expect(card).toMatchObject({ kind: 'failed' });
    w.sup.answer(card!.id, { optionId: 'retry' });
    await w.sup.tick();
    expect(fake.workers).toHaveLength(3);
    expect(fake.workers.at(-1)!.job.resumeSessionId ?? null).toBeNull();
  });

  it('runs the gates of a team that builds with Xcode with the Xcode tools, and other teams without', () => {
    const w = track(world(scripted().spawn));
    const limits = (team: Team) => (w.sup as unknown as { gateLimits(folder: string, team: Team): { xcode?: boolean } }).gateLimits('/tmp/x', team);
    const plain = store.getTeam(w.db, 'team1')!;
    expect(limits(plain).xcode).toBe(false);
    expect(limits({ ...plain, sandboxWrite: ['~/Library/Developer/Xcode', '~/Library/Caches'] }).xcode).toBe(true);
  });

  it('gives an employee a tool it lacks from a card whose button really does it', async () => {
    const fake = scripted((worker) => {
      if (fake.workers.length > 1) return;
      worker.say(started);
      worker.say({ t: 'tool', askId: 'need', name: 'request_tools', input: { capabilities: ['web_search', 'run_commands'], reason: 'to look up the competitors' } });
      worker.say(exit('stopped', 'asked', 'sess-1'));
    });
    const w = track(world(fake.spawn, { employees: [employee({ capabilities: ['read_files'] }), employee({ id: 'emp2', name: 'Grace' })] }));
    const task = newTask(w);
    await w.sup.tick();
    await w.sup.settle();

    expect(fake.workers[0]!.received.find((m) => m.t === 'tool_result')).toMatchObject({ ok: true });
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'stopped', reason: 'tools' }]);
    const [card] = store.openDecisions(w.db);
    expect(card).toMatchObject({ kind: 'capability', taskId: task.id, employeeId: 'emp1' });
    expect(card!.text).toMatch(/Ada .*web search and run commands.*to look up the competitors/);
    expect(card!.options.map((option) => option.effect)).toEqual(['grant_capabilities', 'resume_with_answer', 'stop_task']);
    expect(card!.options[0]!.label).toBe('Give Ada web search and run commands');

    w.sup.answer(card!.id, { optionId: card!.options[0]!.id });
    expect(store.getEmployee(w.db, 'emp1')!.capabilities).toEqual(['read_files', 'web_search', 'run_commands']);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
    expect(fake.workers[1]!.job.resumeSessionId).toBe('sess-1');
    expect(fake.workers[1]!.job.tools).toEqual(expect.arrayContaining(['Read', 'Bash', 'WebSearch', 'WebFetch']));
    expect(fake.workers[1]!.job.firstTurn).toMatch(/You now have .*web search and run commands/);
  });

  it('answers a request for a tool nobody on the team can have, or one it already has, without a card', async () => {
    const fake = scripted();
    const w = track(world(fake.spawn, { employees: [employee({ capabilities: ['read_files'] }), employee({ id: 'emp2', name: 'Grace' })] }));
    newTask(w);
    await w.sup.tick();
    fake.workers[0]!.say(started);
    fake.workers[0]!.say({ t: 'tool', askId: 'a', name: 'request_tools', input: { capabilities: ['git_push'], reason: 'to publish' } });
    fake.workers[0]!.say({ t: 'tool', askId: 'b', name: 'request_tools', input: { capabilities: ['read_files'], reason: 'to read' } });
    await w.sup.settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replies = fake.workers[0]!.received.filter((m) => m.t === 'tool_result');
    expect(replies).toMatchObject([{ askId: 'a', ok: false }, { askId: 'b', ok: false }]);
    expect((replies[0] as { text: string }).text).toMatch(/can be given: run commands, write code, web search/);
    expect((replies[1] as { text: string }).text).toMatch(/already have/);
    expect(store.openDecisions(w.db)).toEqual([]);
    expect(store.liveRuns(w.db)).toHaveLength(1);
  });

  it("says so when an employee asks a third question in a row, and drops the buttons it wrote itself", async () => {
    const fake = scripted((worker) => {
      worker.say(started);
      worker.say({ t: 'tool', askId: 'q', name: 'request_decision', input: { question: `Question ${fake.workers.length}?`, options: ['Re-run me with more tools', 'Drop it'] } });
      worker.say(exit('stopped', 'asked', 'sess-1'));
    });
    const w = track(world(fake.spawn));
    const task = newTask(w);
    for (let round = 1; round <= 3; round++) {
      await w.sup.tick();
      await w.sup.settle();
      const [card] = store.openDecisions(w.db);
      expect(card, `round ${round}`).toMatchObject({ kind: 'question', taskId: task.id });
      if (round < 3) {
        expect(card!.options.map((option) => option.label)).toEqual(['Re-run me with more tools', 'Drop it', 'Answer', 'Stop it']);
        w.sup.answer(card!.id, { optionId: card!.options[0]!.id });
      } else {
        expect(card!.text).toMatch(/^Ada has asked 3 times in a row about "Write the note" and done no work in between\./);
        expect(card!.text).toContain('Question 3?');
        expect(card!.options.map((option) => option.label)).toEqual(['Answer', 'Stop it']);
      }
    }
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
