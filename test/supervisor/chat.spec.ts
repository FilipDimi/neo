import { afterEach, describe, expect, it } from 'vitest';
import * as store from '../../src/db/store.ts';
import { chat, messageEmployee } from '../../src/supervisor/chat.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, team, world, type World } from '../helpers.ts';

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const people = [
  employee({ id: 'neo', name: 'Neo', teamId: 'office', role: 'Chief of staff.', capabilities: ['read_files'] }),
  employee({ id: 'lead', name: 'Priya', teamId: 'ios', role: 'Leads iOS.' }),
  employee({ id: 'ada', name: 'Ada', teamId: 'ios' }),
  employee({ id: 'mw', name: 'Mara', teamId: 'marketing', role: 'Writes copy.' }),
];
const teams = [team({ id: 'office', name: 'Office', leadId: 'neo' }), team({ id: 'ios', name: 'Engineering iOS', leadId: 'lead' }), team({ id: 'marketing', name: 'Marketing', selfManaged: true })];

function company(play: (scene: Scene) => Promise<void> | void): { w: World; fixture: InProcess } {
  const fixture = inProcess(staged(play));
  const w = (open = world(fixture.spawn, { company: { chiefOfStaffId: 'neo' }, teams, employees: people }));
  return { w, fixture };
}
async function drain(w: World, fixture: InProcess, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
  }
}

describe('the company chat', () => {
  it('queues a route run for the chief of staff, with the teams in front of it', async () => {
    let turn = '';
    const { w, fixture } = company((s) => void (s.mode === 'route' && (turn = s.input.prompt)));
    const message = chat(w.sup, 'Make the open seamless and write the App Store description.');
    expect(message).toMatchObject({ fromId: 'user', toId: 'neo', state: 'delivered' });
    expect(store.openRequests(w.db)).toMatchObject([{ mode: 'route', employeeId: 'neo' }]);
    await w.sup.tick();
    await fixture.idle();
    expect(fixture.jobs[0]).toMatchObject({ mode: 'route', engineTools: ['create_task', 'set_status'], tools: ['Read', 'Glob', 'Grep'] });
    for (const part of ['Make the open seamless', 'teamId: ios', 'teamId: marketing', 'Mara (id: mw)', 'mcp__engine__create_task']) expect(turn, part).toContain(part);
  });

  it("create_task puts an unassigned task on a led team for its lead to brief, and requires an assignee on a self-managed one", async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const { w, fixture } = company(async (s) => {
      if (s.mode !== 'route') return;
      const base = { priority: 1, doneCondition: 'Done.', capUsd: 1 };
      replies.push(await s.engine('create_task', { ...base, teamId: 'ios', title: 'Seamless open', brief: 'No hand-off when the app opens.' }));
      replies.push(await s.engine('create_task', { ...base, teamId: 'marketing', title: 'App Store description', brief: 'Write it.' }));
      replies.push(await s.engine('create_task', { ...base, teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write it.' }));
      replies.push(await s.engine('create_task', { ...base, teamId: 'nowhere', title: 'Lost', brief: 'x' }));
      s.say('I wrote two tasks: the seamless open for iOS and the App Store description for Mara.');
    });
    chat(w.sup, 'Make the open seamless and write the App Store description.');
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    expect(replies.map((r) => r.ok)).toEqual([true, false, true, false]);
    expect(replies[1]!.text).toMatch(/assignee/);
    const created = store.listTasks(w.db).filter((t) => t.kind === 'work');
    expect(created.map((t) => [t.title, t.teamId, t.assigneeId, t.createdBy, t.priority])).toEqual([
      ['Seamless open', 'ios', null, 'neo', 1],
      ['App Store description', 'marketing', 'mw', 'neo', 1],
    ]);
    expect(store.openRequests(w.db).map((r) => [r.mode, r.employeeId]).sort()).toEqual([['brief', 'lead'], ['work', 'mw']]);
  });

  it("the chief of staff's reply arrives as a message, its desk says what it is doing, and the chat task is done", async () => {
    const { w, fixture } = company(async (s) => {
      if (s.mode !== 'route') return;
      const base = { priority: 2, doneCondition: 'Done.', capUsd: 1, teamId: 'marketing', assigneeId: 'mw', brief: 'Write it.' };
      await s.engine('create_task', { ...base, title: 'One' });
      await s.engine('create_task', { ...base, title: 'Two' });
      s.say('I wrote two tasks for Mara.');
    });
    chat(w.sup, 'Two things for marketing.');
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    const [chatTask] = store.listTasks(w.db).filter((t) => t.kind === 'chat');
    expect(chatTask).toMatchObject({ state: 'done', assigneeId: 'neo', teamId: 'office' });
    expect(store.runsOf(w.db, chatTask!.id)[0]).toMatchObject({ mode: 'route', outcome: 'done', activity: 'writing 2 tasks from your chat' });
    const messages = store.recentMessages(w.db, 10);
    expect(messages.at(-1)).toMatchObject({ fromId: 'neo', toId: 'user', text: 'I wrote two tasks for Mara.', taskId: chatTask!.id });
    expect(store.getEmployee(w.db, 'neo')?.chatSessionId).toBe('sess-1');
  });

  it('resumes the conversation on the next message', async () => {
    const { w, fixture } = company((s) => void (s.mode === 'route' && s.say('Noted.')));
    chat(w.sup, 'First.');
    await drain(w, fixture, 2);
    chat(w.sup, 'Second.');
    await drain(w, fixture, 2);
    expect(fixture.jobs.map((j) => j.resumeSessionId)).toEqual([undefined, 'sess-1']);
    expect(fixture.jobs[1]!.firstTurn).toContain('Second.');
  });

  it('says so when there is no chief of staff', () => {
    const fixture = inProcess(staged(() => {}));
    const w = (open = world(fixture.spawn, { teams, employees: people }));
    expect(() => chat(w.sup, 'Hello?')).toThrow(/chief of staff/);
  });
});

describe('a message to an employee', () => {
  it('reaches a running employee as its next turn', async () => {
    const { w, fixture } = company(async (s) => {
      if (s.mode === 'work') await new Promise((resolve) => setTimeout(resolve, 30));
    });
    w.sup.createTask({ teamId: 'marketing', assigneeId: 'mw', title: 'Write copy', brief: 'Write it.' });
    await w.sup.tick();
    const message = messageEmployee(w.sup, 'mw', 'Keep it under 100 words.');
    await fixture.idle();
    expect(message.taskId).toBeNull();
    expect(store.listTasks(w.db)).toHaveLength(1);
    expect(fixture.toWorker).toContainEqual(expect.objectContaining({ t: 'message', text: expect.stringContaining('Keep it under 100 words.') }));
  });

  it('becomes a task assigned to an idle employee', async () => {
    const { w } = company(() => {});
    const message = messageEmployee(w.sup, 'mw', 'Draft three taglines for the launch.');
    const [task] = store.listTasks(w.db);
    expect(task).toMatchObject({ assigneeId: 'mw', teamId: 'marketing', brief: 'Draft three taglines for the launch.', createdBy: 'user', kind: 'work' });
    expect(message).toMatchObject({ toId: 'mw', taskId: task!.id, state: 'delivered' });
    expect(store.openRequests(w.db)).toMatchObject([{ mode: 'work', employeeId: 'mw' }]);
  });
});
