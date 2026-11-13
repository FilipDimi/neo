import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { companyNow } from '../../src/supervisor/companyNow.ts';
import { recordDecision } from '../../src/supervisor/record.ts';
import { movedFor, staleLine } from '../../src/supervisor/stale.ts';
import { createFolder } from '../../src/git/folder.ts';
import { carryPaths } from '../../src/git/merge.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, fileAt, gitIn, gitRepo, repo, team, tempDir, world, type World } from '../helpers.ts';

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
    setup.w.clock.advance(60);
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
    setup.w.clock.advance(60);
    await drain(setup);
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === waits.id);
    expect(told.map((message) => message.text)).toEqual(['About "Show cards": the contract is now 0.2.0 (this ticket was made at 0.1.0). 0.2.0 (adds): Stages on cards. It landed on track/rust, and the engine carried it to track/ios. Check whether your work depends on what changed.']);
    // The iOS branch has the contract as it is on the Rust branch, as a commit of the engine's.
    expect(fileAt(setup.repoPath, 'track/ios', 'docs/contract/api.md')).toBe('Version 0.2.0\nGET /v1/stages');
    expect(gitIn(setup.repoPath, 'log', '-1', '--format=%an: %s', 'track/ios')).toBe('Virtual Startup: Contract 0.2.0, from track/rust');
    // Nothing else of the Rust branch came with it.
    expect(gitIn(setup.repoPath, 'diff', '--name-only', 'track/ios~1', 'track/ios')).toBe('docs/contract/api.md');
  });

  it('does not carry the contract to a branch whose contract is not in step: it asks, and overwrites on the word', async () => {
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
    // Nobody is told to copy files: a card asks whether the engine may overwrite what is there.
    const [card] = store.openDecisions(setup.w.db);
    expect(card!.text).toBe('Contract 0.2.0 landed on track/rust, and the engine did not carry it to track/ios: the contract there is not what it was on track/rust before this change, so carrying it would overwrite something nobody has looked at. Overwrite docs/contract on track/ios with what is on track/rust, or leave it?');
    expect(card!.options.map((option) => option.label)).toEqual(['Overwrite it', 'Leave it']);
    setup.w.sup.answer(card!.id, { optionId: 'overwrite' });
    await setup.w.sup.settle();
    expect(fileAt(setup.repoPath, 'track/ios', 'docs/contract/api.md')).toBe('Version 0.2.0\nGET /v1/stages');
    expect(gitIn(setup.repoPath, 'log', '-1', '--format=%an: %s', 'track/ios')).toBe('Virtual Startup: Contract 0.2.0, from track/rust');
    expect(store.openDecisions(setup.w.db)).toEqual([]);
  });
});

describe('what the review of versions and push found', () => {
  const stagesLand = async (s: Scene) => {
    if (titleOf(s) !== 'Stages') return;
    s.write('docs/contract/api.md', 'Version 0.2.0\nGET /v1/stages\n');
    await s.engine('report_done', { summary: 'The contract has stages.' });
  };
  const hold = (w: World, taskId: string) =>
    apply(w.db, (tx) => {
      for (const request of store.requestsOf(w.db, taskId)) tx.emit({ kind: 'request_dropped', requestId: request.id, taskId });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(w.db, taskId)!, state: 'blocked' }, cause: 'state' });
    }, w.clock.now());

  it('takes what has landed for what a ticket is built on, not a version that was only handed out', async () => {
    const setup = twoTeams(stagesLand);
    const stages = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Stages', brief: 'x', doneCondition: 'y' });
    // The version is handed out before the other ticket is made, and lands after it.
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'contract_version_issued', issued: { id: 'cv1', repoId: 'repo1', version: '0.2.0', change: 'adds', summary: 'Stages on cards.', taskId: stages.id, decisions: [], by: 'rlead', at: setup.w.clock.now().toISOString() } });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, stages.id)!, contractVersion: '0.2.0' }, cause: 'edited' });
    }, setup.w.clock.now());
    const built = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y' });
    expect(built.builtOn).toEqual({ decisions: [], contract: '0.1.0' });
    hold(setup.w, built.id);
    setup.w.clock.advance(60);
    await drain(setup);
    expect(store.getTask(setup.w.db, stages.id)).toMatchObject({ state: 'done', mergedInto: 'track/rust' });
    expect(movedFor(setup.w.db, store.getTask(setup.w.db, built.id)!).contract).toMatchObject({ from: '0.1.0', to: '0.2.0' });
    expect(store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === built.id)).toHaveLength(1);
  });

  it('moves nothing when the ticket that held a version landed without changing the contract', async () => {
    const setup = twoTeams(async (s) => {
      if (titleOf(s) !== 'Stages') return;
      await s.engine('contract_version', { change: 'adds', summary: 'Stages on cards.' });
      s.write('rust.md', 'no contract change after all\n');
      await s.engine('report_done', { summary: 'Nothing in the contract had to change.' });
    });
    const built = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y' });
    hold(setup.w, built.id);
    setup.w.clock.advance(60);
    const stages = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Stages', brief: 'x', doneCondition: 'y' });
    await drain(setup);
    expect(store.getTask(setup.w.db, stages.id)).toMatchObject({ state: 'done', mergedInto: 'track/rust' });
    expect(movedFor(setup.w.db, store.getTask(setup.w.db, built.id)!).contract).toBeNull();
    expect(store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === built.id)).toEqual([]);
    expect(gitIn(setup.repoPath, 'log', '-1', '--format=%s', 'track/ios')).toBe('first');
  });

  it('takes a report only once its author has been shown everything that moved, and brings up to date only that', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    let setup: Setup;
    setup = twoTeams(async (s) => {
      const [a, b] = store.allRecord(setup.w.db);
      decide(setup.w, 'A, as it now is.', a!.id);
      s.write('ios/Cards.swift', 'struct Cards {}\n');
      replies.push(await s.engine('report_done', { summary: 'Cards.', checks: [{ file: 'ios/Cards.swift' }] }));
      // Before it reports again, the other decision it is built on moves too.
      decide(setup.w, 'B, as it now is.', b!.id);
      replies.push(await s.engine('report_done', { summary: 'Cards, checked against A.', checks: [{ file: 'ios/Cards.swift' }] }));
      replies.push(await s.engine('report_done', { summary: 'Cards, checked against A and B.', checks: [{ file: 'ios/Cards.swift' }] }));
    });
    const a = decide(setup.w, 'A.');
    const b = decide(setup.w, 'B.');
    const made = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Show cards', brief: 'x', doneCondition: 'y', decisions: [a, b] });
    await drain(setup);
    expect(replies.map((reply) => reply.ok)).toEqual([false, false, true]);
    expect(replies[0]!.text).toContain(`${a}, which this ticket is built on, was replaced by`);
    expect(replies[0]!.text).not.toContain(`${b}, which`);
    expect(replies[0]!.text).toMatch(/report again in full/);
    expect(replies[1]!.text).toContain(`${b}, which this ticket is built on, was replaced by`);
    expect(store.getTask(setup.w.db, made.id)!.builtOn!.decisions).toEqual(['D-3', 'D-4']);
  });

  it('follows a line of replacements, and does not call stale a ticket that cites the one that stands', () => {
    const setup = twoTeams(() => {});
    const one = decide(setup.w, 'One.');
    const old = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Old', brief: 'x', doneCondition: 'y', decisions: [one] });
    const two = decide(setup.w, 'Two.', one);
    const both = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Both', brief: 'x', doneCondition: 'y', decisions: [one, two] });
    expect(staleLine(movedFor(setup.w.db, both))).toBeNull();
    const three = decide(setup.w, 'Three.', two);
    // The ticket that cites only the first is told of the third, which now stands where the first did.
    const told = store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === old.id).map((message) => message.text);
    expect(told.at(-1)).toContain(`${one}, which this ticket is built on, was replaced by ${three}: Three.`);
    expect(staleLine(movedFor(setup.w.db, store.getTask(setup.w.db, both.id)!))).toBe(`built on ${two}, replaced by ${three}`);
  });

  it('gives a ticket\'s message to that ticket\'s session, not to whatever its reader is running', async () => {
    const turns: Record<string, string[]> = {};
    let setup: Setup;
    setup = twoTeams(
      async (s) => {
        const title = titleOf(s) === '?' ? 'later' : titleOf(s);
        (turns[title] ??= []).push(s.text);
        if (title === 'Busy' && s.index === 0) {
          // While the lead works on one ticket, a decision another of its tickets is built on is replaced.
          decide(setup.w, 'Cards have stages.', store.allRecord(setup.w.db)[0]!.id);
          await new Promise((resolve) => setTimeout(resolve, 60));
          s.write('busy.md', 'x\n');
          return void (await s.engine('report_done', { summary: 'Busy is done.' }));
        }
        if (title === 'Built on it' && s.index === 0) {
          s.write('built.md', 'x\n');
          await s.engine('report_done', { summary: 'Checked against the decision that stands.' });
          await s.engine('report_done', { summary: 'Checked against the decision that stands, in full.' });
        }
      },
      { everyTurn: true },
    );
    const first = decide(setup.w, 'Cards have no stages.');
    const built = setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Built on it', brief: 'x', doneCondition: 'y', decisions: [first] });
    hold(setup.w, built.id);
    setup.w.sup.createTask({ teamId: 'ios', assigneeId: 'ilead', title: 'Busy', brief: 'x', doneCondition: 'y' });
    await drain(setup);
    // Nothing about the other ticket was said into the session that was running.
    expect((turns.Busy ?? []).join('\n')).not.toContain('was replaced by');
    expect(store.recentMessages(setup.w.db, 20).filter((message) => message.taskId === built.id)).toMatchObject([{ state: 'waiting' }]);
    // Its own run finds it at its start.
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, built.id)!, state: 'queued' }, cause: 'state' });
      tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: built.id, mode: 'work', employeeId: 'ilead', reason: 'new' }, setup.w.clock.now()) });
    }, setup.w.clock.now());
    await drain(setup);
    expect(turns['Built on it']![0]).toContain('was replaced by');
  });

  it('does not carry a contract folder over a file that stands where the folder would go', async () => {
    const repoPath = gitRepo(['a', 'b'], { 'README.md': 'x\n' });
    const dir = path.join(tempDir('vs-carry-'), 'clone');
    await createFolder({ repoPath, dir, branch: 'work', startPoint: 'a' });
    const was = gitIn(dir, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(dir, 'docs/contract'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/contract/api.md'), 'Version 0.1.0\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'contract');
    // On the other branch a file called docs stands where the folder would go.
    const other = `${repoPath}-b`;
    gitIn(repoPath, 'worktree', 'add', '-q', other, 'b');
    fs.writeFileSync(path.join(other, 'docs'), 'a file, not a folder\n');
    gitIn(other, 'add', '-A');
    gitIn(other, 'commit', '-q', '-m', 'docs is a file here');
    gitIn(repoPath, 'worktree', 'remove', '--force', other);
    const result = await carryPaths({ repoPath, dir, from: gitIn(dir, 'rev-parse', 'HEAD'), was, branch: 'b', paths: ['docs/contract'], message: 'Contract', engine: { name: 'Engine', email: 'engine@example.invalid' } });
    expect(result).toBe('not_in_step');
    expect(fileAt(repoPath, 'b', 'docs')).toBe('a file, not a folder');
  });

  it('does not count a stopped part in how far a split has come', () => {
    const setup = twoTeams(() => {});
    const parent = setup.w.sup.createTask({ teamId: 'rust', assigneeId: 'rlead', title: 'Whole', brief: 'x', doneCondition: 'y' });
    const at = setup.w.clock.now();
    apply(setup.w.db, (tx) => {
      for (const [title, state] of [['One', 'done'], ['Two', 'failed'], ['Three', 'running']] as const) tx.emit({ kind: 'task_changed', task: store.newTask({ teamId: 'rust', parentId: parent.id, assigneeId: 'rlead', title, brief: 'x', createdBy: 'rlead', state }, at), cause: 'created' });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, parent.id)!, state: 'running' }, cause: 'state' });
    }, at);
    expect(companyNow(setup.w.db, at)).toMatch(/- "Whole" \(running\): .*; 1 of 2 parts done \(1 stopped\)/);
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
