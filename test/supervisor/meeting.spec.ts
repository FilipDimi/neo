import { afterEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../src/db/store.ts';
import { buildFirstTurn, buildSystemPrompt } from '../../src/supervisor/definition.ts';
import { engineToolsFor } from '../../src/supervisor/jobs.ts';
import { nextReviewer, proposalsOf, withApproval } from '../../src/supervisor/meeting.ts';
import { requestFor } from '../../src/supervisor/scheduler.ts';
import { apply } from '../../src/db/apply.ts';
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
const people = [
  employee({ id: 'neo', name: 'Neo', teamId: 'office', role: 'Chief of staff.', capabilities: ['read_files'] }),
  employee({ id: 'rlead', name: 'Rust lead', teamId: 'rust', capabilities: [...all] }),
  employee({ id: 'ilead', name: 'iOS lead', teamId: 'ios', capabilities: [...all] }),
  employee({ id: 'wlead', name: 'Web lead', teamId: 'web', capabilities: [...all] }),
  employee({ id: 'reng', name: 'Rust engineer', teamId: 'rust', capabilities: [...all] }),
  employee({ id: 'self', name: 'Solo', teamId: 'solo', capabilities: [...all] }),
];
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Rust serves an API that iOS and Web use, all in one repository whose contract is docs/contract. */
function company(play: (scene: Scene) => Promise<void> | void, over: { maxReviewRounds?: number } = {}): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo(['track/rust', 'track/ios', 'track/web']);
  const at = (branch: string) => [{ repoId: 'repo1', baseBranch: branch, mergeTarget: branch }];
  const w = (open = world(fixture.spawn, {
    company: { chiefOfStaffId: 'neo' },
    repos: [repo({ path: repoPath, contract: { paths: ['docs/contract'] } })],
    teams: [
      team({ id: 'office', name: 'Office', leadId: 'neo' }),
      team({ id: 'rust', name: 'Rust', leadId: 'rlead', repos: at('track/rust'), maxReviewRounds: over.maxReviewRounds ?? 3 }),
      team({ id: 'ios', name: 'iOS', leadId: 'ilead', repos: at('track/ios') }),
      team({ id: 'web', name: 'Web', leadId: 'wlead', repos: at('track/web') }),
      team({ id: 'solo', name: 'Solo', selfManaged: true }),
    ],
    employees: people,
  }));
  return { w, fixture, repoPath };
}
/** Runs the company until the meeting is over (so the tickets it makes are not started) or nothing moves. */
async function drain({ w, fixture }: Setup, max = 80): Promise<void> {
  let quiet = 0;
  const over = () => store.listTasks(w.db).some((task) => task.meeting && (task.state === 'done' || task.state === 'failed'));
  for (let i = 0; i < max && quiet < 2; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    if (over()) return;
    quiet = store.liveRuns(w.db).length === 0 && store.openRequests(w.db).length === 0 ? quiet + 1 : 0;
  }
}
const POSITION: Record<string, string> = { 'Rust lead': 'Rust: we can serve stages from the stages table.', 'iOS lead': 'iOS: we need stages and a short title on every card.', 'Web lead': 'Web: we need stages, and no breaking change to cards.' };
const call = { topic: 'Stages on cards', question: 'How do cards get their stages and a short title?', teams: ['Rust', 'iOS', 'Web'], author: 'Rust' };

/** Positions say their piece; the author drafts; every review plays `review`. */
const meeting = (seen: { positions: Record<string, string>; draft: string[]; reviews: { who: string; prompt: string }[] }, review: (s: Scene, round: number) => Promise<unknown>) => async (s: Scene) => {
  const prompt = s.input.prompt;
  // The chief of staff, given the card when the leads cannot agree, accepts the design as it is.
  if (s.mode === 'decide') return void (await s.engine('decide', { option: 'accept', notes: 'The design holds; what is left is for the tickets.' }));
  if (s.mode === 'review') {
    seen.reviews.push({ who: s.who, prompt });
    return void (await review(s, seen.reviews.length));
  }
  if (prompt.startsWith('# Your team\'s position')) {
    seen.positions[s.who] = prompt;
    return void (await s.engine('report_done', { summary: POSITION[s.who] }));
  }
  if (s.who === 'Rust lead') {
    seen.draft.push(prompt);
    if (!s.resumed) await s.engine('contract_version', { change: 'adds', summary: 'Stages and short titles.' });
    s.write('docs/contract/stages.md', `Version 0.1.0\nGET /v1/stages${s.resumed ? '\nshort_title is required' : ''}\n`);
    await s.engine('report_done', {
      summary: 'The design: GET /v1/stages, and short_title on every card.',
      checks: [{ file: 'docs/contract/stages.md' }],
      decisions: [{ statement: 'Cards carry a short title, and it is required.', why: 'The phone shows it on every card.' }],
      followUps: [
        { team: 'iOS', title: 'Show the stages', brief: 'Show each card\'s stages.', doneCondition: 'Stages are shown.' },
        { team: 'Rust', title: 'Serve the stages', brief: 'Serve GET /v1/stages.', doneCondition: 'It answers.' },
      ],
    });
  }
};
const approve = (s: Scene) => s.engine('submit_review', { verdict: 'approve', notes: '', findings: [], ...looked(s) });

describe('a design meeting', () => {
  it('collects positions written alone, has the author draft from all of them, and lands only when every other lead approves', async () => {
    const seen = { positions: {} as Record<string, string>, draft: [] as string[], reviews: [] as { who: string; prompt: string }[] };
    const setup = company(meeting(seen, approve));
    const called = setup.w.sup.callMeeting('ilead', call);
    expect(called.ok).toBe(true);
    const [held] = store.listTasks(setup.w.db).filter((task) => task.meeting);
    expect(held).toMatchObject({ teamId: 'rust', title: 'Design: Stages on cards', state: 'running', meeting: { topic: 'Stages on cards', calledBy: 'ilead', teams: ['rust', 'ios', 'web'], approvedBy: [] } });
    const positions = store.listTasks(setup.w.db, { parentId: held!.id });
    expect(positions.map((task) => [task.teamId, task.assigneeId, task.meetingRole])).toEqual([['rust', 'rlead', 'position'], ['ios', 'ilead', 'position'], ['web', 'wlead', 'position']]);
    await drain(setup);

    // Each position was written alone.
    expect(seen.positions['iOS lead']).toContain('How do cards get their stages and a short title?');
    expect(seen.positions['iOS lead']).not.toContain(POSITION['Rust lead']);
    expect(seen.positions['Rust lead']).not.toContain(POSITION['iOS lead']);
    // A position is not committed, gated or reviewed.
    for (const position of store.listTasks(setup.w.db, { parentId: held!.id })) expect(store.runsOf(setup.w.db, position.id).map((run) => run.mode)).toEqual(['work']);
    // The author drafted from all of them.
    for (const part of ['Stages on cards', POSITION['Rust lead'], POSITION['iOS lead'], POSITION['Web lead'], 'iOS lead', 'mcp__engine__contract_version', 'followUps']) expect(seen.draft[0], part).toContain(part);
    // Every other lead reviewed, in order, each shown its own position and what the design proposes.
    expect(seen.reviews.map((review) => review.who)).toEqual(['iOS lead', 'Web lead']);
    for (const part of ['Stages on cards', POSITION['iOS lead'], 'Cards carry a short title, and it is required.', 'Show the stages']) expect(seen.reviews[0]!.prompt, part).toContain(part);
    expect(seen.reviews[1]!.prompt).toContain(POSITION['Web lead']);

    // Settled: the draft landed, the decision is on record, the tickets are made on it, and the user is told.
    const done = store.getTask(setup.w.db, held!.id)!;
    expect(done).toMatchObject({ state: 'done', mergedInto: 'track/rust' });
    expect(fileAt(setup.repoPath, 'track/rust', 'docs/contract/stages.md')).toContain('GET /v1/stages');
    const [decided] = store.allRecord(setup.w.db);
    expect(decided).toMatchObject({ statement: 'Cards carry a short title, and it is required.', by: { kind: 'lead', employeeId: 'rlead' }, taskId: held!.id });
    const followUps = store.listTasks(setup.w.db).filter((task) => task.title === 'Show the stages' || task.title === 'Serve the stages');
    expect(followUps.map((task) => [task.teamId, task.title, task.builtOn?.decisions])).toEqual([['ios', 'Show the stages', [decided!.id]], ['rust', 'Serve the stages', [decided!.id]]]);
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.fromId === 'neo' && message.toId === 'user');
    expect(told.at(-1)!.text).toMatch(new RegExp(`^Design agreed: Stages on cards\\. Decided ${decided!.id}: Cards carry a short title, and it is required\\. Contract 0\\.1\\.0\\. Tickets: iOS "Show the stages", Rust "Serve the stages"\\.$`));
  });

  it('goes back to the author when a lead sends it back, and every lead reviews again', async () => {
    const seen = { positions: {} as Record<string, string>, draft: [] as string[], reviews: [] as { who: string; prompt: string }[] };
    const setup = company(
      meeting(seen, (s, round) =>
        round === 2 ? s.engine('submit_review', { verdict: 'send_back', notes: 'Say that short_title is required.', findings: [{ severity: 'blocking', file: 'docs/contract/stages.md', title: 'short_title is not required', why: 'The phone needs it on every card.', fix: 'Mark it required.' }] }) : approve(s),
      ),
    );
    setup.w.sup.callMeeting('neo', call);
    await drain(setup);
    // iOS approved, Web sent it back, the author fixed it, and both reviewed again.
    expect(seen.reviews.map((review) => review.who)).toEqual(['iOS lead', 'Web lead', 'iOS lead', 'Web lead']);
    expect(seen.draft[1]).toContain('Say that short_title is required.');
    const [held] = store.listTasks(setup.w.db).filter((task) => task.meeting);
    expect(held).toMatchObject({ state: 'done', reviewRounds: 1 });
  });

  it('gives the card to the chief of staff when the rounds run out, though the user decides the company\'s cards', async () => {
    const seen = { positions: {} as Record<string, string>, draft: [] as string[], reviews: [] as { who: string; prompt: string }[] };
    const setup = company(meeting(seen, (s) => s.engine('submit_review', { verdict: 'send_back', notes: 'Not like this.', findings: [{ severity: 'blocking', file: 'docs/contract/stages.md', title: 'Wrong shape', why: 'It breaks the phone.', fix: 'Change it.' }] })), { maxReviewRounds: 1 });
    setup.w.sup.callMeeting('neo', call);
    await drain(setup);
    // The user decides the company's cards, but this one went to the chief of staff, who accepted the design as it is.
    expect(store.getCompany(setup.w.db)!.decider).not.toBe('chief');
    const [card] = store.allDecisions(setup.w.db).filter((one) => one.kind === 'review');
    expect(card).toMatchObject({ deciderId: 'neo', answer: { optionId: 'accept', by: 'neo' } });
    expect(store.forUser(setup.w.db)).toEqual([]);
    const [held] = store.listTasks(setup.w.db).filter((task) => task.meeting);
    expect(held).toMatchObject({ state: 'done', mergedInto: 'track/rust' });
    expect(store.allRecord(setup.w.db).map((entry) => entry.statement)).toEqual(['Cards carry a short title, and it is required.']);
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.fromId === 'neo' && message.toId === 'user');
    expect(told.at(-1)!.text).toMatch(/^Design settled: Stages on cards\. The leads did not all agree, and Neo accepted it as it is: The design holds; what is left is for the tickets\. Decided D-/);
  });

  it('is called by a lead or the chief of staff only, and refuses what cannot be a meeting, in words', () => {
    const setup = company(() => {});
    const { sup } = setup.w;
    expect(sup.callMeeting('reng', call)).toMatchObject({ ok: false, text: expect.stringMatching(/lead or the chief of staff/) });
    expect(sup.callMeeting('ilead', { ...call, teams: ['Rust'] })).toMatchObject({ ok: false, text: expect.stringMatching(/at least two teams/) });
    expect(sup.callMeeting('ilead', { ...call, teams: ['Rust', 'Marketing'] })).toMatchObject({ ok: false, text: expect.stringMatching(/no team "Marketing".*Rust, iOS, Web/) });
    expect(sup.callMeeting('ilead', { ...call, teams: ['Rust', 'Solo'] })).toMatchObject({ ok: false, text: expect.stringMatching(/Solo has no lead/) });
    expect(sup.callMeeting('ilead', { ...call, author: 'Web', teams: ['Rust', 'iOS'] })).toMatchObject({ ok: false, text: expect.stringMatching(/author.*one of the teams/) });
    expect(sup.callMeeting('ilead', { ...call, author: 'Office', teams: ['Office', 'iOS'] })).toMatchObject({ ok: false, text: expect.stringMatching(/Office works in no repository/) });
    expect(store.listTasks(setup.w.db)).toEqual([]);
  });

  it('is offered to leads and the chief of staff, and named in their turns', () => {
    const base = { deciding: false, admin: false, chief: false, lead: false };
    expect(engineToolsFor({ ...base, mode: 'work', lead: true })).toContain('call_meeting');
    expect(engineToolsFor({ ...base, mode: 'route', chief: true })).toContain('call_meeting');
    expect(engineToolsFor({ ...base, mode: 'work' })).not.toContain('call_meeting');
    // Not while deciding a card for the user.
    expect(engineToolsFor({ ...base, mode: 'route', chief: true, deciding: true })).not.toContain('call_meeting');
    const setup = company(() => {});
    const company_ = store.getCompany(setup.w.db)!;
    const rust = store.getTeam(setup.w.db, 'rust')!;
    const lead = store.getEmployee(setup.w.db, 'rlead')!;
    expect(buildSystemPrompt({ company: company_, team: rust, employee: lead, teammates: [], memoryIndex: '', mode: 'work', meetings: true })).toContain('mcp__engine__call_meeting');
    expect(buildSystemPrompt({ company: company_, team: rust, employee: lead, teammates: [], memoryIndex: '', mode: 'work' })).not.toContain('mcp__engine__call_meeting');
    const chat = store.newTask({ teamId: 'office', title: 'Chat', brief: 'The phone needs stages from the API.', createdBy: 'user', kind: 'chat' }, new Date());
    expect(buildFirstTurn({ task: chat, mode: 'route', team: store.getTeam(setup.w.db, 'office')!, repo: null, teammates: [], remainingUsd: 0, chief: true })).toContain('mcp__engine__call_meeting');
  });

  it('is called by a lead from its own work, which carries on', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const setup = company(async (s) => {
      if (!s.input.prompt.includes('# Task: Show stages on the phone')) return;
      replies.push(await s.engine('call_meeting', call));
      s.write('ios/Stages.swift', 'struct Stages {}\n');
      await s.engine('report_done', { summary: 'The screen is ready for stages; the API is being agreed in a meeting.', checks: [{ file: 'ios/Stages.swift' }] });
    });
    const own = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', parentId: null, title: 'Show stages on the phone', brief: 'Show each card\'s stages.', doneCondition: 'Stages are shown.' });
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    expect(replies).toMatchObject([{ ok: true, text: expect.stringMatching(/^Called: "Stages on cards", with Rust, iOS and Web\..*carry on/) }]);
    const [held] = store.listTasks(setup.w.db).filter((task) => task.meeting);
    expect(held!.meeting).toMatchObject({ calledBy: 'ilead', teams: ['rust', 'ios', 'web'] });
    // Its own task went on: nothing of it waits for the meeting.
    expect(store.runsOf(setup.w.db, own.id).map((run) => [run.mode, run.outcome])).toEqual([['brief', 'done']]);
  });

  it('passes over a lead who no longer works here, and is drafted again (never briefed) when it is asked for anew', () => {
    const setup = company(() => {});
    setup.w.sup.callMeeting('neo', call);
    const [held] = store.listTasks(setup.w.db).filter((task) => task.meeting);
    expect(nextReviewer(setup.w.db, held!)?.lead.id).toBe('ilead');
    apply(setup.w.db, (tx) => tx.emit({ kind: 'employee_changed', employee: { ...store.getEmployee(setup.w.db, 'ilead')!, fired: true } }), new Date());
    expect(nextReviewer(setup.w.db, held!)?.lead.id).toBe('wlead');
    expect(nextReviewer(setup.w.db, withApproval(setup.w.db, held!, 'wlead'))).toBeNull();
    expect(requestFor(held!, store.getTeam(setup.w.db, 'rust')!)).toEqual({ mode: 'integrate', employeeId: 'rlead' });
  });

  it('refuses a second meeting on a topic that is still being held, and proposals on work that is not a meeting', () => {
    const setup = company(() => {});
    expect(setup.w.sup.callMeeting('neo', call).ok).toBe(true);
    expect(setup.w.sup.callMeeting('wlead', { ...call, topic: 'stages on cards ' })).toMatchObject({ ok: false, text: expect.stringMatching(/already being held/) });
    const plain = store.newTask({ teamId: 'rust', title: 'Plain', brief: 'x', createdBy: 'user' }, new Date());
    expect(proposalsOf(setup.w.db, plain, { summary: 'x', decisions: [{ statement: 'A.', why: 'B.' }] })).toMatchObject({ refused: expect.stringMatching(/not one/) });
    const [held] = store.listTasks(setup.w.db).filter((task) => task.meeting);
    expect(proposalsOf(setup.w.db, held, { summary: 'x', followUps: [{ team: 'Marketing', title: 'T', brief: 'B', doneCondition: 'D' }] })).toMatchObject({ refused: expect.stringMatching(/Rust, iOS, Web/) });
    expect(proposalsOf(setup.w.db, held, { summary: 'x', followUps: [{ team: 'ios', title: 'T', brief: 'B', doneCondition: 'D' }] })).toEqual({ proposals: { decisions: [], followUps: [{ teamId: 'ios', title: 'T', brief: 'B', doneCondition: 'D' }] } });
  });
});
