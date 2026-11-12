import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../src/db/store.ts';
import type { Gate } from '../../src/shared/types.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitRepo, repo, team, world, type World } from '../helpers.ts';

// Real git and real gates.
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
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Priya leads Ada and Grace in a repository with two gates; finished work lands on `team` by itself. */
function ledWorld(play: (scene: Scene) => Promise<void> | void): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo();
  const w = (open = world(fixture.spawn, { repos: [repo({ path: repoPath, gates: GATES })], teams: [team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })], employees: people }));
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
const greet = (w: World) => w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Add a greeting', brief: 'One friendly line in GREETING.md.', doneCondition: 'GREETING.md exists.', gates: ['greeting'], capUsd: 2 });
/** A reviewer who looked at the file and approves. */
const approve = (s: Scene) => s.engine('submit_review', { verdict: 'approve', notes: '', findings: [], checks: [{ file: 'GREETING.md' }] });

describe('a done report says what was checked, and only what holds is kept', () => {
  it('refuses a command run before the last change, a gate the repository lacks, and runs a gate claimed in the prose', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const told: string[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        told.push(s.input.prompt);
        if (!s.resumed) {
          await s.tool('Bash', { command: 'cargo test -p jobs' });
          await s.tool('Write', { file_path: path.join(s.cwd, 'GREETING.md'), content: 'Hello.\n' });
          s.write('GREETING.md', 'Hello.\n');
          replies.push(await s.engine('report_done', { summary: 'Added.', checks: [{ command: 'cargo test -p jobs' }] }));
          await s.tool('Bash', { command: 'cd sub &&  cargo test  -p jobs' });
          replies.push(await s.engine('report_done', { summary: 'Added.', checks: [{ command: 'cargo test -p jobs' }, { gate: 'lint' }] }));
          replies.push(await s.engine('report_done', { summary: 'Added. The farewell gate passes too.', checks: [{ command: 'cargo test -p jobs' }, { file: 'GREETING.md', line: 1 }] }));
        } else {
          s.write('FAREWELL.md', 'Goodbye.\n');
          await s.engine('report_done', { summary: 'Added the farewell as well.' });
        }
      }
      if (s.mode === 'review') await approve(s);
    });
    const task = greet(setup.w);
    await drain(setup);
    expect(replies.map((reply) => reply.ok), JSON.stringify(replies)).toEqual([false, false, true]);
    expect(replies[0]!.text).toContain('this run did not run `cargo test -p jobs` after its last change');
    expect(replies[1]!.text).toMatch(/There is no gate "lint" here \(the gates are: greeting, farewell\)/);
    // The prose said the farewell gate passes. The engine ran it: it failed, and the work went back with its output.
    expect(told[1]).toMatch(/"farewell" failed/);
    const [first] = store.runsOf(setup.w.db, task.id).filter((run) => run.mode === 'work');
    expect(first!.checks).toEqual([
      { kind: 'command', what: 'cargo test -p jobs', shown: 'ran cargo test -p jobs' },
      { kind: 'file', what: 'GREETING.md', line: 1, shown: 'cites GREETING.md:1' },
    ]);
    expect(first!.claimedGates).toEqual(['farewell']);
    expect(first!.gateResults.map((result) => [result.name, result.exitCode === 0])).toEqual([['greeting', true], ['farewell', false]]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath, 'team', 'FAREWELL.md')).toBe('Goodbye.');
  });

  it('keeps a gate an author ran with run_gate apart from the engine\'s own, with when it finished', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', 'Hello.\n');
        await s.engine('run_gate', { name: 'greeting' });
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') await approve(s);
    });
    const task = greet(setup.w);
    await drain(setup);
    const [work] = store.runsOf(setup.w.db, task.id).filter((run) => run.mode === 'work');
    expect(work!.askedGates?.map((result) => [result.name, result.exitCode, typeof result.at])).toEqual([['greeting', 0, 'string']]);
    expect(work!.gateResults.map((result) => result.name)).toEqual(['greeting']);
    expect(work!.gateResults[0]!.at).toMatch(/^\d{4}-/);
  });
});

describe('a review says what it checked, and an approval waits for the gates it claims', () => {
  it('refuses an approval that lists nothing, and lands one that cites a file of the work', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', 'Hello.\n');
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') {
        replies.push(await s.engine('submit_review', { verdict: 'approve', notes: 'Looks fine.', findings: [] }));
        replies.push(await s.engine('submit_review', { verdict: 'approve', notes: 'Looks fine.', findings: [], checks: [{ file: 'GREETING.md', line: 1 }] }));
      }
    });
    const task = greet(setup.w);
    await drain(setup);
    expect(replies.map((reply) => reply.ok)).toEqual([false, true]);
    expect(replies[0]!.text).toBe('An approval says what you checked: list at least one gate, command or file.');
    const review = store.runsOf(setup.w.db, task.id).find((run) => run.mode === 'review')!;
    expect(review.checks).toEqual([{ kind: 'file', what: 'GREETING.md', line: 1, shown: 'cites GREETING.md:1' }]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('runs a gate the approval claims and nobody ran: a failure sends the work back, a pass lands it', async () => {
    const told: string[] = [];
    let reviews = 0;
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        told.push(s.input.prompt);
        s.write('GREETING.md', 'Hello.\n');
        if (s.resumed) s.write('FAREWELL.md', 'Goodbye.\n');
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') {
        reviews++;
        await s.engine('submit_review', { verdict: 'approve', notes: 'The farewell gate is green.', findings: [] });
      }
    });
    const task = greet(setup.w);
    await drain(setup);
    expect(reviews).toBe(2);
    expect(told[1]).toMatch(/"farewell" failed/);
    const [first, second] = store.runsOf(setup.w.db, task.id).filter((run) => run.mode === 'review');
    expect(first!.claimedGates).toEqual(['farewell']);
    expect(first!.gateResults.map((result) => [result.name, result.exitCode === 0])).toEqual([['farewell', false]]);
    expect(second!.gateResults.map((result) => [result.name, result.exitCode === 0])).toEqual([['farewell', true]]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('takes a gate the reviewer ran itself as proof, and the commit step\'s, without running it again', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', 'Hello.\n');
        s.write('FAREWELL.md', 'Goodbye.\n');
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') {
        await s.engine('run_gate', { name: 'farewell' });
        await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [], checks: [{ gate: 'farewell' }, { gate: 'greeting' }] });
      }
    });
    const task = greet(setup.w);
    await drain(setup);
    const review = store.runsOf(setup.w.db, task.id).find((run) => run.mode === 'review')!;
    expect(review.claimedGates).toEqual(['farewell', 'greeting']);
    expect(review.gateResults).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('lands nothing when the task is stopped while the gate an approval claims is running', async () => {
    const slow: Gate = { name: 'slow', command: 'sleep 1', timeoutMinutes: 1, lock: null };
    const fixture = inProcess(
      staged(async (s) => {
        if (s.mode === 'work') {
          s.write('GREETING.md', 'Hello.\n');
          await s.engine('report_done', { summary: 'Added.' });
        }
        if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [], checks: [{ gate: 'slow' }] });
      }),
    );
    const repoPath = gitRepo();
    const w = (open = world(fixture.spawn, { repos: [repo({ path: repoPath, gates: [...GATES, slow] })], teams: [team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })], employees: people }));
    const setup = { w, fixture, repoPath };
    const task = greet(w);
    for (let i = 0; i < 40 && !store.runsOf(w.db, task.id).some((run) => run.mode === 'review' && run.endedAt); i++) {
      await w.sup.tick();
      await fixture.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    w.sup.cancelTask(task.id);
    await drain(setup);
    expect(store.getTask(w.db, task.id)).toMatchObject({ state: 'failed', mergedInto: null });
    expect(fileAt(repoPath, 'team', 'GREETING.md')).toBeNull();
  });
});
