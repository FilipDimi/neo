import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEvents } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { Gate } from '../../src/shared/types.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitIn, gitRepo, refOf, repo, team, world, type World } from '../helpers.ts';

// Every test here runs real git and real gates, several times over. On a busy machine five seconds is not always enough.
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
  { name: 'no-todo', command: '! grep -rn TODO --include=*.md .', timeoutMinutes: 1, lock: null },
  { name: 'script', command: 'bash check.sh', timeoutMinutes: 1, lock: null },
  { name: 'both', command: 'test -f GREETING.md && test -f FAREWELL.md', timeoutMinutes: 1, lock: null },
];

type Setup = { w: World; fixture: InProcess; repoPath: string | null };

/** A led team (Priya leads Ada and Grace), with a repository unless told otherwise. */
function ledWorld(play: (scene: Scene) => Promise<void> | void, over: { repo?: boolean; repoPath?: string; baseBranch?: string; mergeTarget?: string | null; maxReviewRounds?: number; selfManaged?: boolean } = {}): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = over.repo === false ? null : (over.repoPath ?? gitRepo());
  const w = (open = world(fixture.spawn, {
    repos: repoPath ? [repo({ path: repoPath, gates: GATES })] : [],
    teams: [team({ leadId: over.selfManaged ? null : 'lead', selfManaged: over.selfManaged ?? false, maxReviewRounds: over.maxReviewRounds ?? 3, repos: repoPath ? [{ repoId: 'repo1', baseBranch: over.baseBranch ?? 'team', mergeTarget: over.mergeTarget === undefined ? 'team' : over.mergeTarget }] : [] })],
    employees: people,
  }));
  return { w, fixture, repoPath };
}

/** Ticks until nothing is running, queued or in flight. */
async function drain({ w, fixture }: Setup, max = 40): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < max && quiet < 2; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    quiet = store.liveRuns(w.db).length === 0 && store.openRequests(w.db).length === 0 ? quiet + 1 : 0;
  }
}

const proposal = (subtasks: object[]) => ({ subtasks: subtasks.map((s) => ({ brief: 'Do it.', doneCondition: 'Done.', gates: [], priority: 2, capUsd: 0.5, retryAllowed: true, ...s })) });
const twoFiles = proposal([
  { title: 'Greeting', assigneeId: 'emp1', ownership: ['GREETING.md'], gates: ['greeting'] },
  { title: 'Farewell', assigneeId: 'emp2', ownership: ['FAREWELL.md'], gates: ['farewell'] },
]);

/** The whole led flow, played straight: brief into two, each writes its file, the lead approves and integrates. */
const straight = async (s: Scene) => {
  if (s.mode === 'brief') await s.engine('propose_subtasks', twoFiles);
  if (s.mode === 'work') {
    s.write(s.who === 'Ada' ? 'GREETING.md' : 'FAREWELL.md', `from ${s.who}\n`);
    await s.engine('report_done', { summary: `${s.who} wrote the file.` });
  }
  if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '' });
  if (s.mode === 'integrate') await s.engine('report_done', { summary: 'Both files are in.' });
};
const parentTask = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', title: 'Add a greeting and a farewell', brief: 'Two files, one each.', doneCondition: 'Both files exist.', gates: ['greeting', 'farewell'], capUsd: 2, ...over });

describe('a team with no repository', () => {
  it('finishes a task its lead split: there is nothing to merge, so integrating is only the lead putting it together', async () => {
    let integrateTurn = '';
    const halves = proposal([
      { title: 'Half one', assigneeId: 'emp1', ownership: [] },
      { title: 'Half two', assigneeId: 'emp2', ownership: [] },
    ]);
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'brief') await s.engine('propose_subtasks', halves);
        if (s.mode === 'work') {
          s.write(`half-${s.who}.md`, `from ${s.who}\n`);
          await s.engine('report_done', { summary: `${s.who} did a half.` });
        }
        if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '' });
        if (s.mode === 'integrate') {
          integrateTurn = s.input.prompt;
          await s.engine('report_done', { summary: 'Put together.' });
        }
      },
      { repo: false },
    );
    const parent = setup.w.sup.createTask({ teamId: 'team1', title: 'Plan the launch', brief: 'Two halves.', capUsd: 2 });
    await drain(setup);
    expect(store.openDecisions(setup.w.db).map((d) => [d.kind, d.text])).toEqual([]);
    expect(store.listTasks(setup.w.db, { parentId: parent.id }).map((c) => c.state)).toEqual(['done', 'done']);
    expect(store.runsOf(setup.w.db, parent.id).filter((run) => run.mode === 'integrate')).toHaveLength(1);
    // Nothing was merged anywhere, so the lead is told where each half is and what is in it.
    for (const child of store.listTasks(setup.w.db, { parentId: parent.id })) {
      const who = child.assigneeId === 'emp1' ? 'Ada' : 'Grace';
      expect(integrateTurn).toContain(`"${child.title}", by ${who}, in ${path.join(setup.w.dir, 'folders', child.id)}`);
      expect(integrateTurn).toContain(`half-${who}.md`);
      expect(integrateTurn).toContain(`${who} did a half.`);
    }
    expect(store.getTask(setup.w.db, parent.id)!.state).toBe('done');
  });
});

describe('briefing', () => {
  it('creates children from a valid proposal, moves the parent to running and queues each child', async () => {
    const setup = ledWorld(async (s) => void (s.mode === 'brief' && (await s.engine('propose_subtasks', twoFiles))));
    const parent = parentTask(setup.w);
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    const children = store.listTasks(setup.w.db, { parentId: parent.id });
    expect(children.map((c) => [c.title, c.assigneeId, c.createdBy, c.repoId, c.gates])).toEqual([
      ['Greeting', 'emp1', 'lead', 'repo1', ['greeting']],
      ['Farewell', 'emp2', 'lead', 'repo1', ['farewell']],
    ]);
    expect(store.getTask(setup.w.db, parent.id)?.state).toBe('running');
    expect(store.openRequests(setup.w.db).map((r) => [r.mode, r.employeeId])).toEqual([['work', 'emp1'], ['work', 'emp2']]);
    expect(store.runsOf(setup.w.db, parent.id)).toMatchObject([{ mode: 'brief', employeeId: 'lead', outcome: 'done' }]);
  });

  it('tells the lead why a proposal is refused, and raises a briefing card after two refusals in one run', async () => {
    const replies: string[] = [];
    const overlapping = proposal([{ title: 'A', assigneeId: 'emp1', ownership: ['src'] }, { title: 'B', assigneeId: 'emp2', ownership: ['src/x.ts'] }]);
    const setup = ledWorld(async (s) => {
      if (s.mode !== 'brief') return;
      replies.push((await s.engine('propose_subtasks', overlapping)).text);
      replies.push((await s.engine('propose_subtasks', overlapping)).text);
    });
    const parent = parentTask(setup.w);
    await drain(setup);
    expect(replies[0]).toMatch(/A.*B/);
    expect(store.listTasks(setup.w.db, { parentId: parent.id })).toHaveLength(0);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'briefing', taskId: parent.id }]);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'blocked', blockedFrom: 'briefing' });
    expect(store.runsOf(setup.w.db, parent.id)).toMatchObject([{ outcome: 'stopped', reason: 'briefing' }]);
  });

  it('a lead that does a task itself from a brief run has it reviewed by a teammate, like any other work', async () => {
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
        s.write('NOTE.md', 'small enough to do myself\n');
        await s.engine('report_done', { summary: 'Did it myself.' });
      },
      { repo: false },
    );
    const task = parentTask(setup.w, { gates: [] });
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)?.state).toBe('done');
    expect(store.runsOf(setup.w.db, task.id).map((r) => [r.mode, r.employeeId])).toEqual([['brief', 'lead'], ['review', 'emp1']]);
  });
});

describe('work and review', () => {
  it('sends finished work to the lead for review, with the summary, the diff and the gate results', async () => {
    let reviewTurn = '';
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Added the greeting.' });
      }
      if (s.mode === 'review') reviewTurn = s.input.prompt;
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    expect(store.getTask(setup.w.db, task.id)?.state).toBe('review');
    expect(store.openRequests(setup.w.db)).toMatchObject([{ mode: 'review', employeeId: 'lead' }]);
    const [run] = store.runsOf(setup.w.db, task.id);
    expect(run).toMatchObject({ outcome: 'done', diffLines: 1, gateResults: [{ name: 'greeting', exitCode: 0 }] });
    expect(run!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(setup.repoPath!, 'log', '-1', '--format=%an|%s', store.getTask(setup.w.db, task.id)!.branch!)).toBe('Ada|Add a greeting and a farewell');
    await setup.w.sup.tick();
    await setup.fixture.idle();
    for (const part of ['Added the greeting.', 'GREETING.md', 'greeting: passed (exit 0)', '+hello']) expect(reviewTurn, part).toContain(part);
    expect(setup.fixture.jobs[1]).toMatchObject({ mode: 'review', cwd: setup.fixture.jobs[0]!.cwd, tools: ['Read', 'Glob', 'Grep'] });
  });

  it('goes straight to done on a self-managed team', async () => {
    const setup = ledWorld(
      async (s) => {
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Added the greeting.' });
      },
      { selfManaged: true },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(store.runsOf(setup.w.db, task.id).map((r) => r.mode)).toEqual(['work']);
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBe('hello');
  });

  it("send_back resumes the author's session with the notes and counts a round", async () => {
    const prompts: string[] = [];
    let reviews = 0;
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        prompts.push(s.input.prompt);
        s.write('GREETING.md', s.resumed ? 'Hello, properly.\n' : 'hi\n');
        await s.engine('report_done', { summary: s.resumed ? 'Fixed the greeting.' : 'Added the greeting.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', ++reviews === 1 ? { verdict: 'send_back', notes: 'Write a full sentence.' } : { verdict: 'approve', notes: '' });
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    const runs = store.runsOf(setup.w.db, task.id);
    expect(runs.map((r) => [r.mode, r.employeeId])).toEqual([['work', 'emp1'], ['review', 'lead'], ['work', 'emp1'], ['review', 'lead']]);
    expect(runs[2]!.sessionId).toBe(runs[0]!.sessionId);
    expect(prompts[1]).toContain('Write a full sentence.');
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', reviewRounds: 1 });
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBe('Hello, properly.');
  });

  it('raises a review card when work is sent back more often than the team allows', async () => {
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'work') {
          s.write('GREETING.md', `try ${Date.now()}\n`);
          await s.engine('report_done', { summary: 'Another try.' });
        }
        if (s.mode === 'review') await s.engine('submit_review', { verdict: 'send_back', notes: 'Still not right.' });
      },
      { maxReviewRounds: 2 },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).filter((r) => r.mode === 'review')).toHaveLength(3);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'review', taskId: task.id }]);
    expect(store.openDecisions(setup.w.db)[0]!.options.map((o) => o.label)).toEqual(['Send back', 'Accept as it is', 'Stop it']);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'blocked', reviewRounds: 2 });
    // The user accepts it as it is: the work lands and the task is done.
    setup.w.sup.answer(store.openDecisions(setup.w.db)[0]!.id, { optionId: 'accept' });
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('an escalated review becomes a card', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'escalate', notes: 'This changes the public tone; a person should decide.' });
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'review', taskId: task.id, text: expect.stringContaining('public tone') }]);
  });

  it('a failed gate sends the work back with the real output and counts a review round', async () => {
    const prompts: string[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        prompts.push(s.input.prompt);
        if (s.resumed) s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: s.resumed ? 'Now it exists.' : 'All done, I promise.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '' });
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    const runs = store.runsOf(setup.w.db, task.id);
    expect(runs.map((r) => r.mode)).toEqual(['work', 'work', 'review']);
    expect(runs[0]!.gateResults).toMatchObject([{ name: 'greeting', exitCode: 1 }]);
    expect(prompts[1]).toContain('greeting');
    expect(prompts[1]).toContain('exit 1');
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', reviewRounds: 1 });
  });

  it('gives a sub-task whose gate still fails after one send-back to its lead to judge, not back to its author for ever', async () => {
    // The lead gives each half the gate of the whole. Neither half can make it pass alone: it needs the other.
    const halves = proposal([
      { title: 'Greeting', assigneeId: 'emp1', ownership: ['GREETING.md'], gates: ['both'] },
      { title: 'Farewell', assigneeId: 'emp2', ownership: ['FAREWELL.md'], gates: ['both'] },
    ]);
    const sentBack: string[] = [];
    const reviews: string[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'brief') return void (await s.engine('propose_subtasks', halves));
      // The reviews of the two halves. The whole, put together, is reviewed too: that one is not about a failing gate.
      if (s.mode === 'review' && !s.input.prompt.includes('This is the whole task')) reviews.push(s.input.prompt);
      if (s.mode === 'work' && s.resumed) {
        sentBack.push(s.input.prompt);
        return void (await s.engine('report_done', { summary: 'My file is there. The gate also needs the other half, which is not mine.' }));
      }
      return straight(s);
    });
    const parent = parentTask(setup.w, { gates: ['both'] });
    await drain(setup);
    // Each author is sent back once, told what to do if the failure is not its own, and then the lead decides.
    for (const child of store.listTasks(setup.w.db, { parentId: parent.id })) {
      const runs = store.runsOf(setup.w.db, child.id);
      expect(runs.map((run) => run.mode), child.title).toEqual(['work', 'work', 'review']);
      expect(runs.slice(0, 2).map((run) => run.gateResults.map((gate) => [gate.name, gate.exitCode]))).toEqual([[['both', 1]], [['both', 1]]]);
      expect(child).toMatchObject({ state: 'done', reviewRounds: 1 });
    }
    expect(sentBack).toHaveLength(2);
    for (const turn of sentBack) expect(turn).toMatch(/files this sub-task does not own.*do not ask about it.*report_done again/s);
    expect(reviews).toHaveLength(2);
    for (const turn of reviews) {
      expect(turn).toContain('both: FAILED (exit 1)');
      expect(turn).toMatch(/The gate both still fails after the author was sent back for it/);
      expect(turn).toContain('The gate also needs the other half');
    }
    // Nobody had to be asked, and on the whole the gate is held as ever: here it passes.
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    expect(store.runsOf(setup.w.db, parent.id).findLast((run) => run.mode === 'integrate')).toMatchObject({ gateResults: [{ name: 'both', exitCode: 0 }] });
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('counts the send-back for a gate even when the author did something else in between', async () => {
    const halves = proposal([
      { title: 'Greeting', assigneeId: 'emp1', ownership: ['GREETING.md'], gates: ['both'] },
      { title: 'Farewell', assigneeId: 'emp2', ownership: ['FAREWELL.md'], gates: ['both'] },
    ]);
    const resumes = new Map<string, number>();
    const setup = ledWorld(async (s) => {
      if (s.mode === 'brief') return void (await s.engine('propose_subtasks', halves));
      // Asked by Ada, the lead answers; everything else it reviews, it approves.
      if (s.mode === 'review') return void (await s.engine('submit_review', s.input.prompt.includes('has stopped with a question') ? { verdict: 'send_back', notes: 'Report it done and say so.' } : { verdict: 'approve', notes: '' }));
      if (s.mode === 'work' && s.resumed) {
        const turn = (resumes.get(s.who) ?? 0) + 1;
        resumes.set(s.who, turn);
        // Sent back for the gate, Ada asks instead of reporting. Only then does she report again.
        if (s.who === 'Ada' && turn === 1) return void (await s.engine('request_decision', { question: 'The gate needs the other half. What now?', options: [] }));
        return void (await s.engine('report_done', { summary: 'Mine is there; the gate needs the other half.' }));
      }
      return straight(s);
    });
    const parent = parentTask(setup.w, { gates: ['both'] });
    await drain(setup);
    const ada = store.listTasks(setup.w.db, { parentId: parent.id }).find((child) => child.title === 'Greeting')!;
    // One send-back for the gate, a question in between, and at the second failure it is the lead's to judge.
    expect(store.runsOf(setup.w.db, ada.id).map((run) => `${run.mode}${run.reason ? ` (${run.reason})` : ''}`)).toEqual(['work', 'work (question)', 'review (answered)', 'work', 'review (approved)']);
    expect(store.getTask(setup.w.db, ada.id)).toMatchObject({ state: 'done', reviewRounds: 1 });
    expect(store.openDecisions(setup.w.db)).toEqual([]);
  });

  it('keeps sending a task that is not a sub-task back for a failing gate: there the gate is the user\'s, and it holds', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') await s.engine('report_done', { summary: 'It is fine, really.' });
      if (s.mode === 'review') throw new Error('work with a failing gate must not reach review');
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).map((run) => run.mode)).toEqual(['work', 'work', 'work', 'work']);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'review', taskId: task.id }]);
  });

  it('a file changed outside the ownership raises an ownership card naming it', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode !== 'work') return;
      s.write('GREETING.md', 'hello\n');
      s.write('src/elsewhere.ts', 'export {};\n'); // as a command would: no Write call for the engine to refuse
      await s.engine('report_done', { summary: 'Added the greeting, and tidied something else.' });
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [], ownership: ['GREETING.md'] });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'ownership', taskId: task.id });
    expect(card!.text).toContain('src/elsewhere.ts');
    expect(store.openRequests(setup.w.db)).toHaveLength(0);
  });

  it("runs a gate confined: what an employee wrote cannot reach outside the folder through the engine's own check", async () => {
    const outside = path.join(os.homedir(), `vs-flow-gate-probe-${process.pid}`);
    const seen: string[] = [];
    const setup = ledWorld(
      async (s) => {
        // The gate runs the repository's own script, and the employee has just rewritten it.
        s.write('check.sh', `echo escaped > "${outside}" && echo WROTE-OUTSIDE\n`);
        seen.push((await s.engine('run_gate', { name: 'script' })).text);
        await s.engine('request_decision', { question: 'Stop here?', options: ['Yes'] });
      },
      { selfManaged: true },
    );
    parentTask(setup.w, { assigneeId: 'emp1' });
    await drain(setup);
    expect(seen[0]).toContain('FAILED');
    expect(seen[0]).not.toContain('WROTE-OUTSIDE');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("has a teammate review a lead's own work before it can reach a merge card", async () => {
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Wrote it myself.' });
      },
      { mergeTarget: null },
    );
    const task = parentTask(setup.w, { assigneeId: 'lead', gates: [] });
    await drain(setup);
    // Given straight to the lead, the task is briefed: the lead judged it one small change and did it itself.
    expect(store.runsOf(setup.w.db, task.id).map((run) => [run.mode, run.employeeId, run.outcome])).toEqual([['brief', 'lead', 'done'], ['review', 'emp1', 'done']]);
    // The verdict stays with the review run, where the task's history shows it.
    expect(store.runsOf(setup.w.db, task.id)[1]).toMatchObject({ reason: 'approved' });
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'merge' });
    expect(card!.text).toMatch(/\? Approved by Ada, no gates;/);
  });

  it('does not call work reviewed on the merge card when the reviewer did not approve it and it was accepted as it is', async () => {
    for (const [verdict, said] of [['escalate', /\? Ada could not decide and it was accepted as it is, no gates;/], ['send_back', /\? Ada sent it back and it was accepted as it is, no gates;/]] as const) {
      const setup = ledWorld(
        async (s) => {
          if (s.mode === 'review') return void (await s.engine('submit_review', { verdict, notes: 'Not sure about the wording.' }));
          s.write('GREETING.md', 'hello\n');
          await s.engine('report_done', { summary: 'Wrote it myself.' });
        },
        { mergeTarget: null, maxReviewRounds: 1 },
      );
      parentTask(setup.w, { assigneeId: 'lead', gates: [] });
      await drain(setup);
      const [asked] = store.openDecisions(setup.w.db);
      expect(asked, verdict).toMatchObject({ kind: 'review' });
      setup.w.sup.answer(asked!.id, { optionId: 'accept' });
      await drain(setup);
      const [card] = store.openDecisions(setup.w.db);
      expect(card, verdict).toMatchObject({ kind: 'merge' });
      expect(card!.text, verdict).toMatch(said);
      expect(card!.text).not.toMatch(/approved|reviewed,/i);
      await setup.w.sup.stop();
    }
  });

  it('splits a task given straight to the lead when the lead finds more than one piece in it', async () => {
    const setup = ledWorld(straight);
    const parent = parentTask(setup.w, { assigneeId: 'lead' });
    await drain(setup);
    expect(store.listTasks(setup.w.db, { parentId: parent.id }).map((child) => [child.title, child.assigneeId, child.state])).toEqual([['Greeting', 'emp1', 'done'], ['Farewell', 'emp2', 'done']]);
    // The lead split it and put it together; a teammate reviewed the whole.
    expect(store.runsOf(setup.w.db, parent.id).map((run) => [run.mode, run.employeeId])).toEqual([['brief', 'lead'], ['integrate', 'lead'], ['review', 'emp1']]);
    expect(store.getTask(setup.w.db, parent.id)!.state).toBe('done');
  });

  it('tells a reviewer who asks for commands that a review only reads, and raises no card for it', async () => {
    const seen: string[] = [];
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') {
          seen.push((await s.engine('request_tools', { capabilities: ['run_commands'], reason: 'to run the tests' })).text);
          return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
        }
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Wrote it myself.' });
      },
      { mergeTarget: null },
    );
    parentTask(setup.w, { assigneeId: 'lead', gates: [] });
    await drain(setup);
    expect(seen[0]).toMatch(/a review only reads/);
    expect(seen[0]).toContain('mcp__engine__run_gate');
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'merge' }]);
  });

  it('sends work back, instead of losing it, when the employee left a git repository of its own inside the folder', async () => {
    const turns: string[] = [];
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
        turns.push(s.input.prompt);
        if (!s.resumed) {
          // What `cargo new tool` leaves: a folder with a repository of its own.
          fs.mkdirSync(path.join(s.cwd, 'tool'));
          gitIn(path.join(s.cwd, 'tool'), 'init', '-q');
          s.write('tool/main.rs', 'fn main() {}\n');
        } else fs.rmSync(path.join(s.cwd, 'tool/.git'), { recursive: true, force: true });
        await s.engine('report_done', { summary: 'Made the tool.' });
      },
      { selfManaged: true },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatch(/git repository of its own/);
    expect(turns[1]).toContain('tool/.git');
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath!, 'team', 'tool/main.rs')).toBe('fn main() {}');
  });

  it('never offers to accept work that could not be committed: accepting it would land the branch without it', async () => {
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
        // The repository inside the folder keeps coming back, whatever the employee is told.
        if (!fs.existsSync(path.join(s.cwd, 'tool'))) {
          fs.mkdirSync(path.join(s.cwd, 'tool'));
          gitIn(path.join(s.cwd, 'tool'), 'init', '-q');
        }
        s.write('tool/main.rs', 'fn main() {}\n');
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Made the tool.' });
      },
      { selfManaged: true, maxReviewRounds: 1 },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'review', taskId: task.id });
    expect(card!.options.map((option) => option.label)).toEqual(['Send back', 'Stop it']);
    expect(card!.text).toMatch(/cannot be accepted as it is/);
    expect(() => setup.w.sup.answer(card!.id, { optionId: 'accept' })).toThrow();
    // The work is still where its author left it, and nothing has landed.
    expect(fs.existsSync(path.join(setup.w.dir, 'folders', task.id, 'GREETING.md'))).toBe(true);
    expect(store.getTask(setup.w.db, task.id)!.state).toBe('blocked');
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBeNull();
  });

  it("sends a lead's work back to the lead when the teammate does not pass it", async () => {
    let reviews = 0;
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') return void (await s.engine('submit_review', ++reviews === 1 ? { verdict: 'send_back', notes: 'Say who it is for.' } : { verdict: 'approve', notes: '' }));
        s.write('GREETING.md', s.resumed ? 'hello, reader\n' : 'hello\n');
        await s.engine('report_done', { summary: s.resumed ? 'Fixed.' : 'Wrote it myself.' });
      },
      { mergeTarget: null },
    );
    const task = parentTask(setup.w, { assigneeId: 'lead', gates: [] });
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).map((run) => [run.mode, run.employeeId])).toEqual([['brief', 'lead'], ['review', 'emp1'], ['work', 'lead'], ['review', 'emp1']]);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'merge' }]);
  });

  it('says on the merge card when nobody reviewed the work and no gate checked it', async () => {
    // A self-managed team has no reviewer unless the task names one, and this task has no gates.
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') throw new Error('nobody should be reviewing this');
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Wrote it myself.' });
      },
      { mergeTarget: null, selfManaged: true },
    );
    parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'merge' });
    expect(card!.text).toMatch(/Nobody reviewed it and no gate checked it/);
  });

  it('run_gate lets an employee run a named gate and see the real result', async () => {
    const seen: string[] = [];
    const setup = ledWorld(
      async (s) => {
        seen.push((await s.engine('run_gate', { name: 'greeting' })).text);
        s.write('GREETING.md', 'hello\n');
        seen.push((await s.engine('run_gate', { name: 'greeting' })).text);
        seen.push((await s.engine('run_gate', { name: 'nope' })).text);
        await s.engine('report_done', { summary: 'Checked before reporting.' });
      },
      { selfManaged: true },
    );
    parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    expect(seen[0]).toContain('FAILED (exit 1)');
    expect(seen[1]).toContain('passed (exit 0)');
    expect(seen[2]).toMatch(/no gate named "nope"/);
    // While the engine ran the gate for it, the run was not silent: it said what it was waiting for.
    const waited = readEvents(setup.w.db, 0, 10_000).filter((row) => row.event.kind === 'run_activity' && row.event.text === 'running the gate "greeting"');
    expect(waited.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a question on a led team', () => {
  const QUESTION = { question: 'Who is the greeting for?', options: ['The reader', 'The team'] };
  /** Ada asks before she writes anything; once she has an answer she writes the greeting. The lead does what the test says with the question. */
  function asking(lead: (s: Scene) => Promise<unknown>, seen: { lead: string[]; ada: string[] }) {
    return async (s: Scene) => {
      if (s.mode === 'review' && s.input.prompt.includes('has stopped with a question')) {
        seen.lead.push(s.input.prompt);
        return void (await lead(s));
      }
      if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
      if (s.mode !== 'work') return;
      seen.ada.push(s.input.prompt);
      if (!s.resumed) return void (await s.engine('request_decision', QUESTION));
      s.write('GREETING.md', 'hello, reader\n');
      await s.engine('report_done', { summary: 'Wrote it for the reader.' });
    };
  }

  it('goes to the lead, who answers it: the member carries on with the answer and the user is never asked', async () => {
    const seen = { lead: [] as string[], ada: [] as string[] };
    const setup = ledWorld(asking((s) => s.engine('submit_review', { verdict: 'send_back', notes: 'For the reader. One friendly line.' }), seen));
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    // The question is with the lead: no card, the task is not blocked, and the member is told where it went.
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)!.state).toBe('running');
    expect(store.openRequests(setup.w.db)).toMatchObject([{ mode: 'review', employeeId: 'lead' }]);
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).map((run) => [run.mode, run.employeeId, run.outcome, run.reason])).toEqual([
      ['work', 'emp1', 'stopped', 'question'],
      ['review', 'lead', 'done', 'answered'],
      ['work', 'emp1', 'done', null],
      ['review', 'lead', 'done', 'approved'],
    ]);
    expect(seen.lead[0]).toContain('Ada is working on this task and has stopped with a question');
    expect(seen.lead[0]).toContain('Who is the greeting for?');
    expect(seen.lead[0]).toContain('- The reader\n- The team');
    expect(seen.ada[1]).toContain('Your lead, Priya, answers your question:\n\nFor the reader. One friendly line.');
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    // An answered question is not a round of review.
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team', reviewRounds: 0 });
  });

  it('reaches the user only when the lead says the user must decide, with what both of them said; the answer goes to the one who asked', async () => {
    const seen = { lead: [] as string[], ada: [] as string[] };
    const setup = ledWorld(asking((s) => s.engine('submit_review', { verdict: 'escalate', notes: 'It depends on who the product is sold to, which only you know.' }), seen));
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'question', taskId: task.id, employeeId: 'emp1' });
    expect(card!.text).toContain('Ada asks about "Add a greeting and a farewell": Who is the greeting for?');
    expect(card!.text).toContain('Priya, who leads the team, could not settle it: It depends on who the product is sold to, which only you know.');
    expect(card!.options.map((option) => option.label)).toEqual(['The reader', 'The team', 'Answer', 'Stop it']);
    setup.w.sup.answer(card!.id, { optionId: 'choice1' });
    await drain(setup);
    expect(seen.ada[1]).toContain('The answer to your question: The reader');
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('does not take "approve" or an empty note for an answer', async () => {
    const said: string[] = [];
    const seen = { lead: [] as string[], ada: [] as string[] };
    const setup = ledWorld(
      asking(async (s) => {
        said.push((await s.engine('submit_review', { verdict: 'approve', notes: '' })).text);
        said.push((await s.engine('submit_review', { verdict: 'send_back', notes: '  ' })).text);
        await s.engine('submit_review', { verdict: 'send_back', notes: 'For the reader.' });
      }, seen),
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    expect(said[0]).toMatch(/Nothing is finished yet/);
    expect(said[1]).toMatch(/notes are your answer/);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done' });
    expect(store.getTask(setup.w.db, task.id)!.reviewRounds).toBe(0);
  });

  it('asks the user straight away when it is the lead who asks, or when the team has no lead', async () => {
    const byLead = ledWorld(async (s) => void (await s.engine('request_decision', QUESTION)), { mergeTarget: null });
    const task = parentTask(byLead.w, { assigneeId: 'lead' });
    await drain(byLead);
    expect(store.openDecisions(byLead.w.db)).toMatchObject([{ kind: 'question', taskId: task.id, employeeId: 'lead' }]);
    await byLead.w.sup.stop();

    const alone = ledWorld(async (s) => void (await s.engine('request_decision', QUESTION)), { selfManaged: true });
    const own = parentTask(alone.w, { assigneeId: 'emp1' });
    await drain(alone);
    expect(store.openDecisions(alone.w.db)).toMatchObject([{ kind: 'question', taskId: own.id, employeeId: 'emp1' }]);
    expect(store.runsOf(alone.w.db, own.id).map((run) => run.mode)).toEqual(['work']);
  });

  it('tells the user when a member keeps asking, even though its lead has answered each time', async () => {
    let questions = 0;
    const setup = ledWorld(async (s) => {
      if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'send_back', notes: 'For the reader.' }));
      if (s.mode === 'work') await s.engine('request_decision', { question: `Question ${++questions}?`, options: [] });
    });
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: ['greeting'] });
    await drain(setup);
    expect(store.runsOf(setup.w.db, task.id).map((run) => run.mode)).toEqual(['work', 'review', 'work', 'review', 'work']);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'question', taskId: task.id });
    expect(card!.text).toMatch(/Ada has asked 3 times in a row/);
  });
});

describe('integration and landing', () => {
  it('briefs, works, reviews, integrates and lands on the team branch; main never moves', async () => {
    const setup = ledWorld(straight);
    const mainBefore = refOf(setup.repoPath!, 'main');
    const parent = parentTask(setup.w);
    await drain(setup);
    const children = store.listTasks(setup.w.db, { parentId: parent.id });
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(children.map((c) => c.state)).toEqual(['done', 'done']);
    expect(store.runsOf(setup.w.db, parent.id).map((r) => r.mode)).toEqual(['brief', 'integrate', 'review']);
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBe('from Ada');
    expect(fileAt(setup.repoPath!, 'team', 'FAREWELL.md')).toBe('from Grace');
    expect(refOf(setup.repoPath!, 'main')).toBe(mainBefore);
    expect(store.openDecisions(setup.w.db)).toHaveLength(0);
    // Folders of finished tasks are gone; their branches stay in the user's repository.
    for (const t of [parent, ...children]) expect(fs.existsSync(path.join(setup.w.dir, 'folders', t.id))).toBe(false);
    for (const c of children) expect(refOf(setup.repoPath!, c.branch!)).toMatch(/^[0-9a-f]{40}$/);
    const integrate = store.runsOf(setup.w.db, parent.id)[1]!;
    expect(integrate.gateResults.map((g) => [g.name, g.exitCode])).toEqual([['greeting', 0], ['farewell', 0]]);
  });

  it('holds a split task to what it owns when its parts are put together', async () => {
    // The parts stay inside the task; the lead, putting them together, changes a file the task was never given.
    const setup = ledWorld(async (s) => {
      if (s.mode === 'integrate') {
        s.write('README.md', 'rewritten while integrating\n');
        return void (await s.engine('report_done', { summary: 'Both files are in.' }));
      }
      return straight(s);
    });
    const parent = parentTask(setup.w, { ownership: ['GREETING.md', 'FAREWELL.md'] });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'ownership', taskId: parent.id });
    expect(card!.text).toMatch(/Put together by Priya, "Add a greeting and a farewell" changes files outside what it owns \(GREETING\.md, FAREWELL\.md\): README\.md/);
    expect(fileAt(setup.repoPath!, 'team', 'README.md')).not.toBe('rewritten while integrating');
    expect(store.getTask(setup.w.db, parent.id)!.state).not.toBe('done');
    // Accepting it carries on from there: the gates, then the landing.
    setup.w.sup.answer(card!.id, { optionId: 'accept' });
    await drain(setup);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath!, 'team', 'README.md')).toBe('rewritten while integrating');
  });

  it('does not ask twice about a file outside the ownership that the user has already accepted', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work' && s.who === 'Ada') s.write('README.md', 'Ada also touched this\n');
      return straight(s);
    });
    const parent = parentTask(setup.w, { ownership: ['GREETING.md', 'FAREWELL.md'] });
    await drain(setup);
    const [first] = store.openDecisions(setup.w.db);
    expect(first).toMatchObject({ kind: 'ownership' });
    expect(first!.taskId).not.toBe(parent.id);
    expect(first!.text).toContain('README.md');
    setup.w.sup.answer(first!.id, { optionId: 'accept' });
    await drain(setup);
    // Accepted once, on the sub-task: when the parts are put together it is not asked about again.
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath!, 'team', 'README.md')).toBe('Ada also touched this');
  });

  it('holds a task to its own changes when its team starts from one branch and lands on another', async () => {
    const repoPath = gitRepo(['team']);
    // Other work is already on the landing branch: another file, and a line in the file this task will write.
    gitIn(repoPath, 'checkout', '-q', 'team');
    fs.writeFileSync(path.join(repoPath, 'OTHER.md'), 'other work\n');
    fs.writeFileSync(path.join(repoPath, 'GREETING.md'), 'theirs\n');
    gitIn(repoPath, 'add', '-A');
    gitIn(repoPath, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'other work lands');
    gitIn(repoPath, 'checkout', '-q', 'main');
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'integrate') {
          s.write('GREETING.md', 'theirs and mine\n');
          return void (await s.engine('report_done', { summary: 'Resolved.' }));
        }
        s.write('GREETING.md', 'mine\n');
        await s.engine('report_done', { summary: 'Wrote it.' });
      },
      { selfManaged: true, baseBranch: 'main', mergeTarget: 'team', repoPath },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', ownership: ['GREETING.md'], gates: [] });
    await drain(setup);
    // OTHER.md came in with the landing branch. It is not this task's change, and nobody is asked about it.
    expect(store.openDecisions(setup.w.db).map((card) => [card.kind, card.text])).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(repoPath, 'team', 'GREETING.md')).toBe('theirs and mine');
    expect(fileAt(repoPath, 'team', 'OTHER.md')).toBe('other work');
  });

  it('still catches a file of its own that such a task changed outside what it owns', async () => {
    const repoPath = gitRepo(['team']);
    gitIn(repoPath, 'checkout', '-q', 'team');
    fs.writeFileSync(path.join(repoPath, 'OTHER.md'), 'other work\n');
    gitIn(repoPath, 'add', '-A');
    gitIn(repoPath, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'other work lands');
    gitIn(repoPath, 'checkout', '-q', 'main');
    const setup = ledWorld(
      async (s) => {
        s.write('GREETING.md', 'mine\n');
        s.write('STRAY.md', 'not mine to write\n');
        await s.engine('report_done', { summary: 'Wrote it.' });
      },
      { selfManaged: true, baseBranch: 'main', mergeTarget: 'team', repoPath },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', ownership: ['GREETING.md'], gates: [] });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'ownership', taskId: task.id });
    expect(card!.text).toMatch(/: STRAY\.md\.$/);
  });

  it('never asks to merge a task that changed nothing: it is done, and what was reported is its result', async () => {
    const setup = ledWorld(
      async (s) => {
        if (s.mode === 'review') return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
        await s.engine('report_done', { summary: 'I looked: the greeting is already right, so nothing needed changing.' });
      },
      { mergeTarget: null },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    expect(store.openDecisions(setup.w.db).map((card) => [card.kind, card.text])).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: null });
    expect(store.runsOf(setup.w.db, task.id).at(0)!.summary).toContain('nothing needed changing');
  });

  it('takes away a merge card that asks about nothing, left from before, and finishes its task', async () => {
    const setup = ledWorld(
      async (s) => {
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Wrote it.' });
      },
      { selfManaged: true, mergeTarget: null },
    );
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    await drain(setup);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'merge', taskId: task.id }]);
    // A card with something behind it stays.
    await setup.w.sup.settleStaleCards();
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'merge', taskId: task.id }]);
    // The same card over a branch with nothing on it: what an older engine raised for a question.
    const folder = store.getTask(setup.w.db, task.id)!.folder!;
    gitIn(folder, 'reset', '-q', '--hard', 'origin/team');
    await setup.w.sup.settleStaleCards();
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: null });
  });

  it('raises a merge card when the team has no merge target; Merge lands it', async () => {
    const setup = ledWorld(straight, { mergeTarget: null });
    const parent = parentTask(setup.w);
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'merge', taskId: parent.id });
    expect(card!.text).toContain('team');
    // Each part was reviewed, and so was how the lead put them together: the card says who stands behind the whole.
    expect(card!.text).toMatch(/\? Its 2 sub-tasks were each approved by a reviewer and the whole by Ada, gates green \(greeting, farewell\);/);
    expect(card!.options.map((o) => o.label)).toEqual(['Merge', 'Keep the branch', 'Stop it']);
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBeNull();
    setup.w.sup.answer(card!.id, { optionId: 'merge' });
    await drain(setup);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBe('from Ada');
  });

  it('Keep the branch completes the task without merging', async () => {
    const setup = ledWorld(straight, { mergeTarget: null });
    const parent = parentTask(setup.w);
    await drain(setup);
    setup.w.sup.answer(store.openDecisions(setup.w.db)[0]!.id, { optionId: 'keep' });
    await drain(setup);
    const done = store.getTask(setup.w.db, parent.id)!;
    expect(done).toMatchObject({ state: 'done', mergedInto: null });
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBeNull();
    expect(fileAt(setup.repoPath!, done.branch!, 'GREETING.md')).toBe('from Ada');
  });

  it('gives the lead the conflict to resolve when two children changed the same file', async () => {
    let integrateTurn = '';
    const both = proposal([{ title: 'First', assigneeId: 'emp1', ownership: ['a'] }, { title: 'Second', assigneeId: 'emp2', ownership: ['b'] }]);
    const setup = ledWorld(async (s) => {
      if (s.mode === 'brief') await s.engine('propose_subtasks', both);
      if (s.mode === 'work') {
        s.write('README.md', `rewritten by ${s.who}\n`); // both stray into the same file, by command
        await s.engine('report_done', { summary: 'Rewrote the readme.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '' });
      if (s.mode === 'integrate') {
        integrateTurn = s.input.prompt;
        if (s.read('README.md').includes('<<<<<<<')) s.write('README.md', 'rewritten by Ada and Grace\n');
        await s.engine('report_done', { summary: 'Resolved the readme.' });
      }
    });
    const parent = parentTask(setup.w, { gates: [] });
    await drain(setup);
    // Each child changed a file it does not own: accept both, to reach the merge.
    for (let i = 0; i < 2; i++) {
      for (const card of store.openDecisions(setup.w.db).filter((d) => d.kind === 'ownership')) setup.w.sup.answer(card.id, { optionId: 'accept' });
      await drain(setup);
    }
    expect(integrateTurn).toContain('README.md');
    expect(integrateTurn).toMatch(/conflict/i);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath!, 'team', 'README.md')).toBe('rewritten by Ada and Grace');
  });

  it('asks instead of merging when the target is checked out with uncommitted changes', async () => {
    const setup = ledWorld(
      async (s) => {
        s.write('GREETING.md', 'hello\n');
        await s.engine('report_done', { summary: 'Added.' });
      },
      { selfManaged: true, mergeTarget: 'main' },
    );
    fs.writeFileSync(path.join(setup.repoPath!, 'README.md'), 'my own uncommitted edit\n');
    const task = parentTask(setup.w, { assigneeId: 'emp1', gates: [] });
    // The team's base is `team`; its merge target is `main`, which the user has checked out and is editing.
    await drain(setup);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'merge', taskId: task.id, text: expect.stringContaining('uncommitted') }]);
    expect(fs.readFileSync(path.join(setup.repoPath!, 'README.md'), 'utf8')).toBe('my own uncommitted edit\n');
    gitIn(setup.repoPath!, 'checkout', '-q', '--', 'README.md');
    setup.w.sup.answer(store.openDecisions(setup.w.db)[0]!.id, { optionId: 'merge' });
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'main' });
    expect(fs.existsSync(path.join(setup.repoPath!, 'GREETING.md'))).toBe(true);
  });

  it('asks what to do when a sub-task was stopped, and can integrate the rest', async () => {
    const setup = ledWorld(async (s) => {
      if (s.mode === 'brief') await s.engine('propose_subtasks', twoFiles);
      if (s.mode === 'work' && s.who === 'Ada') {
        s.write('GREETING.md', 'from Ada\n');
        await s.engine('report_done', { summary: 'Wrote the greeting.' });
      }
      if (s.mode === 'work' && s.who === 'Grace') await s.engine('request_decision', { question: 'Is a farewell really wanted?', options: [] });
      if (s.mode === 'review' && s.input.prompt.includes('has stopped with a question')) return void (await s.engine('submit_review', { verdict: 'escalate', notes: 'Only the user knows whether a farewell is wanted.' }));
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '' });
      if (s.mode === 'integrate') await s.engine('report_done', { summary: 'Integrated the greeting only.' });
    });
    const parent = parentTask(setup.w, { gates: ['greeting'] });
    await drain(setup);
    const question = store.openDecisions(setup.w.db).find((d) => d.kind === 'question')!;
    setup.w.sup.answer(question.id, { optionId: 'stop' });
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'question', taskId: parent.id, text: expect.stringContaining('Farewell') });
    setup.w.sup.answer(card!.id, { optionId: 'integrate' });
    await drain(setup);
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath!, 'team', 'GREETING.md')).toBe('from Ada');
    expect(fileAt(setup.repoPath!, 'team', 'FAREWELL.md')).toBeNull();
  });
});
