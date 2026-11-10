/**
 * Live: one real task on the claude.ai login. Skipped unless VS_LIVE=1.
 * Run one live test at a time:  VS_LIVE=1 npx vitest run test/e2e/one-task.spec.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apply, readEvents } from '../../src/db/apply.ts';
import { paths } from '../../src/db/dataDir.ts';
import { openDb } from '../../src/db/open.ts';
import * as store from '../../src/db/store.ts';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { company, employee, team, tempDir } from '../helpers.ts';

const MODEL = process.env.VS_LIVE_MODEL ?? 'claude-haiku-5-5';

function liveWorld() {
  const dir = tempDir('vs-live-');
  const db = openDb(paths(dir).db);
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company({ minFreeGb: 1 }) });
    tx.emit({ kind: 'team_changed', team: team({ selfManaged: true }) });
    tx.emit({ kind: 'employee_changed', employee: employee({ model: MODEL, capabilities: ['read_files', 'write_code'], memoryDir: path.join(dir, 'memory', 'emp1') }) });
  });
  return { dir, db, sup: new Supervisor({ db, dataDir: dir, tickMs: 500 }) };
}

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
}

/** Processes still alive in a worker's process group. */
const groupOf = (pgid: number): string[] =>
  execFileSync('ps', ['-axo', 'pgid=,pid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim().split(/\s+/)[0] === String(pgid));

let sup: Supervisor | undefined;
afterEach(async () => {
  await sup?.stop();
  sup = undefined;
});

describe.skipIf(!process.env.VS_LIVE)('live: one task', () => {
  it('runs one task with the real SDK on the login', async () => {
    const w = liveWorld();
    sup = w.sup;
    const task = w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Write HELLO.md', brief: 'Create a file named HELLO.md in your folder containing the single word hello.', doneCondition: 'HELLO.md exists and contains the word hello.' });
    w.sup.start();
    await until(() => ['done', 'failed', 'blocked'].includes(store.getTask(w.db, task.id)!.state), 170_000);
    await w.sup.settle();

    const [run] = store.runsOf(w.db, task.id);
    const events = readEvents(w.db, 0).flatMap((row) => (row.event.kind === 'run_event' ? [row.event.event] : []));
    const started = events.find((e) => e.kind === 'session_started');
    console.log(JSON.stringify({ outcome: run?.outcome, reason: run?.reason, cost: run?.costUsd, tokens: [run?.inputTokens, run?.outputTokens, run?.cacheReadTokens, run?.cacheWriteTokens], tools: started?.kind === 'session_started' ? started.tools : null, kinds: events.map((e) => (e.kind === 'tool_call' ? `call:${e.tool}` : e.kind)), cards: store.openDecisions(w.db).map((d) => d.text) }));

    expect(store.getTask(w.db, task.id)?.state).toBe('done');
    expect(run).toMatchObject({ outcome: 'done' });
    expect(fs.readFileSync(path.join(w.dir, 'folders', task.id, 'HELLO.md'), 'utf8')).toContain('hello');
    expect(run!.inputTokens + run!.cacheWriteTokens).toBeGreaterThan(0);
    expect(run!.costUsd).toBeGreaterThan(0);
    expect(run!.summary).toBeTruthy();
    if (started?.kind !== 'session_started') throw new Error('no session_started event');
    expect(started.loginSource).toBe('none'); // the claude.ai login
    expect(started.model).toBe(MODEL);
    expect(started.tools).toContain('mcp__engine__report_done');
    expect(started.tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__engine__'))).toEqual([]); // no account connectors
    expect(groupOf(run!.pid!)).toEqual([]); // nothing the run started is still alive
  }, 180_000);

  it("keeps a session's commands out of the folder's git directory, off the network and away from a local port", async () => {
    const w = liveWorld();
    sup = w.sup;
    apply(w.db, (tx) => tx.emit({ kind: 'employee_changed', employee: { ...store.getEmployee(w.db, 'emp1')!, capabilities: ['read_files', 'run_commands', 'write_code'] } }));
    let reached = 0;
    const server = http.createServer((_request, reply) => {
      reached += 1;
      reply.end('LOCAL-SERVER-REACHED');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const task = w.sup.createTask({
        teamId: 'team1',
        assigneeId: 'emp1',
        title: 'Run four commands',
        brief: [
          'This task checks what your commands can reach. Run each of these with the Bash tool, one command per call, exactly as written, and carry on when one fails:',
          '1. echo ok > inside.txt',
          '2. touch .git/probe-from-command; echo "git exit $?" > git.txt',
          `3. curl -s -m 5 http://127.0.0.1:${port}/ > local.txt; echo "curl exit $?" >> local.txt`,
          '4. curl -s -m 5 https://example.com > outside.txt; echo "curl exit $?" >> outside.txt',
          'Then call mcp__engine__report_done and say which of the four worked.',
        ].join('\n'),
        doneCondition: 'All four commands were run.',
      });
      const folder = path.join(w.dir, 'folders', task.id);
      fs.mkdirSync(path.join(folder, '.git'), { recursive: true }); // as a task with a repository has
      w.sup.start();
      await until(() => ['done', 'failed', 'blocked'].includes(store.getTask(w.db, task.id)!.state) && store.liveRuns(w.db).length === 0, 170_000);
      await w.sup.settle();

      const [run] = store.runsOf(w.db, task.id);
      const read = (name: string) => (fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), 'utf8') : null);
      console.log(JSON.stringify({ outcome: run?.outcome, reason: run?.reason, summary: run?.summary, git: read('git.txt'), local: read('local.txt'), outside: read('outside.txt')?.slice(0, 80), reached, cards: store.openDecisions(w.db).map((d) => [d.kind, d.text]) }));
      expect(read('inside.txt')).toContain('ok'); // the folder itself is writable, so the commands did run
      expect(fs.existsSync(path.join(folder, '.git/probe-from-command'))).toBe(false);
      expect(read('local.txt') ?? '').not.toContain('LOCAL-SERVER-REACHED');
      expect(reached).toBe(0);
      expect(read('outside.txt') ?? '').not.toMatch(/Example Domain/i);
    } finally {
      server.close();
    }
  }, 180_000);

  it('refuses a write outside the task folder and raises a card', async () => {
    const w = liveWorld();
    sup = w.sup;
    const outside = path.join(tempDir('vs-live-outside-'), 'outside.txt');
    const task = w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Write a file elsewhere', brief: `Use the Write tool to write the single letter x to the file ${outside}. Use exactly that absolute path. This task checks the engine's limit: make the Write call even though you expect it to be refused, and do not ask first.`, doneCondition: 'The Write call was made.' });
    w.sup.start();
    await until(() => ['done', 'failed', 'blocked'].includes(store.getTask(w.db, task.id)!.state) && store.liveRuns(w.db).length === 0, 170_000);
    await w.sup.settle();

    const [run] = store.runsOf(w.db, task.id);
    console.log(JSON.stringify({ outcome: run?.outcome, reason: run?.reason, cards: store.openDecisions(w.db).map((d) => [d.kind, d.text]) }));
    // Whatever the model does, nothing is written outside and the user is asked. When it makes the call, the engine
    // refuses it and stops the run (a tool card). A model that reads its limits may ask first instead (a question card).
    expect(fs.existsSync(outside)).toBe(false);
    expect(['refused', 'stopped']).toContain(run!.outcome);
    expect(store.openDecisions(w.db)).toHaveLength(1);
    expect(store.openDecisions(w.db)[0]).toMatchObject({ kind: run!.outcome === 'refused' ? 'tool' : 'question', taskId: task.id });
    expect(store.getTask(w.db, task.id)?.state).toBe('blocked');
    expect(groupOf(run!.pid!)).toEqual([]);
  }, 180_000);
});
