import { afterEach, describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { ToSupervisor } from '../../src/worker/protocol.ts';
import { exit, scripted } from '../fixtures/scriptedLink.ts';
import { employee, plus, run, T0, team, world, type World } from '../helpers.ts';

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const started: ToSupervisor = { t: 'event', event: { kind: 'session_started', sessionId: 'sess-1', model: 'claude-haiku-5-5', loginSource: 'none', tools: [] } };
const usage = (costUsd: number, tokens = 100): ToSupervisor => ({ t: 'event', event: { kind: 'usage', inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, sessionCostUsd: costUsd } });
const newTask = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', title: 'Write the note', brief: 'Write it.', assigneeId: 'emp1', capUsd: 2, ...over });

describe('task caps', () => {
  it('gives each run what the task has left as its budget', async () => {
    const fake = scripted();
    const w = (open = world(fake.spawn));
    const task = newTask(w);
    apply(w.db, (tx) => tx.emit({ kind: 'run_ended', run: run({ id: 'earlier', taskId: task.id, outcome: 'expired', costUsd: 0.75 }), teamId: 'team1' }));
    await w.sup.tick();
    expect(fake.workers[0]!.job.maxBudgetUsd).toBe(1.25);
  });

  it('raises a cap card instead of starting a run for an exhausted task', async () => {
    const fake = scripted();
    const w = (open = world(fake.spawn));
    const task = newTask(w);
    apply(w.db, (tx) => tx.emit({ kind: 'run_ended', run: run({ id: 'earlier', taskId: task.id, outcome: 'done', costUsd: 2 }), teamId: 'team1' }));
    await w.sup.tick();
    expect(fake.workers).toHaveLength(0);
    const [card] = store.openDecisions(w.db);
    expect(card).toMatchObject({ kind: 'cap', taskId: task.id });
    expect(card!.text).toContain('$2.00');
    expect(card!.options.map((o) => o.label)).toEqual(['Raise by $2.00', 'Stop it']);
    expect(store.getTask(w.db, task.id)).toMatchObject({ state: 'blocked', blockedFrom: 'queued' });
  });

  it('an over-budget run blocks the task with a cap card and uses no retry', async () => {
    const fake = scripted((worker) => {
      worker.say(started);
      worker.say(usage(2.1));
      worker.say(exit('failed', 'error_max_budget_usd'));
    });
    const w = (open = world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await w.sup.settle();
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'over_budget', costUsd: 2.1 }]);
    expect(store.openRequests(w.db)).toHaveLength(0);
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'cap', taskId: task.id }]);
    expect(store.getTask(w.db, task.id)?.state).toBe('blocked');
  });

  it('Raise by adds to the cap and resumes the session with the new budget', async () => {
    const fake = scripted((worker) => {
      if (worker.job.resumeSessionId) return;
      worker.say(started);
      worker.say(usage(2.1));
      worker.say(exit('failed', 'error_max_budget_usd'));
    });
    const w = (open = world(fake.spawn));
    const task = newTask(w);
    await w.sup.tick();
    await w.sup.settle();
    w.sup.answer(store.openDecisions(w.db)[0]!.id, { optionId: 'raise' });
    await w.sup.tick();
    expect(store.getTask(w.db, task.id)).toMatchObject({ capUsd: 4, state: 'running' });
    expect(fake.workers[1]!.job).toMatchObject({ resumeSessionId: 'sess-1' });
    expect(fake.workers[1]!.job.maxBudgetUsd).toBeCloseTo(1.9, 10);
  });

  it('prices a turn the SDK reported no cost for', async () => {
    const fake = scripted((worker) => worker.say(usage(0, 1_000_000)));
    const w = (open = world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    await Promise.resolve();
    // One million tokens in and one million out on Haiku 5.5, from the price table.
    expect(store.liveRuns(w.db)[0]!.costUsd).toBeCloseTo(0.6, 10);
  });
});

describe('the usage limit', () => {
  const three = [employee(), employee({ id: 'emp2' }), employee({ id: 'emp3' })];
  const rejected = (resetsAt: number | null): ToSupervisor => ({ t: 'event', event: { kind: 'plan_usage', status: 'rejected', window: 'five_hour', utilization: 1, resetsAt } });

  it('pauses the company, raises one card for three live runs, and uses no retry', async () => {
    const fake = scripted((worker) => worker.say(started));
    const w = (open = world(fake.spawn, { employees: three }));
    const tasks = three.map((e) => newTask(w, { assigneeId: e.id }));
    await w.sup.tick();
    await Promise.resolve();
    expect(store.liveRuns(w.db)).toHaveLength(3);
    fake.workers[1]!.say(rejected(null));
    await w.sup.settle();
    expect(store.getCompany(w.db)?.paused).toEqual({ reason: 'usage_limit', until: null });
    expect(store.liveRuns(w.db)).toHaveLength(0);
    expect(fake.workers.every((worker) => worker.killed)).toBe(true);
    expect(store.allRuns(w.db).map((r) => r.outcome)).toEqual(['usage_limit', 'usage_limit', 'usage_limit']);
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'usage_limit', taskId: null }]);
    // Each run will pick its session up again, with its attempt unspent.
    expect(store.openRequests(w.db).map((r) => [r.reason, r.attempt, r.resumeSessionId])).toEqual([['resume', 1, 'sess-1'], ['resume', 1, 'sess-1'], ['resume', 1, 'sess-1']]);
    for (const task of tasks) expect(store.getTask(w.db, task.id)?.state).toBe('running');
    // Nothing starts while paused, and nobody is called idle.
    await w.sup.tick();
    expect(fake.workers).toHaveLength(3);
    expect(store.openDecisions(w.db)).toHaveLength(1);
    // The user lifts the pause.
    w.sup.answer(store.openDecisions(w.db)[0]!.id, { optionId: 'resume' });
    await w.sup.tick();
    expect(fake.workers).toHaveLength(6);
  });

  it("resumes by itself when the limit's reset time passes, and closes its card", async () => {
    const fake = scripted((worker) => worker.say(started));
    const w = (open = world(fake.spawn));
    newTask(w);
    await w.sup.tick();
    await Promise.resolve();
    const resetsAt = Math.floor(plus(T0, 3600).getTime() / 1000);
    fake.workers[0]!.say(rejected(resetsAt));
    await w.sup.settle();
    expect(store.getCompany(w.db)?.paused).toEqual({ reason: 'usage_limit', until: plus(T0, 3600).toISOString() });
    w.clock.advance(1800);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(1);
    w.clock.advance(1801);
    await w.sup.tick();
    expect(store.getCompany(w.db)?.paused).toBeNull();
    expect(store.openDecisions(w.db)).toHaveLength(0);
    expect(fake.workers).toHaveLength(2);
  });

  it('a second limit notice while paused changes nothing', async () => {
    const fake = scripted((worker) => worker.say(started));
    const w = (open = world(fake.spawn, { employees: three }));
    three.slice(0, 2).forEach((e) => newTask(w, { assigneeId: e.id }));
    await w.sup.tick();
    await Promise.resolve();
    fake.workers[0]!.say(rejected(null));
    fake.workers[1]!.say(rejected(null));
    await w.sup.settle();
    expect(store.openDecisions(w.db)).toHaveLength(1);
    expect(store.openRequests(w.db)).toHaveLength(2);
  });
});

describe('daily caps', () => {
  /** One task runs, spends, and finishes; a second is queued behind it. */
  async function spentWorld(over: Parameters<typeof world>[1], costUsd: number) {
    const fake = scripted((worker) => {
      if (fake.workers.length > 1) return;
      worker.say(started);
      worker.say(usage(costUsd));
      worker.say({ t: 'tool', askId: 'done', name: 'report_done', input: { summary: 'Done.' } });
      worker.say(exit('done'));
    });
    const w = (open = world(fake.spawn, over));
    newTask(w, { title: 'The first' });
    await w.sup.tick();
    await w.sup.settle();
    const second = newTask(w, { title: 'The second', assigneeId: 'emp2' });
    return { w, fake, second };
  }

  it("says so with a card when the company's daily cap stops work, once", async () => {
    const { w, fake } = await spentWorld({ company: { dailyCapUsd: 1 } }, 1.2);
    await w.sup.tick();
    await w.sup.tick();
    expect(fake.workers).toHaveLength(1); // nothing more starts
    const cards = store.openDecisions(w.db);
    expect(cards).toMatchObject([{ kind: 'cap', taskId: null }]);
    expect(cards[0]!.text).toMatch(/\$1\.20 of today's \$1(\.00)? cap/);
    expect(cards[0]!.text).toMatch(/1 task is waiting/);
    expect(cards[0]!.options.map((option) => option.effect)).toEqual(['raise_daily_cap', 'wait']);
  });

  it('starts the waiting work when the cap is raised from the card', async () => {
    const { w, fake, second } = await spentWorld({ company: { dailyCapUsd: 1 } }, 1.2);
    await w.sup.tick();
    const card = store.openDecisions(w.db)[0]!;
    w.sup.answer(card.id, { optionId: 'raise' });
    expect(store.getCompany(w.db)!.dailyCapUsd).toBeGreaterThan(1.2);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
    expect(store.liveRuns(w.db).map((live) => live.taskId)).toEqual([second.id]);
    expect(store.openDecisions(w.db)).toEqual([]);
  });

  it('asks only once a day when the answer is to wait, and asks again the next day if work is still stopped', async () => {
    const { w, fake } = await spentWorld({ company: { dailyCapUsd: 1 } }, 1.2);
    await w.sup.tick();
    w.sup.answer(store.openDecisions(w.db)[0]!.id, { optionId: 'wait' });
    await w.sup.tick();
    await w.sup.tick();
    expect(store.openDecisions(w.db)).toEqual([]);
    expect(fake.workers).toHaveLength(1);
    // The next day the spend starts from nothing, and the work starts by itself.
    w.clock.advance(24 * 3600);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
    expect(store.openDecisions(w.db)).toEqual([]);
  });

  it("says which team's cap it is when a team's daily cap stops its work", async () => {
    const { w, fake } = await spentWorld({ teams: [team({ selfManaged: true, dailyCapUsd: 0.5 })] }, 0.6);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(1);
    const cards = store.openDecisions(w.db);
    expect(cards).toMatchObject([{ kind: 'cap', taskId: null }]);
    expect(cards[0]!.text).toContain(store.getTeam(w.db, 'team1')!.name);
    w.sup.answer(cards[0]!.id, { optionId: 'raise' });
    expect(store.getTeam(w.db, 'team1')!.dailyCapUsd).toBeGreaterThan(0.6);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
  });

  it('raises no card when a cap is reached but nothing is waiting', async () => {
    const fake = scripted((worker) => {
      worker.say(started);
      worker.say(usage(1.2));
      worker.say({ t: 'tool', askId: 'done', name: 'report_done', input: { summary: 'Done.' } });
      worker.say(exit('done'));
    });
    const w = (open = world(fake.spawn, { company: { dailyCapUsd: 1 } }));
    newTask(w);
    await w.sup.tick();
    await w.sup.settle();
    await w.sup.tick();
    expect(store.openDecisions(w.db)).toEqual([]);
  });
});
