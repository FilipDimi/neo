import { useUi } from '../app/context.ts';
import { orgChart, type Person } from '../model/select.ts';
import { useNow, useStore } from '../store/store.ts';

const STATUS_WORD: Record<Person['status'], string> = { working: 'working', reviewing: 'reviewing', idle: 'idle', stuck: 'stuck, needs you' };

function Dot({ status }: { status: Person['status'] }) {
  return <span className="dot" data-status={status} aria-hidden="true" />;
}

/** Who works here: the chief of staff, then each team with what it may do, its lead and its members. */
export function OrgChart({ onNewTeam, onEditTeam }: { onNewTeam(): void; onEditTeam(teamId: string): void }) {
  const ui = useUi();
  const now = useNow(5000);
  const chart = useStore((store) => orgChart(store, now), [now]);
  const row = (person: Person, title: string) => (
    <button type="button" className="person-row" data-status={person.status} aria-label={`${person.name}, ${title}, ${STATUS_WORD[person.status]}`} onClick={() => ui.openPerson(person.id)}>
      <span className="avatar">{person.tag}</span>
      <span>{title}</span>
      <span className="grow" />
      <span className="status-word" data-status={person.status}>
        {STATUS_WORD[person.status]}
      </span>
    </button>
  );
  return (
    <div className="org">
      <div className="label">Org chart</div>
      {chart.chief && row(chart.chief, 'Chief of staff')}
      {chart.teams.map((team) => (
        <div key={team.id} className="org-team">
          <div className="org-team-head">
            <span>{team.name}</span>
            <span className="muted">{team.summary}</span>
            <button type="button" className="quiet" aria-label={`Edit the team ${team.name}`} onClick={() => onEditTeam(team.id)}>
              Edit
            </button>
          </div>
          {team.lead && row(team.lead, team.lead.name)}
          <div className="chips">
            {team.members.map((member) => (
              <button key={member.id} type="button" className="chip" data-status={member.status} aria-label={`${member.name}, ${STATUS_WORD[member.status]}`} onClick={() => ui.openPerson(member.id)}>
                <Dot status={member.status} /> {member.name}
              </button>
            ))}
            {team.members.length === 0 && !team.lead && <span className="muted">nobody yet</span>}
          </div>
        </div>
      ))}
      <div className="grow" />
      <button type="button" className="pill" onClick={onNewTeam}>
        New team
      </button>
    </div>
  );
}
