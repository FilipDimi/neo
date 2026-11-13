import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { adminTool } from '../../src/supervisor/admin.ts';
import { companyNow } from '../../src/supervisor/companyNow.ts';
import { recover } from '../../src/supervisor/recover.ts';
import { buildFirstTurn } from '../../src/supervisor/definition.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
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
  employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...all] }),
  employee({ capabilities: [...all] }),
  employee({ id: 'emp2', name: 'Grace', capabilities: [...all] }),
  employee({ id: 'other', name: 'Linus', teamId: 'team2', capabilities: [...all] }),
];
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Ada and Grace work on one branch without a lead's split; Linus's team lands on another branch of the same repository. */
function shared(play: (scene: Scene) => Promise<void> | void, over: { owns?: string[]; concurrency?: number } = {}): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo(['team', 'elsewhere']);
  const w = (open = world(fixture.spawn, {
    company: { concurrency: over.concurrency ?? 3 },
    repos: [repo({ path: repoPath })],
    teams: [
      team({ selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team', ...(over.owns ? { owns: over.owns } : {}) }] }),
      team({ id: 'team2', name: 'Elsewhere', selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'elsewhere', mergeTarget: 'elsewhere' }] }),
    ],
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
const titleOf = (s: Scene): string => /# Task: (.+)/.exec(s.input.prompt)?.[1] ?? '?';
const make = (setup: Setup, title: string, assigneeId: string, more: object = {}) => setup.w.sup.createTask({ teamId: assigneeId === 'other' ? 'team2' : 'team1', assigneeId, title, brief: 'x', doneCondition: 'y', ...more });
const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a claim is what a task has changed and not landed', () => {
  it('holds a file from the first write until the task lands, and refuses another task on the same branch a write to it', async () => {
    const allowed: Record<string, boolean[]> = {};
    let setup: Setup;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    setup = shared(async (s) => {
      const title = titleOf(s);
      const write = async (file: string) => {
        const ok = await s.tool('Write', { file_path: path.join(s.cwd, file), content: `${title}\n` });
        (allowed[title] ??= []).push(ok);
        if (ok) s.write(file, `${title}\n`);
        return ok;
      };
      if (title === 'First') {
        await write('shared.md');
        await held; // it keeps working while the others try
        return void (await s.engine('report_done', { summary: 'First wrote the shared file.' }));
      }
      // Give the first task time to have written.
      while (!store.listTasks(setup.w.db).some((task) => task.title === 'First' && task.claims?.includes('shared.md'))) await pause();
      await write('shared.md');
      await write(`${title}.md`);
      if (title === 'Third') release();
      await s.engine('report_done', { summary: `${title} wrote its own file.` });
    });
    const first = make(setup, 'First', 'emp1');
    make(setup, 'Second', 'emp2');
    // Another team, landing on another branch: its file of the same name is its own.
    make(setup, 'Third', 'other');
    await drain(setup);
    expect(allowed).toEqual({ First: [true], Second: [false, true], Third: [true, true] });
    // Held until it landed; then nobody's.
    expect(store.getTask(setup.w.db, first.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    const second = store.listTasks(setup.w.db).find((task) => task.title === 'Second')!;
    expect(second.claims).toEqual(['Second.md']);
  });

  it('says who holds the file, and what to do', async () => {
    const setup = shared(() => {});
    const first = make(setup, 'First', 'emp1');
    const second = make(setup, 'Second', 'emp2');
    apply(setup.w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, first.id)!, state: 'running', claims: ['src/api/routes.rs'] }, cause: 'edited' }), setup.w.clock.now());
    const holder = (setup.w.sup as unknown as { heldBy(task: unknown, file: string): { title: string } | null }).heldBy(store.getTask(setup.w.db, second.id)!, 'src/api/routes.rs');
    expect(holder).toMatchObject({ title: 'First' });
    expect((setup.w.sup as unknown as { heldBy(task: unknown, file: string): unknown }).heldBy(store.getTask(setup.w.db, second.id)!, 'src/api/other.rs')).toBeNull();
    // Its own file, and a file held on another branch, are nobody else's.
    expect((setup.w.sup as unknown as { heldBy(task: unknown, file: string): unknown }).heldBy(store.getTask(setup.w.db, first.id)!, 'src/api/routes.rs')).toBeNull();
    const third = make(setup, 'Third', 'other');
    expect((setup.w.sup as unknown as { heldBy(task: unknown, file: string): unknown }).heldBy(store.getTask(setup.w.db, third.id)!, 'src/api/routes.rs')).toBeNull();
  });
});

describe('a run can wait for another task', () => {
  it('ends the run, waits without asking anyone, and starts the same session again with the other\'s work in its folder', async () => {
    const turns: Record<string, string[]> = {};
    const replies: { ok: boolean; text: string }[] = [];
    let setup: Setup;
    setup = shared(
      async (s) => {
        const title = titleOf(s) === '?' ? 'Second' : titleOf(s);
        (turns[title] ??= []).push(s.input.prompt);
        if (title === 'First') {
          s.write('shared.md', 'from the first\n');
          return void (await s.engine('report_done', { summary: 'First wrote the shared file.' }));
        }
        if (!s.resumed) {
          replies.push(await s.engine('wait_for', { task: 'Second', why: 'x' }));
          replies.push(await s.engine('wait_for', { task: 'Nothing like it', why: 'x' }));
          replies.push(await s.engine('wait_for', { task: 'First', why: 'It builds on the shared file.' }));
          return;
        }
        // Started again: the first task's file is in its folder.
        s.write('second.md', `built on: ${s.read('shared.md').trim()}\n`);
        await s.engine('report_done', { summary: 'Second built on it.' });
      },
      { concurrency: 1 },
    );
    const second = make(setup, 'Second', 'emp2');
    const first = make(setup, 'First', 'emp1');
    // The second starts first, and finds it needs the first.
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    expect(replies.map((reply) => reply.ok)).toEqual([false, false, true]);
    expect(replies[0]!.text).toMatch(/cannot wait for itself/);
    expect(replies[1]!.text).toMatch(/no open task "Nothing like it"/);
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'queued', after: [first.id] });
    expect(store.runsOf(setup.w.db, second.id).map((run) => [run.outcome, run.reason])).toEqual([['stopped', 'waiting']]);
    expect(store.openDecisions(setup.w.db)).toEqual([]);
    expect(companyNow(setup.w.db, setup.w.clock.now())).toContain('- "Second" (queued): waiting for "First" to be done');
    await drain(setup);
    expect(turns.Second![1]).toMatch(/What you waited for is done[\s\S]*- "First": done, merged into team; the engine merged team into your folder/);
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'done' });
    expect(fileAt(setup.repoPath, 'team', 'second.md')).toBe('built on: from the first');
    expect(store.allDecisions(setup.w.db)).toEqual([]);
  });

  it('refuses to wait in a circle, and for a task that is over', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    let setup: Setup;
    setup = shared(async (s) => {
      if (titleOf(s) !== 'B') return;
      replies.push(await s.engine('wait_for', { task: 'A', why: 'x' }));
      replies.push(await s.engine('wait_for', { task: store.listTasks(setup.w.db).find((task) => task.title === 'Old')!.id, why: 'x' }));
      s.write('b.md', 'x\n');
      await s.engine('report_done', { summary: 'B.' });
    });
    const b = make(setup, 'B', 'emp2');
    const old = make(setup, 'Old', 'emp1');
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, old.id)!, state: 'done', mergedInto: 'team' }, cause: 'state' });
      for (const request of store.requestsOf(setup.w.db, old.id)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: old.id });
    }, setup.w.clock.now());
    // A waits for B already.
    make(setup, 'A', 'emp1', { after: [b.id] });
    await drain(setup);
    expect(replies.map((reply) => reply.ok)).toEqual([false, false]);
    expect(replies[0]!.text).toMatch(/"A" waits for this task/);
    expect(replies[1]!.text).toMatch(/"Old" is done already: merged into team/);
  });
});

describe('plans, folders, and the same ask twice', () => {
  it('refuses a task that names files another open task holds, unless it waits for that task', () => {
    const setup = shared(() => {});
    const first = make(setup, 'First', 'emp1');
    apply(setup.w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, first.id)!, state: 'running', claims: ['src/api/routes.rs'] }, cause: 'edited' }), setup.w.clock.now());
    expect(() => make(setup, 'Second', 'emp2', { ownership: ['src/api'] })).toThrow(/names src\/api, where "First" \(Ada\) is changing src\/api\/routes\.rs and has not landed.*after/s);
    expect(make(setup, 'Second', 'emp2', { ownership: ['src/api'], after: [first.id] })).toMatchObject({ state: 'queued' });
    // Other files, or another branch: nothing in the way.
    expect(make(setup, 'Fourth', 'emp2', { ownership: ['web'] }).ownership).toEqual(['web']);
    expect(make(setup, 'Fifth', 'other', { ownership: ['src/api'] }).ownership).toEqual(['src/api']);
  });

  it('gives a team\'s own folders to a task made without files, and shows them to the chief of staff', () => {
    const setup = shared(() => {}, { owns: ['ios', 'docs/design'] });
    expect(make(setup, 'Plain', 'emp1').ownership).toEqual(['ios', 'docs/design']);
    expect(make(setup, 'Named', 'emp1', { ownership: ['ios/App'] }).ownership).toEqual(['ios/App']);
    const chat = store.newTask({ teamId: 'team1', title: 'Chat', brief: 'Who does the phone app?', createdBy: 'user', kind: 'chat' }, new Date());
    const teams = store.allTeams(setup.w.db).map((one) => ({ team: one, lead: null, members: [] }));
    expect(buildFirstTurn({ task: chat, mode: 'route', team: teams[0]!.team, repo: null, teammates: [], remainingUsd: 0, chief: true, teams })).toMatch(/its folders: ios, docs\/design/);
  });

  it('does not make the same task twice on one team while the first is open', () => {
    const setup = shared(() => {});
    const first = make(setup, 'Fix the list scroll', 'emp1');
    expect(() => make(setup, ' fix the list  scroll. ', 'emp2')).toThrow(new RegExp(`"Fix the list scroll" is already on \\w+'s board \\(queued, Ada has it\\): task ${first.id}`, 's'));
    // Another team may have a task of that name; and once the first is over, so may this one.
    expect(make(setup, 'Fix the list scroll', 'other').teamId).toBe('team2');
    setup.w.sup.cancelTask(first.id);
    expect(make(setup, 'Fix the list scroll', 'emp2').title).toBe('Fix the list scroll');
  });
});

describe('what the review of claims found', () => {
  /** A whole that is open, with one part that is done and holds a file: nothing of it has landed. */
  const wholeWithDonePart = (setup: Setup) => {
    const whole = make(setup, 'Whole', 'emp1');
    const at = setup.w.clock.now();
    const part = store.newTask({ teamId: 'team1', parentId: whole.id, assigneeId: 'emp1', title: 'Part', brief: 'x', createdBy: 'emp1', repoId: 'repo1', state: 'done', ownership: ['src/f.md'], claims: ['src/f.md'] }, at);
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'task_changed', task: part, cause: 'created' });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, whole.id)!, state: 'running' }, cause: 'state' });
      for (const request of store.requestsOf(setup.w.db, whole.id)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: whole.id });
    }, at);
    return { whole: store.getTask(setup.w.db, whole.id)!, part };
  };
  const held = (setup: Setup, taskId: string, file: string) => (setup.w.sup as unknown as { heldBy(task: unknown, file: string): { title: string } | null }).heldBy(store.getTask(setup.w.db, taskId)!, file);

  it('keeps a finished part\'s files held until its whole has landed, and names the whole as what to wait for', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    let setup: Setup;
    let partId = '';
    setup = shared(async (s) => {
      if (titleOf(s) !== 'Outside') return;
      replies.push(await s.engine('wait_for', { task: partId, why: 'It holds src/f.md.' }));
    });
    const { whole, part } = wholeWithDonePart(setup);
    partId = part.id;
    const outside = make(setup, 'Outside', 'emp2');
    expect(held(setup, outside.id, 'src/f.md')).toMatchObject({ title: 'Whole' });
    expect(() => make(setup, 'Planned', 'emp2', { ownership: ['src'] })).toThrow(new RegExp(`where "Whole" .* is changing src/f\\.md and has not landed.*after: \\["${whole.id}"\\]`, 's'));
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    // Waiting for the part is waiting for its whole: the part being done puts nothing on the branch.
    expect(replies).toMatchObject([{ ok: true, text: expect.stringContaining('waits for "Whole"') }]);
    expect(store.getTask(setup.w.db, outside.id)).toMatchObject({ state: 'queued', after: [whole.id] });
    // Landed: nobody's.
    apply(setup.w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, whole.id)!, state: 'done', mergedInto: 'team' }, cause: 'state' }), setup.w.clock.now());
    expect(held(setup, outside.id, 'src/f.md')).toBeNull();
  });

  it('sees a circle that goes through a whole and its part', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    let setup: Setup;
    let partId = '';
    setup = shared(async (s) => {
      if (titleOf(s) !== 'Part two') return;
      replies.push(await s.engine('wait_for', { task: 'Outside', why: 'x' }));
      s.write('two.md', 'x\n');
      await s.engine('report_done', { summary: 'Two.' });
    });
    const { whole } = wholeWithDonePart(setup);
    // Outside waits for the whole; a part of the whole then wants to wait for Outside.
    make(setup, 'Outside', 'emp2', { after: [whole.id] });
    const at = setup.w.clock.now();
    const two = store.newTask({ teamId: 'team1', parentId: whole.id, assigneeId: 'emp1', title: 'Part two', brief: 'x', createdBy: 'emp1', repoId: 'repo1', ownership: ['two.md'] }, at);
    partId = two.id;
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'task_changed', task: two, cause: 'created' });
      tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: two.id, mode: 'work', employeeId: 'emp1', reason: 'new' }, at) });
    }, at);
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    expect(replies).toMatchObject([{ ok: false, text: expect.stringMatching(/"Outside" waits for this task/) }]);
    expect(store.getTask(setup.w.db, partId)!.after).toBeUndefined();
  });

  it('commits a waiting task\'s work before taking in what it waited for, and says so when the two collide', async () => {
    const turns: string[] = [];
    const setup = shared(
      async (s) => {
        const title = titleOf(s) === '?' ? 'Second' : titleOf(s);
        if (title === 'First') {
          s.write('common.md', 'from the first\n');
          return void (await s.engine('report_done', { summary: 'First.' }));
        }
        turns.push(s.input.prompt);
        if (!s.resumed) {
          // Work of its own, not committed, in a file the other task will also write.
          s.write('common.md', 'from the second\n');
          return void (await s.engine('wait_for', { task: 'First', why: 'It builds on it.' }));
        }
        s.write('common.md', 'from the first\nfrom the second\n');
        await s.engine('report_done', { summary: 'Second, on top of the first.' });
      },
      { concurrency: 1 },
    );
    const second = make(setup, 'Second', 'emp2');
    make(setup, 'First', 'emp1');
    await drain(setup);
    expect(turns[1]).toMatch(/- "First": done, merged into team; the engine merged team into your folder: CONFLICT in common\.md/);
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath, 'team', 'common.md')).toBe('from the first\nfrom the second');
  });

  it('does not start a task that put itself to wait because it was given to someone else, and then starts it afresh for them', async () => {
    const who: string[] = [];
    const setup = shared(
      async (s) => {
        const title = titleOf(s);
        if (title === 'First') {
          s.write('first.md', 'x\n');
          return void (await s.engine('report_done', { summary: 'First.' }));
        }
        who.push(`${s.who}${s.resumed ? ' (resumed)' : ''}`);
        if (who.length === 1) return void (await s.engine('wait_for', { task: 'First', why: 'x' }));
        s.write('second.md', 'x\n');
        await s.engine('report_done', { summary: 'Second.' });
      },
      { concurrency: 1 },
    );
    const second = make(setup, 'Second', 'emp2');
    make(setup, 'First', 'emp1');
    await setup.w.sup.tick();
    await setup.fixture.idle();
    await setup.w.sup.settle();
    expect(store.getTask(setup.w.db, second.id)!.state).toBe('queued');
    setup.w.sup.editTask(second.id, { assigneeId: 'emp1' });
    expect(store.requestsOf(setup.w.db, second.id)).toEqual([]);
    await drain(setup);
    // It was Grace's session that waited; the task is Ada's now, who starts it from the beginning.
    expect(who).toEqual(['Grace', 'Ada']);
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'done' });
  });

  it('sends back work whose commands changed a file another task holds', async () => {
    const turns: string[] = [];
    const setup = shared(async (s) => {
      if (titleOf(s) === 'First' ) return;
      turns.push(s.input.prompt);
      if (!s.resumed) s.write('shared.md', 'written by a command\n');
      else fs.rmSync(path.join(s.cwd, 'shared.md'));
      s.write('second.md', 'x\n');
      await s.engine('report_done', { summary: 'Second.' });
    });
    const first = make(setup, 'First', 'emp1');
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, first.id)!, state: 'blocked', claims: ['shared.md'] }, cause: 'edited' });
    }, setup.w.clock.now());
    const second = make(setup, 'Second', 'emp2');
    await drain(setup);
    expect(turns[1]).toMatch(/shared\.md is being changed by "First" \(Ada\), which has not landed\. Your work changed it too/);
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'done', claims: ['second.md'] });
  });

  it('tells titles apart in any alphabet, and takes a team\'s folders only as paths, with the contract beside them', async () => {
    const setup = shared(() => {}, { owns: ['ios'] });
    make(setup, 'Поправи го скролот', 'emp1');
    expect(make(setup, 'Додади копче', 'emp2').title).toBe('Додади копче');
    expect(() => make(setup, 'поправи  го скролот!', 'emp2')).toThrow(/is already on/);
    expect(make(setup, '???', 'emp1').title).toBe('???');
    expect(make(setup, '!!!', 'emp1').title).toBe('!!!');
    // A team's folders, where the repository has a contract: a task held to the folders may still change the contract under a version.
    apply(setup.w.db, (tx) => tx.emit({ kind: 'repo_changed', repo: { ...store.getRepo(setup.w.db, 'repo1')!, contract: { paths: ['docs/contract'] } } }), setup.w.clock.now());
    expect(make(setup, 'With the contract', 'emp1').ownership).toEqual(['ios', 'docs/contract']);
    await expect(adminTool({ db: setup.w.db, now: setup.w.clock.now(), paths: setup.w.sup.paths, skills: [] }, 'update_team', { team: 'team1', owns: ['/ios'] })).rejects.toThrow(/names no file or folder/);
  });

  it('does not start again, at a restart, a run whose task had been put to wait', () => {
    const setup = shared(() => {});
    const first = make(setup, 'First', 'emp1');
    const second = make(setup, 'Second', 'emp2');
    const at = setup.w.clock.now();
    apply(setup.w.db, (tx) => {
      const request = store.requestsOf(setup.w.db, second.id)[0]!;
      const run = store.newRun(request, at, 15);
      tx.emit({ kind: 'run_started', run, requestId: request.id, teamId: 'team1' });
      // The engine was killed after the wait was written down and before the run had ended.
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, second.id)!, state: 'queued', after: [first.id] }, cause: 'state' });
    }, at);
    recover(setup.w.db, at, { startedAt: () => null, killGroup: () => {} } as never);
    expect(store.runsOf(setup.w.db, second.id).map((run) => [run.outcome, run.reason])).toEqual([['stopped', 'waiting']]);
    expect(store.requestsOf(setup.w.db, second.id)).toEqual([]);
  });
});
