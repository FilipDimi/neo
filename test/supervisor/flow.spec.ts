import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvents } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { Gate } from '../../src/shared/types.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitIn, gitRepo, refOf, repo, team, world, type World } from '../helpers.ts';

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
];

type Setup = { w: World; fixture: InProcess; repoPath: string | null };

/** A led team (Priya leads Ada and Grace), with a repository unless told otherwise. */
function ledWorld(play: (scene: Scene) => Promise<void> | void, over: { repo?: boolean; mergeTarget?: string | null; maxReviewRounds?: number; selfManaged?: boolean } = {}): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = over.repo === false ? null : gitRepo();
  const w = (open = world(fixture.spawn, {
    repos: repoPath ? [repo({ path: repoPath, gates: GATES })] : [],
    teams: [team({ leadId: over.selfManaged ? null : 'lead', selfManaged: over.selfManaged ?? false, maxReviewRounds: over.maxReviewRounds ?? 3, repos: repoPath ? [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: over.mergeTarget === undefined ? 'team' : over.mergeTarget }] : [] })],
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

  it('a lead that reports done from a brief run completes the task without review', async () => {
    const setup = ledWorld(
      async (s) => {
        s.write('NOTE.md', 'small enough to do myself\n');
        await s.engine('report_done', { summary: 'Did it myself.' });
      },
      { repo: false },
    );
    const task = parentTask(setup.w, { gates: [] });
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)?.state).toBe('done');
    expect(store.runsOf(setup.w.db, task.id).map((r) => r.mode)).toEqual(['brief']);
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

describe('integration and landing', () => {
  it('briefs, works, reviews, integrates and lands on the team branch; main never moves', async () => {
    const setup = ledWorld(straight);
    const mainBefore = refOf(setup.repoPath!, 'main');
    const parent = parentTask(setup.w);
    await drain(setup);
    const children = store.listTasks(setup.w.db, { parentId: parent.id });
    expect(store.getTask(setup.w.db, parent.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(children.map((c) => c.state)).toEqual(['done', 'done']);
    expect(store.runsOf(setup.w.db, parent.id).map((r) => r.mode)).toEqual(['brief', 'integrate']);
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

  it('raises a merge card when the team has no merge target; Merge lands it', async () => {
    const setup = ledWorld(straight, { mergeTarget: null });
    const parent = parentTask(setup.w);
    await drain(setup);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'merge', taskId: parent.id });
    expect(card!.text).toContain('team');
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
