import { useEffect, useState, type FormEvent } from 'react';
import type { Capability, ModelTier } from '../../../src/shared/types.ts';
import { useApi } from '../app/context.ts';
import { useStore } from '../store/store.ts';

export type SkillOption = { id: string; label: string; description: string; source: 'bundled' | 'user' | 'plugin' | 'company'; path: string | null };
export type PresetOption = { id: string; label: string; role: string; capabilities: Capability[]; skills: string[]; tier: ModelTier; lead: boolean; model: string };
export type HireOptions = { presets: PresetOption[]; skills: SkillOption[]; models: { id: string; label: string; tier: ModelTier | null }[]; capabilities: { id: Capability; label: string }[]; availableByTeam: Record<string, Capability[]> };

const TIER_FOR: Record<ModelTier, string> = { member: 'engineers, analysts', lead: 'leads, reviewers', routine: 'routine' };
const SKILLS_SHOWN = 7;
const NEW_TEAM = '__new_team__';

/** Hiring is a form. The definition a session receives is generated from it; nothing is hand-edited. */
export function HireForm({ onNewTeam }: { onNewTeam(): void }) {
  const api = useApi();
  const teams = useStore((store) => [...store.teams.values()]);
  const employees = useStore((store) => store.employees);
  const [options, setOptions] = useState<HireOptions | null>(null);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
  const [lead, setLead] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  // Ticked to begin with: what most work needs. An employee with no tools can read nothing and do nothing but ask.
  const [capabilities, setCapabilities] = useState<Capability[]>(['read_files', 'run_commands', 'write_code']);
  const [allSkills, setAllSkills] = useState(false);
  const [find, setFind] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hired, setHired] = useState<string | null>(null);

  useEffect(() => {
    api.get<HireOptions>('/api/hire-options').then(
      (loaded) => {
        setOptions(loaded);
        setModel((current) => current || (loaded.models.find((m) => m.tier === 'member') ?? loaded.models[0])?.id || '');
      },
      (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams.length]);

  const team = teams.find((candidate) => candidate.id === teamId) ?? teams[0];
  const currentLead = team?.leadId ? employees.get(team.leadId) : undefined;
  const leadTaken = Boolean(team?.selfManaged || (currentLead && !currentLead.fired));
  const available = (team && options?.availableByTeam[team.id]) || [];
  if (!options) return <div className="hire muted">{error ?? 'Loading…'}</div>;
  const noTools = capabilities.filter((capability) => available.includes(capability)).length === 0;

  const chosenFirst = [...options.skills.filter((s) => skills.includes(s.id)), ...options.skills.filter((s) => !skills.includes(s.id))];
  const matching = find.trim() ? chosenFirst.filter((s) => `${s.id} ${s.description}`.toLowerCase().includes(find.trim().toLowerCase())) : chosenFirst;
  const shownSkills = allSkills ? matching : chosenFirst.slice(0, Math.max(SKILLS_SHOWN, skills.length));
  const selected = options.skills.filter((s) => skills.includes(s.id));
  const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? [...list, item] : list.filter((entry) => entry !== item));

  function usePreset(preset: PresetOption): void {
    setRole(preset.role);
    setSkills(preset.skills.filter((id) => options!.skills.some((s) => s.id === id)));
    setCapabilities(preset.capabilities.filter((capability) => available.includes(capability)));
    setModel(preset.model);
    setLead(preset.lead && !leadTaken);
    setPresetsOpen(false);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!team) return setError('Create a team first.');
    setError(null);
    setHired(null);
    try {
      await api.post('/api/employees', { name: name.trim(), teamId: team.id, role: role.trim(), model, lead: lead && !leadTaken, skills, capabilities: capabilities.filter((capability) => available.includes(capability)) });
      setHired(name.trim());
      setName('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <form className="hire" onSubmit={(event) => void submit(event)}>
      <div>
        <h1>Hire an employee</h1>
        <p className="muted">A singleton with a name, a team, a role sentence and skills. The definition the runtime receives is generated from this form; nothing here is hand-edited markdown.</p>
      </div>

      <div className="hire-grid">
        <label>
          Name
          <input className="field" required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Team
          <select className="field" value={team?.id ?? ''} onChange={(event) => (event.target.value === NEW_TEAM ? onNewTeam() : setTeamId(event.target.value))}>
            {teams.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
            <option value={NEW_TEAM}>New team…</option>
          </select>
        </label>
        <label className="wide">
          Role, in one sentence
          <input className="field" required value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <label>
          Model
          <select className="field" value={model} onChange={(event) => setModel(event.target.value)}>
            {options.models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.tier ? ` · ${TIER_FOR[option.tier]}` : ''}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="kind">
          <legend>Kind</legend>
          <label className={`choice${!lead ? ' on' : ''}`}>
            <input type="radio" name="kind" checked={!lead} onChange={() => setLead(false)} />
            Member
          </label>
          <label className={`choice${lead ? ' on' : ''}`} title={leadTaken ? (team?.selfManaged ? 'A self-managed team has no lead.' : `${currentLead?.name} leads this team.`) : undefined}>
            <input type="radio" name="kind" checked={lead && !leadTaken} disabled={leadTaken} onChange={() => setLead(true)} />
            Lead
          </label>
        </fieldset>
      </div>

      <div className="hire-group" role="group" aria-label="Skills · loaded first on every run">
        <div className="group-title">Skills · loaded first on every run</div>
        {allSkills && (
          <>
            <label htmlFor="find-skill" className="sr-only">
              Find a skill
            </label>
            <input id="find-skill" className="field small" placeholder="Find a skill…" value={find} onChange={(event) => setFind(event.target.value)} />
          </>
        )}
        <div className="chips">
          {shownSkills.map((skill) => (
            <label key={skill.id} className={`chip check${skills.includes(skill.id) ? ' on' : ''}`} title={skill.description}>
              <input type="checkbox" name={skill.id} checked={skills.includes(skill.id)} onChange={(event) => setSkills((current) => toggle(current, skill.id, event.target.checked))} />
              {skill.id}
            </label>
          ))}
          {!allSkills && options.skills.length > shownSkills.length && (
            <button type="button" className="chip dashed" onClick={() => setAllSkills(true)}>
              + {options.skills.length - shownSkills.length} more installed
            </button>
          )}
        </div>
        {selected.length > 0 && <div className="muted small">{`Selected: ${selected.map((skill) => `${skill.id} ${skill.description}`).join(' · ')}.`}</div>}
      </div>

      <div className="hire-group" role="group" aria-label="Tools · what the runtime mounts">
        <div className="group-title">Tools · what the runtime mounts</div>
        <div className="chips">
          {options.capabilities.map((capability) =>
            available.includes(capability.id) ? (
              <label key={capability.id} className={`chip check${capabilities.includes(capability.id) ? ' on' : ''}`}>
                <input type="checkbox" name={capability.id} checked={capabilities.includes(capability.id)} onChange={(event) => setCapabilities((current) => toggle(current, capability.id, event.target.checked))} />
                {capability.label}
              </label>
            ) : (
              <span key={capability.id} className="chip dashed off">
                {capability.label} · off for this team
              </span>
            ),
          )}
        </div>
      </div>

      {noTools && <p className="muted small">With no tools this employee can read nothing and do nothing but ask you questions. Tick at least one.</p>}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {hired && <p role="status">{hired} was hired.</p>}
      <div className="grow" />
      <div className="hire-actions">
        <button type="submit" className="pill on" disabled={noTools}>
          {`Hire ${name.trim()}`.trim()}
        </button>
        <button type="button" className="pill" aria-expanded={presetsOpen} onClick={() => setPresetsOpen((open) => !open)}>
          Start from a preset
        </button>
        {presetsOpen ? (
          options.presets.map((preset) => (
            <button key={preset.id} type="button" className="chip" onClick={() => usePreset(preset)}>
              {preset.label}
            </button>
          ))
        ) : (
          <span className="muted small">Presets: {options.presets.map((preset) => preset.label.toLowerCase()).join(' · ')}</span>
        )}
      </div>
    </form>
  );
}
