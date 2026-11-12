import { fork } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ToSupervisor, ToWorker, WorkerJob } from '../../src/worker/protocol.ts';
import { runWorker } from '../../src/worker/worker.ts';
import { fakeRuntime, type FakeRuntime } from '../fixtures/fakeRuntime.ts';

const WORKER = new URL('../../src/worker/worker.ts', import.meta.url).pathname;
const HANGING = new URL('../fixtures/hangingRuntime.ts', import.meta.url).pathname;

const job = (over: Partial<WorkerJob> = {}): WorkerJob => ({
  runId: 'run1',
  mode: 'work',
  cwd: '/tmp/project',
  systemPrompt: 'You are Ada.',
  firstTurn: '<first turn>',
  model: 'claude-haiku-5-5',
  env: { PATH: '/bin' },
  tools: ['Read', 'Bash'],
  engineTools: ['report_done', 'request_decision', 'set_status', 'run_gate', 'propose_subtasks'],
  skills: [],
  plugins: [],
  additionalDirectories: [],
  sandbox: undefined,
  maxTurns: 150,
  ...over,
});

/** A supervisor that answers every ask, by default with yes. */
function supervisor(answers: { decide?: (call: { tool: string; input: unknown }) => Partial<Extract<ToWorker, { t: 'decision' }>> | null; tool?: (name: string, input: unknown) => { ok: boolean; text: string } } = {}) {
  const said: ToSupervisor[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const tell = (message: ToWorker) => setImmediate(() => listeners.forEach((l) => l(message)));
  const channel = {
    send(message: ToSupervisor) {
      said.push(message);
      if (message.t === 'decide') {
        const reply = answers.decide ? answers.decide(message.call) : { allow: true };
        if (reply) tell({ t: 'decision', askId: message.askId, allow: true, ...reply });
      }
      if (message.t === 'tool') tell({ t: 'tool_result', askId: message.askId, ...(answers.tool?.(message.name, message.input) ?? { ok: true, text: 'ok' }) });
    },
    onMessage: (listener: (message: unknown) => void) => void listeners.push(listener),
  };
  const exitOf = () => said.find((m): m is Extract<ToSupervisor, { t: 'exit' }> => m.t === 'exit');
  return { channel, said, tell, exitOf };
}

const run = (runtime: FakeRuntime, sup = supervisor(), over: Partial<WorkerJob> = {}) => runWorker(job(over), sup.channel, runtime, { decideTimeoutMs: 30 }).then(() => sup);

describe('runWorker', () => {
  it('forwards runtime events and exits done after report_done', async () => {
    const runtime = fakeRuntime(async (turn) => {
      turn.say('Writing the note.');
      await turn.engine('report_done', { summary: 'Wrote the note.' });
    });
    const sup = await run(runtime);
    expect(sup.said.filter((m) => m.t === 'event').map((m) => (m.t === 'event' ? m.event.kind : ''))).toEqual(['session_started', 'assistant_text', 'tool_call', 'tool_result', 'usage', 'turn_finished', 'finished']);
    expect(sup.said).toContainEqual(expect.objectContaining({ t: 'tool', name: 'report_done', input: { summary: 'Wrote the note.' } }));
    expect(sup.exitOf()).toEqual({ t: 'exit', outcome: 'done', reason: null, sessionId: 'sess-1', summary: 'Writing the note.' });
    expect(runtime.turns).toEqual(['<first turn>']);
  });

  it("starts the session from the job, in the job's folder and environment", async () => {
    const runtime = fakeRuntime((turn) => turn.engine('report_done', { summary: 'x' }).then(() => {}));
    await run(runtime, supervisor(), { maxBudgetUsd: 1.25, skills: ['user:postgresql'], plugins: ['/data/mounts/ada/user'], additionalDirectories: ['/data/memory/ada'] });
    expect(runtime.sessions[0]).toMatchObject({ cwd: '/tmp/project', prompt: '<first turn>', systemPrompt: 'You are Ada.', model: 'claude-haiku-5-5', env: { PATH: '/bin' }, tools: ['Read', 'Bash'], maxTurns: 150, maxBudgetUsd: 1.25, skills: ['user:postgresql'], plugins: ['/data/mounts/ada/user'], additionalDirectories: ['/data/memory/ada'] });
    expect(runtime.sessions[0]!.engineTools?.names).toEqual(job().engineTools);
  });

  it('feeds a message as the next user turn', async () => {
    const sup = supervisor();
    const runtime = fakeRuntime(async (turn) => {
      if (turn.index === 0) {
        sup.tell({ t: 'message', id: 'm1', text: 'Message from the user: stop at the test step' });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else await turn.engine('report_done', { summary: 'Stopped at the test step.' });
    });
    await run(runtime, sup);
    // The message is the very next turn. (The reminder for the unreported first turn may still follow it.)
    expect(runtime.turns.slice(0, 2)).toEqual(['<first turn>', 'Message from the user: stop at the test step']);
    expect(sup.said).toContainEqual({ t: 'message_result', id: 'm1', delivered: true });
    expect(sup.exitOf()?.outcome).toBe('done');
  });

  it('says so when a message arrives after the session has taken its last turn', async () => {
    const sup = supervisor();
    const runtime = fakeRuntime(async (turn) => void (await turn.engine('report_done', { summary: 'done' })));
    const finished = run(runtime, sup);
    await new Promise((resolve) => setTimeout(resolve, 15));
    sup.tell({ t: 'message', id: 'late', text: 'one more thing' });
    await finished;
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.turns).toEqual(['<first turn>']);
    expect(sup.said).toContainEqual({ t: 'message_result', id: 'late', delivered: false });
  });

  it('asks the supervisor about every tool call, and refuses when no answer comes', async () => {
    const allowed: boolean[] = [];
    const runtime = fakeRuntime(async (turn) => {
      allowed.push(await turn.tool('Read', { file_path: 'a.txt' }));
      allowed.push(await turn.tool('Bash', { command: 'make' }));
      await turn.engine('report_done', { summary: 'x' });
    });
    const sup = await run(runtime, supervisor({ decide: (call) => (call.tool === 'Bash' ? null : { allow: true }) }));
    expect(allowed).toEqual([true, false]);
    expect(sup.said.filter((m) => m.t === 'decide').map((m) => (m.t === 'decide' ? m.call.tool : ''))).toEqual(['Read', 'Bash', 'mcp__engine__report_done']);
  });

  it('stops the session when a decision says stop', async () => {
    const runtime = fakeRuntime(async (turn) => {
      await turn.tool('Write', { file_path: '/etc/hosts', content: 'x' });
      await turn.engine('report_done', { summary: 'never reached' });
    });
    const sup = await run(runtime, supervisor({ decide: (call) => (call.tool === 'Write' ? { allow: false, reason: 'outside the folder', stop: true } : { allow: true }) }));
    expect(sup.exitOf()).toMatchObject({ outcome: 'stopped', sessionId: 'sess-1' });
    expect(sup.said.some((m) => m.t === 'tool')).toBe(false);
  });

  it('stops when the supervisor says stop', async () => {
    const sup = supervisor();
    const runtime = fakeRuntime(async () => {
      sup.tell({ t: 'stop' });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    await run(runtime, sup);
    expect(sup.exitOf()).toMatchObject({ outcome: 'stopped' });
  });

  it('passes on everything the session did before an engine tool call, before the call itself', async () => {
    const runtime = fakeRuntime(async (turn) => {
      await turn.tool('Bash', { command: 'cargo test -p jobs' });
      await turn.engine('report_done', { summary: 'Done.', checks: [{ command: 'cargo test -p jobs' }] });
    });
    const sup = await run(runtime);
    const order = sup.said.flatMap((message) => (message.t === 'event' && (message.event.kind === 'tool_call' || message.event.kind === 'tool_result') ? [`${message.event.kind}:${message.event.kind === 'tool_call' ? message.event.tool : ''}`] : message.t === 'tool' ? [`ask:${message.name}`] : []));
    // The command and its result, then the session's own record of the call, then the call reaches the supervisor.
    expect(order.slice(0, 4)).toEqual(['tool_call:Bash', 'tool_result:', 'tool_call:mcp__engine__report_done', 'ask:report_done']);
  });

  it('rejects an engine-tool input that breaks its schema before it reaches the supervisor', async () => {
    let reply: { ok: boolean; text: string } | undefined;
    const runtime = fakeRuntime(async (turn) => {
      if (turn.index > 0) return;
      reply = await turn.engine('propose_subtasks', { subtasks: [{ title: 'No assignee' }] });
    });
    const sup = await run(runtime);
    expect(reply).toMatchObject({ ok: false, text: expect.stringContaining('assigneeId') });
    expect(sup.said.some((m) => m.t === 'tool')).toBe(false);
  });

  it('reminds once, then exits failed with no_report', async () => {
    const runtime = fakeRuntime((turn) => turn.say('All finished, I think.'));
    const sup = await run(runtime);
    expect(runtime.turns).toHaveLength(2);
    expect(runtime.turns[1]).toContain('report_done');
    expect(sup.exitOf()).toMatchObject({ outcome: 'failed', reason: 'no_report' });
  });

  it('accepts the report when it comes after the reminder', async () => {
    const runtime = fakeRuntime(async (turn) => {
      if (turn.index === 1) await turn.engine('report_done', { summary: 'Now reported.' });
    });
    expect((await run(runtime)).exitOf()).toMatchObject({ outcome: 'done' });
  });

  it('a refused proposal does not end the work: the session may try again', async () => {
    const runtime = fakeRuntime(async (turn) => {
      const proposal = { subtasks: [{ title: 'A', assigneeId: 'e', brief: 'b', ownership: [], doneCondition: 'd', gates: [], priority: 2, capUsd: 1, retryAllowed: true }] };
      const first = await turn.engine('propose_subtasks', proposal);
      if (!first.ok) await turn.engine('report_done', { summary: 'Did it myself instead.' });
    });
    const sup = await run(runtime, supervisor({ tool: (name) => (name === 'propose_subtasks' ? { ok: false, text: 'overlap' } : { ok: true, text: 'ok' }) }));
    expect(runtime.turns).toHaveLength(1);
    expect(sup.exitOf()).toMatchObject({ outcome: 'done' });
  });

  it("reports failed with the SDK's reason when the turn limit is hit", async () => {
    const runtime = fakeRuntime((turn) => turn.fail('error_max_turns'));
    expect((await run(runtime)).exitOf()).toMatchObject({ outcome: 'failed', reason: 'error_max_turns', sessionId: 'sess-1' });
  });

  it('resumes with resumeSessionId when the job carries one', async () => {
    const runtime = fakeRuntime((turn) => turn.engine('report_done', { summary: 'x' }).then(() => {}));
    const sup = await run(runtime, supervisor(), { resumeSessionId: 'sess-9' });
    expect(runtime.sessions[0]!.resumeSessionId).toBe('sess-9');
    expect(sup.exitOf()?.sessionId).toBe('sess-9');
  });

  it('a route run needs no report: it ends after its turn, and its last words are the summary', async () => {
    const runtime = fakeRuntime(async (turn) => {
      await turn.engine('create_task', { teamId: 't', title: 'T', brief: 'B', priority: 2, doneCondition: 'D', capUsd: 1 });
      turn.say('I wrote one task for the iOS team.');
    });
    const sup = await run(runtime, supervisor(), { mode: 'route', engineTools: ['create_task', 'set_status'] });
    expect(runtime.turns).toHaveLength(1);
    expect(sup.exitOf()).toMatchObject({ outcome: 'done', summary: 'I wrote one task for the iOS team.' });
  });
});

describe('the worker process', () => {
  it("exits when the supervisor's channel closes", async () => {
    const child = fork(WORKER, [], { execArgv: ['--import', 'tsx'], detached: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : null))));
    child.send({ t: 'start', job: job({ runtimeModule: HANGING }) });
    await new Promise<void>((resolve) => child.on('message', (m: ToSupervisor) => m.t === 'event' && resolve()));
    child.disconnect();
    expect(await exited).not.toBe(0);
  }, 15_000);
});
