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
    expect(fixture.jobs[0]).toMatchObject({ mode: 'route', engineTools: ['create_task', 'set_status', 'read_decisions', 'record_decision', 'contract_version'], tools: ['Read', 'Glob', 'Grep'] });
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

  it('puts the state of the board in front of the chief of staff with every message, so it never has to guess', async () => {
    const turns: string[] = [];
    const { w, fixture } = company(async (s) => {
      if (s.mode === 'route') return void turns.push(s.input.prompt);
      await s.engine('set_status', { text: 'docking the glass row' });
      await new Promise(() => {}); // Ada keeps working
    });
    const working = w.sup.createTask({ teamId: 'ios', assigneeId: 'ada', title: 'Dock the glass row', brief: 'Do it.' });
    w.sup.createTask({ teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write it.' });
    await w.sup.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    chat(w.sup, 'Is the iOS team working on something?');
    await w.sup.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.getTask(w.db, working.id)!.state).toBe('running');
    const turn = turns.at(-1)!;
    expect(turn).toContain('The company right now');
    expect(turn).toMatch(/Engineering iOS:\n- "Dock the glass row" \(running\): Ada is working on it \("docking the glass row"\)/);
    expect(turn).toMatch(/Marketing:\n- "App Store description"/);
    expect(turn).toMatch(/answer it from "The company right now"/);
    expect(turn).not.toContain('Is the iOS team working on something?" (');
  });

  it('treats a direct message to the chief of staff as chat, not as a task that gets ticked off', async () => {
    const { w } = company(() => {});
    const message = messageEmployee(w.sup, 'neo', 'Keep an eye on the iOS team for me.');
    expect(message.toId).toBe('neo');
    expect(store.listTasks(w.db)).toMatchObject([{ kind: 'chat', assigneeId: 'neo' }]);
    expect(store.openRequests(w.db)).toMatchObject([{ mode: 'route', employeeId: 'neo' }]);
  });

  it('says so when there is no chief of staff', () => {
    const fixture = inProcess(staged(() => {}));
    const w = (open = world(fixture.spawn, { teams, employees: people }));
    expect(() => chat(w.sup, 'Hello?')).toThrow(/chief of staff/);
  });
});

describe('Morpheus, the admin', () => {
  function admin(play: (scene: Scene) => Promise<void> | void) {
    const fixture = inProcess(staged(play));
    const morpheus = employee({ id: 'morpheus', name: 'Morpheus', teamId: 'admin', role: 'Runs this app.', capabilities: ['read_files', 'run_commands', 'write_code'] });
    const w = (open = world(fixture.spawn, { company: { chiefOfStaffId: 'neo', adminId: 'morpheus' }, teams: [...teams, team({ id: 'admin', name: 'Admin', selfManaged: true })], employees: [...people, morpheus] }));
    return { w, fixture };
  }

  it('changes the setup from a conversation, with tools only his conversations get', async () => {
    const said: string[] = [];
    let turn = '';
    const { w, fixture } = admin(async (s) => {
      if (s.mode !== 'route') return;
      turn = s.input.prompt;
      said.push((await s.engine('create_team', { name: 'Design', purpose: 'Designs the app.', selfManaged: true, dailyCapUsd: 5 })).text);
      s.say('Done: the Design team exists.');
    });
    messageEmployee(w.sup, 'morpheus', 'add a design team, $5 a day');
    await drain(w, fixture);
    expect(said[0]).toMatch(/Created the team Design \(self-managed; \$5 a day/);
    expect(store.allTeams(w.db).map((entry) => entry.name)).toContain('Design');
    expect(store.recentMessages(w.db, 5).at(-1)).toMatchObject({ fromId: 'morpheus', toId: 'user', text: 'Done: the Design team exists.' });
    expect(turn).toContain('You are the admin of this company app');
    expect(fixture.jobs[0]!.engineTools).toEqual(expect.arrayContaining(['create_task', 'company_setup', 'create_team', 'remove_team', 'hire', 'fire', 'update_company', 'set_gates']));
    // His rules are the app's, not the product's.
    expect(fixture.jobs[0]!.systemPrompt).toContain('## Your rules');
    expect(fixture.jobs[0]!.systemPrompt).not.toContain('## Company rules');
  });

  it('does not lend the setup tools to anyone else, not even the chief of staff', async () => {
    const said: string[] = [];
    const { w, fixture } = admin(async (s) => {
      if (s.mode !== 'route') return;
      said.push((await s.engine('remove_team', { team: 'Marketing' })).text);
      s.say('Tried.');
    });
    chat(w.sup, 'remove marketing');
    await drain(w, fixture);
    // The chief of staff has its own tools and the record's; the setup tools stay the admin's.
    expect(fixture.jobs[0]!.engineTools).toEqual(['create_task', 'set_status', 'read_decisions', 'record_decision', 'contract_version']);
    expect(said[0]).toMatch(/Only the admin changes the setup/);
    expect(store.allTeams(w.db).map((entry) => entry.name)).toContain('Marketing');
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

  it('is a conversation with an idle employee: answered in words, with nothing put on the board and nothing to merge', async () => {
    let turn = '';
    const { w, fixture } = company((s) => {
      if (s.mode !== 'route') throw new Error(`a question must not become ${s.mode}`);
      turn = s.input.prompt;
      s.say('Nothing right now: the iOS board is empty.');
    });
    const message = messageEmployee(w.sup, 'lead', 'yo, what are we working on?');
    const [task] = store.listTasks(w.db);
    // A chat, with no repository behind it: there is no branch, so nothing can ever ask to be merged.
    expect(task).toMatchObject({ kind: 'chat', assigneeId: 'lead', teamId: 'ios', repoId: null, brief: 'yo, what are we working on?' });
    expect(message).toMatchObject({ toId: 'lead', taskId: task!.id, state: 'delivered' });
    expect(store.openRequests(w.db)).toMatchObject([{ mode: 'route', employeeId: 'lead' }]);
    await drain(w, fixture);
    expect(store.runsOf(w.db, task!.id).map((run) => [run.mode, run.employeeId, run.outcome])).toEqual([['route', 'lead', 'done']]);
    expect(store.openDecisions(w.db)).toEqual([]);
    expect(store.getTask(w.db, task!.id)!.state).toBe('done');
    // The answer comes back as a message from the one who was asked.
    expect(store.recentMessages(w.db, 10).at(-1)).toMatchObject({ fromId: 'lead', toId: 'user', text: 'Nothing right now: the iOS board is empty.' });
    // It was told that it was written to directly, to answer from the board, and where work would go if it were asked for.
    expect(turn).toContain('The user wrote to you directly');
    expect(turn).toContain('yo, what are we working on?');
    expect(turn).toContain('The company right now');
    expect(turn).toContain('teamId: ios');
    expect(turn).not.toContain('teamId: marketing');
  });

  it('lets an employee that is asked for work put it on its own board, and on no other', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const { w, fixture } = company(async (s) => {
      if (s.mode !== 'route') return;
      const base = { priority: 2, doneCondition: 'Done.', capUsd: 1, title: 'Fix the roster', brief: 'The roster drops the last row.' };
      replies.push(await s.engine('create_task', { ...base, teamId: 'marketing', assigneeId: 'mw' }));
      replies.push(await s.engine('create_task', { ...base, teamId: 'ios' }));
      s.say('It is on the iOS board.');
    });
    messageEmployee(w.sup, 'lead', 'Fix the roster, it drops the last row.');
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    expect(replies[0]).toMatchObject({ ok: false, text: expect.stringMatching(/your own team/) });
    expect(replies[1]).toMatchObject({ ok: true });
    expect(store.listTasks(w.db).filter((task) => task.kind === 'work')).toMatchObject([{ teamId: 'ios', title: 'Fix the roster', createdBy: 'lead' }]);
  });
});
