import { useState, type FormEvent } from 'react';
import type { Team } from '../../../src/shared/types.ts';
import { useApi } from '../app/context.ts';
import { useStore } from '../store/store.ts';

/** What xcodebuild must be able to write besides the task folder (measured in the spike). The engine resolves the two $ names. */
export const XCODE_BUILD_FOLDERS = ['~/Library/Developer/Xcode', '~/Library/Caches', '~/Library/org.swift.swiftpm', '$DARWIN_USER_CACHE_DIR', '$DARWIN_USER_TEMP_DIR'];

const FLAGS: [keyof Pick<Team, 'mayPush' | 'mayOpenPr' | 'mayPublish' | 'maySend' | 'mayPay' | 'mayDelete'>, string][] = [
  ['mayPush', 'push branches'],
  ['mayOpenPr', 'open pull requests'],
  ['mayPublish', 'publish'],
  ['maySend', 'send messages to people'],
  ['mayPay', 'spend money'],
  ['mayDelete', 'delete outside its folders'],
];

/** A team: its purpose, who leads it or nobody, what it may spend and touch. Limits live here, and the engine enforces them. */
export function TeamForm({ teamId, onDone }: { teamId?: string | undefined; onDone(): void }) {
  const api = useApi();
  const existing = useStore((store) => (teamId ? store.teams.get(teamId) : undefined), [teamId]);
  const repos = useStore((store) => [...store.repos.values()]);
  const [name, setName] = useState(existing?.name ?? '');
  const [purpose, setPurpose] = useState(existing?.purpose ?? '');
  const [selfManaged, setSelfManaged] = useState(existing?.selfManaged ?? false);
  const [dailyCapUsd, setDailyCapUsd] = useState(String(existing?.dailyCapUsd ?? 20));
  const [leaseMinutes, setLeaseMinutes] = useState(String(existing?.leaseMinutes ?? 15));
  const [teamRepos, setTeamRepos] = useState<Record<string, { baseBranch: string; mergeTarget: string }>>(Object.fromEntries((existing?.repos ?? []).map((r) => [r.repoId, { baseBranch: r.baseBranch, mergeTarget: r.mergeTarget ?? '' }])));
  const [flags, setFlags] = useState(Object.fromEntries(FLAGS.map(([flag]) => [flag, existing?.[flag] ?? false])));
  const [xcode, setXcode] = useState(Boolean(existing?.sandboxWrite.includes(XCODE_BUILD_FOLDERS[0]!)));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const others = (existing?.sandboxWrite ?? []).filter((folder) => !XCODE_BUILD_FOLDERS.includes(folder));
    const body = {
      name: name.trim(),
      purpose: purpose.trim(),
      selfManaged,
      dailyCapUsd: Number(dailyCapUsd),
      leaseMinutes: Number(leaseMinutes),
      maxReviewRounds: existing?.maxReviewRounds ?? 3,
      repos: Object.entries(teamRepos).map(([repoId, entry]) => ({ repoId, baseBranch: entry.baseBranch.trim(), mergeTarget: entry.mergeTarget.trim() || null })),
      ...flags,
      sandboxWrite: xcode ? [...others, ...XCODE_BUILD_FOLDERS] : others,
    };
    try {
      await (existing ? api.patch(`/api/teams/${existing.id}`, body) : api.post('/api/teams', body));
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <form className="panel" aria-label={existing ? `Edit ${existing.name}` : 'New team'} onSubmit={(event) => void submit(event)}>
      <h2>{existing ? `Edit ${existing.name}` : 'New team'}</h2>
      <label>
        Name
        <input className="field" required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Purpose
        <input className="field" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
      </label>
      <fieldset>
        <legend>How it works</legend>
        <label className="check">
          <input type="radio" name="managed" checked={!selfManaged} onChange={() => setSelfManaged(false)} />
          Led: a lead briefs and reviews
        </label>
        <label className="check">
          <input type="radio" name="managed" checked={selfManaged} onChange={() => setSelfManaged(true)} />
          Self-managed: each task goes straight to its assignee
        </label>
      </fieldset>
      <div className="row">
        <label>
          Spend per day
          <input className="field" type="number" min="0" step="1" required value={dailyCapUsd} onChange={(event) => setDailyCapUsd(event.target.value)} />
        </label>
        <label>
          Lease, in minutes
          <input className="field" type="number" min="1" step="1" required value={leaseMinutes} onChange={(event) => setLeaseMinutes(event.target.value)} />
        </label>
      </div>
      {repos.length > 0 && (
        <fieldset className="stack">
          <legend>Repositories it works in</legend>
          {repos.map((repo) => {
            const entry = teamRepos[repo.id];
            const set = (change: Partial<{ baseBranch: string; mergeTarget: string }>) => setTeamRepos((current) => ({ ...current, [repo.id]: { ...current[repo.id]!, ...change } }));
            return (
              <div key={repo.id} className="repo-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(entry)}
                    onChange={(event) =>
                      setTeamRepos((current) => {
                        const { [repo.id]: _dropped, ...rest } = current;
                        return event.target.checked ? { ...current, [repo.id]: { baseBranch: '', mergeTarget: '' } } : rest;
                      })
                    }
                  />
                  {repo.path}
                </label>
                {entry && (
                  <div className="row">
                    <label>
                      {/* The path is in the line above; here it is only for someone who cannot see that line. */}
                      Base branch<span className="sr-only"> for {repo.path}</span>
                      <input className="field" required value={entry.baseBranch} onChange={(event) => set({ baseBranch: event.target.value })} />
                    </label>
                    <label>
                      May merge into<span className="sr-only">, for {repo.path}</span>
                      <input className="field" placeholder="nothing: every merge is your decision" value={entry.mergeTarget} onChange={(event) => set({ mergeTarget: event.target.value })} />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
      <fieldset>
        <legend>This team may</legend>
        {FLAGS.map(([flag, label]) => (
          <label key={flag} className="check">
            <input type="checkbox" checked={Boolean(flags[flag])} onChange={(event) => setFlags((current) => ({ ...current, [flag]: event.target.checked }))} />
            {label}
          </label>
        ))}
        <p className="muted small">Only pushing has a mechanism in this version. The rest are recorded; a request for one becomes a decision for you.</p>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={xcode} onChange={(event) => setXcode(event.target.checked)} />
        Builds with Xcode: its commands may also write Xcode's own folders
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="pill on">
          {existing ? 'Save the team' : 'Create the team'}
        </button>
        <button type="button" className="pill" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
