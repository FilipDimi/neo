import { useRef, useState, type FormEvent } from 'react';
import { useApi } from '../app/context.ts';
import { countsCost } from '../../../src/shared/view.ts';
import { useStore } from '../store/store.ts';

/** A task typed straight onto the board. On a led team the lead briefs it unless someone is chosen. */
export function NewTask({ onDone }: { onDone(): void }) {
  const api = useApi();
  const teams = useStore((store) => [...store.teams.values()]);
  const people = useStore((store) => [...store.employees.values()].filter((employee) => !employee.fired));
  const repos = useStore((store) => store.repos);
  const priced = useStore((store) => countsCost(store.company));
  const chiefTeam = useStore((store) => (store.company?.chiefOfStaffId ? store.employees.get(store.company.chiefOfStaffId)?.teamId : undefined));
  const choices = teams.filter((team) => team.id !== chiefTeam);
  const [teamId, setTeamId] = useState(choices[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [doneCondition, setDoneCondition] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('2');
  const [gates, setGates] = useState<string[]>([]);
  const [cap, setCap] = useState('2');
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  const team = choices.find((candidate) => candidate.id === teamId);
  const members = people.filter((employee) => employee.teamId === teamId);
  const repo = team?.repos[0] ? repos.get(team.repos[0].repoId) : undefined;

  function pickTeam(id: string): void {
    setTeamId(id);
    setAssigneeId('');
    setGates([]);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!team) return setError('Choose a team.');
    if (team.selfManaged && !assigneeId) return setError(`${team.name} is self-managed, so this task needs an assignee.`);
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      await api.post('/api/tasks', { teamId, title: title.trim(), brief: brief.trim(), doneCondition: doneCondition.trim(), priority: Number(priority), assigneeId: assigneeId || null, repoId: repo?.id ?? null, gates, capUsd: Number(cap) });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    sending.current = false;
  }

  return (
    <form className="panel new-task-form" aria-label="New task" onSubmit={(event) => void submit(event)}>
      <h2>New task</h2>
      <label>
        Team
        <select className="field" value={teamId} onChange={(event) => pickTeam(event.target.value)}>
          {choices.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input className="field" required value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Brief
        <textarea className="field" required rows={4} value={brief} onChange={(event) => setBrief(event.target.value)} />
      </label>
      <label>
        Done when
        <input className="field" value={doneCondition} onChange={(event) => setDoneCondition(event.target.value)} />
      </label>
      <div className="row">
        <label>
          Assignee
          <select className="field" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
            <option value="">{team?.selfManaged ? 'Choose…' : 'The lead briefs it'}</option>
            {members.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select className="field" value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="1">P1</option>
            <option value="2">P2</option>
            <option value="3">P3</option>
          </select>
        </label>
        {priced && (
          <label>
            Cap
            <input className="field" type="number" min="0.1" step="0.1" required value={cap} onChange={(event) => setCap(event.target.value)} />
          </label>
        )}
      </div>
      {repo && repo.gates.length > 0 && (
        <fieldset>
          <legend>Gates the engine runs</legend>
          {repo.gates.map((gate) => (
            <label key={gate.name} className="check">
              <input type="checkbox" checked={gates.includes(gate.name)} onChange={(event) => setGates((current) => (event.target.checked ? [...current, gate.name] : current.filter((name) => name !== gate.name)))} />
              {gate.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="pill on">
          Add the task
        </button>
        <button type="button" className="pill" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
