/**
 * A worker hosts exactly one session for one run, and nothing else. It has no inbox and never
 * waits: it forwards what the session does, asks the supervisor about every tool call, and exits.
 */
import { fileURLToPath } from 'node:url';
import type { RuntimeFactory, SessionInput } from '../runtime/sdk.ts';
import { CLOSING_TOOLS, TOOL_INPUT, ToWorker, type EngineTool, type ToSupervisor, type WorkerJob } from './protocol.ts';

export type Channel = { send(message: ToSupervisor): void; onMessage(listener: (message: unknown) => void): void };

const REMINDER: Record<WorkerJob['mode'], string> = {
  brief: 'You ended your turn without telling the engine the outcome. Call mcp__engine__propose_subtasks to split the task, or mcp__engine__report_done if you did it yourself. Nothing counts until you do.',
  work: 'You ended your turn without reporting. If the work is finished, call mcp__engine__report_done with a short summary. If you cannot finish it, call mcp__engine__request_decision. Nothing counts until you do.',
  integrate: 'You ended your turn without reporting. Call mcp__engine__report_done when the integration is finished, or mcp__engine__request_decision if you cannot finish it.',
  review: 'You ended your turn without a verdict. Call mcp__engine__submit_review with approve, send_back or escalate.',
  route: '',
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Ask = DistributiveOmit<Extract<ToSupervisor, { askId: string }>, 'askId'>;

export async function runWorker(job: WorkerJob, channel: Channel, runtime: RuntimeFactory, options: { decideTimeoutMs?: number } = {}): Promise<void> {
  const waiting = new Map<string, (reply: unknown) => void>();
  let asked = 0;
  function ask<T>(message: Ask, fallback: T, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve) => {
      const askId = `${job.runId}-${++asked}`;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => waiting.delete(askId) && resolve(fallback), timeoutMs);
      waiting.set(askId, (reply) => {
        clearTimeout(timer);
        resolve(reply as T);
      });
      channel.send({ ...message, askId } as ToSupervisor);
    });
  }

  let reported = false; // a closing tool call was accepted
  let reminded = false;
  let inputClosed = false;
  let stopped = false;
  let sessionId: string | null = job.resumeSessionId ?? null;
  let lastText: string | null = null;
  let failure: string | null = null;

  const handle = runtime({
    cwd: job.cwd,
    prompt: job.firstTurn,
    systemPrompt: job.systemPrompt,
    model: job.model,
    ...(job.effort && { effort: job.effort }),
    env: job.env,
    tools: job.tools,
    maxTurns: job.maxTurns,
    skills: job.skills,
    plugins: job.plugins,
    additionalDirectories: job.additionalDirectories,
    sandbox: job.sandbox as SessionInput['sandbox'],
    ...(job.maxBudgetUsd !== undefined && { maxBudgetUsd: job.maxBudgetUsd }),
    ...(job.resumeSessionId !== undefined && { resumeSessionId: job.resumeSessionId }),
    engineTools: {
      names: job.engineTools,
      call: async (name: EngineTool, input: unknown) => {
        const parsed = TOOL_INPUT[name].safeParse(input);
        if (!parsed.success) return { ok: false, text: `The input does not fit the tool: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` };
        const reply = await ask({ t: 'tool', name, input: parsed.data }, { ok: false, text: 'The supervisor did not answer.' });
        if (reply.ok && CLOSING_TOOLS.has(name)) reported = true;
        return reply;
      },
    },
    // Asked for every tool call. No answer in time is a refusal: a limit never fails open.
    decideTool: async (call) => {
      const reply = await ask<{ allow: boolean; reason?: string; stop?: boolean }>({ t: 'decide', call }, { allow: false, reason: 'The supervisor did not answer in time, so the call is refused.' }, options.decideTimeoutMs ?? 60_000);
      if (reply.stop) {
        stopped = true;
        queueMicrotask(() => handle.stop());
      }
      return { allow: reply.allow, ...(reply.reason !== undefined && { reason: reply.reason }) };
    },
  });

  channel.onMessage((raw) => {
    const parsed = ToWorker.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.t) {
      case 'decision':
      case 'tool_result': {
        const resolve = waiting.get(message.askId);
        waiting.delete(message.askId);
        return resolve?.(message);
      }
      case 'message':
        // Once the session takes no more turns the message would be lost, so say it was not delivered.
        if (!inputClosed) handle.send(message.text);
        return channel.send({ t: 'message_result', id: message.id, delivered: !inputClosed });
      case 'stop':
        stopped = true;
        return handle.stop();
    }
  });

  const closeInput = () => {
    inputClosed = true;
    handle.end();
  };

  for await (const event of handle.events) {
    channel.send({ t: 'event', event });
    if (event.kind === 'session_started') sessionId = event.sessionId;
    if (event.kind === 'assistant_text' && event.text.trim()) lastText = event.text.trim();
    if (event.kind === 'turn_finished' && event.ok && !inputClosed) {
      if (reported || job.mode === 'route') closeInput();
      else if (!reminded) {
        // One reminder, then the input closes: whatever happens next, this run ends.
        reminded = true;
        handle.send(REMINDER[job.mode]);
        closeInput();
      }
    }
    if (event.kind === 'finished') {
      sessionId = event.sessionId ?? sessionId;
      if (!event.ok) failure = event.reason ?? 'error';
    }
  }

  const done = failure === null && (reported || job.mode === 'route');
  channel.send({
    t: 'exit',
    outcome: stopped ? 'stopped' : done ? 'done' : 'failed',
    reason: stopped ? 'stopped' : done ? null : (failure ?? 'no_report'),
    sessionId,
    summary: lastText,
  });
}

// ---------- the child process entry ----------

if (process.argv[1] === fileURLToPath(import.meta.url) && process.send) {
  let sending = 0;
  let drained = () => {};
  const channel: Channel = {
    send(message) {
      sending += 1;
      process.send!(message, undefined, undefined, () => --sending === 0 && drained());
    },
    onMessage: (listener) => void process.on('message', listener),
  };
  // The supervisor is gone: nothing would record this session, so nothing it started may live on.
  process.on('disconnect', () => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      process.exit(1);
    }
  });
  process.once('message', async (raw) => {
    const start = ToWorker.safeParse(raw);
    if (!start.success || start.data.t !== 'start') process.exit(2);
    const job = start.data.job;
    try {
      const runtime: RuntimeFactory = job.runtimeModule ? ((await import(job.runtimeModule)) as { startSession: RuntimeFactory }).startSession : (await import('../runtime/sdk.ts')).startSession;
      await runWorker(job, channel, runtime);
    } catch (error) {
      channel.send({ t: 'exit', outcome: 'failed', reason: error instanceof Error ? error.message : String(error), sessionId: null, summary: null });
    }
    if (sending > 0) await new Promise<void>((resolve) => (drained = resolve));
    process.exit(0);
  });
}
