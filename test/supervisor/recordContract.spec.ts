import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { ContractVersion } from '../../src/shared/types.ts';
import { currentContract, issueContractVersion, nextVersion, onContractVersion, states } from '../../src/supervisor/record.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { company as companyRow, employee, fileAt, gitRepo, repo, run, T0, task, team, tempDb, world, type World } from '../helpers.ts';

// Real git.
vi.setConfig({ testTimeout: 20_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

describe('the contract\'s versions are handed out by the engine', () => {
  it('raises the right number for each kind of change', () => {
    expect(nextVersion('0.10.1', 'wording')).toBe('0.10.2');
    expect(nextVersion('0.10.1', 'adds')).toBe('0.11.0');
    expect(nextVersion('0.10.1', 'breaking')).toBe('1.0.0');
    expect(nextVersion(null, 'wording')).toBe('0.0.1');
    expect(nextVersion(null, 'adds')).toBe('0.1.0');
  });

  it('only ever hands out a higher one, whoever asks in whatever order, and starts where it is told to', () => {
    const db = tempDb();
    apply(db, (tx) => tx.emit({ kind: 'repo_changed', repo: repo({ contract: { paths: ['docs/contract'] } }) }));
    const issue = (input: Partial<Parameters<typeof issueContractVersion>[3]>): ContractVersion => {
      let made!: ContractVersion;
      apply(db, (tx) => void (made = issueContractVersion(tx, db, T0, { repoId: 'repo1', change: 'wording', summary: 'x', taskId: null, by: null, ...input })));
      return made;
    };
    expect(issue({ change: 'start', version: '0.10.1' }).version).toBe('0.10.1');
    expect(issue({ change: 'wording' }).version).toBe('0.10.2');
    expect(issue({ change: 'adds' }).version).toBe('0.11.0');
    // A wording change asked for after an addition was handed out comes after it: a version says nothing false about order.
    expect(issue({ change: 'wording' }).version).toBe('0.11.1');
    expect(currentContract(db, 'repo1')).toBe('0.11.1');
    expect(() => issue({ change: 'start', version: '0.9.0' })).toThrow(/not higher than 0\.11\.1/);
    expect(() => issue({ change: 'start', version: 'ten' })).toThrow(/three numbers/);
    expect(store.contractVersions(db, 'repo1').map((entry) => entry.version)).toEqual(['0.10.1', '0.10.2', '0.11.0', '0.11.1']);
  });

  it('knows a version stated from one that is only part of another', () => {
    expect(states('**0.10.2** (2026-11-12): wording only.', '0.10.2')).toBe(true);
    expect(states('  version: 0.10.2', '0.10.2')).toBe(true);
    expect(states('version: 0.10.21', '0.10.2')).toBe(false);
    expect(states('version: 10.10.2', '0.10.2')).toBe(false);
    expect(states('version: 0.10.2.1', '0.10.2')).toBe(false);
    expect(states('version: 0x10y2', '0.10.2')).toBe(false);
  });

  it('gives a version to a ticket when its lead or the chief of staff asks, once, and to nobody else', () => {
    const db = tempDb();
    apply(db, (tx) => {
      tx.emit({ kind: 'company_changed', company: companyRow({ chiefOfStaffId: 'neo' }) });
      tx.emit({ kind: 'repo_changed', repo: repo({ contract: { paths: ['docs/contract'] } }) });
      tx.emit({ kind: 'repo_changed', repo: repo({ id: 'plain', path: '/tmp/plain' }) });
      tx.emit({ kind: 'team_changed', team: team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'main', mergeTarget: null }] }) });
      for (const person of [employee({ id: 'lead', name: 'Priya' }), employee()]) tx.emit({ kind: 'employee_changed', employee: person });
      tx.emit({ kind: 'task_changed', task: task({ repoId: 'repo1', state: 'running' }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'part', parentId: 'task1', repoId: 'repo1' }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'other', repoId: 'repo1' }), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'bare', repoId: 'plain' }), cause: 'created' });
    });
    const asLead = run({ id: 'r1', employeeId: 'lead' });
    const first = onContractVersion(db, T0, asLead, { change: 'adds', summary: 'A stories endpoint.' });
    expect(first).toMatchObject({ ok: true, text: expect.stringMatching(/0\.1\.0/) });
    expect(store.getTask(db, 'task1')!.contractVersion).toBe('0.1.0');
    expect(store.contractVersions(db, 'repo1')[0]).toMatchObject({ version: '0.1.0', change: 'adds', summary: 'A stories endpoint.', taskId: 'task1', by: 'lead' });
    // Asked again: the one it has. A ticket holds one version.
    expect(onContractVersion(db, T0, asLead, { change: 'breaking', summary: 'Again.' }).text).toMatch(/already holds 0\.1\.0/);
    expect(onContractVersion(db, T0, asLead, { change: 'wording', summary: 'A typo.', subtask: 'part' }).text).toMatch(/0\.1\.1/);
    expect(store.getTask(db, 'part')!.contractVersion).toBe('0.1.1');
    expect(onContractVersion(db, T0, asLead, { change: 'wording', summary: 'x', subtask: 'other' })).toMatchObject({ ok: false, text: expect.stringMatching(/not a sub-task/) });
    expect(onContractVersion(db, T0, run({ id: 'r2', employeeId: 'emp1' }), { change: 'wording', summary: 'x' })).toMatchObject({ ok: false, text: expect.stringMatching(/lead/) });
    expect(onContractVersion(db, T0, run({ id: 'r3', employeeId: 'lead', taskId: 'bare' }), { change: 'wording', summary: 'x' })).toMatchObject({ ok: false, text: expect.stringMatching(/no contract/) });
    expect(store.contractVersions(db, 'repo1')).toHaveLength(2);
  });
});

const everything = ['read_files', 'run_commands', 'write_code'] as const;
const people = [employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...everything] }), employee({ capabilities: [...everything] }), employee({ id: 'emp2', name: 'Grace', capabilities: [...everything] })];
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Priya leads Ada and Grace in a repository whose contract is `docs/contract`; finished work lands on `team` by itself. */
function ledWorld(play: (scene: Scene) => Promise<void> | void, contractPath = 'docs/contract'): Setup {
  const fixture = inProcess(staged(play));
  const repoPath = gitRepo();
  const w = (open = world(fixture.spawn, { repos: [repo({ path: repoPath, contract: { paths: [contractPath] } })], teams: [team({ leadId: 'lead', repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })], employees: people }));
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
const approve = (s: Scene) => s.engine('submit_review', { verdict: 'approve', notes: '', findings: [] });
const ticket = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Add the stories endpoint', brief: 'Add it.', doneCondition: 'It is described.', capUsd: 2, ...over });

describe('no version, no change to the contract', () => {
  it('sends back a change to the contract made without a version, and lands the work once the change is out', async () => {
    const told: string[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        told.push(s.input.prompt);
        if (s.resumed) fs.rmSync(path.join(s.input.cwd, 'docs'), { recursive: true });
        else s.write('docs/contract/stories.md', 'GET /v1/stories\n');
        s.write('NOTE.md', 'Stories are served.\n');
        await s.engine('report_done', { summary: 'Done.' });
      }
      if (s.mode === 'review') await approve(s);
    }, 'docs/contract/**');
    const made = ticket(setup.w);
    await drain(setup);
    expect(told).toHaveLength(2);
    for (const part of ['changed the contract (docs/contract/stories.md) without a version', 'mcp__engine__contract_version', 'mcp__engine__report_done']) expect(told[1], part).toContain(part);
    expect(store.getTask(setup.w.db, made.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(fileAt(setup.repoPath, 'team', 'docs/contract/stories.md')).toBeNull();
  });

  it('sends back a change whose files do not state the version it was given, and lands it once they do', async () => {
    const told: string[] = [];
    const setup = ledWorld(async (s) => {
      if (s.mode === 'work') {
        told.push(s.input.prompt);
        s.write('docs/contract/stories.md', s.resumed ? 'Version 0.1.0\nGET /v1/stories\n' : 'GET /v1/stories\n');
        await s.engine('report_done', { summary: 'Done.' });
      }
      if (s.mode === 'review') await approve(s);
    });
    const made = ticket(setup.w);
    apply(setup.w.db, (tx) => void issueContractVersion(tx, setup.w.db, T0, { repoId: 'repo1', change: 'adds', summary: 'Stories.', taskId: made.id, by: 'lead' }));
    await drain(setup);
    expect(told[0]).toContain('This ticket changes the contract. Its version is 0.1.0');
    expect(told[1]).toContain('do not state 0.1.0');
    expect(store.getTask(setup.w.db, made.id)).toMatchObject({ state: 'done', mergedInto: 'team', contractVersion: '0.1.0' });
    expect(fileAt(setup.repoPath, 'team', 'docs/contract/stories.md')).toContain('Version 0.1.0');
  });

  it('lets a part change the contract when its lead named that for it, under a version of its own', async () => {
    const told: Record<string, string> = {};
    const setup = ledWorld(async (s) => {
      const integrating = s.mode === 'integrate' || (s.mode === 'work' && s.who === 'Priya');
      if (s.mode === 'brief') {
        const part = { brief: 'Do it.', doneCondition: 'Done.', priority: 2, capUsd: 0.5, retryAllowed: true, gates: [] };
        await s.engine('propose_subtasks', {
          subtasks: [
            { ...part, title: 'The contract', assigneeId: 'emp1', ownership: ['docs/contract'], contract: { change: 'adds', summary: 'A stories endpoint.' } },
            { ...part, title: 'The server', assigneeId: 'emp2', ownership: ['server'] },
          ],
        });
      }
      if (s.mode === 'work' && !integrating) {
        told[s.who] = s.input.prompt;
        if (s.who === 'Ada') s.write('docs/contract/stories.md', 'Version 0.1.0\nGET /v1/stories\n');
        else s.write('server/stories.txt', 'served\n');
        await s.engine('report_done', { summary: 'Done.' });
      }
      if (integrating) await s.engine('report_done', { summary: 'Together.' });
      if (s.mode === 'review') await approve(s);
    });
    const whole = setup.w.sup.createTask({ teamId: 'team1', title: 'Stories', brief: 'Contract and server.', doneCondition: 'Both.', capUsd: 3 });
    await drain(setup);
    const [contract, server] = store.listTasks(setup.w.db, { parentId: whole.id });
    expect(contract).toMatchObject({ title: 'The contract', contractVersion: '0.1.0', state: 'done' });
    expect(server!.contractVersion).toBeUndefined();
    expect(told.Ada).toContain('Its version is 0.1.0');
    expect(told.Grace).not.toContain('This ticket changes the contract');
    expect(store.getTask(setup.w.db, whole.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(store.openDecisions(setup.w.db)).toEqual([]);
  });
});
