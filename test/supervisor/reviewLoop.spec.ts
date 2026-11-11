import { afterEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../src/db/store.ts';
import type { Gate } from '../../src/shared/types.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, gitRepo, repo, team, world, type World } from '../helpers.ts';

// Real git and real gates, several times over.
vi.setConfig({ testTimeout: 20_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const everything = ['read_files', 'run_commands', 'write_code'] as const;
const people = [employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...everything] }), employee({ capabilities: [...everything] }), employee({ id: 'emp2', name: 'Grace', capabilities: [...everything] })];
const GATES: Gate[] = [
  { name: 'greeting', command: 'test -f GREETING.md', timeoutMinutes: 1, lock: null },
  { name: 'farewell', command: 'test -f FAREWELL.md', timeoutMinutes: 1, lock: null },
];

type Setup = { w: World; fixture: InProcess };

/** Priya leads Ada and Grace, in a repository. Finished work lands on `team` by itself unless told otherwise. */
function ledWorld(play: (scene: Scene) => Promise<void> | void, over: { mergeTarget?: string | null } = {}): Setup {
  const fixture = inProcess(staged(play));
  const w = (open = world(fixture.spawn, {
    repos: [repo({ path: gitRepo(), gates: GATES })],
    teams: [team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: over.mergeTarget === undefined ? 'team' : over.mergeTarget }] })],
    employees: people,
  }));
  return { w, fixture };
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

const tooCurt = { severity: 'blocking', file: 'GREETING.md', line: 1, title: 'The greeting is one curt word', why: 'It is the first thing a reader sees.', fix: 'Write one friendly sentence.' } as const;
const noNewline = { severity: 'minor', file: 'GREETING.md', title: 'No newline at the end', why: 'Some tools complain.', fix: 'End the file with a newline.' } as const;
const greet = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Add a greeting', brief: 'One friendly line in GREETING.md.', doneCondition: 'GREETING.md exists.', gates: ['greeting'], capUsd: 2, ...over });

describe('a review gives findings, and each is checked again', () => {
  it('sends the findings to the author one by one, and tells the next review to check each', async () => {
    const seen = { author: [] as string[], reviewer: [] as string[] };
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        seen.author.push(s.input.prompt);
        s.write('GREETING.md', s.resumed ? 'Hello, and welcome.\n' : 'yo');
        await s.engine('report_done', { summary: s.resumed ? '1: rewritten as one friendly sentence. 2: the file ends with a newline now.' : 'Added.' });
      }
      if (s.mode === 'review') {
        seen.reviewer.push(s.input.prompt);
        if (seen.reviewer.length === 1) await s.engine('submit_review', { verdict: 'send_back', notes: 'Close, but not yet.', findings: [tooCurt, noNewline] });
        else await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
      }
    });
    const task = greet(setup.w);
    await drain(setup);

    // The reviewer is asked for findings it can be held to.
    for (const part of ['findings', 'blocking', 'minor']) expect(seen.reviewer[0], part).toContain(part);
    // The author gets them numbered, with where, why and what would fix each, and is told to answer each.
    for (const part of [
      'Your work was reviewed by Priya and sent back:\n\nClose, but not yet.',
      '1. [blocking] GREETING.md:1: The greeting is one curt word. It is the first thing a reader sees. Fix: Write one friendly sentence.',
      '2. [minor] GREETING.md: No newline at the end. Some tools complain. Fix: End the file with a newline.',
      'by its number',
      'mcp__engine__report_done',
    ])
      expect(seen.author[1], part).toContain(part);
    // The second review has the first one's findings in front of it and must settle each.
    for (const part of ['1. [blocking] GREETING.md:1: The greeting is one curt word.', '2. [minor] GREETING.md: No newline at the end.', 'still open and still right is blocking', '1: rewritten as one friendly sentence.']) expect(seen.reviewer[1], part).toContain(part);
    expect(seen.reviewer[0]).not.toContain('still open and still right');
    // The findings stay with the review that made them.
    const reviews = store.runsOf(setup.w.db, task.id).filter((run) => run.mode === 'review');
    expect(reviews.map((run) => [run.reason, run.findings?.map((finding) => finding.severity)])).toEqual([['sent_back', ['blocking', 'minor']], ['approved', []]]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team', reviewRounds: 1 });
  });

  it('does not take an approval that lists something blocking, nor a send-back that names nothing to fix', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', 'Hello.\n');
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') {
        replies.push(await s.engine('submit_review', { verdict: 'approve', notes: 'Fine.', findings: [tooCurt] }));
        replies.push(await s.engine('submit_review', { verdict: 'send_back', notes: '', findings: [noNewline] }));
        replies.push(await s.engine('submit_review', { verdict: 'send_back', notes: ' ', findings: [] }));
        replies.push(await s.engine('submit_review', { verdict: 'approve', notes: 'Fine.', findings: [noNewline] }));
      }
    });
    const task = greet(setup.w);
    await drain(setup);
    expect(replies.map((reply) => reply.ok)).toEqual([false, false, false, true]);
    expect(replies[0]!.text).toMatch(/blocking/);
    expect(replies[1]!.text).toMatch(/nothing blocking/i);
    expect(replies[2]!.text).toMatch(/what to fix/);
    // Approved with something minor: it lands, and what was noticed is kept.
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(store.runsOf(setup.w.db, task.id).at(-1)!.findings).toMatchObject([{ severity: 'minor', title: 'No newline at the end' }]);
  });
});

const twoFiles = {
  subtasks: [
    { title: 'Greeting', assigneeId: 'emp1', ownership: ['GREETING.md'], gates: ['greeting'] },
    { title: 'Farewell', assigneeId: 'emp2', ownership: ['FAREWELL.md'], gates: ['farewell'] },
  ].map((part) => ({ brief: 'Do it.', doneCondition: 'Done.', priority: 2, capUsd: 0.5, retryAllowed: true, ...part })),
};
const whole = (w: World) => w.sup.createTask({ teamId: 'team1', title: 'Add a greeting and a farewell', brief: 'Two files, one each.', doneCondition: 'Both files exist and read as one voice.', gates: ['greeting', 'farewell'], capUsd: 3 });

describe('what a lead puts together is reviewed before it lands', () => {
  /** The led flow; `onWhole` plays the review of the put-together task, every other review approves. */
  const split = (onWhole: (s: Scene, round: number) => Promise<unknown>, seen: { whole: string[]; integrate: string[] }) => {
    let rounds = 0;
    return async (s: Scene) => {
      // A lead sent back with findings resumes its integration; the fixture knows an integration only by its first words.
      const integrating = s.mode === 'integrate' || (s.mode === 'work' && s.who === 'Priya');
      if (s.mode === 'brief') await s.engine('propose_subtasks', twoFiles);
      if (s.mode === 'work' && !integrating) {
        s.write(s.who === 'Ada' ? 'GREETING.md' : 'FAREWELL.md', `from ${s.who}\n`);
        await s.engine('report_done', { summary: `${s.who} wrote the file.` });
      }
      if (integrating) {
        seen.integrate.push(s.input.prompt);
        if (s.resumed) s.write('FAREWELL.md', 'Goodbye, and thank you.\n');
        await s.engine('report_done', { summary: s.resumed ? '1: the farewell now speaks in the same voice.' : 'Both files are in.' });
      }
      if (s.mode === 'review') {
        if (!s.input.prompt.includes('This is the whole task')) return void (await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] }));
        seen.whole.push(s.input.prompt);
        await onWhole(s, ++rounds);
      }
    };
  };

  it('gives the whole to a teammate who did not put it together, and lands it only once that review approves', async () => {
    const seen = { whole: [] as string[], integrate: [] as string[] };
    const setup = ledWorld(split((s) => s.engine('submit_review', { verdict: 'approve', notes: 'Fits.', findings: [] }), seen));
    const task = whole(setup.w);
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).map((run) => [run.mode, run.employeeId, run.reason])).toEqual([['brief', 'lead', null], ['integrate', 'lead', null], ['review', 'emp1', 'approved']]);
    for (const part of ['put together by Priya', '- "Greeting", by Ada', '- "Farewell", by Grace', 'how they fit', 'Both files exist and read as one voice.', 'GREETING.md', 'FAREWELL.md']) expect(seen.whole[0], part).toContain(part);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('sends the whole back to the lead with findings, and reviews it again', async () => {
    const seen = { whole: [] as string[], integrate: [] as string[] };
    const twoVoices = { severity: 'blocking', file: 'FAREWELL.md', line: 1, title: 'The two files do not read as one voice', why: 'The done-condition asks for it.', fix: 'Rewrite the farewell to match the greeting.' } as const;
    const setup = ledWorld(split((s, round) => (round === 1 ? s.engine('submit_review', { verdict: 'send_back', notes: 'The parts are fine; the whole is not.', findings: [twoVoices] }) : s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] })), seen));
    const task = whole(setup.w);
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).map((run) => [run.mode, run.employeeId, run.reason])).toEqual([
      ['brief', 'lead', null],
      ['integrate', 'lead', null],
      ['review', 'emp1', 'sent_back'],
      ['integrate', 'lead', null],
      ['review', 'emp1', 'approved'],
    ]);
    expect(seen.integrate[1]).toContain('1. [blocking] FAREWELL.md:1: The two files do not read as one voice.');
    expect(seen.whole[1]).toContain('still open and still right is blocking');
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team', reviewRounds: 1 });
  });

  it('says on the merge card that the whole was reviewed, and by whom', async () => {
    const seen = { whole: [] as string[], integrate: [] as string[] };
    const setup = ledWorld(split((s) => s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] }), seen), { mergeTarget: null });
    whole(setup.w);
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'merge' });
    expect(card!.text).toMatch(/Its 2 sub-tasks were each approved by a reviewer and the whole by Ada, gates green \(greeting, farewell\);/);
  });
});
