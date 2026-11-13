import { useEffect, useState, type FormEvent } from 'react';
import type { Capability, Employee, Message, Run } from '../../../src/shared/types.ts';
import { useApi, useUi } from '../app/context.ts';
import { countsCost, type TaskLine } from '../../../src/shared/view.ts';
import { money } from '../format.ts';
import { Figure } from '../frame/Figure.tsx';
import { MessageBox } from '../frame/MessageBox.tsx';
import { Prose } from '../frame/Prose.tsx';
import { skillSets, skillsInBrief } from '../../../src/shared/skills.ts';
import { memoryNotes, modelName, personView } from '../model/human.ts';
import { personStatus } from '../model/select.ts';
import { useNow, useStore } from '../store/store.ts';
import type { HireOptions } from './HireForm.tsx';

/** `runs` are theirs from the last week, or their last thirty. `tasks` name the tasks of those runs: the board may no longer hold them. */
type Detail = { employee: Employee; memoryIndex: string; runs: Run[]; tasks: TaskLine[]; spentToday: number };
type Draft = { role: string; model: string; effort: string; capabilities: Capability[]; skills: string[] };
const CAPABILITY_LABEL: Record<string, string> = { read_files: 'read files', run_commands: 'run commands', write_code: 'write code', web_search: 'web search', git_push: 'git push', send_messages: 'send messages' };
const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? [...list.filter((other) => other !== item), item] : list.filter((other) => other !== item));

/** How many pieces of recent work are shown before "Show all". */
const RECENT_SHOWN = 5;

/**
 * One employee, as a person: who they are and what they are doing, how the week went, what they last worked on, and
 * a line to them. What they remember and how they are set up (model, tools, skills) are one step away, folded.
 */
export function PersonPage({ employeeId, onClose }: { employeeId: string; onClose(): void }) {
  const api = useApi();
  const ui = useUi();
  // A minute is the smallest thing this page says about time.
  const now = useNow(30_000);
  const employee = useStore((store) => store.employees.get(employeeId), [employeeId]);
  const team = useStore((store) => (employee ? store.teams.get(employee.teamId) : undefined), [employee?.teamId]);
  const status = useStore((store) => personStatus(store, employeeId), [employeeId]);
  const tasks = useStore((store) => store.tasks);
  const priced = useStore((store) => countsCost(store.company));
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
  // How they are set up stays shut until asked for, and open while it is being changed.
  const [setupOpen, setSetupOpen] = useState(false);
  const [options, setOptions] = useState<HireOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allWork, setAllWork] = useState(false);
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));
  // What the page says above the fold, from the store and this person's runs.
  const view = useStore((store) => personView(store, employeeId, detail?.runs ?? [], now, detail?.tasks ?? []), [employeeId, detail, now.getTime()]);

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
      // A tool the team no longer allows has no box to untick here, and the engine refuses it: it is left out, as hiring does.
      const kept = options ? draft.capabilities.filter((capability) => (options.availableByTeam[employee!.teamId] ?? []).includes(capability)) : draft.capabilities;
      await api.patch(`/api/employees/${employeeId}`, { role: draft.role.trim(), model: draft.model, effort: draft.effort || null, skills: draft.skills, capabilities: kept });
      setError(null);
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

  const notes = memoryNotes(detail?.memoryIndex ?? '');
  const recent = view?.recent ?? [];
  const can = employee.capabilities.map((capability) => CAPABILITY_LABEL[capability] ?? capability);

  return (
    <aside className="drawer person" role="dialog" aria-label={employee.name}>
      <header className="who">
        {view && <Figure shirt={view.portrait.shirt} skin={view.portrait.skin} />}
        <div className="who-words">
          <h2>{employee.name}</h2>
          <p className="who-line" data-status={status}>
            {view?.who}
          </p>
        </div>
        <button type="button" className="quiet" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <p className="role">{employee.role}</p>

      {/* What is in front of them right now. It opens the task. */}
      {view?.doing &&
        (view.doing.taskId ? (
          <button type="button" className="doing" data-status={status} onClick={() => ui.openTask(view.doing!.taskId!)}>
            {view.doing.text}
          </button>
        ) : (
          <p className="doing" data-status={status}>
            {view.doing.text}
          </p>
        ))}

      <section>
        <p className="week">{detail ? view?.week : 'Loading…'}</p>
        {recent.length > 0 && (
          <>
            <h3>Recent work</h3>
            <ul className="work">
              {recent.slice(0, allWork ? recent.length : RECENT_SHOWN).map((work) => (
                <li key={work.taskId}>
                  {/* A task the board still holds opens. One that is history is told, and that is all there is of it here. */}
                  {work.open ? (
                    <button type="button" className="work-row" onClick={() => ui.openTask(work.taskId)}>
                      <span className="work-title">{work.title}</span>
                      <span className="work-line">
                        {work.did}, {work.state.toLowerCase()}, {work.when}
                      </span>
                    </button>
                  ) : (
                    <div className="work-row">
                      <span className="work-title">{work.title}</span>
                      <span className="work-line">
                        {work.did}, {work.state.toLowerCase()}, {work.when}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {recent.length > RECENT_SHOWN && !allWork && (
              <button type="button" className="quiet more-work" onClick={() => setAllWork(true)}>
                Show all {recent.length}
              </button>
            )}
          </>
        )}
      </section>

      {error && !draft && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {talk.length > 0 && (
        <section>
          <h3>Conversation</h3>
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

      {/* One step away: what they have noted down, in their own words. */}
      <details className="fold plain">
        <summary>{detail ? (notes.length === 0 ? `${employee.name} has noted nothing down yet` : `What ${employee.name} remembers (${notes.length} ${notes.length === 1 ? 'note' : 'notes'})`) : 'Loading…'}</summary>
        <ul className="notes">
          {notes.map((one, index) => (
            <li key={index}>
              {one.date && <span className="note-date">{one.date}</span>}
              <span>{one.text}</span>
            </li>
          ))}
        </ul>
      </details>

      {/* One step away: the machinery. Which model, which tools and skills, and the two things that change them. */}
      <details className="fold plain" open={setupOpen || draft !== null} onToggle={(event) => setSetupOpen(event.currentTarget.open)}>
        <summary>How {employee.name} is set up</summary>
      {draft === null ? (
        <section className="setup-lines">
          <p>
            Runs on <span title={employee.model}>{modelName(employee.model)}</span>
            {employee.effort ? `, at ${employee.effort} effort` : ''}.
          </p>
          <p>{can.length > 0 ? `Can ${can.join(', ')}.` : 'Has no tools: it can only ask you questions.'}</p>
          <p>{employee.skills.length > 0 ? `Skills: ${skillsInBrief(employee.skills)}.` : 'No skills.'}</p>
          {priced && <p>{money(detail?.spentToday ?? 0)} spent today.</p>}
          <div className="chips">
            <button type="button" className="pill small" onClick={edit}>
              Edit
            </button>
            <button type="button" className="pill small" onClick={() => void fire()}>
              Fire {employee.name}
            </button>
          </div>
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

          {/* Why a save was refused, beside the button that was pressed. */}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
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
      </details>
    </aside>
  );
}
