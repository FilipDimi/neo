import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffOf } from '../../src/api/diff.ts';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { RecordEntry } from '../../src/shared/types.ts';
import { judgeToolCall } from '../../src/supervisor/blastRadius.ts';
import { recordDecision, type NewEntry } from '../../src/supervisor/record.ts';
import { fileOf, render, writeRecordFiles } from '../../src/supervisor/recordFiles.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { company as companyRow, employee, fileAt, gitIn, gitRepo, repo, T0, task, team, tempDb, tempDir, world, type World } from '../helpers.ts';

// Real git.
vi.setConfig({ testTimeout: 20_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const lead = { kind: 'lead' as const, employeeId: 'lead' };
function add(db: World['db'], statement: string, over: Partial<NewEntry> = {}): RecordEntry {
  let made!: RecordEntry;
  apply(db, (tx) => void (made = recordDecision(tx, db, T0, { statement, why: 'Because.', by: lead, repoId: 'repo1', ...over })), T0);
  return made;
}

describe('a decision as a file', () => {
  it('writes everything the entry has, and only that', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'team_changed', team: team({ leadId: 'lead' }) });
      tx.emit({ kind: 'employee_changed', employee: employee({ id: 'lead', name: 'Priya' }) });
      tx.emit({ kind: 'task_changed', task: task({ title: 'Add the stories endpoint' }), cause: 'created' });
    });
    add(db, 'Errors are problem+json.', { why: '' });
    const full = add(db, 'Errors are problem+json with a code.\nSecond line of the statement.', { why: 'Clients switch on the code.', replaces: 'D-1', taskId: 'task1', detail: 'Question:\nWhich shape?\n\nAnswer:\nWith a code.' });
    expect(fileOf(full)).toBe('D-0002.md');
    expect(render(full)).toBe(
      [
        '# D-0002: Errors are problem+json with a code.',
        '',
        '- Date: 2026-11-09',
        '- Decided by: Priya',
        '- Ticket: "Add the stories endpoint"',
        '- Replaces: D-0001',
        '',
        '## The decision',
        '',
        'Errors are problem+json with a code.\nSecond line of the statement.',
        '',
        '## Why',
        '',
        'Clients switch on the code.',
        '',
        '## The question and the answer',
        '',
        'Question:\nWhich shape?\n\nAnswer:\nWith a code.',
        '',
      ].join('\n'),
    );
    // What a file says never changes once written: being replaced later is said by the newer one, not added to the older.
    const first = store.getEntry(db, 'D-1')!;
    expect(first.replacedBy).toBe('D-2');
    expect(render(first)).toBe(['# D-0001: Errors are problem+json.', '', '- Date: 2026-11-09', '- Decided by: Priya', ''].join('\n'));
    // Renaming the person afterwards does not rewrite what was filed.
    apply(db, (tx) => tx.emit({ kind: 'employee_changed', employee: employee({ id: 'lead', name: 'Renamed' }) }));
    expect(render(store.getEntry(db, 'D-1')!)).toContain('- Decided by: Priya');
  });

  it('is written for the repository it is about and for the whole company, never for an archive or another repository', () => {
    const db = tempDb();
    const dir = gitRepo();
    const here = repo({ path: dir, decisionsDir: './docs/decisions/' });
    add(db, 'About this repository.');
    add(db, 'About the whole company.', { repoId: null });
    add(db, 'About another repository.', { repoId: 'other' });
    const old = add(db, 'Kept by hand before.');
    apply(db, (tx) => tx.emit({ kind: 'record_changed', entry: { ...old, archived: true } }));
    expect(writeRecordFiles(db, here, dir)).toEqual(['docs/decisions/D-0001.md', 'docs/decisions/D-0002.md']);
    expect(fs.readdirSync(path.join(dir, 'docs/decisions')).sort()).toEqual(['D-0001.md', 'D-0002.md']);
    // Nothing new: nothing written.
    expect(writeRecordFiles(db, here, dir)).toEqual([]);
    expect(writeRecordFiles(db, repo({ path: dir }), dir)).toEqual([]);
  });

  it('merges without a conflict when two branches each carry decisions, one of them written after a reversal', () => {
    const db = tempDb();
    const dir = gitRepo(['alpha', 'beta']);
    const here = repo({ path: dir, decisionsDir: 'docs/decisions' });
    const commit = (branch: string) => {
      gitIn(dir, 'checkout', '-q', branch);
      writeRecordFiles(db, here, dir);
      gitIn(dir, 'add', '-A');
      gitIn(dir, 'commit', '-q', '-m', `record on ${branch}`);
    };
    add(db, 'The API speaks JSON.');
    add(db, 'Dates are ISO 8601.');
    commit('alpha');
    add(db, 'The API speaks JSON and CSV.', { replaces: 'D-1' });
    commit('beta');
    gitIn(dir, 'checkout', '-q', 'alpha');
    gitIn(dir, 'merge', '-q', '--no-edit', 'beta'); // throws on a conflict
    expect(fs.readdirSync(path.join(dir, 'docs/decisions')).sort()).toEqual(['D-0001.md', 'D-0002.md', 'D-0003.md']);
    expect(gitIn(dir, 'status', '--porcelain')).toBe('');
  });

  it('refuses an agent that writes in the decisions folder, in words, without stopping its run', () => {
    const folder = tempDir();
    const ctx = { task: task(), team: team(), employee: employee(), mode: 'work' as const, folder, company: companyRow(), grants: [], engineDirs: ['docs/decisions'] };
    const call = (file: string) => ({ id: 'c1', tool: 'Write', input: { file_path: path.join(folder, file), content: 'x' } });
    const refused = judgeToolCall(ctx, call('docs/decisions/D-0001.md'));
    expect(refused).toMatchObject({ allow: false, reason: expect.stringMatching(/the engine writes.*record_decision/s) });
    expect(refused.stop).toBeUndefined();
    expect(judgeToolCall(ctx, call('docs/decisions-notes.md'))).toEqual({ allow: true });
    expect(judgeToolCall({ ...ctx, engineDirs: [] }, call('docs/decisions/D-0001.md'))).toEqual({ allow: true });
  });
});

const everything = ['read_files', 'run_commands', 'write_code'] as const;
const people = [employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...everything] }), employee({ capabilities: [...everything] }), employee({ id: 'emp2', name: 'Grace', capabilities: [...everything] })];
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Priya leads Ada and Grace in a repository that keeps its decisions in `docs/decisions`; finished work lands on `team` by itself. */
function ledWorld(play: (scene: Scene) => Promise<void> | void): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo();
  const w = (open = world(fixture.spawn, { repos: [repo({ path: repoPath, decisionsDir: 'docs/decisions' })], teams: [team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })], employees: people }));
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
const note = (w: World, title: string) => w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title, brief: 'Write it.', doneCondition: 'It exists.', capUsd: 2 });
const records = (repoPath: string) => gitIn(repoPath, 'log', '--format=%an|%s', 'team').split('\n').filter((line) => line.includes('|Record:'));

describe('decision files reach the repository when work lands', () => {
  it('writes them into the landing as the engine, once, and again only when there is something new', async () => {
    let n = 0;
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        s.write(`NOTE-${++n}.md`, 'A note.\n');
        await s.engine('report_done', { summary: 'Written.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
    });
    const first = add(setup.w.db, 'Notes are in markdown.');
    note(setup.w, 'First note');
    await drain(setup);
    expect(fileAt(setup.repoPath, 'team', 'docs/decisions/D-0001.md')).toBe(render(store.getEntry(setup.w.db, first.id)!).trimEnd());
    expect(records(setup.repoPath)).toEqual(['Virtual Startup|Record: decisions up to D-0001']);
    // A second landing with nothing new decided adds no commit of the engine's.
    note(setup.w, 'Second note');
    await drain(setup);
    expect(fileAt(setup.repoPath, 'team', 'NOTE-2.md')).toBe('A note.');
    expect(records(setup.repoPath)).toHaveLength(1);
    add(setup.w.db, 'Notes are short.');
    note(setup.w, 'Third note');
    await drain(setup);
    expect(records(setup.repoPath)[0]).toBe('Virtual Startup|Record: decisions up to D-0002');
    expect(store.openDecisions(setup.w.db)).toEqual([]);
  });

  it('puts back a decision file an employee changed, and sends back work that adds a file of its own there', async () => {
    const told: string[] = [];
    let landed = false;
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        told.push(s.input.prompt);
        if (!landed) s.write('NOTE.md', 'A note.\n');
        else if (!s.resumed) {
          // A command, not a tool call: nothing judged these writes before they happened.
          s.write('docs/decisions/D-0001.md', 'tampered\n');
          s.write('docs/decisions/my-own-notes.md', 'mine\n');
          s.write('OTHER.md', 'More.\n');
        } else fs.rmSync(path.join(s.input.cwd, 'docs/decisions/my-own-notes.md'));
        await s.engine('report_done', { summary: 'Written.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
    });
    const entry = add(setup.w.db, 'Notes are in markdown.');
    note(setup.w, 'First note');
    await drain(setup);
    landed = true;
    const second = note(setup.w, 'Second note');
    await drain(setup);
    const back = told.find((prompt) => prompt.includes('my-own-notes.md'));
    expect(back).toMatch(/only the engine writes in docs\/decisions/i);
    expect(back).not.toContain('D-0001.md');
    expect(store.getTask(setup.w.db, second.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath, 'team', 'docs/decisions/D-0001.md')).toBe(render(store.getEntry(setup.w.db, entry.id)!).trimEnd());
    expect(fileAt(setup.repoPath, 'team', 'docs/decisions/my-own-notes.md')).toBeNull();
    expect(fileAt(setup.repoPath, 'team', 'OTHER.md')).toBe('More.');
  });

  it('refuses a write in the decisions folder as the run makes it, and does not count the engine\'s files as the ticket\'s change', async () => {
    const allowed: boolean[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        allowed.push(await s.tool('Write', { file_path: path.join(s.input.cwd, 'docs/decisions/D-0001.md'), content: 'mine' }));
        allowed.push(await s.tool('Write', { file_path: path.join(s.input.cwd, 'NOTE.md'), content: 'A note.' }));
        s.write('NOTE.md', 'A note.\n');
        await s.engine('report_done', { summary: 'Written.' });
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
    });
    add(setup.w.db, 'Notes are in markdown.');
    const made = note(setup.w, 'First note');
    await drain(setup);
    // Refused in words; the run carried on to the write it may make, and to its report.
    expect(allowed).toEqual([false, true]);
    const landed = store.getTask(setup.w.db, made.id)!;
    expect(landed).toMatchObject({ state: 'done', mergedInto: 'team' });
    const diff = await diffOf(setup.w.db, landed);
    expect(diff.patch).toContain('NOTE.md');
    expect(diff.patch).not.toContain('D-0001');
    expect(diff.lines).toBe(1);
  });
});
