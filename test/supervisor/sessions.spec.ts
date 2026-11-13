import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as store from '../../src/db/store.ts';
import { readIndex } from '../../src/supervisor/memory.ts';
import { fakeRuntime } from '../fixtures/fakeRuntime.ts';
import { inProcess } from '../fixtures/inProcess.ts';
import { employee, tempDir, world, type World } from '../helpers.ts';

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const coder = employee({ capabilities: ['read_files', 'run_commands', 'write_code'] });
const newTask = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', title: 'Write the note', brief: 'Write NOTE.md with one line.', doneCondition: 'NOTE.md exists.', assigneeId: 'emp1', ...over });

async function runToRest(w: World, fixture: { idle(): Promise<void> }, ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
  }
}

describe('a run, through the real worker logic', () => {
  it('runs an employee at the effort it was hired with', async () => {
    const fixture = inProcess(fakeRuntime((turn) => turn.engine('report_done', { summary: 'Wrote it.' }).then(() => {})));
    const w = (open = world(fixture.spawn, { employees: [{ ...coder, effort: 'xhigh' }] }));
    newTask(w);
    await runToRest(w, fixture, 1);
    expect(fixture.jobs[0]).toMatchObject({ mode: 'work', effort: 'xhigh' });
  });

  it('gives the session its identity, its first turn and its limits', async () => {
    const fixture = inProcess(fakeRuntime((turn) => turn.engine('report_done', { summary: 'Wrote it.' }).then(() => {})));
    const w = (open = world(fixture.spawn, { employees: [coder] }));
    const task = newTask(w);
    await runToRest(w, fixture, 1);
    const job = fixture.jobs[0]!;
    expect(job.systemPrompt).toContain('You are Ada');
    expect(job.systemPrompt).toContain('never run git commit');
    expect(job.firstTurn).toContain('Write NOTE.md with one line.');
    expect(job.firstTurn).toContain('NOTE.md exists.');
    expect(job.firstTurn).toContain('mcp__engine__report_done');
    expect(job.systemPrompt).not.toContain('Write NOTE.md');
    expect(job.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit']);
    expect(job.engineTools).toEqual(['report_done', 'request_decision', 'request_tools', 'set_status', 'run_gate', 'wait_for', 'read_decisions']);
    // No effort was chosen for this employee, so none is sent: the model uses its own.
    expect(job).not.toHaveProperty('effort');
    expect(job.cwd).toBe(path.join(w.dir, 'folders', task.id));
    expect(fs.existsSync(job.cwd)).toBe(true);
    expect(job.additionalDirectories).toEqual([path.join(w.dir, 'memory', 'emp1')]);
    expect(job.maxTurns).toBe(150);
    // The Bash timeout sits two minutes under the 15-minute lease, so a long command cannot outlast it silently.
    expect(job.env).toMatchObject({ BASH_MAX_TIMEOUT_MS: '780000', BASH_DEFAULT_TIMEOUT_MS: '780000' });
    expect(job.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect((job.sandbox as { enabled: boolean }).enabled).toBe(true);
  });

  it("runs a task to done and remembers it in the employee's memory", async () => {
    const fixture = inProcess(fakeRuntime((turn) => turn.engine('report_done', { summary: 'Wrote NOTE.md with one line.' }).then(() => {})));
    const w = (open = world(fixture.spawn, { employees: [coder] }));
    const task = newTask(w);
    await runToRest(w, fixture);
    expect(store.getTask(w.db, task.id)?.state).toBe('done');
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'done', summary: 'Wrote NOTE.md with one line.', costUsd: 0.01 }]);
    expect(readIndex(path.join(w.dir, 'memory', 'emp1'))).toContain('Write the note: Wrote NOTE.md with one line.');
  });

  it('shows what the employee remembers in its next run', async () => {
    const fixture = inProcess(fakeRuntime((turn) => turn.engine('report_done', { summary: 'Learned that notes go in docs/.' }).then(() => {})));
    const w = (open = world(fixture.spawn, { employees: [coder] }));
    newTask(w);
    await runToRest(w, fixture);
    newTask(w, { title: 'A second note' });
    await runToRest(w, fixture);
    expect(fixture.jobs[1]!.systemPrompt).toContain('Learned that notes go in docs/.');
  });

  it('a refused tool call ends the run as refused with a tool card, and Allow once lets the resumed session repeat it', async () => {
    const outside = path.join(tempDir(), 'outside.txt');
    const allowed: boolean[] = [];
    const runtime = fakeRuntime(async (turn) => {
      allowed.push(await turn.tool('Write', { file_path: outside, content: 'x' }));
      await turn.engine('report_done', { summary: 'Wrote outside, with permission.' });
    });
    const fixture = inProcess(runtime);
    const w = (open = world(fixture.spawn, { employees: [coder] }));
    const task = newTask(w);
    await runToRest(w, fixture, 2);
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'refused' }]);
    expect(store.getTask(w.db, task.id)).toMatchObject({ state: 'blocked', blockedFrom: 'running' });
    const [card] = store.openDecisions(w.db);
    expect(card).toMatchObject({ kind: 'tool', taskId: task.id, employeeId: 'emp1' });
    expect(card!.text).toContain(outside);
    expect(card!.options.map((o) => o.label)).toEqual(['Allow once', 'Keep refused', 'Stop it']);
    expect(runtime.turns).toHaveLength(1);

    expect(w.sup.answer(card!.id, { optionId: 'allow_once' })).toBe('applied');
    await runToRest(w, fixture, 2);
    expect(allowed).toEqual([false, true]);
    expect(runtime.sessions[1]!.resumeSessionId).toBe('sess-1');
    expect(runtime.sessions[1]!.prompt).toContain('allowed once');
    expect(store.grantsOf(w.db, task.id)).toMatchObject([{ tool: 'Write', used: true }]);
    expect(store.getTask(w.db, task.id)?.state).toBe('done');
  });

  it('a refused secret does not stop the run', async () => {
    const seen: boolean[] = [];
    const fixture = inProcess(
      fakeRuntime(async (turn) => {
        seen.push(await turn.tool('Read', { file_path: '/Users/someone/project/.env' }));
        await turn.engine('report_done', { summary: 'Carried on without it.' });
      }),
    );
    const w = (open = world(fixture.spawn, { employees: [coder] }));
    const task = newTask(w);
    await runToRest(w, fixture);
    expect(seen).toEqual([false]);
    expect(store.getTask(w.db, task.id)?.state).toBe('done');
    expect(store.openDecisions(w.db)).toHaveLength(0);
  });

  it('a session that will not report fails the run, and that becomes a card, not a retry', async () => {
    const fixture = inProcess(fakeRuntime((turn) => turn.say('I think that is everything.')));
    const w = (open = world(fixture.spawn, { employees: [coder] }));
    const task = newTask(w);
    await runToRest(w, fixture);
    expect(store.runsOf(w.db, task.id)).toMatchObject([{ outcome: 'failed', reason: 'no_report' }]);
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'failed' }]);
    expect(store.openRequests(w.db)).toHaveLength(0);
  });
});
