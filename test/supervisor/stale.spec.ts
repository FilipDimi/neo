import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { companyNow } from '../../src/supervisor/companyNow.ts';
import { recordDecision } from '../../src/supervisor/record.ts';
import { movedFor, staleLine } from '../../src/supervisor/stale.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitIn, gitRepo, repo, team, world, type World } from '../helpers.ts';

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
];
type Setup = { w: World; fixture: InProcess; repoPath: string };

/** Rust and iOS each land on a branch of their own in one repository whose contract is docs/contract. Each team is its lead alone, who does the work itself. */
function twoTeams(play: (scene: Scene) => Promise<void> | void, over: { everyTurn?: boolean } = {}): Setup {
  const fixture = inProcess(staged(play, over));
  const repoPath = gitRepo(['track/rust', 'track/ios'], { 'README.md': 'hello\n', 'docs/contract/api.md': 'Version 0.1.0\n' });
  const at = (branch: string) => [{ repoId: 'repo1', baseBranch: branch, mergeTarget: branch }];
  const w = (open = world(fixture.spawn, {
    company: { chiefOfStaffId: 'neo' },
    repos: [repo({ path: repoPath, contract: { paths: ['docs/contract'] } })],
    teams: [team({ id: 'office', name: 'Office', leadId: 'neo' }), team({ id: 'rust', name: 'Rust', leadId: 'rlead', repos: at('track/rust') }), team({ id: 'ios', name: 'iOS', leadId: 'ilead', repos: at('track/ios') })],
    employees: people,
  }));
  // The contract's count begins at what the files say.
  apply(w.db, (tx) => tx.emit({ kind: 'contract_version_issued', issued: { id: 'cv0', repoId: 'repo1', version: '0.1.0', change: 'start', summary: '', taskId: null, decisions: [], by: null, at: w.clock.now().toISOString() } }), w.clock.now());
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
const decide = (w: World, statement: string, replaces?: string) => {
  let id = '';
  apply(w.db, (tx) => void (id = recordDecision(tx, w.db, w.clock.now(), { statement, why: 'Because.', by: { kind: 'chief', employeeId: 'neo' }, repoId: 'repo1', ...(replaces ? { replaces } : {}) }).id), w.clock.now());
  return id;
};
const titleOf = (s: Scene): string => /# Task: (.+)/.exec(s.input.prompt)?.[1] ?? '?';

describe('stale is computed', () => {
  it('knows a ticket built on a decision that was replaced, and on a contract that has since landed a newer version', async () => {
    const setup = twoTeams(async (s) => {
      // The Rust ticket changes the contract under its version and lands.
      if (titleOf(s) !== 'Stages') return;
      await s.engine('contract_version', { change: 'adds', summary: 'Stages on cards.' });
      s.write('docs/contract/api.md', 'Version 0.2.0\nGET /v1/stages\n');
      await s.engine('report_done', { summary: 'The contract has stages.' });
    });
    const first = decide(setup.w, 'Cards have no stages.');
    const built = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y', decisions: [first], after: [] });
    expect(store.getTask(setup.w.db, built.id)!.builtOn).toEqual({ decisions: [first], contract: '0.1.0' });
    expect(movedFor(setup.w.db, built)).toEqual({ decisions: [], contract: null });
    expect(staleLine(movedFor(setup.w.db, built))).toBeNull();

    const second = decide(setup.w, 'Cards have stages.', first);
    expect(movedFor(setup.w.db, built).decisions).toEqual([{ id: first, replacedBy: second, statement: 'Cards have stages.' }]);

    // A version that was handed out but has not landed moves nothing yet.
    apply(setup.w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, built.id)!, state: 'blocked' }, cause: 'state' }), setup.w.clock.now());
    const changes = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Stages', brief: 'x', doneCondition: 'y' });
    expect(movedFor(setup.w.db, built).contract).toBeNull();
    await drain(setup);
    expect(store.getTask(setup.w.db, changes.id)).toMatchObject({ state: 'done', mergedInto: 'track/rust', contractVersion: '0.2.0' });
    expect(movedFor(setup.w.db, built).contract).toEqual({ from: '0.1.0', to: '0.2.0', changes: ['0.2.0 (adds): Stages on cards.'] });
    expect(staleLine(movedFor(setup.w.db, built))).toBe(`built on ${first}, replaced by ${second}; built on contract 0.1.0, now 0.2.0`);
    expect(companyNow(setup.w.db, setup.w.clock.now())).toContain(`built on ${first}, replaced by ${second}; built on contract 0.1.0, now 0.2.0`);
    // The ticket that made the change is not stale for it.
    expect(staleLine(movedFor(setup.w.db, store.getTask(setup.w.db, changes.id)!))).toBeNull();
  });
});

describe('whoever depends on a change is told when it happens', () => {
  it('tells a running ticket, as its next turn, that a decision it is built on was replaced; and one that is not running at its next start', async () => {
    const turns: Record<string, string[]> = {};
    let replaced = '';
    let setup: Setup;
    setup = twoTeams(
      async (s) => {
        const who = s.who;
        (turns[who] ??= []).push(s.text);
        if (who === 'iOS lead' && s.index === 0) {
          // While it works, the decision it is built on is replaced.
          replaced = decide(setup.w, 'Cards have stages.', store.allRecord(setup.w.db)[0]!.id);
          // It goes on working for a moment, as a session does: the message arrives while it still runs.
          await new Promise((resolve) => setTimeout(resolve, 60));
          return;
        }
        if (who === 'iOS lead' && s.index === 1) {
          s.write('ios/Cards.swift', 'struct Cards {}\n');
          return void (await s.engine('report_done', { summary: 'Cards, with stages as now decided.' }));
        }
        if (who === 'Rust lead') {
          s.write('rust.md', 'x\n');
          await s.engine('report_done', { summary: 'Done.' });
        }
      },
      { everyTurn: true },
    );
    const first = decide(setup.w, 'Cards have no stages.');
    setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y', decisions: [first] });
    // A second ticket on the same decision, whose owner is busy elsewhere and has not started it.
    const waiting = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Serve cards', brief: 'x', doneCondition: 'y', decisions: [first] });
    apply(setup.w.db, (tx) => {
      for (const request of store.requestsOf(setup.w.db, waiting.id)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: waiting.id });
    }, setup.w.clock.now());
    await drain(setup);
    expect(turns['iOS lead']![1]).toMatch(new RegExp(`About "Show cards": ${first}, which this ticket is built on, was replaced by ${replaced}: Cards have stages\\.`));
    // The one that was not running has it waiting, and reads it when it starts.
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === waiting.id);
    expect(told).toMatchObject([{ fromId: 'neo', toId: 'rlead', state: 'waiting' }]);
    apply(setup.w.db, (tx) => tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: waiting.id, mode: 'work', employeeId: 'rlead', reason: 'new' }, setup.w.clock.now()) }), setup.w.clock.now());
    await drain(setup);
    expect(turns['Rust lead']![0]).toContain(`was replaced by ${replaced}`);
  });

  it('holds a report on a stale ticket once, with what moved, then takes it and brings the ticket up to date', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    let setup: Setup;
    let second = '';
    setup = twoTeams(async (s) => {
      second = decide(setup.w, 'Cards have stages.', store.allRecord(setup.w.db)[0]!.id);
      s.write('ios/Cards.swift', 'struct Cards {}\n');
      replies.push(await s.engine('report_done', { summary: 'Cards.' }));
      replies.push(await s.engine('report_done', { summary: 'Cards, checked against the new decision: stages are shown.' }));
    });
    const first = decide(setup.w, 'Cards have no stages.');
    const made = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y', decisions: [first] });
    await drain(setup);
    expect(replies[0]).toMatchObject({ ok: false, text: expect.stringMatching(new RegExp(`${first}, which this ticket is built on, was replaced by ${second}: Cards have stages\\..*Check your work against it.*report again`, 's')) });
    expect(replies[1]!.ok).toBe(true);
    expect(store.getTask(setup.w.db, made.id)).toMatchObject({ state: 'done', builtOn: { decisions: [second], contract: '0.1.0' } });
  });

  it('tells the tickets of the repository built on an older contract when a newer one lands, and carries the contract to the other team\'s branch', async () => {
    const setup = twoTeams(async (s) => {
      if (titleOf(s) !== 'Stages') return;
      await s.engine('contract_version', { change: 'adds', summary: 'Stages on cards.' });
      s.write('docs/contract/api.md', 'Version 0.2.0\nGET /v1/stages\n');
      await s.engine('report_done', { summary: 'The contract has stages.' });
    });
    const waits = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y' });
    apply(setup.w.db, (tx) => {
      for (const request of store.requestsOf(setup.w.db, waits.id)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId: waits.id });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, waits.id)!, state: 'blocked' }, cause: 'state' });
    }, setup.w.clock.now());
    setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Stages', brief: 'x', doneCondition: 'y' });
    await drain(setup);
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === waits.id);
    expect(told.map((message) => message.text)).toEqual(['About "Show cards": the contract is now 0.2.0 (this ticket was made at 0.1.0). 0.2.0 (adds): Stages on cards. It landed on track/rust, and the engine carried it to track/ios. Check whether your work depends on what changed.']);
    // The iOS branch has the contract as it is on the Rust branch, as a commit of the engine's.
    expect(fileAt(setup.repoPath, 'track/ios', 'docs/contract/api.md')).toBe('Version 0.2.0\nGET /v1/stages');
    expect(gitIn(setup.repoPath, 'log', '-1', '--format=%an: %s', 'track/ios')).toBe('Virtual Startup: Contract 0.2.0, from track/rust');
    // Nothing else of the Rust branch came with it.
    expect(gitIn(setup.repoPath, 'diff', '--name-only', 'track/ios~1', 'track/ios')).toBe('docs/contract/api.md');
  });

  it('does not carry the contract to a branch whose contract is not in step, and tells that team instead', async () => {
    const setup = twoTeams(async (s) => {
      if (titleOf(s) !== 'Stages') return;
      await s.engine('contract_version', { change: 'adds', summary: 'Stages on cards.' });
      s.write('docs/contract/api.md', 'Version 0.2.0\nGET /v1/stages\n');
      await s.engine('report_done', { summary: 'The contract has stages.' });
    });
    // Someone changed the contract on the iOS branch by hand: it is not what the Rust branch had.
    const other = `${setup.repoPath}-ios`;
    gitIn(setup.repoPath, 'worktree', 'add', '-q', other, 'track/ios');
    fs.writeFileSync(`${other}/docs/contract/api.md`, 'Version 0.1.0\nedited by hand on iOS\n');
    gitIn(other, 'commit', '-q', '-am', 'hand edit');
    gitIn(setup.repoPath, 'worktree', 'remove', '--force', other);
    setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Stages', brief: 'x', doneCondition: 'y' });
    await drain(setup);
    expect(fileAt(setup.repoPath, 'track/ios', 'docs/contract/api.md')).toBe('Version 0.1.0\nedited by hand on iOS');
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.toId === 'ilead');
    expect(told.map((message) => message.text)).toEqual(['Contract 0.2.0 landed on track/rust, and the engine could not carry it to track/ios: the contract there is not what it was on track/rust before this change. Bring docs/contract over from track/rust as work of your team.']);
  });
});

describe('progress is computed', () => {
  it('says how far a split has come', async () => {
    const setup = twoTeams(() => {});
    const parent = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Whole', brief: 'x', doneCondition: 'y' });
    const at = setup.w.clock.now();
    apply(setup.w.db, (tx) => {
      const part = (title: string, state: 'done' | 'running' | 'queued', more: object = {}) => {
        const child = store.newTask({ teamId: 'rust', parentId: parent.id, assigneeId: 'rlead', title, brief: 'x', createdBy: 'rlead', state, ...more }, at);
        tx.emit({ kind: 'task_changed', task: child, cause: 'created' });
        return child;
      };
      const one = part('One', 'done');
      part('Two', 'running');
      part('Three', 'queued', { after: [one.id, 'gone'] });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, parent.id)!, state: 'running' }, cause: 'state' });
    }, at);
    expect(companyNow(setup.w.db, at)).toMatch(/- "Whole" \(running\): .*; 1 of 3 parts done/);
  });
});
