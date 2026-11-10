import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { company, employee, repo, T0, team } from '../../../test/rows.ts';
import { fromSnapshot } from '../store/reduce.ts';
import { fakeApi, mount } from '../testing.tsx';
import { NewTask } from './NewTask.tsx';

const gate = (name: string) => ({ name, command: name, timeoutMinutes: 5, lock: null });
const store = fromSnapshot({
  version: 1,
  company: company(),
  repos: [repo({ id: 'app', path: '/app', gates: [gate('tests'), gate('lint')] }), repo({ id: 'site', path: '/site', gates: [gate('build')] })],
  teams: [team({ id: 'ios', name: 'Engineering iOS', leadId: 'lead', repos: [{ repoId: 'app', baseBranch: 'main', mergeTarget: null }] }), team({ id: 'marketing', name: 'Marketing', selfManaged: true, repos: [{ repoId: 'site', baseBranch: 'main', mergeTarget: null }] })],
  employees: [employee({ id: 'lead', name: 'Priya', teamId: 'ios' }), employee({ id: 'ada', name: 'Ada', teamId: 'ios' }), employee({ id: 'mw', name: 'Mara', teamId: 'marketing' }), employee({ id: 'gone', name: 'Gone', teamId: 'marketing', fired: true })],
  tasks: [],
  runs: [],
  requests: [],
  decisions: [],
  messages: [],
  health: null,
  planUsage: null,
  spend: { company: 0, byTeam: {}, byEmployee: {} },
  lastEventId: 1,
  now: T0.toISOString(),
});

describe('NewTask', () => {
  it('posts a new task with the fields the engine expects', async () => {
    let done = 0;
    const { api } = mount(<NewTask onDone={() => done++} />, { store, now: T0, api: fakeApi(() => ({ task: {} })) });
    await userEvent.type(screen.getByLabelText('Title'), 'Edge scrubber on Today');
    await userEvent.type(screen.getByLabelText('Brief'), 'Add the scrubber.');
    await userEvent.type(screen.getByLabelText('Done when'), 'It scrubs.');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), '1');
    await userEvent.click(screen.getByLabelText('tests'));
    await userEvent.clear(screen.getByLabelText('Cap'));
    await userEvent.type(screen.getByLabelText('Cap'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Add the task' }));
    expect(api.calls).toEqual([['POST', '/api/tasks', { teamId: 'ios', title: 'Edge scrubber on Today', brief: 'Add the scrubber.', doneCondition: 'It scrubs.', priority: 1, assigneeId: null, repoId: 'app', gates: ['tests'], capUsd: 3 }]]);
    expect(done).toBe(1);
  });

  it("requires an assignee for a self-managed team and offers only that team's people and that repository's gates", async () => {
    const { api } = mount(<NewTask onDone={() => {}} />, { store, now: T0, api: fakeApi(() => ({ task: {} })) });
    await userEvent.selectOptions(screen.getByLabelText('Team'), 'marketing');
    expect(screen.queryByLabelText('tests')).toBeNull();
    expect(screen.getByLabelText('build')).toBeTruthy();
    const assignee = screen.getByLabelText('Assignee') as HTMLSelectElement;
    expect([...assignee.options].map((o) => o.textContent)).toEqual(['Choose…', 'Mara']);
    await userEvent.type(screen.getByLabelText('Title'), 'T');
    await userEvent.type(screen.getByLabelText('Brief'), 'B');
    await userEvent.click(screen.getByRole('button', { name: 'Add the task' }));
    expect(api.calls).toEqual([]);
    expect(screen.getByRole('alert').textContent).toMatch(/self-managed.*assignee/);
    await userEvent.selectOptions(assignee, 'mw');
    await userEvent.click(screen.getByRole('button', { name: 'Add the task' }));
    expect(api.calls[0]![2]).toMatchObject({ teamId: 'marketing', assigneeId: 'mw', repoId: 'site' });
  });

  it('on a led team the lead briefs it unless someone is chosen', () => {
    mount(<NewTask onDone={() => {}} />, { store, now: T0 });
    const assignee = screen.getByLabelText('Assignee') as HTMLSelectElement;
    expect([...assignee.options].map((o) => o.textContent)).toEqual(['The lead briefs it', 'Priya', 'Ada']);
  });

  it("shows the engine's reason when it refuses", async () => {
    mount(<NewTask onDone={() => {}} />, { store, now: T0, api: fakeApi(() => Promise.reject(new Error('no gate named "x"'))) });
    await userEvent.type(screen.getByLabelText('Title'), 'T');
    await userEvent.type(screen.getByLabelText('Brief'), 'B');
    await userEvent.click(screen.getByRole('button', { name: 'Add the task' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no gate named');
  });
});
