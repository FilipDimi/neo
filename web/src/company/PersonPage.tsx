import { useEffect, useState, type FormEvent } from 'react';
import type { Employee, Message, Run } from '../../../src/shared/types.ts';
import { useApi } from '../app/context.ts';
import { money } from '../format.ts';
import { personStatus } from '../model/select.ts';
import { useStore } from '../store/store.ts';

type Detail = { employee: Employee; memoryIndex: string; runs: Run[]; spentToday: number };
const CAPABILITY_LABEL: Record<string, string> = { read_files: 'read files', run_commands: 'run commands', write_code: 'write code', web_search: 'web search', git_push: 'git push', send_messages: 'send messages' };

/** One employee: who they are, what they remember, what they have done, and a line to them. */
export function PersonPage({ employeeId, onClose }: { employeeId: string; onClose(): void }) {
  const api = useApi();
  const employee = useStore((store) => store.employees.get(employeeId), [employeeId]);
  const team = useStore((store) => (employee ? store.teams.get(employee.teamId) : undefined), [employee?.teamId]);
  const status = useStore((store) => personStatus(store, employeeId), [employeeId]);
  const tasks = useStore((store) => store.tasks);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));

  useEffect(() => {
    let current = true;
    api.get<Detail>(`/api/employees/${employeeId}`).then((loaded) => current && setDetail(loaded), fail);
    return () => void (current = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!employee) return null;

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!text.trim()) return;
    try {
      const reply = await api.post<{ message: Message }>(`/api/employees/${employeeId}/message`, { text: text.trim() });
      setNote(reply.message.taskId ? `${employee!.name} was idle, so your message became a task on the board.` : `Your message goes to ${employee!.name} as the next turn of the run in progress.`);
      setText('');
    } catch (failure) {
      fail(failure);
    }
  }

  async function fire(): Promise<void> {
    if (!window.confirm(`Fire ${employee!.name}? Nothing in flight is stopped, and their memory is archived.`)) return;
    try {
      await api.post(`/api/employees/${employeeId}/fire`);
      onClose();
    } catch (failure) {
      fail(failure);
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label={employee.name}>
      <header>
        <div>
          <div className="label">
            {team?.name}
            {team?.leadId === employee.id ? ' · lead' : ''} · {status}
          </div>
          <h2>{employee.name}</h2>
        </div>
        <button type="button" className="quiet" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <section>
        {role === null ? (
          <p>
            {employee.role}{' '}
            <button type="button" className="quiet" onClick={() => setRole(employee.role)}>
              Edit
            </button>
          </p>
        ) : (
          <form
            className="drawer-message"
            onSubmit={(event) => {
              event.preventDefault();
              void api.patch(`/api/employees/${employeeId}`, { role }).then(() => setRole(null), fail);
            }}
          >
            <label htmlFor="edit-role" className="sr-only">
              Role, in one sentence
            </label>
            <input id="edit-role" className="field" value={role} onChange={(event) => setRole(event.target.value)} />
            <button type="submit" className="pill small on">
              Save
            </button>
          </form>
        )}
        <p className="muted">
          {employee.model} · {money(detail?.spentToday ?? 0)} today
        </p>
        <p className="muted">Tools: {employee.capabilities.map((capability) => CAPABILITY_LABEL[capability] ?? capability).join(', ') || 'none'}</p>
        <p className="muted">Skills: {employee.skills.join(', ') || 'none'}</p>
        <p className="muted small">Edits take effect at this person's next run.</p>
      </section>
      <section>
        <div className="label">What they remember</div>
        <pre className="memory">{detail ? detail.memoryIndex || 'Nothing yet.' : 'Loading…'}</pre>
      </section>
      <section>
        <div className="label">Runs</div>
        {(detail?.runs ?? []).length === 0 && <p className="muted">No runs yet.</p>}
        {[...(detail?.runs ?? [])].reverse().map((run) => (
          <div key={run.id} className="run">
            <span>{`${run.mode} · ${run.outcome} · ${money(run.costUsd)}`}</span>
            <span className="muted">{tasks.get(run.taskId)?.title ?? ''}</span>
          </div>
        ))}
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="drawer-message" onSubmit={(event) => void send(event)}>
        <label htmlFor="person-message" className="sr-only">
          Message to {employee.name}
        </label>
        <input id="person-message" className="field" placeholder={`Message to ${employee.name}…`} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="pill small on">
          Send
        </button>
      </form>
      {note && <p className="muted">{note}</p>}
      <footer>
        <button type="button" className="pill small" onClick={() => void fire()}>
          Fire {employee.name}
        </button>
      </footer>
    </aside>
  );
}
