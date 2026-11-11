import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import { paths } from '../../src/db/dataDir.ts';
import * as store from '../../src/db/store.ts';
import type { Gate } from '../../src/shared/types.ts';
import { adminTool } from '../../src/supervisor/admin.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitIn, gitRepo, repo, T0, team, world, type World } from '../helpers.ts';

// Real git and real gates.
vi.setConfig({ testTimeout: 20_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const everything = ['read_files', 'run_commands', 'write_code'] as const;
const people = [employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...everything] }), employee({ capabilities: [...everything] }), employee({ id: 'emp2', name: 'Grace', capabilities: [...everything] })];
const greeting: Gate = { name: 'greeting', command: 'test -f GREETING.md', timeoutMinutes: 1, lock: null };

type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Priya leads Ada and Grace in a repository; finished work lands on `team` by itself. */
function ledWorld(play: (scene: Scene) => Promise<void> | void, gates: Gate[] = [greeting]): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo();
  const w = (open = world(fixture.spawn, { repos: [repo({ path: repoPath, gates })], teams: [team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })], employees: people }));
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

/** Ada writes the greeting and reports; Priya approves. */
const plain = async (s: Scene): Promise<void> => {
  if (s.mode === 'work') {
    s.write('GREETING.md', 'Hello, and welcome.\n');
    await s.engine('report_done', { summary: 'Added.' });
  }
  if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
};
const greet = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Add a greeting', brief: 'One friendly line in GREETING.md.', doneCondition: 'GREETING.md exists.', gates: ['greeting'], capUsd: 2, ...over });

describe('what an earlier start left behind', () => {
  it('starts a task whose folder was made by a start that never got recorded', async () => {
    const setup = ledWorld(plain);
    const task = greet(setup.w);
    const leftover = path.join(paths(setup.w.dir).folders, task.id);
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'half-a-checkout.txt'), 'x');
    await drain(setup);
    expect(store.openDecisions(setup.w.db).map((card) => card.text)).toEqual([]);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });
});

describe('a gate a task names', () => {
  it('cannot be taken away or renamed while that task is unfinished', async () => {
    const setup = ledWorld(() => {});
    const task = greet(setup.w);
    const ctx = { db: setup.w.db, now: T0, paths: paths(setup.w.dir), skills: [] };
    await expect(adminTool(ctx, 'set_gates', { repo: setup.repoPath, gates: [{ ...greeting, name: 'greetings' }] })).rejects.toThrow(/"Add a greeting" .*"greeting"/);
    expect(await adminTool(ctx, 'set_gates', { repo: setup.repoPath, gates: [{ ...greeting, timeoutMinutes: 5 }, { ...greeting, name: 'more' }] })).toMatch(/greeting \(5 min\), more/);
    apply(setup.w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, task.id)!, state: 'failed' }, cause: 'state' }));
    expect(await adminTool(ctx, 'set_gates', { repo: setup.repoPath, gates: [] })).toMatch(/none/);
  });

  it('is never skipped because it is gone: the work does not land, and a card says which gate is missing', async () => {
    const setup = ledWorld(plain);
    const task = greet(setup.w);
    // However it came about (an older engine, a row changed by hand), the repository no longer has the gate.
    apply(setup.w.db, (tx) => tx.emit({ kind: 'repo_changed', repo: repo({ path: setup.repoPath, gates: [] }) }));
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ mergedInto: null });
    expect(store.getTask(setup.w.db, task.id)!.state).not.toBe('done');
    expect(store.openDecisions(setup.w.db).map((card) => card.text).join('\n')).toMatch(/gate "greeting".*no longer/);
  });

  it('leaves nothing of its own in the work: what a gate wrote is not committed with the next run', async () => {
    let reviews = 0;
    const litter: Gate = { name: 'greeting', command: 'echo built > BUILD-INFO.txt && echo changed >> README.md && test -f GREETING.md', timeoutMinutes: 1, lock: null };
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write('GREETING.md', s.resumed ? 'Hello, and welcome.\n' : 'yo\n');
        await s.engine('report_done', { summary: 'Added.' });
      }
      if (s.mode === 'review') {
        if (++reviews === 1) await s.engine('submit_review', { verdict: 'send_back', notes: 'Too curt.', findings: [{ severity: 'blocking', file: 'GREETING.md', line: 1, title: 'One curt word', why: 'First thing read.', fix: 'A friendly sentence.' }] });
        else await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
      }
    }, [litter]);
    const task = greet(setup.w);
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath, 'team', 'GREETING.md')).toBe('Hello, and welcome.');
    expect(fileAt(setup.repoPath, 'team', 'BUILD-INFO.txt')).toBeNull();
    expect(fileAt(setup.repoPath, 'team', 'README.md')).toBe('hello');
    expect(gitIn(setup.repoPath, 'log', '--format=%s', 'team').split('\n')).not.toContain('');
  });
});
