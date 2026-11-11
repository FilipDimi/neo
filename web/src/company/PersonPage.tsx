import { useEffect, useState, type FormEvent } from 'react';
import type { Capability, Employee, Message, Run } from '../../../src/shared/types.ts';
import { useApi } from '../app/context.ts';
import { money } from '../format.ts';
import { MessageBox } from '../frame/MessageBox.tsx';
import { Prose } from '../frame/Prose.tsx';
import { skillSets, skillsInBrief } from '../../../src/shared/skills.ts';
import { personStatus } from '../model/select.ts';
import { useStore } from '../store/store.ts';
import type { HireOptions } from './HireForm.tsx';

type Detail = { employee: Employee; memoryIndex: string; runs: Run[]; spentToday: number };
type Draft = { role: string; model: string; effort: string; capabilities: Capability[]; skills: string[] };
const CAPABILITY_LABEL: Record<string, string> = { read_files: 'read files', run_commands: 'run commands', write_code: 'write code', web_search: 'web search', git_push: 'git push', send_messages: 'send messages' };
const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? [...list.filter((other) => other !== item), item] : list.filter((other) => other !== item));

/** One employee: who they are, what they remember, what they have done, and a line to them. */
export function PersonPage({ employeeId, onClose }: { employeeId: string; onClose(): void }) {
  const api = useApi();
  const employee = useStore((store) => store.employees.get(employeeId), [employeeId]);
  const team = useStore((store) => (employee ? store.teams.get(employee.teamId) : undefined), [employee?.teamId]);
  const status = useStore((store) => personStatus(store, employeeId), [employeeId]);
  const tasks = useStore((store) => store.tasks);
  // What was said between the user and this person, most recent last.
  const talk = useStore(
    (store) =>
      [...store.messages.values()]
        .filter((message) => (message.fromId === 'user' && message.toId === employeeId) || (message.fromId === employeeId && message.toId === 'user'))
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-6),
    [employeeId],
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [options, setOptions] = useState<HireOptions | null>(null);
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

  function edit(): void {
    setError(null);
    setDraft({ role: employee!.role, model: employee!.model, effort: employee!.effort ?? '', capabilities: employee!.capabilities, skills: employee!.skills });
    // What can be chosen: the models, the tools this team may have, the skills installed on this machine.
    api.get<HireOptions>('/api/hire-options').then(setOptions, fail);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    try {
      await api.patch(`/api/employees/${employeeId}`, { role: draft.role.trim(), model: draft.model, effort: draft.effort || null, skills: draft.skills, capabilities: draft.capabilities });
      setDraft(null);
    } catch (failure) {
      fail(failure);
    }
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!text.trim()) return;
    try {
      const reply = await api.post<{ message: Message }>(`/api/employees/${employeeId}/message`, { text: text.trim() });
      setNote(reply.message.taskId ? `${employee!.name} will answer here. If you asked for work, it goes on the ${team?.name ?? 'team'} board.` : `Your message goes to ${employee!.name} as the next turn of the run in progress.`);
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

  const allowed = options?.availableByTeam[employee.teamId] ?? [];
  const tools = (options?.capabilities ?? []).filter((capability) => allowed.includes(capability.id));
  const addable = (options?.skills ?? []).filter((skill) => !draft?.skills.includes(skill.id));
  // Families among what is installed, and the ones this person has every member of.
  const installedSets = skillSets((options?.skills ?? []).map((skill) => skill.id)).sets;
  const wholeSets = installedSets.filter((set) => set.ids.every((id) => draft?.skills.includes(id)));
  const inWholeSet = new Set(wholeSets.flatMap((set) => set.ids));
  const noTools = draft !== null && draft.capabilities.filter((capability) => !options || allowed.includes(capability)).length === 0;

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
      {draft === null ? (
        <section>
          <p>
            {employee.role}{' '}
            <button type="button" className="quiet" onClick={edit}>
              Edit
            </button>
          </p>
          <p className="muted">
            {employee.model} · {employee.effort ? `${employee.effort} effort` : "the model's own effort"} · {money(detail?.spentToday ?? 0)} today
          </p>
          <p className="muted">Tools: {employee.capabilities.map((capability) => CAPABILITY_LABEL[capability] ?? capability).join(', ') || 'none'}</p>
          <p className="muted">Skills: {skillsInBrief(employee.skills) || 'none'}</p>
        </section>
      ) : (
        <form className="person-edit" onSubmit={(event) => void save(event)}>
          <label htmlFor="edit-role" className="label">
            Role, in one sentence
          </label>
          <input id="edit-role" className="field" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} />

          <label htmlFor="edit-model" className="label">
            Model
          </label>
          <select id="edit-model" className="field" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {/* The model in use is always offered, whatever the list says. */}
            {[...new Set([draft.model, ...(options?.models.map((model) => model.id) ?? [])])].map((id) => (
              <option key={id} value={id}>
                {options?.models.find((model) => model.id === id)?.label ?? id}
              </option>
            ))}
          </select>

          <label htmlFor="edit-effort" className="label">
            Effort
          </label>
          <select id="edit-effort" className="field" value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.target.value })} title="How hard the model works on each piece of work. Higher thinks longer and costs more.">
            <option value="">The model's own</option>
            {/* The level in use is always offered, whatever the list says. */}
            {[...new Set([...(draft.effort ? [draft.effort] : []), ...(options?.efforts ?? []).map((effort) => effort.id)])].map((id) => (
              <option key={id} value={id}>
                {options?.efforts?.find((effort) => effort.id === id)?.label ?? id}
              </option>
            ))}
          </select>

          <div className="label">Tools</div>
          <div className="chips">
            {!options && <span className="muted small">Loading…</span>}
            {tools.map((capability) => (
              <label key={capability.id} className={`chip check${draft.capabilities.includes(capability.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={draft.capabilities.includes(capability.id)} onChange={(event) => setDraft({ ...draft, capabilities: toggle(draft.capabilities, capability.id, event.target.checked) })} />
                {capability.label}
              </label>
            ))}
          </div>
          {noTools && <p className="muted small">With no tools this employee can read nothing and do nothing but ask you questions. Tick at least one.</p>}

          <div className="label">Skills · one by itself is loaded first, a set is drawn on as the task needs</div>
          <div className="chips">
            {draft.skills.length === 0 && <span className="muted small">none</span>}
            {/* A family this person has whole is one tick: taking it away takes all of it. */}
            {wholeSets.map((set) => (
              <label key={`set:${set.name}`} className="chip check on" title={set.ids.join(', ')}>
                <input type="checkbox" checked onChange={() => setDraft({ ...draft, skills: draft.skills.filter((other) => !set.ids.includes(other)) })} />
                {`${set.name} · all ${set.ids.length}`}
              </label>
            ))}
            {draft.skills.filter((skill) => !inWholeSet.has(skill)).map((skill) => (
              <label key={skill} className="chip check on">
                <input type="checkbox" checked onChange={() => setDraft({ ...draft, skills: draft.skills.filter((other) => other !== skill) })} />
                {skill}
              </label>
            ))}
          </div>
          <label htmlFor="edit-skill" className="sr-only">
            Add a skill
          </label>
          <select
            id="edit-skill"
            className="field"
            value=""
            onChange={(event) => {
              const family = installedSets.find((set) => `set:${set.name}` === event.target.value);
              if (family) setDraft({ ...draft, skills: [...new Set([...draft.skills, ...family.ids])] });
              else if (event.target.value) setDraft({ ...draft, skills: [...draft.skills, event.target.value] });
            }}
          >
            <option value="">Add a skill…</option>
            {installedSets
              .filter((set) => !wholeSets.includes(set))
              .map((set) => (
                <option key={`set:${set.name}`} value={`set:${set.name}`}>
                  {`${set.name} · all ${set.ids.length} skills`}
                </option>
              ))}
            {addable.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.id}
              </option>
            ))}
          </select>

          <div className="chips">
            <button type="submit" className="pill small on" disabled={noTools || !draft.role.trim()}>
              Save
            </button>
            <button type="button" className="pill small" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <span className="muted small">Changes take effect at this person's next run.</span>
          </div>
        </form>
      )}
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
      {talk.length > 0 && (
        <section>
          <div className="label">Conversation</div>
          {talk.map((message) => (
            <div key={message.id} className={message.fromId === 'user' ? 'said mine' : 'said'}>
              <div className="said-who">{message.fromId === 'user' ? 'You' : employee.name}</div>
              <Prose text={message.text} />
            </div>
          ))}
        </section>
      )}
      <form className="drawer-message" onSubmit={(event) => void send(event)}>
        <label htmlFor="person-message" className="sr-only">
          Message to {employee.name}
        </label>
        <MessageBox id="person-message" className="field" placeholder={`Message to ${employee.name}…`} value={text} onChange={setText} />
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
