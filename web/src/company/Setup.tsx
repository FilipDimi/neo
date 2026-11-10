import { useState, type FormEvent } from 'react';
import { useApi } from '../app/context.ts';

/** First start: name the company. Teams, people and more repositories come afterwards, on the Hire view. */
export function Setup({ onDone }: { onDone?: () => void }) {
  const api = useApi();
  const [name, setName] = useState('');
  const [chiefName, setChiefName] = useState('');
  const [rules, setRules] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [gateName, setGateName] = useState('');
  const [gateCommand, setGateCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/setup', { name: name.trim(), ...(chiefName.trim() ? { chiefName: chiefName.trim() } : {}), ...(rules.trim() ? { rules: rules.trim() } : {}) });
      if (repoPath.trim()) await api.post('/api/repos', { path: repoPath.trim(), gates: gateName.trim() && gateCommand.trim() ? [{ name: gateName.trim(), command: gateCommand.trim(), timeoutMinutes: 15, lock: null }] : [] });
      onDone?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  }

  return (
    <div className="setup">
      <form className="panel" onSubmit={(event) => void submit(event)}>
        <h2>Start a company</h2>
        <p className="muted">It runs on this machine, on the Claude login already here. You get a chief of staff to talk to; teams and people come next.</p>
        <label>
          Company name
          <input className="field" required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Chief of staff's name
          <input className="field" placeholder="Chief of staff" value={chiefName} onChange={(event) => setChiefName(event.target.value)} />
        </label>
        <label>
          Company rules
          <textarea className="field" rows={3} placeholder="What every employee must hold to, in plain sentences." value={rules} onChange={(event) => setRules(event.target.value)} />
        </label>
        <fieldset className="stack">
          <legend>A repository to work in (optional)</legend>
          <label>
            Repository path
            <input className="field" placeholder="/Users/you/code/project" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} />
          </label>
          <div className="row">
            <label>
              Gate name
              <input className="field" placeholder="tests" value={gateName} onChange={(event) => setGateName(event.target.value)} />
            </label>
            <label>
              Gate command
              <input className="field" placeholder="npm test" value={gateCommand} onChange={(event) => setGateCommand(event.target.value)} />
            </label>
          </div>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="pill on" disabled={busy}>
          Create the company
        </button>
      </form>
    </div>
  );
}
