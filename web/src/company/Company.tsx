import { useState } from 'react';
import { Scrim } from '../frame/Scrim.tsx';
import './company.css';
import { HireForm } from './HireForm.tsx';
import { OrgChart } from './OrgChart.tsx';
import { TeamForm } from './TeamForm.tsx';

/** The Hire view: the org chart on the left, the hire form on the right. */
export function Company() {
  const [teamForm, setTeamForm] = useState<{ teamId?: string } | null>(null);
  return (
    <div className="company-view">
      <OrgChart onNewTeam={() => setTeamForm({})} onEditTeam={(teamId) => setTeamForm({ teamId })} />
      <HireForm onNewTeam={() => setTeamForm({})} />
      {teamForm && (
        <Scrim onClose={() => setTeamForm(null)}>
          <TeamForm teamId={teamForm.teamId} onDone={() => setTeamForm(null)} />
        </Scrim>
      )}
    </div>
  );
}
