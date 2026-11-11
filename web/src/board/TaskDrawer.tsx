import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { EventRow } from '../../../src/shared/events.ts';
import type { Decision, Message, Run, Task } from '../../../src/shared/types.ts';
import { useApi, useUi, type TaskTab } from '../app/context.ts';
import { money } from '../format.ts';
import { MessageBox } from '../frame/MessageBox.tsx';
import { Prose } from '../frame/Prose.tsx';
import { liveRuns } from '../model/select.ts';
import { useStore } from '../store/store.ts';

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

type Detail = { task: Task; children: Task[]; runs: Run[]; events: EventRow[]; decisions: Decision[] };
type Diff = { stat: string; patch: string; lines: number };

/** One line of the feed for an event worth showing, or null. */
function feedLine(row: EventRow, nameOf: (id: string) => string): string | null {
  const event = row.event;
  switch (event.kind) {
    case 'run_started':
      return `— ${nameOf(event.run.employeeId)} started a ${event.run.mode} run`;
    case 'run_ended':
      return `— the run ended: ${event.run.outcome}${event.run.reason ? ` (${event.run.reason})` : ''}`;
    case 'gate_finished':
      return `— gate ${event.result.name}: ${event.result.exitCode === 0 ? 'passed' : `FAILED (exit ${event.result.exitCode})`}`;
    case 'decision_raised':
      return `— a decision was raised: ${event.decision.text}`;
    case 'decision_answered': {
      // Who settled it and how: the user, or whoever decided on the user's behalf, with their reason.
      const { answer, options } = event.decision;
      const pressed = options.find((option) => option.id === answer?.optionId);
      if (event.result !== 'applied' || !answer || !pressed) return null;
      const said = (answer.why ?? answer.text)?.trim();
      return `— ${answer.by ? nameOf(answer.by) : 'you'} decided: ${pressed.label}${said ? `. ${said}` : ''}`;
    }
    case 'run_event': {
      const inner = event.event;
      if (inner.kind === 'assistant_text') return inner.text;
      if (inner.kind === 'tool_call') {
        const input = (inner.input ?? {}) as Record<string, unknown>;
        const what = input.file_path ?? input.command ?? input.pattern ?? input.summary ?? input.text ?? '';
        return `▸ ${inner.tool.replace('mcp__engine__', '')} ${String(what).slice(0, 120)}`.trim();
      }
      return null;
    }
    default:
      return null;
  }
}

/** Everything about one task: its brief, its sub-tasks, its runs, what is happening now, the diff, and a line to its employee. */
type Files = { folder: string | null; files: { path: string; bytes: number; text: string | null }[]; more: number };
const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function TaskDrawer({ taskId, tab = 'feed', onClose }: { taskId: string; tab?: TaskTab | undefined; onClose(): void }) {
  const api = useApi();
  const ui = useUi();
  const task = useStore((store) => store.tasks.get(taskId), [taskId]);
  const children = useStore((store) => [...store.tasks.values()].filter((child) => child.parentId === taskId), [taskId]);
  const runs = useStore((store) => [...store.runs.values()].filter((run) => run.taskId === taskId), [taskId]);
  const employees = useStore((store) => store.employees);
  const team = useStore((store) => (task ? store.teams.get(task.teamId) : undefined), [task?.teamId]);
  const live = useStore((store) => liveRuns(store).find((run) => run.taskId === taskId), [taskId]);
  const seq = useStore((store) => store.taskSeq[taskId] ?? 0, [taskId]);
  const messages = useStore((store) => store.messages);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showing, setShowing] = useState<TaskTab>(tab);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [files, setFiles] = useState<Files | null>(null);
  // A task with a repository shows what its branch changed. One without shows the files it wrote.
  const hasRepo = Boolean(task?.repoId || task?.branch);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const nameOf = (id: string | null) => (id === 'user' ? 'you' : ((id && employees.get(id)?.name) ?? 'nobody'));
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));

  // The task's own events: fetched when the drawer opens, and again whenever something about this task happens.
  useEffect(() => {
    let current = true;
    api.get<Detail>(`/api/tasks/${taskId}`).then((loaded) => current && setDetail(loaded), fail);
    return () => void (current = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, seq]);

  useEffect(() => setShowing(tab), [tab, taskId]);
  useEffect(() => {
    if (showing !== 'diff') return;
    let current = true;
    if (hasRepo) api.get<Diff>(`/api/tasks/${taskId}/diff`).then((loaded) => current && setDiff(loaded), fail);
    else api.get<Files>(`/api/tasks/${taskId}/files`).then((loaded) => current && setFiles(loaded), fail);
    return () => void (current = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, taskId, seq, hasRepo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Follow the feed while the reader is at its end; leave them alone when they have scrolled up.
  useEffect(() => {
    if (following.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [detail]);

  if (!task) return null;
  const recipient = nameOf(live?.employeeId ?? task.assigneeId ?? team?.leadId ?? null);
  const delivered = sent ? (messages.get(sent.id)?.state ?? sent.state) : null;

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!text.trim()) return;
    try {
      const reply = await api.post<{ message: Message }>(`/api/tasks/${taskId}/message`, { text: text.trim() });
      setSent(reply.message);
      setText('');
    } catch (failure) {
      fail(failure);
    }
  }

  const lines = (detail?.events ?? []).flatMap((row) => {
    const line = feedLine(row, nameOf);
    // What the employee wrote is shown with its formatting; the engine's own lines are plain.
    return line ? [{ id: row.id, line, words: row.event.kind === 'run_event' && row.event.event.kind === 'assistant_text' }] : [];
  });

  return (
    <aside className="drawer" role="dialog" aria-label={task.title}>
      <header>
        <div>
          <div className="label">
            {team?.name} · {task.state} · P{task.priority}
          </div>
          <h2>{task.title}</h2>
        </div>
        <button type="button" className="quiet" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <section>
        <Prose className="brief" text={task.brief} />
        {task.doneCondition && (
          <p>
            <span className="label">Done when</span> <span>{task.doneCondition}</span>
          </p>
        )}
        {task.gates.length > 0 && <p className="muted">Gates: {task.gates.join(', ')}</p>}
        {task.ownership.length > 0 && <p className="muted">Owns: {task.ownership.join(', ')}</p>}
      </section>

      {children.length > 0 && (
        <section>
          <div className="label">Sub-tasks</div>
          {children.map((child) => (
            <button key={child.id} type="button" className="child" onClick={() => ui.openTask(child.id)}>
              <span>{child.title}</span>
              <span className="muted">
                {nameOf(child.assigneeId)} · {child.state}
              </span>
            </button>
          ))}
        </section>
      )}

      {runs.length > 0 && (
        <section>
          <div className="label">Runs</div>
          {runs.map((run) => (
            <div key={run.id} className="run">
              <span>{`${run.mode} · ${nameOf(run.employeeId)} · ${run.outcome}${run.reason ? ` (${run.reason})` : ''} · ${money(run.costUsd)}`}</span>
              {run.gateResults.map((gate, index) => (
                <span key={index} className={gate.exitCode === 0 ? 'gate ok' : 'gate bad'} title={gate.output}>
                  {gate.name} {gate.exitCode === 0 ? 'passed' : 'failed'}
                </span>
              ))}
              {/* What a review found, in the reviewer's order: the numbers are the ones its author answers by. */}
              {run.findings && run.findings.length > 0 && (
                <ol className="findings">
                  {run.findings.map((finding, index) => (
                    <li key={index} data-severity={finding.severity}>
                      <b>{finding.severity}</b> {`${finding.file}${finding.line ? `:${finding.line}` : ''}: ${sentence(finding.title)}${finding.why.trim() ? ` ${sentence(finding.why)}` : ''}${finding.fix.trim() ? ` Fix: ${sentence(finding.fix)}` : ''}`}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </section>
      )}

      <nav className="tabs">
        <button type="button" className={`pill small${showing === 'feed' ? ' on' : ''}`} onClick={() => setShowing('feed')}>
          Live feed
        </button>
        <button type="button" className={`pill small${showing === 'diff' ? ' on' : ''}`} onClick={() => setShowing('diff')}>
          {hasRepo ? 'Diff' : 'Files'}
        </button>
      </nav>
      {showing === 'feed' ? (
        <div
          className="feed"
          ref={feed}
          onScroll={(event) => {
            const box = event.currentTarget;
            following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
          }}
        >
          {lines.length === 0 ? <p className="muted">Nothing has happened on this task yet.</p> : lines.map((entry) => (entry.words ? <Prose key={entry.id} text={entry.line} /> : <p key={entry.id}>{entry.line}</p>))}
        </div>
      ) : hasRepo ? (
        <div className="feed">
          {!diff ? <p className="muted">Loading…</p> : diff.patch ? <pre>{`${diff.stat}\n\n${diff.patch}`}</pre> : <p className="muted">No changes on this task's branch yet.</p>}
        </div>
      ) : (
        <div className="feed files">
          {!files ? (
            <p className="muted">Loading…</p>
          ) : files.files.length === 0 ? (
            <p className="muted">This task has not written any files yet.</p>
          ) : (
            <>
              {files.files.map((file, index) => (
                <details key={file.path} open={index === 0}>
                  <summary>{`${file.path} · ${size(file.bytes)}`}</summary>
                  {file.text === null ? <p className="muted">This file is not shown here: it is not text, or it is too long. It is in the folder below.</p> : <pre>{file.text}</pre>}
                </details>
              ))}
              {files.more > 0 && <p className="muted">{`and ${files.more} more`}</p>}
              <p className="muted">
                In <code>{files.folder}</code>
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="drawer-message" onSubmit={(event) => void send(event)}>
        <label htmlFor="task-message" className="sr-only">
          Message to {recipient}
        </label>
        <MessageBox id="task-message" className="field" placeholder={`Message to ${recipient}…`} value={text} onChange={setText} />
        <button type="submit" className="pill small on">
          Send
        </button>
      </form>
      {delivered && <p className="muted">{delivered === 'delivered' ? `Your message was delivered to ${recipient}.` : `Your message is waiting for ${recipient}'s next turn.`}</p>}

      <footer>
        {live && (
          <button type="button" className="pill small" onClick={() => void api.post(`/api/runs/${live.id}/stop`).catch(fail)}>
            Stop the run
          </button>
        )}
        {task.state !== 'done' && task.state !== 'failed' && (
          <button type="button" className="pill small" onClick={() => window.confirm(`Cancel "${task.title}"? Its runs stop and it is marked failed.`) && void api.patch(`/api/tasks/${taskId}`, { cancel: true }).catch(fail)}>
            Cancel the task
          </button>
        )}
        <label className="inline">
          Priority
          <select className="field" value={task.priority} onChange={(event) => void api.patch(`/api/tasks/${taskId}`, { priority: Number(event.target.value) }).catch(fail)}>
            <option value={1}>P1</option>
            <option value={2}>P2</option>
            <option value={3}>P3</option>
          </select>
        </label>
      </footer>
    </aside>
  );
}
