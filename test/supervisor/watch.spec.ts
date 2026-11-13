import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, readEvents } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { GateQueue } from '../../src/git/gates.ts';
import type { Gate } from '../../src/shared/types.ts';
import { companyNow } from '../../src/supervisor/companyNow.ts';
import { called, looked, newWatch, refusal, refused, resulted, undelivered } from '../../src/supervisor/progress.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, gitRepo, repo, team, tempDir, world, type World } from '../helpers.ts';

// Real git and real gates.
vi.setConfig({ testTimeout: 30_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

// Each gate writes a line into a file the repository ignores, so a test can count how often it really ran.
const GATES: Gate[] = [
  { name: 'greeting', command: 'echo ran >> runs.log; test -f GREETING.md', timeoutMinutes: 1, lock: null },
  { name: 'never', command: 'echo ran >> never.log; false', timeoutMinutes: 1, lock: null },
  // Marked as depending on nothing but the files: only such a gate's pass is taken over at the commit.
  { name: 'pure', command: 'echo ran >> pure.log; test -f GREETING.md', timeoutMinutes: 1, lock: null, byFiles: true },
  { name: 'slow', command: 'sleep 0.4', timeoutMinutes: 1, lock: null },
  { name: 'slower', command: 'sleep 0.8', timeoutMinutes: 1, lock: null },
];
const ran = (folder: string, log = 'runs.log'): number => (fs.existsSync(path.join(folder, log)) ? fs.readFileSync(path.join(folder, log), 'utf8').trim().split('\n').length : 0);
type Setup = { w: World; fixture: InProcess; repoPath: string };

function oneWorker(play: (scene: Scene) => Promise<void> | void, over: { everyTurn?: boolean } = {}): Setup {
  const fixture = inProcess(staged(play, over));
  const repoPath = gitRepo(['team'], { 'README.md': 'hello\n', '.gitignore': '*.log\n' });
  const w = (open = world(fixture.spawn, {
    repos: [repo({ path: repoPath, gates: GATES })],
    teams: [team({ selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })],
    employees: [employee({ capabilities: ['read_files', 'run_commands', 'write_code'] })],
  }));
  return { w, fixture, repoPath };
}
async function drain({ w, fixture }: Setup, max = 40): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < max && quiet < 2; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    quiet = store.liveRuns(w.db).length === 0 && store.openRequests(w.db).length === 0 ? quiet + 1 : 0;
  }
}
const task = (setup: Setup, gates: string[] = []) => setup.w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Greet', brief: 'Write the greeting.', doneCondition: 'It greets.', gates });

describe('a gate is not run twice on the same files', () => {
  it('lets a pass stand: asked again with nothing changed, the gate is not run', async () => {
    const seen: { ok: boolean; text: string }[] = [];
    let folder = '';
    const setup = oneWorker(async (s) => {
      folder = s.cwd;
      s.write('GREETING.md', 'hello\n');
      seen.push(await s.engine('run_gate', { name: 'greeting' }));
      seen.push(await s.engine('run_gate', { name: 'greeting' }));
      seen.push({ ok: true, text: String(ran(folder)) });
      // A change, and it is run again.
      s.write('GREETING.md', 'hello there\n');
      seen.push(await s.engine('run_gate', { name: 'greeting' }));
      seen.push({ ok: true, text: String(ran(folder)) });
      await s.engine('report_done', { summary: 'Greets.' });
    });
    task(setup);
    await drain(setup);
    expect(seen[0]).toMatchObject({ ok: true, text: expect.stringContaining('passed (exit 0)') });
    expect(seen[1]).toMatchObject({ ok: true, text: expect.stringMatching(/greeting: passed .* on exactly these files\. Not run again: its result stands\./) });
    expect(seen[2]!.text).toBe('1');
    expect(seen[3]!.text).toContain('passed (exit 0)');
    expect(seen[4]!.text).toBe('2');
  });

  it('runs a failed gate once more on the same files, then refuses; and refuses a gate that failed five times in one run', async () => {
    const seen: { ok: boolean; text: string }[] = [];
    let folder = '';
    const setup = oneWorker(async (s) => {
      folder = s.cwd;
      for (let i = 0; i < 3; i++) seen.push(await s.engine('run_gate', { name: 'never' }));
      seen.push({ ok: true, text: String(ran(folder, 'never.log')) });
      // Something changes each time: it is run again, until it has failed five times in this run.
      for (let i = 0; i < 4; i++) {
        s.write('notes.md', `try ${i}\n`);
        seen.push(await s.engine('run_gate', { name: 'never' }));
      }
      seen.push({ ok: true, text: String(ran(folder, 'never.log')) });
      await s.engine('report_done', { summary: 'It cannot pass.' });
    });
    task(setup);
    await drain(setup);
    expect(seen[0]!.text).toContain('FAILED (exit 1)');
    expect(seen[1]!.text).toContain('FAILED (exit 1)');
    expect(seen[2]).toMatchObject({ ok: false, text: expect.stringMatching(/"never" has failed twice on exactly these files.*nothing has run since that could change it.*Change something, or call mcp__engine__report_done and say what fails/s) });
    expect(seen[3]!.text).toBe('2');
    // Three more real runs (five failures in all), then no more whatever changes.
    expect(seen.slice(4, 7).every((reply) => reply.text.includes('FAILED (exit 1)'))).toBe(true);
    expect(seen[7]).toMatchObject({ ok: false, text: expect.stringMatching(/"never" has failed 5 times in this run/) });
    expect(seen[8]!.text).toBe('5');
  });

  it('runs a failed gate a third time on the same files only if a command went through since, and never a fourth', async () => {
    const seen: { ok: boolean; text: string }[] = [];
    let folder = '';
    const setup = oneWorker(async (s) => {
      folder = s.cwd;
      seen.push(await s.engine('run_gate', { name: 'never' }));
      seen.push(await s.engine('run_gate', { name: 'never' }));
      // Something ran that the files do not show (an install, say): the gate may go differently now.
      await s.tool('Bash', { command: 'npm install --offline' });
      seen.push(await s.engine('run_gate', { name: 'never' }));
      await s.tool('Bash', { command: 'npm install --offline' });
      seen.push(await s.engine('run_gate', { name: 'never' }));
      seen.push({ ok: true, text: String(ran(folder, 'never.log')) });
      await s.engine('report_done', { summary: 'It cannot pass.' });
    });
    task(setup);
    await drain(setup);
    expect(seen.slice(0, 3).every((reply) => reply.text.includes('FAILED (exit 1)'))).toBe(true);
    expect(seen[3]).toMatchObject({ ok: false, text: expect.stringMatching(/"never" has failed 3 times on exactly these files.*If it needs something outside your files/s) });
    expect(seen[4]!.text).toBe('3');
  });

  it('runs every gate at the commit, whatever the run passed before, unless the gate is marked as depending on the files alone', async () => {
    let folder = '';
    const setup = oneWorker(async (s) => {
      folder = s.cwd;
      s.write('GREETING.md', 'hello\n');
      await s.engine('run_gate', { name: 'greeting' });
      await s.engine('report_done', { summary: 'Greets.' });
    });
    const made = task(setup, ['greeting']);
    await drain(setup);
    const [run] = store.runsOf(setup.w.db, made.id);
    expect(run!.gateResults).toHaveLength(1);
    expect(run!.gateResults[0]!.reused).toBeUndefined();
    expect(readEvents(setup.w.db, 0, 10_000).filter((row) => row.event.kind === 'gate_started').length).toBe(1);
    expect(folder).not.toBe('');
  });

  it('runs a marked gate at the commit all the same when its command was changed since the pass', async () => {
    let setup: Setup;
    setup = oneWorker(async (s) => {
      s.write('GREETING.md', 'hello\n');
      await s.engine('run_gate', { name: 'pure' });
      const before = store.getRepo(setup.w.db, 'repo1')!;
      apply(setup.w.db, (tx) => tx.emit({ kind: 'repo_changed', repo: { ...before, gates: before.gates.map((gate) => (gate.name === 'pure' ? { ...gate, command: 'echo ran >> pure.log; test -f GREETING.md && true' } : gate)) } }), setup.w.clock.now());
      await s.engine('report_done', { summary: 'Greets.' });
    });
    const made = task(setup, ['pure']);
    await drain(setup);
    const [run] = store.runsOf(setup.w.db, made.id);
    expect(run!.gateResults).toHaveLength(1);
    expect(run!.gateResults[0]!.reused).toBeUndefined();
  });

  it('does not run a gate again at the commit when the run passed it on exactly the committed files', async () => {
    let folder = '';
    const setup = oneWorker(async (s) => {
      folder = s.cwd;
      s.write('GREETING.md', 'hello\n');
      await s.engine('run_gate', { name: 'pure' });
      await s.engine('report_done', { summary: 'Greets.', checks: [{ gate: 'pure' }] });
    });
    const made = task(setup, ['pure']);
    await drain(setup);
    expect(store.getTask(setup.w.db, made.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    const [run] = store.runsOf(setup.w.db, made.id);
    // One real run, the one the employee asked for. The engine's own result is that one, said to be so.
    expect(run!.gateResults).toMatchObject([{ name: 'pure', exitCode: 0, reused: true }]);
    expect(run!.gateResults[0]!.tree).toBe(run!.askedGates![0]!.tree);
    expect(readEvents(setup.w.db, 0, 10_000).filter((row) => row.event.kind === 'gate_started').length).toBe(0);
    expect(folder).not.toBe('');
  });

  it('runs it at the commit when the files changed after the pass', async () => {
    const setup = oneWorker(async (s) => {
      s.write('GREETING.md', 'hello\n');
      await s.engine('run_gate', { name: 'greeting' });
      s.write('GREETING.md', 'hello, changed after the gate\n');
      await s.engine('report_done', { summary: 'Greets.' });
    });
    const made = task(setup, ['greeting']);
    await drain(setup);
    const [run] = store.runsOf(setup.w.db, made.id);
    expect(run!.gateResults).toHaveLength(1);
    expect(run!.gateResults[0]!.reused).toBeUndefined();
    expect(run!.gateResults[0]!.tree).not.toBe(run!.askedGates![0]!.tree);
    expect(readEvents(setup.w.db, 0, 10_000).filter((row) => row.event.kind === 'gate_started').length).toBe(1);
  });
});

describe('waiting is a state', () => {
  it('tells a gate that waits behind a lock who holds it', async () => {
    const queue = new GateQueue();
    const dir = tempDir('vs-gates-');
    const slow: Gate = { name: 'slow', command: 'sleep 0.3', timeoutMinutes: 1, lock: 'sim' };
    const quick: Gate = { name: 'quick', command: 'true', timeoutMinutes: 1, lock: 'sim' };
    const queued: (string | null)[] = [];
    const order: string[] = [];
    const first = queue.run([slow], dir, { label: 'The first task', onQueued: () => queued.push('first waited'), onStart: () => order.push('slow') });
    const second = queue.run([quick], dir, { label: 'The second task', onQueued: (_gate, heldBy) => queued.push(heldBy), onStart: () => order.push('quick') });
    await Promise.all([first, second]);
    expect(queued).toEqual(['The first task']);
    expect(order).toEqual(['slow', 'quick']);
    // Free again: the next one does not wait.
    await queue.run([quick], dir, { onQueued: () => queued.push('third waited') });
    expect(queued).toEqual(['The first task']);
  });

  it('tells everyone in line who holds the lock now, as it changes hands', async () => {
    const queue = new GateQueue();
    const dir = tempDir('vs-gates-');
    const gate = (name: string): Gate => ({ name, command: 'sleep 0.2', timeoutMinutes: 1, lock: 'sim' });
    const told: Record<string, (string | null)[]> = { second: [], third: [], again: [] };
    const first = queue.run([gate('a'), gate('a2')], dir, { label: 'First', onQueued: (g, heldBy) => (g.name === 'a2' ? told.again!.push(heldBy) : undefined) });
    const second = queue.run([gate('b')], dir, { label: 'Second', onQueued: (_g, heldBy) => told.second!.push(heldBy) });
    const third = queue.run([gate('c')], dir, { label: 'Third', onQueued: (_g, heldBy) => told.third!.push(heldBy) });
    await Promise.all([first, second, third]);
    expect(told.second).toEqual(['First']);
    // The third waits behind the first, then behind the second: it is told of each.
    expect(told.third!.slice(0, 2)).toEqual(['First', 'Second']);
    // The first task's second gate waits behind the others, never behind itself.
    expect(told.again!.length).toBeGreaterThan(0);
    expect(told.again).not.toContain('First');
  });

  it('keeps saying a run waits while one of two gates it asked for at once is still running', async () => {
    const setup = oneWorker(async (s) => {
      await Promise.all([s.engine('run_gate', { name: 'slow' }), s.engine('run_gate', { name: 'slower' })]);
      s.write('GREETING.md', 'hello\n');
      await s.engine('report_done', { summary: 'Greets.' });
    });
    const made = task(setup);
    await drain(setup);
    const [run] = store.runsOf(setup.w.db, made.id);
    const rows = readEvents(setup.w.db, 0, 10_000).filter((row) => (row.event.kind === 'run_waiting' || row.event.kind === 'gate_finished') && row.event.runId === run!.id);
    const cleared = rows.findIndex((row) => row.event.kind === 'run_waiting' && row.event.waiting === null);
    const lastGate = rows.findLastIndex((row) => row.event.kind === 'gate_finished');
    expect(cleared).toBeGreaterThan(lastGate);
  });

  it('says what the engine is doing for a task whose run has ended, where it said nobody was on it', async () => {
    const setup = oneWorker(async (s) => {
      s.write('GREETING.md', 'hello\n');
      await s.engine('report_done', { summary: 'Greets.' });
    });
    const made = task(setup, ['greeting']);
    await drain(setup);
    // The engine ran the gate after the report, and said so on the run while it did.
    const [run] = store.runsOf(setup.w.db, made.id);
    const waits = readEvents(setup.w.db, 0, 10_000).flatMap((row) => (row.event.kind === 'run_waiting' && row.event.runId === run!.id ? [row.event.waiting] : []));
    expect(waits).toMatchObject([{ on: 'gate', what: 'greeting' }, null]);
    expect(run!.waiting).toBeUndefined();

    // As the board says it while it lasts.
    const other = setup.w.sup.createTask({ teamId: 'team1', title: 'Another', brief: 'x', doneCondition: 'y', assigneeId: 'emp1' });
    const at = setup.w.clock.now();
    apply(setup.w.db, (tx) => {
      const live = store.newRun(store.openRequests(setup.w.db).find((request) => request.taskId === other.id)!, at, 15);
      tx.emit({ kind: 'run_started', run: live, requestId: null, teamId: 'team1' });
      tx.emit({ kind: 'run_ended', run: { ...live, outcome: 'done', endedAt: at.toISOString() }, teamId: 'team1' });
      tx.emit({ kind: 'task_changed', task: { ...store.getTask(setup.w.db, other.id)!, state: 'running' }, cause: 'state' });
      tx.emit({ kind: 'run_waiting', runId: live.id, taskId: other.id, waiting: { on: 'lock', what: 'the xcode lock, held by "Build the footer"', since: at.toISOString() } });
    }, at);
    setup.w.clock.advance(12 * 60);
    expect(companyNow(setup.w.db, setup.w.clock.now())).toContain('- "Another" (running): the engine is waiting for the xcode lock, held by "Build the footer", to run its gates, for 12 min');
    apply(setup.w.db, (tx) => tx.emit({ kind: 'run_waiting', runId: store.runsOf(setup.w.db, other.id)[0]!.id, taskId: other.id, waiting: { on: 'gate', what: 'ios-full', since: setup.w.clock.now().toISOString() } }), setup.w.clock.now());
    setup.w.clock.advance(3 * 60);
    expect(companyNow(setup.w.db, setup.w.clock.now())).toContain('- "Another" (running): the engine is running its gate "ios-full", for 3 min');

    // And for a run that is live: waiting is said apart from working, with how long.
    const third = setup.w.sup.createTask({ teamId: 'team1', title: 'Third', brief: 'x', doneCondition: 'y', assigneeId: 'emp1' });
    const since = setup.w.clock.now();
    apply(setup.w.db, (tx) => {
      const live = store.newRun(store.openRequests(setup.w.db).find((request) => request.taskId === third.id)!, since, 15);
      tx.emit({ kind: 'run_started', run: live, requestId: null, teamId: 'team1' });
      tx.emit({ kind: 'run_waiting', runId: live.id, taskId: third.id, waiting: { on: 'lock', what: 'the xcode lock, held by "Another"', since: since.toISOString() } });
    }, since);
    setup.w.clock.advance(7 * 60);
    expect(companyNow(setup.w.db, setup.w.clock.now())).toMatch(/- "Third" \(\w+\): Ada is working on it, and has been waiting for the xcode lock, held by "Another" for 7 min/);
  });
});

describe('a budget of calls without progress', () => {
  const few = { options: { progress: { askAfter: 6, stopAfter: 9, lookEvery: 3 } } };
  function watched(play: (scene: Scene) => Promise<void> | void): Setup {
    const fixture = inProcess(staged(play, { everyTurn: true }));
    const repoPath = gitRepo(['team'], { 'README.md': 'hello\n', '.gitignore': '*.log\n' });
    const w = (open = world(fixture.spawn, {
      repos: [repo({ path: repoPath, gates: GATES })],
      teams: [team({ selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: 'team' }] })],
      employees: [employee({ capabilities: ['read_files', 'run_commands', 'write_code'] })],
      ...few,
    }));
    return { w, fixture, repoPath };
  }
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

  it('asks a run where it stands, then stops it with a card that says what it was doing', async () => {
    const turns: string[] = [];
    const setup = watched(async (s) => {
      turns.push(s.text);
      if (s.index > 0) return;
      await s.engine('set_status', { text: 'Reading the greeting code' });
      for (let i = 0; i < 40; i++) {
        if (!(await s.tool(i % 4 === 3 ? 'Grep' : 'Read', i % 4 === 3 ? { pattern: 'hello', path: s.cwd } : { file_path: path.join(s.cwd, 'README.md') }))) return;
        await pause();
      }
    });
    const made = task(setup);
    await drain(setup);
    const [run] = store.runsOf(setup.w.db, made.id);
    expect(run).toMatchObject({ outcome: 'stopped', reason: 'no_progress' });
    // It was asked first, as a turn of its own.
    const said = readEvents(setup.w.db, 0, 10_000).flatMap((row) => (row.event.kind === 'run_activity' ? [row.event.text] : []));
    expect(said.filter((text) => /^asked where it stands: \d+ calls with nothing new$/.test(text))).toHaveLength(1);
    const [card] = store.openDecisions(setup.w.db);
    expect(card).toMatchObject({ kind: 'failed', taskId: made.id, runId: run!.id });
    expect(card!.text).toMatch(/^Ada was stopped on "Greet": \d+ tool calls in a row with nothing new in its folder, no check newly passing and no report\. It was: Reading the greeting code\. In those calls it read or searched \d+ times/);
    expect(card!.options.map((option) => [option.id, option.label])).toEqual([['retry', 'Let it carry on'], ['stop', 'Stop it']]);
    expect(store.getTask(setup.w.db, made.id)!.state).toBe('blocked');

    // "Let it carry on" resumes the same session, told why it was stopped.
    setup.w.sup.answer(card!.id, { optionId: 'retry' });
    const [again] = store.openRequests(setup.w.db);
    expect(again).toMatchObject({ taskId: made.id, resumeSessionId: run!.sessionId, firstTurn: expect.stringMatching(/stopped you because it saw no progress/) });
  });

  it('counts a new file, a report and a gate newly passing as progress, and a file changed back and forth as none', async () => {
    const setup = watched(async (s) => {
      if (s.index > 0) return;
      // Twenty calls, with something new in the folder every few: never asked, never stopped.
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) s.write(`notes/${i}.md`, `step ${i}\n`);
        if (!(await s.tool('Read', { file_path: path.join(s.cwd, 'README.md') }))) return;
        await pause();
      }
      s.write('GREETING.md', 'hello\n');
      await s.engine('report_done', { summary: 'Greets.' });
    });
    const steady = task(setup);
    await drain(setup);
    expect(store.runsOf(setup.w.db, steady.id)[0]).toMatchObject({ outcome: 'done' });
    expect(readEvents(setup.w.db, 0, 10_000).some((row) => row.event.kind === 'run_activity' && row.event.text.startsWith('asked where it stands'))).toBe(false);
  });

  it('does not take a file changed back and forth for progress', async () => {
    const setup = watched(async (s) => {
      if (s.index > 0) return;
      for (let i = 0; i < 40; i++) {
        s.write('GREETING.md', i % 2 === 0 ? 'hello\n' : 'hi\n');
        if (!(await s.tool('Read', { file_path: path.join(s.cwd, 'README.md') }))) return;
        await pause();
      }
    });
    const made = task(setup);
    await drain(setup);
    expect(store.runsOf(setup.w.db, made.id)[0]).toMatchObject({ outcome: 'stopped', reason: 'no_progress' });
  });
});

describe('a folder that is no repository', () => {
  it('counts files written by commands as progress there too', async () => {
    const fixture = inProcess(
      staged(
        async (s) => {
          if (s.index > 0) return;
          for (let i = 0; i < 24; i++) {
            // As a command would write it: no Write call names the file.
            if (i % 2 === 0) s.write(`out/${i}.txt`, `step ${i}\n`);
            if (!(await s.tool('Bash', { command: `echo step ${i} > out/${i}.txt` }))) return;
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          await s.engine('report_done', { summary: 'Written.' });
        },
        { everyTurn: true },
      ),
    );
    const w = (open = world(fixture.spawn, {
      teams: [team({ selfManaged: true })],
      employees: [employee({ capabilities: ['read_files', 'run_commands', 'write_code'] })],
      options: { progress: { askAfter: 6, stopAfter: 9, lookEvery: 3 } },
    }));
    const made = w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Write the notes', brief: 'x', doneCondition: 'y' });
    await drain({ w, fixture, repoPath: '' });
    expect(store.runsOf(w.db, made.id)[0]).toMatchObject({ outcome: 'done' });
  });
});

describe('loop breakers', () => {
  it('refuses a command the fourth time it would fail the same way, and allows it once something was written', () => {
    const watch = newWatch();
    const run = (id: string, command: string, ok: boolean) => {
      const call = { id, tool: 'Bash', input: { command } };
      const refused = refusal(watch, call);
      if (refused) return refused;
      called(watch, call);
      resulted(watch, id, ok);
      return null;
    };
    expect(run('1', 'cargo test -p jobs', false)).toBeNull();
    expect(run('2', 'cargo  test -p jobs ', false)).toBeNull();
    // Reading in between changes nothing.
    called(watch, { id: 'r', tool: 'Read', input: { file_path: 'a' } });
    resulted(watch, 'r', true);
    expect(run('3', 'cargo test -p jobs', false)).toBeNull();
    expect(run('4', 'cargo test -p jobs', false)).toMatch(/this exact command has failed 3 times in a row.*Change something first/s);
    // Another command is not that one.
    expect(run('5', 'cargo build', false)).toBeNull();
    // Something was written: it may be tried again.
    called(watch, { id: 'w', tool: 'Edit', input: { file_path: 'src/lib.rs' } });
    resulted(watch, 'w', true);
    expect(run('6', 'cargo test -p jobs', false)).toBeNull();
  });

  it('never stops a run it has not asked first, and gives it the whole margin after asking, however late it looked', () => {
    const budget = { askAfter: 50, stopAfter: 75, lookEvery: 10 };
    const watch = newWatch();
    const at = new Date('2026-11-12T10:00:00Z');
    expect(looked(watch, 'tree-a', at, budget)).toBe('carry_on'); // where the run began
    const read = (count: number) => {
      for (let i = 0; i < count; i++) called(watch, { id: `r${watch.calls}`, tool: 'Read', input: {} });
    };
    read(80);
    // The folder was not looked at in time: at 80 calls it is asked, not stopped.
    expect(looked(watch, 'tree-a', at, budget)).toBe('ask');
    read(20);
    expect(looked(watch, 'tree-a', at, budget)).toBe('carry_on');
    read(5);
    expect(looked(watch, 'tree-a', at, budget)).toBe('stop');
    // Something new in the folder, and the count starts again.
    expect(looked(watch, 'tree-b', at, budget)).toBe('carry_on');
    expect(watch).toMatchObject({ calls: 0, asked: null, changedAt: at.toISOString() });
    // Back to an earlier tree is nothing new.
    read(50);
    expect(looked(watch, 'tree-a', at, budget)).toBe('ask');
  });

  it('takes a call for the same only when all of it is the same, and does not count a call that was never made', () => {
    const watch = newWatch();
    for (const id of ['1', '2', '3']) {
      called(watch, { id, tool: 'Bash', input: { command: 'make check' } });
      resulted(watch, id, false);
    }
    expect(refusal(watch, { tool: 'Bash', input: { command: 'make check' } })).not.toBeNull();
    // The same words with more time is another try.
    expect(refusal(watch, { tool: 'Bash', input: { command: 'make check', timeout: 600_000 } })).toBeNull();
    // A call the engine refused was not run, so it did not fail.
    const other = newWatch();
    for (const id of ['1', '2', '3']) {
      called(other, { id, tool: 'Bash', input: { command: 'curl example.com' } });
      refused(other, id);
      resulted(other, id, false);
    }
    expect(refusal(other, { tool: 'Bash', input: { command: 'curl example.com' } })).toBeNull();
  });

  it('counts a report that was refused, and asks again when its question did not reach the session', () => {
    const budget = { askAfter: 3, stopAfter: 5, lookEvery: 1 };
    const watch = newWatch();
    const at = new Date('2026-11-12T10:00:00Z');
    looked(watch, 'tree-a', at, budget);
    for (const id of ['1', '2', '3']) called(watch, { id, tool: 'mcp__engine__report_done', input: { summary: 'Done.' } });
    expect(watch.calls).toBe(3);
    expect(looked(watch, 'tree-a', at, budget)).toBe('ask');
    // The session had closed its ears: the question was not delivered, so it has not been asked.
    undelivered(watch);
    called(watch, { id: '4', tool: 'Read', input: {} });
    expect(looked(watch, 'tree-a', at, budget)).toBe('ask');
    called(watch, { id: '5', tool: 'Read', input: {} });
    called(watch, { id: '6', tool: 'Read', input: {} });
    expect(looked(watch, 'tree-a', at, budget)).toBe('stop');
  });

  it('refuses it through the session, as the reason for a refused call', async () => {
    const allowed: boolean[] = [];
    const setup = oneWorker(async (s) => {
      for (let i = 0; i < 3; i++) {
        s.emit({ kind: 'tool_call', id: `fail-${i}`, tool: 'Bash', input: { command: 'make check' } });
        s.emit({ kind: 'tool_result', id: `fail-${i}`, ok: false });
      }
      // The engine hears of those a moment later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      allowed.push(await s.tool('Bash', { command: 'make check' }));
      allowed.push(await s.tool('Bash', { command: 'make other' }));
      s.write('GREETING.md', 'hello\n');
      await s.engine('report_done', { summary: 'Greets.' });
    });
    task(setup);
    await drain(setup);
    expect(allowed).toEqual([false, true]);
  });
});
