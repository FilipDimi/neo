import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { company, employee, repo, run, T0, task, team } from '../../../test/rows.ts';
import { storyAt } from '../fixtures/story.ts';
import { fromSnapshot } from '../store/reduce.ts';
import { fakeApi, mount } from '../testing.tsx';
import { HireForm, type HireOptions } from './HireForm.tsx';
import { OrgChart } from './OrgChart.tsx';
import { PersonPage } from './PersonPage.tsx';
import { Setup } from './Setup.tsx';
import { TeamForm, XCODE_BUILD_FOLDERS } from './TeamForm.tsx';

const skill = (id: string, description: string, source: 'bundled' | 'user' | 'plugin' | 'company' = 'user') => ({ id, label: id.split(':').pop()!, description, source, path: null });
const OPTIONS: HireOptions = {
  presets: [
    { id: 'engineering_lead', label: 'Engineering lead', role: 'Splits work, reviews it and integrates it.', capabilities: ['read_files', 'run_commands', 'write_code'], skills: [], tier: 'lead', lead: true, model: 'claude-opus-5-5' },
    { id: 'analyst', label: 'Analyst', role: 'Reads logs and data and writes a short note with what to change.', capabilities: ['read_files', 'run_commands', 'web_search'], skills: ['dataviz'], tier: 'member', lead: false, model: 'claude-sonnet-5-5' },
  ],
  skills: [skill('dataviz', 'makes charts', 'bundled'), ...Array.from({ length: 10 }, (_, i) => skill(`user:s${i}-skill`, `does thing ${i}`)), skill('apple-skills:performance', 'loads Instruments and hang analysis', 'plugin'), skill('company:privacy-rules', 'keeps the seven answers off every log line', 'company')],
  models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'member' }, { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'lead' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 'routine' }],
  efforts: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }, { id: 'max', label: 'Max' }],
  capabilities: [{ id: 'read_files', label: 'read files' }, { id: 'run_commands', label: 'run commands' }, { id: 'write_code', label: 'write code' }, { id: 'web_search', label: 'web search' }, { id: 'git_push', label: 'git push' }, { id: 'send_messages', label: 'send messages' }],
  availableByTeam: { ios: ['read_files', 'run_commands', 'write_code', 'web_search'], marketing: ['read_files', 'run_commands', 'write_code', 'web_search'] },
};
const store = fromSnapshot({
  version: 1,
  company: company(),
  repos: [repo({ id: 'app', path: '/code/app' })],
  teams: [team({ id: 'ios', name: 'Engineering iOS', leadId: 'lead' }), team({ id: 'marketing', name: 'Marketing', selfManaged: true })],
  employees: [employee({ id: 'lead', name: 'Priya', teamId: 'ios' })],
  tasks: [],
  runs: [],
  requests: [],
  decisions: [],
  messages: [],
  health: null,
  planUsage: null,
  spend: { company: 0, byTeam: {}, byEmployee: { lead: 1.5 } },
  lastEventId: 1,
  now: T0.toISOString(),
});
const hireApi = (onPost: (body: unknown) => unknown = () => ({ employee: { name: 'Ada' } })) => fakeApi((method, _path, body) => (method === 'GET' ? OPTIONS : onPost(body)));
const form = async (api = hireApi()) => {
  const mounted = mount(<HireForm onNewTeam={() => {}} />, { store, now: T0, api });
  await screen.findByLabelText('Name');
  return mounted;
};

describe('HireForm', () => {
  it('offers skills, a few at first, and counts the rest as "+ N more installed"', async () => {
    await form();
    const skills = screen.getByRole('group', { name: /Skills/ });
    expect(within(skills).getAllByRole('checkbox')).toHaveLength(7);
    expect(within(skills).getByRole('button', { name: '+ 6 more installed' })).toBeTruthy();
    await userEvent.click(within(skills).getByRole('button', { name: '+ 6 more installed' }));
    expect(within(skills).getAllByRole('checkbox')).toHaveLength(13);
    await userEvent.type(within(skills).getByLabelText('Find a skill'), 'privacy');
    expect(within(skills).getAllByRole('checkbox').map((box) => (box as HTMLInputElement).name)).toEqual(['company:privacy-rules']);
  });

  it('offers a family of skills as one tick, and says it in one word when it is chosen', async () => {
    const gsd = ['add-backlog', 'add-phase', 'plan-phase', 'verify-work'].map((name) => skill(`user:gsd-${name}`, `gsd ${name}`));
    const api = fakeApi((method) => (method === 'GET' ? { ...OPTIONS, skills: [...OPTIONS.skills, ...gsd] } : { employee: { name: 'Ada' } }));
    await form(api);
    const skills = screen.getByRole('group', { name: /Skills/ });
    // One tick for the family; its members are not laid out one by one.
    const family = within(skills).getByLabelText('gsd · 4 skills') as HTMLInputElement;
    expect(within(skills).queryByLabelText('user:gsd-add-phase')).toBeNull();
    await userEvent.click(family);
    expect((within(skills).getByLabelText('gsd · all 4') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Selected: gsd (all 4).')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Role, in one sentence'), 'Plans the work.');
    await userEvent.selectOptions(screen.getByLabelText('Effort'), 'xhigh');
    await userEvent.click(screen.getByRole('button', { name: 'Hire Ada' }));
    expect(api.calls.at(-1)![2]).toMatchObject({ effort: 'xhigh', skills: gsd.map((entry) => entry.id) });
    // One of a family can still be found and taken by itself.
    await userEvent.click(within(skills).getByLabelText('gsd · all 4'));
    await userEvent.click(within(skills).getByRole('button', { name: /more installed/ }));
    await userEvent.type(within(skills).getByLabelText('Find a skill'), 'plan-phase');
    await userEvent.click(within(skills).getByLabelText('user:gsd-plan-phase'));
    expect((within(skills).getByLabelText('gsd · 1 of 4') as HTMLInputElement).checked).toBe(false);
  });

  it("puts chosen skills first and builds the Selected line from their descriptions", async () => {
    await form();
    const skills = screen.getByRole('group', { name: /Skills/ });
    await userEvent.click(within(skills).getByRole('button', { name: /more installed/ }));
    await userEvent.click(within(skills).getByLabelText('apple-skills:performance'));
    await userEvent.click(within(skills).getByLabelText('dataviz'));
    expect(screen.getByText('Selected: dataviz makes charts · apple-skills:performance loads Instruments and hang analysis.')).toBeTruthy();
    expect(within(skills).getAllByRole('checkbox').slice(0, 2).map((box) => (box as HTMLInputElement).name)).toEqual(['dataviz', 'apple-skills:performance']);
  });

  it('shows an unavailable capability as "<label> · off for this team" and does not send it', async () => {
    await form();
    const tools = screen.getByRole('group', { name: /Tools/ });
    expect(within(tools).getByText('send messages · off for this team')).toBeTruthy();
    expect(within(tools).getByText('git push · off for this team')).toBeTruthy();
    expect(within(tools).queryByLabelText('send messages')).toBeNull();
    expect(within(tools).getAllByRole('checkbox').map((box) => (box as HTMLInputElement).name)).toEqual(['read_files', 'run_commands', 'write_code', 'web_search']);
  });

  it('disables Lead when the team already has one or is self-managed', async () => {
    await form();
    expect((screen.getByLabelText('Lead') as HTMLInputElement).disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Team'), 'marketing');
    expect((screen.getByLabelText('Lead') as HTMLInputElement).disabled).toBe(true);
  });

  it('will not hire someone with every tool unticked, and says why', async () => {
    const { api } = await form();
    await userEvent.type(screen.getByLabelText('Name'), 'Pat');
    await userEvent.type(screen.getByLabelText('Role, in one sentence'), 'Researches the market.');
    for (const tool of ['read files', 'run commands', 'write code']) await userEvent.click(screen.getByLabelText(tool));
    expect(screen.getByText(/With no tools this employee can read nothing and do nothing but ask you questions/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Hire Pat' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.calls.some(([method]) => method === 'POST')).toBe(false);
  });

  it('posts the hire form\'s fields and names the button after the person', async () => {
    const { api } = await form();
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    expect(screen.getByRole('button', { name: 'Hire Ada' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Role, in one sentence'), 'Reads the usage logs and writes a weekly note.');
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5-5');
    await userEvent.click(screen.getByLabelText('dataviz'));
    // Reading, running commands and writing are ticked to begin with: an employee with no tools can only ask.
    for (const tool of ['read files', 'run commands', 'write code']) expect((screen.getByLabelText(tool) as HTMLInputElement).checked, tool).toBe(true);
    expect((screen.getByLabelText('web search') as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByLabelText('write code'));
    await userEvent.click(screen.getByRole('button', { name: 'Hire Ada' }));
    expect(api.calls.at(-1)).toEqual(['POST', '/api/employees', { name: 'Ada', teamId: 'ios', role: 'Reads the usage logs and writes a weekly note.', model: 'claude-opus-5-5', effort: null, lead: false, skills: ['dataviz'], capabilities: ['read_files', 'run_commands'] }]);
    expect(await screen.findByText('Ada was hired.')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  it('a preset fills role, skills, tools, model and kind', async () => {
    const { api } = await form();
    await userEvent.type(screen.getByLabelText('Name'), 'Quinn');
    await userEvent.click(screen.getByRole('button', { name: 'Start from a preset' }));
    await userEvent.click(screen.getByRole('button', { name: 'Analyst' }));
    expect((screen.getByLabelText('Role, in one sentence') as HTMLInputElement).value).toBe('Reads logs and data and writes a short note with what to change.');
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('claude-sonnet-5-5');
    await userEvent.click(screen.getByRole('button', { name: 'Hire Quinn' }));
    expect(api.calls.at(-1)![2]).toMatchObject({ skills: ['dataviz'], capabilities: ['read_files', 'run_commands', 'web_search'], lead: false });
  });

  it("shows the engine's reason when it refuses", async () => {
    await form(hireApi(() => Promise.reject(new Error('the team Engineering iOS already has a lead, Priya'))));
    await userEvent.type(screen.getByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Role, in one sentence'), 'Writes code.');
    await userEvent.click(screen.getByRole('button', { name: 'Hire Ada' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has a lead');
  });
});

describe('OrgChart', () => {
  it('lists the chief of staff, then each team with its summary, lead and members', () => {
    const { store: day, now } = storyAt('lease_card');
    mount(<OrgChart onNewTeam={() => {}} onEditTeam={() => {}} />, { store: day, now });
    expect(screen.getByRole('button', { name: /Neo/ })).toBeTruthy();
    expect(screen.getByText('led · $20/day · may merge: track/ios')).toBeTruthy();
    expect(screen.getByText('self-managed · $5/day · may publish: no')).toBeTruthy();
    expect(screen.getByRole('button', { name: /iOS lead/ })).toBeTruthy();
  });

  it('shows a stuck member on the red ground, and opens a person when clicked', async () => {
    const { store: day, now } = storyAt('lease_card');
    const { ui } = mount(<OrgChart onNewTeam={() => {}} onEditTeam={() => {}} />, { store: day, now });
    const nh = screen.getByRole('button', { name: /NH/ });
    expect(nh.getAttribute('data-status')).toBe('stuck');
    await userEvent.click(nh);
    expect(ui.asked).toEqual([['openPerson', 'nh']]);
  });
});

describe('TeamForm', () => {
  it('a new team has no merge target unless one is chosen', async () => {
    let done = 0;
    const { api } = mount(<TeamForm onDone={() => done++} />, { store, now: T0, api: fakeApi(() => ({ team: {} })) });
    await userEvent.type(screen.getByLabelText('Name'), 'Engineering Rust');
    await userEvent.type(screen.getByLabelText('Purpose'), 'Builds the backend.');
    await userEvent.click(screen.getByLabelText('/code/app'));
    await userEvent.type(screen.getByLabelText('Base branch for /code/app'), 'track/rust');
    await userEvent.click(screen.getByRole('button', { name: 'Create the team' }));
    expect(api.calls).toEqual([['POST', '/api/teams', expect.objectContaining({ name: 'Engineering Rust', purpose: 'Builds the backend.', selfManaged: false, dailyCapUsd: 20, leaseMinutes: 15, repos: [{ repoId: 'app', baseBranch: 'track/rust', mergeTarget: null }], sandboxWrite: [] })]]);
    expect(done).toBe(1);
  });

  it('"Builds with Xcode" sets the build profile, and a merge target is sent when given', async () => {
    const { api } = mount(<TeamForm onDone={() => {}} />, { store, now: T0, api: fakeApi(() => ({ team: {} })) });
    await userEvent.type(screen.getByLabelText('Name'), 'Engineering iOS 2');
    await userEvent.click(screen.getByLabelText('/code/app'));
    await userEvent.type(screen.getByLabelText('Base branch for /code/app'), 'track/ios');
    await userEvent.type(screen.getByLabelText('May merge into, for /code/app'), 'track/ios');
    await userEvent.click(screen.getByLabelText(/Builds with Xcode/));
    await userEvent.click(screen.getByRole('button', { name: 'Create the team' }));
    expect(api.calls[0]![2]).toMatchObject({ repos: [{ repoId: 'app', baseBranch: 'track/ios', mergeTarget: 'track/ios' }], sandboxWrite: XCODE_BUILD_FOLDERS });
    expect(XCODE_BUILD_FOLDERS).toContain('~/Library/Developer/Xcode');
  });

  it('removes a team after asking, and does nothing when the answer is no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    let done = 0;
    const { api } = mount(<TeamForm teamId="ios" onDone={() => done++} />, { store, now: T0, api: fakeApi(() => ({ team: {} })) });
    await userEvent.click(screen.getByRole('button', { name: 'Remove the team' }));
    expect(api.calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove the team' }));
    await waitFor(() => expect(api.calls).toEqual([['POST', '/api/teams/ios/remove']]));
    expect(confirm.mock.calls[0]![0]).toMatch(/Remove Engineering iOS\? Everyone on it is fired/);
    await waitFor(() => expect(done).toBe(1));
    confirm.mockRestore();
  });

  it('offers no Remove on a team that is being made', () => {
    mount(<TeamForm onDone={() => {}} />, { store, now: T0, api: fakeApi(() => ({ team: {} })) });
    expect(screen.queryByRole('button', { name: 'Remove the team' })).toBeNull();
  });

  it('edits an existing team with PATCH', async () => {
    const { api } = mount(<TeamForm teamId="ios" onDone={() => {}} />, { store, now: T0, api: fakeApi(() => ({ team: {} })) });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Engineering iOS');
    await userEvent.clear(screen.getByLabelText('Spend per day'));
    await userEvent.type(screen.getByLabelText('Spend per day'), '35');
    await userEvent.click(screen.getByRole('button', { name: 'Save the team' }));
    expect(api.calls[0]).toEqual(['PATCH', '/api/teams/ios', expect.objectContaining({ dailyCapUsd: 35 })]);
  });
});

describe('PersonPage', () => {
  const detail = { employee: store.employees.get('lead')!, memoryIndex: '- 2026-11-08: Learned the roster shape.', runs: [run({ employeeId: 'lead', outcome: 'done', mode: 'review', costUsd: 0.2 })], spentToday: 1.5 };

  it('opens on who the person is, how their week went and what they last worked on', async () => {
    const reviewed = run({ id: 'r1', employeeId: 'lead', taskId: 'task1', outcome: 'done', mode: 'review', reason: 'approved', costUsd: 0.2, startedAt: T0.toISOString(), endedAt: T0.toISOString() });
    const withWork = { ...store, tasks: new Map([['task1', task({ title: 'Serve the stages', teamId: 'ios', state: 'done', mergedInto: 'team' })]]) };
    const api = fakeApi(() => ({ ...detail, runs: [reviewed] }));
    const { ui } = mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: withWork, now: T0, api });
    expect(screen.getByRole('dialog', { name: 'Priya' })).toBeTruthy();
    expect(screen.getByText('Leads Engineering iOS. Free right now.')).toBeTruthy();
    expect(screen.getByText('Writes code.')).toBeTruthy();
    expect(await screen.findByText('This week Priya reviewed 1 task.')).toBeTruthy();
    // Recent work is by task, in words, and opens the task.
    const work = screen.getByRole('button', { name: /Serve the stages/ });
    expect(work.textContent).toContain('reviewed it, landed, 0 s ago');
    await userEvent.click(work);
    expect(ui.asked).toContainEqual(['openTask', 'task1', undefined]);
    // Nothing of the machinery is said in the open: no run record, no model id.
    expect(screen.queryByText(/review · done/)).toBeNull();
    expect(screen.queryByText(/claude-/)).toBeNull();
  });

  it('keeps what they remember and how they are set up one step away, in plain words', async () => {
    const api = fakeApi(() => detail);
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store, now: T0, api });
    const memory = (await screen.findByText('What Priya remembers (1 note)')).closest('details')!;
    expect(memory.open).toBe(false);
    expect(within(memory).getByText('Learned the roster shape.')).toBeTruthy();
    expect(within(memory).getByText('8 Nov')).toBeTruthy();
    const setup = screen.getByText('How Priya is set up').closest('details')!;
    expect(setup.open).toBe(false);
    // The model is said as people say it; its id is there for whoever hovers.
    expect(within(setup).getByText('Haiku 5.5').getAttribute('title')).toBe('claude-haiku-5-5');
    expect(within(setup).getByText('Can read files, write code.')).toBeTruthy();
    expect(within(setup).getByText('$1.50 spent today.')).toBeTruthy();
  });

  it('says what is in front of someone who is working, and opens it', async () => {
    const working = run({ id: 'live', employeeId: 'lead', taskId: 'task1', startedAt: new Date(T0.getTime() - 5 * 60_000).toISOString() });
    const busy = { ...store, tasks: new Map([['task1', task({ title: 'Serve the stages', teamId: 'ios', state: 'running', assigneeId: 'lead' })]]), runs: new Map([['live', working]]) };
    const { ui } = mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: busy, now: T0, api: fakeApi(() => ({ ...detail, runs: [working] })) });
    expect(screen.getByText('Leads Engineering iOS. Working now.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Working on "Serve the stages", for 5 min' }));
    expect(ui.asked).toContainEqual(['openTask', 'task1', undefined]);
  });

  it("changes a person's role, model, tools and skills from their page", async () => {
    const lead = store.employees.get('lead')!;
    const api = fakeApi((method, route) => (method === 'GET' ? (route === '/api/hire-options' ? OPTIONS : detail) : {}));
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: { ...store, employees: new Map([['lead', { ...lead, capabilities: ['read_files'], skills: ['dataviz'], model: 'claude-sonnet-5-5' }]]) }, now: T0, api });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // What the person has now is what the form starts from.
    expect((await screen.findByLabelText('read files') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('web search') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('dataviz') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('git push')).toBeNull(); // not a tool this team can have
    await userEvent.click(screen.getByLabelText('web search'));
    await userEvent.click(screen.getByLabelText('dataviz'));
    await userEvent.selectOptions(screen.getByLabelText('Add a skill'), 'company:privacy-rules');
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5-5');
    await userEvent.clear(screen.getByLabelText('Role, in one sentence'));
    await userEvent.type(screen.getByLabelText('Role, in one sentence'), 'Researches the market.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.calls).toContainEqual(['PATCH', '/api/employees/lead', { role: 'Researches the market.', model: 'claude-opus-5-5', effort: null, skills: ['company:privacy-rules'], capabilities: ['read_files', 'web_search'] }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('will not save a person with every tool unticked, and can be cancelled', async () => {
    const lead = store.employees.get('lead')!;
    const api = fakeApi((method, route) => (method === 'GET' ? (route === '/api/hire-options' ? OPTIONS : detail) : {}));
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: { ...store, employees: new Map([['lead', { ...lead, capabilities: ['read_files'] }]]) }, now: T0, api });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByLabelText('read files'));
    expect(screen.getByText(/With no tools this employee can read nothing/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(api.calls.some(([method]) => method === 'PATCH')).toBe(false);
  });

  it('shows the effort and a family of skills in a few words, and lets both be changed', async () => {
    const gsd = ['add-backlog', 'add-phase', 'plan-phase', 'verify-work'].map((name) => `user:gsd-${name}`);
    const lead = store.employees.get('lead')!;
    const api = fakeApi((method, path) => (path === '/api/hire-options' ? { ...OPTIONS, skills: [...OPTIONS.skills, ...gsd.map((id) => skill(id, id))] } : method === 'GET' ? detail : { employee: lead }));
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: { ...store, employees: new Map([['lead', { ...lead, effort: 'high' as const, capabilities: ['read_files' as const], skills: ['dataviz', ...gsd] }]]) }, now: T0, api });
    expect(await screen.findByText(/high effort/)).toBeTruthy();
    expect(screen.getByText('Skills: gsd (4), dataviz.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(await screen.findByLabelText('Effort'), 'max');
    // The family is one tick here too: taking it away takes all four.
    await userEvent.click(screen.getByLabelText('gsd · all 4'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.calls.find((call) => call[0] === 'PATCH')![2]).toMatchObject({ effort: 'max', skills: ['dataviz'] });
  });

  it('shows what was said between the user and this person, and nothing said to anyone else', () => {
    const said = (id: string, fromId: string, toId: string, text: string, seconds: number) => ({ id, fromId, toId, taskId: null, text, state: 'delivered' as const, at: new Date(T0.getTime() + seconds * 1000).toISOString(), deliveredAt: null });
    const talking = {
      ...store,
      messages: new Map([said('m1', 'user', 'lead', 'yo, what are we working on?', 1), said('m2', 'lead', 'user', 'Nothing right now: the board is empty.', 2), said('m3', 'user', 'someone-else', 'Not for Priya.', 3)].map((message) => [message.id, message])),
    };
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: talking, now: T0, api: fakeApi(() => detail) });
    const lines = [...document.querySelectorAll('.said')].map((line) => [line.querySelector('.said-who')!.textContent, line.querySelector('.prose')!.textContent]);
    expect(lines).toEqual([
      ['You', 'yo, what are we working on?'],
      ['Priya', 'Nothing right now: the board is empty.'],
    ]);
    expect(screen.queryByText(/Not for Priya/)).toBeNull();
  });

  it('shows a long answer with its formatting, not with the marks it was written in', () => {
    const answer = '**Where it stands:** two tasks are on the board.\n\n- the header is in review\n- the footer is queued';
    const talking = { ...store, messages: new Map([['m1', { id: 'm1', fromId: 'lead', toId: 'user', taskId: null, text: answer, state: 'delivered' as const, at: T0.toISOString(), deliveredAt: null }]]) };
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store: talking, now: T0, api: fakeApi(() => detail) });
    expect(screen.getByText('Where it stands:').tagName).toBe('STRONG');
    expect(within(document.querySelector<HTMLElement>('.said')!).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['the header is in review', 'the footer is queued']);
    expect(document.querySelector('.said')!.textContent).not.toContain('**');
  });

  it('takes a message of several lines in a box that shows them all', async () => {
    const api = fakeApi((method) => (method === 'GET' ? detail : { message: { state: 'delivered', taskId: 't1' } }));
    mount(<PersonPage employeeId="lead" onClose={() => {}} />, { store, now: T0, api });
    const box = screen.getByLabelText('Message to Priya');
    expect(box.tagName).toBe('TEXTAREA');
    await userEvent.type(box, 'Two things:{Shift>}{Enter}{/Shift}first, the header.{Enter}');
    expect(api.calls).toContainEqual(['POST', '/api/employees/lead/message', { text: 'Two things:\nfirst, the header.' }]);
  });

  it('sends a message, and asks before firing', async () => {
    const api = fakeApi((method) => (method === 'GET' ? detail : { message: { state: 'delivered', taskId: 't1' } }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    let closed = 0;
    mount(<PersonPage employeeId="lead" onClose={() => closed++} />, { store, now: T0, api });
    await userEvent.type(screen.getByLabelText('Message to Priya'), 'Draft three taglines.{Enter}');
    expect(api.calls).toContainEqual(['POST', '/api/employees/lead/message', { text: 'Draft three taglines.' }]);
    expect(await screen.findByText(/Priya will answer here/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Fire Priya' }));
    expect(api.calls.some((c) => c[1].endsWith('/fire'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Fire Priya' }));
    await waitFor(() => expect(api.calls).toContainEqual(['POST', '/api/employees/lead/fire']));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(closed).toBe(1));
  });
});

describe('Setup', () => {
  it('posts the company, then each repository', async () => {
    const api = fakeApi(() => ({}));
    mount(<Setup />, { store: { ...store, company: null }, now: T0, api });
    await userEvent.type(screen.getByLabelText('Company name'), 'Receipts Inc.');
    await userEvent.type(screen.getByLabelText("Chief of staff's name"), 'Neo');
    await userEvent.type(screen.getByLabelText('Company rules'), 'Nothing invented.');
    await userEvent.type(screen.getByLabelText('Repository path'), '/code/receipt');
    await userEvent.type(screen.getByLabelText('Gate name'), 'tests');
    await userEvent.type(screen.getByLabelText('Gate command'), 'cargo test');
    await userEvent.click(screen.getByRole('button', { name: 'Create the company' }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    // One call: the engine checks the repository before it makes the company, so a path it cannot use leaves nothing behind.
    expect(api.calls[0]).toEqual(['POST', '/api/setup', { name: 'Receipts Inc.', chiefName: 'Neo', rules: 'Nothing invented.', repo: { path: '/code/receipt', gates: [{ name: 'tests', command: 'cargo test', timeoutMinutes: 15, lock: null }] } }]);
  });

  it('shows why a repository could not be used and keeps the form, and says so when a gate is half filled in', async () => {
    const api = fakeApi(() => {
      throw new Error('/code/nope: the folder is missing.');
    });
    mount(<Setup />, { store: { ...store, company: null }, now: T0, api });
    await userEvent.type(screen.getByLabelText('Company name'), 'Acme');
    await userEvent.type(screen.getByLabelText('Repository path'), '/code/nope');
    await userEvent.type(screen.getByLabelText('Gate command'), 'npm test');
    await userEvent.click(screen.getByRole('button', { name: 'Create the company' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/gate needs both a name and a command/);
    expect(api.calls).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('Gate name'), 'tests');
    await userEvent.click(screen.getByRole('button', { name: 'Create the company' }));
    expect((await screen.findByRole('alert')).textContent).toContain('the folder is missing');
    expect((screen.getByLabelText('Repository path') as HTMLInputElement).value).toBe('/code/nope');
  });

  it('creates a company with no repository when none is given', async () => {
    const api = fakeApi(() => ({}));
    mount(<Setup />, { store: { ...store, company: null }, now: T0, api });
    await userEvent.type(screen.getByLabelText('Company name'), 'Solo');
    await userEvent.click(screen.getByRole('button', { name: 'Create the company' }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]).toEqual(['POST', '/api/setup', { name: 'Solo' }]);
  });
});
