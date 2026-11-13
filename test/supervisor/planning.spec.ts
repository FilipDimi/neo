import { afterEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../src/db/store.ts';
import { validateProposal } from '../../src/supervisor/briefing.ts';
import { companyNow } from '../../src/supervisor/companyNow.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { looked, staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitRepo, repo, team, world, type World } from '../helpers.ts';

// Real git, several runs.
vi.setConfig({ testTimeout: 30_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const all = ['read_files', 'run_commands', 'write_code'] as const;
const people = [employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...all] }), employee({ capabilities: [...all] }), employee({ id: 'emp2', name: 'Grace', capabilities: [...all] })];
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Priya leads Ada and Grace, unless the team is to manage itself. */
function planned(play: (scene: Scene) => Promise<void> | void, over: { selfManaged?: boolean } = {}): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo();
  const w = (open = world(fixture.spawn, {
    repos: [repo({ path: repoPath })],
    teams: [team({ leadId: over.selfManaged ? null : 'lead', selfManaged: over.selfManaged ?? false, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })],
    employees: people,
  }));
  return { w, fixture, repoPath };
}
async function drain({ w, fixture }: Setup, max = 60): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < max && quiet < 2; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    quiet = store.liveRuns(w.db).length === 0 && store.openRequests(w.db).length === 0 ? quiet + 1 : 0;
  }
}
const sub = (over: object) => ({ brief: 'Do it.', doneCondition: 'Done.', gates: [], priority: 2, capUsd: 0.5, retryAllowed: true, ...over });

describe('what depends on what', () => {
  it('does not start a task until what it waits for is done, says so on the board, and tells it where that landed', async () => {
    const order: string[] = [];
    const prompts: Record<string, string> = {};
    const setup = planned(
      async (s) => {
        const title = /# Task: (.+)/.exec(s.input.prompt)?.[1] ?? '?';
        order.push(title);
        prompts[title] = s.input.prompt;
        s.write(`${title}.md`, 'done\n');
        await s.engine('report_done', { summary: `${title} is written.` });
      },
      { selfManaged: true },
    );
    const first = setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'First', brief: 'Write the first.', doneCondition: 'It is there.' });
    const second = setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp2', title: 'Second', brief: 'Write the second.', doneCondition: 'It is there.', after: ['First'] });
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'queued', after: [first.id] });
    expect(store.openRequests(setup.w.db).map((request) => request.taskId)).toEqual([first.id]);
    expect(companyNow(setup.w.db, setup.w.clock.now())).toContain('- "Second" (queued): waiting for "First" to be done');
    await drain(setup);
    expect(order).toEqual(['First', 'Second']);
    expect(prompts.Second).toMatch(/This task waited for:\n- "First": done, merged into team/);
    expect(store.getTask(setup.w.db, second.id)!.state).toBe('done');
  });

  it('starts a sub-task that waits for another with that one\'s work in its folder, and does not count it as its own', async () => {
    const seen: string[] = [];
    const split = {
      subtasks: [
        sub({ title: 'Greeting', assigneeId: 'emp1', ownership: ['GREETING.md'] }),
        sub({ title: 'Farewell', assigneeId: 'emp2', ownership: ['FAREWELL.md'], after: ['Greeting'] }),
      ],
    };
    const setup = planned(async (s) => {
      if (s.mode === 'brief') return void (await s.engine('propose_subtasks', split));
      if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '', ...looked(s) }));
      if (s.mode === 'integrate') return void (await s.engine('report_done', { summary: 'Both are in.' }));
      seen.push(s.who);
      if (s.who === 'Ada') s.write('GREETING.md', 'hello\n');
      // Grace builds on what Ada wrote: it is in her folder.
      else s.write('FAREWELL.md', `after "${s.read('GREETING.md').trim()}": goodbye\n`);
      await s.engine('report_done', { summary: `${s.who} wrote a file.` });
    });
    const parent = setup.w.sup.createTask({ teamId: 'team1', title: 'Greet and part', brief: 'Two files, the second after the first.', doneCondition: 'Both exist.' });
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    const [greeting, farewell] = store.listTasks(setup.w.db, { parentId: parent.id });
    expect(farewell).toMatchObject({ title: 'Farewell', state: 'queued', after: [greeting!.id] });
    expect(store.openRequests(setup.w.db).map((request) => request.taskId)).toEqual([greeting!.id]);
    await drain(setup);
    expect(seen).toEqual(['Ada', 'Grace']);
    // No card: the greeting in Grace's folder is not a file she changed outside her own.
    expect(store.allDecisions(setup.w.db).map((card) => card.kind)).toEqual([]);
    expect(store.runsOf(setup.w.db, store.listTasks(setup.w.db, { parentId: parent.id })[1]!.id).find((run) => run.mode === 'work')!.diffLines).toBe(1);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath, 'team', 'FAREWELL.md')).toBe('after "hello": goodbye');
  });

  it('asks what to do with a task whose dependency was stopped, and starts it on the word', async () => {
    const setup = planned(() => {}, { selfManaged: true });
    const first = setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'First', brief: 'x', doneCondition: 'y' });
    const second = setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp2', title: 'Second', brief: 'x', doneCondition: 'y', after: [first.id] });
    setup.w.sup.cancelTask(first.id);
    await setup.w.sup.tick();
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'question', taskId: second.id, text: '"Second" was waiting for "First", which was stopped. Start "Second" anyway, or stop it too?' });
    expect(card!.options.map((option) => option.label)).toEqual(['Start it anyway', 'Stop it']);
    setup.w.sup.answer(card!.id, { optionId: 'start' });
    await setup.w.sup.tick();
    expect(store.liveRuns(setup.w.db).map((run) => run.taskId).concat(store.openRequests(setup.w.db).map((request) => request.taskId))).toContain(second.id);
    // Asked once: the card does not come back.
    await setup.w.sup.tick();
    expect(store.openDecisions(setup.w.db)).toEqual([]);
  });

  it('refuses what cannot be an order, in words', () => {
    const setup = planned(() => {}, { selfManaged: true });
    const make = (after: string[]) => () => setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Later', brief: 'x', doneCondition: 'y', after });
    expect(make(['Nothing like it'])).toThrow(/no task "Nothing like it"/);
    setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Twin', brief: 'x', doneCondition: 'y' });
    setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Twin', brief: 'x', doneCondition: 'y' });
    expect(make(['Twin'])).toThrow(/More than one task is called "Twin".*by its id/s);

    const parent = store.newTask({ teamId: 'team1', title: 'Whole', brief: 'x', createdBy: 'user' }, new Date());
    const check = (subtasks: object[]) => validateProposal({ parent, team: store.getTeam(setup.w.db, 'team1')!, employees: people, repo: null, remainingUsd: Infinity, subtasks: subtasks as never });
    const circle = check([sub({ title: 'A', assigneeId: 'emp1', ownership: [], after: ['B'] }), sub({ title: 'B', assigneeId: 'emp2', ownership: [], after: ['A'] })]);
    expect(circle).toMatchObject({ ok: false, reasons: [expect.objectContaining({ code: 'circular_order', text: expect.stringMatching(/"A" and "B" wait for each other/) })] });
    const itself = check([sub({ title: 'A', assigneeId: 'emp1', ownership: [], after: ['A'] })]);
    expect(itself).toMatchObject({ ok: false, reasons: [expect.objectContaining({ code: 'circular_order' })] });
  });
});

describe('the plan in front of the planner', () => {
  it('shows a lead its team\'s board and who has worked where, when it briefs', async () => {
    const briefs: string[] = [];
    const setup = planned(async (s) => {
      if (s.mode === 'brief') {
        briefs.push(s.input.prompt);
        return void (await s.engine('propose_subtasks', { subtasks: [sub({ title: `Part of ${briefs.length}`, assigneeId: 'emp1', ownership: [`part${briefs.length}.md`] })] }));
      }
      if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '', ...looked(s) }));
      if (s.mode === 'integrate') return void (await s.engine('report_done', { summary: 'In.' }));
      s.write(`part${briefs.length}.md`, 'x\n');
      await s.engine('report_done', { summary: 'Written.' });
    });
    setup.w.sup.createTask({ teamId: 'team1', title: 'One', brief: 'x', doneCondition: 'y' });
    await drain(setup);
    setup.w.sup.createTask({ teamId: 'team1', title: 'Two', brief: 'x', doneCondition: 'y' });
    await drain(setup);
    expect(briefs[0]).toContain('Your team\'s board');
    expect(briefs[1]).toMatch(/Your team's board[\s\S]*- "Part of 1" \(done\), Ada: part1\.md/);
    expect(briefs[1]).toMatch(/Who has worked where[\s\S]*- Ada: part1\.md/);
  });
});

describe('the first word on a ticket', () => {
  const oneTicket = { subtasks: [sub({ title: 'Greeting', assigneeId: 'emp1', ownership: ['GREETING.md'] })] };

  it('lets the lead hand a ticket to someone else when its assignee objects', async () => {
    const worked: { who: string; prompt: string }[] = [];
    const setup = planned(async (s) => {
      if (s.mode === 'brief') return void (await s.engine('propose_subtasks', oneTicket));
      if (s.mode === 'integrate') return void (await s.engine('report_done', { summary: 'In.' }));
      if (s.mode === 'review') {
        if (s.input.prompt.includes('has stopped with a question')) return void (await s.engine('submit_review', { verdict: 'send_back', notes: 'Grace takes it: she wrote the greeter.', ticket: { reassignTo: 'emp2' } }));
        return void (await s.engine('submit_review', { verdict: 'approve', notes: '', ...looked(s) }));
      }
      worked.push({ who: s.who, prompt: s.input.prompt });
      if (s.who === 'Ada') return void (await s.engine('request_decision', { question: 'Grace wrote the greeter last week; should she have this?', options: [] }));
      s.write('GREETING.md', 'hello\n');
      await s.engine('report_done', { summary: 'Grace wrote it.' });
    });
    const parent = setup.w.sup.createTask({ teamId: 'team1', title: 'Greet', brief: 'One file.', doneCondition: 'It exists.' });
    await drain(setup);
    expect(worked.map((one) => one.who)).toEqual(['Ada', 'Grace']);
    // The first turn asks for the first word.
    expect(worked[0]!.prompt).toMatch(/Before you change anything: if this is already done/);
    expect(worked[1]!.prompt).toContain('Grace takes it: she wrote the greeter.');
    expect(worked[1]!.prompt).toContain('Grace wrote the greeter last week; should she have this?');
    const [ticket] = store.listTasks(setup.w.db, { parentId: parent.id });
    expect(ticket).toMatchObject({ assigneeId: 'emp2', state: 'done' });
    expect(store.getTask(setup.w.db, parent.id)!.state).toBe('done');
  });

  it('lets the lead drop a ticket that is not needed, and the split goes on without it', async () => {
    const setup = planned(async (s) => {
      if (s.mode === 'brief') return void (await s.engine('propose_subtasks', { subtasks: [...oneTicket.subtasks, sub({ title: 'Farewell', assigneeId: 'emp2', ownership: ['FAREWELL.md'] })] }));
      if (s.mode === 'integrate') return void (await s.engine('report_done', { summary: 'In.' }));
      if (s.mode === 'review') {
        if (s.input.prompt.includes('has stopped with a question')) return void (await s.engine('submit_review', { verdict: 'send_back', notes: 'It is in README.md already.', ticket: { drop: true } }));
        return void (await s.engine('submit_review', { verdict: 'approve', notes: '', ...looked(s) }));
      }
      if (s.who === 'Ada') return void (await s.engine('request_decision', { question: 'README.md already greets (line 1). Is this still needed?', options: [] }));
      s.write('FAREWELL.md', 'bye\n');
      await s.engine('report_done', { summary: 'Grace wrote it.' });
    });
    const parent = setup.w.sup.createTask({ teamId: 'team1', title: 'Greet and part', brief: 'Two files.', doneCondition: 'They exist.' });
    await drain(setup);
    const [greeting] = store.listTasks(setup.w.db, { parentId: parent.id });
    expect(greeting).toMatchObject({ title: 'Greeting', state: 'done', dropped: { by: 'lead', why: 'It is in README.md already.' } });
    expect(store.runsOf(setup.w.db, greeting!.id).filter((run) => run.mode === 'work').map((run) => run.outcome)).toEqual(['stopped']);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done' });
    expect(companyNow(setup.w.db, setup.w.clock.now())).toContain('dropped by Priya: It is in README.md already.');
  });
});
