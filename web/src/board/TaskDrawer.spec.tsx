import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { subjectsOf, type EngineEvent, type EventRow } from '../../../src/shared/events.ts';
import { company, decision, employee, message, run, T0, task, team } from '../../../test/rows.ts';
import { fromSnapshot } from '../store/reduce.ts';
import { fakeApi, mount } from '../testing.tsx';
import { TaskDrawer } from './TaskDrawer.tsx';

const theTask = task({ state: 'running', assigneeId: 'emp1', brief: 'Write the note well.', doneCondition: 'NOTE.md exists.', branch: 'task/x' });
const live = run({ sessionId: 's', costUsd: 0.4, gateResults: [{ name: 'tests', command: 'npm test', exitCode: 0, output: 'ok', durationMs: 5 }] });
const base = { version: 1, company: company(), repos: [], teams: [team()], employees: [employee(), employee({ id: 'emp2', name: 'Grace' })], requests: [], decisions: [], messages: [], health: null, planUsage: null, spend: { company: 0, byTeam: {}, byEmployee: {} }, lastEventId: 5, now: T0.toISOString() };
const store = (tasks = [theTask, task({ id: 'kid', parentId: 'task1', title: 'A sub-task', state: 'done' })]) => fromSnapshot({ ...base, tasks, runs: [live] });
const row = (id: number, event: EngineEvent): EventRow => ({ id, at: T0.toISOString(), ...subjectsOf(event), event });
const said = (id: number, text: string, taskId = 'task1') => row(id, { kind: 'run_event', runId: 'run1', taskId, employeeId: 'emp1', teamId: 'team1', event: { kind: 'assistant_text', text } });
const detail = (events: EventRow[]) => ({ task: theTask, children: [], runs: [live], events, decisions: [] });

describe('TaskDrawer', () => {
  it('loads the task and shows its brief, its children, its runs and its feed', async () => {
    const api = fakeApi(() => detail([said(3, 'Reading the brief.'), row(4, { kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'tool_call', id: 't', tool: 'Write', input: { file_path: 'NOTE.md' } } })]));
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    expect(api.calls[0]).toEqual(['GET', '/api/tasks/task1']);
    expect(screen.getByRole('dialog', { name: 'Do the thing' })).toBeTruthy();
    expect(screen.getByText('Write the note well.')).toBeTruthy();
    expect(screen.getByText('NOTE.md exists.')).toBeTruthy();
    expect(screen.getByText('A sub-task')).toBeTruthy();
    expect(screen.getByText(/work · Ada · running · \$0\.40/)).toBeTruthy();
    expect(screen.getByText(/tests passed/, { selector: '.gate' })).toBeTruthy();
    expect(await screen.findByText('Reading the brief.')).toBeTruthy();
    expect(screen.getByText(/Write NOTE\.md/)).toBeTruthy();
  });

  it("appends live events for the open task and ignores other tasks'", async () => {
    let events = [said(3, 'First.')];
    const api = fakeApi(() => detail(events));
    const { handle } = mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    await screen.findByText('First.');
    act(() => handle.apply(said(6, 'Not mine.', 'other-task')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.calls).toHaveLength(1);
    events = [...events, said(7, 'Second.')];
    act(() => handle.apply(said(7, 'Second.')));
    expect(await screen.findByText('Second.')).toBeTruthy();
    expect(api.calls).toHaveLength(2);
  });

  it("shows what an employee wrote with its formatting, and the engine's own lines as they are", async () => {
    const api = fakeApi(() => detail([said(3, '**Done.** Two files:\n\n- `NOTE.md`\n- `README.md`'), row(4, { kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'tool_call', id: 't', tool: 'Bash', input: { command: 'ls **/*.md' } } })]));
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    expect((await screen.findByText('Done.')).tagName).toBe('STRONG');
    expect(within(document.querySelector<HTMLElement>('.feed')!).getAllByRole('listitem').map((item) => item.innerHTML)).toEqual(['<code>NOTE.md</code>', '<code>README.md</code>']);
    expect(screen.getByText('▸ Bash ls **/*.md')).toBeTruthy();
  });

  it('opens on what the task is and where it stands, with the long brief folded away', async () => {
    const brief = `The settings screen, built from board S-3. ${'Every detail of the layout is spelled out here at length. '.repeat(8)}\n\nWork:\n1. Layout first\n2. Then the toggles`;
    const big = task({ state: 'running', assigneeId: 'emp1', brief, summary: 'The settings screen, from board S-3.', doneCondition: 'It matches the board.', capUsd: 2 });
    const working = run({ sessionId: 's', costUsd: 0.4, activity: 'Laying out the toggles' });
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: fromSnapshot({ ...base, tasks: [big], runs: [working] }), now: T0, api: fakeApi(() => ({ ...detail([]), task: big })) });
    const glance = screen.getByRole('region', { name: 'At a glance' });
    expect(within(glance).getByText('The settings screen, from board S-3.')).toBeTruthy();
    expect(within(glance).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Ada is working on it now: Laying out the toggles.', '$0.40 of $2.00 spent over 1 run.']);
    // The brief is all there, one click away, and not in the way.
    const fold = screen.getByText('The full brief').closest('details')!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText(/Every detail of the layout/)).toBeTruthy();
    expect(within(fold).getByText('It matches the board.')).toBeTruthy();
    expect(within(glance).queryByText(/Every detail of the layout/)).toBeNull();
  });

  it('does not say a short brief twice', async () => {
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api: fakeApi(() => detail([])) });
    expect(screen.getAllByText('Write the note well.')).toHaveLength(1);
    expect(screen.getByText('NOTE.md exists.')).toBeTruthy();
  });

  it('says in the feed who decided a card and what, in their words', async () => {
    const card = decision({ id: 'd1', kind: 'review', text: 'Priya could not decide on "Do the thing".', options: [{ id: 'send_back', label: 'Send back', effect: 'send_back' }, { id: 'accept', label: 'Accept as it is', effect: 'accept' }] });
    const at = T0.toISOString();
    const api = fakeApi(() =>
      detail([
        row(3, { kind: 'decision_answered', decision: { ...card, answer: { optionId: 'send_back', text: 'Make it one friendly line.', by: 'emp1', why: 'Make it one friendly line.' }, answeredAt: at }, result: 'applied' }),
        row(4, { kind: 'decision_answered', decision: { ...card, id: 'd2', answer: { optionId: 'accept' }, answeredAt: at }, result: 'applied' }),
        row(5, { kind: 'decision_answered', decision: { ...card, id: 'd3', answer: { optionId: 'closed' }, answeredAt: at }, result: 'closed' }),
      ]),
    );
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    expect(await screen.findByText('— Ada decided: Send back. Make it one friendly line.')).toBeTruthy();
    expect(screen.getByText('— you decided: Accept as it is')).toBeTruthy();
    expect(screen.queryByText(/closed/)).toBeNull();
  });

  it("lists what a review found under its run, the blocking ones marked", async () => {
    const review = run({ id: 'run2', mode: 'review', outcome: 'done', reason: 'sent_back', endedAt: T0.toISOString(), findings: [{ severity: 'blocking', file: 'NOTE.md', line: 3, title: 'The note contradicts the brief', why: 'It says the opposite.', fix: 'Rewrite line 3.' }, { severity: 'minor', file: 'NOTE.md', title: 'A typo', why: '', fix: 'Fix it.' }] });
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: fromSnapshot({ ...base, tasks: [theTask], runs: [live, review] }), now: T0, api: fakeApi(() => detail([])) });
    const found = within(await screen.findByRole('list', { name: 'What the review found' })).getAllByRole('listitem');
    expect(found.map((item) => [item.getAttribute('data-severity'), item.textContent])).toEqual([
      ['blocking', 'blocking NOTE.md:3: The note contradicts the brief. It says the opposite. Fix: Rewrite line 3.'],
      ['minor', 'minor NOTE.md: A typo. Fix: Fix it.'],
    ]);
  });

  it('shows the diff when asked', async () => {
    const api = fakeApi((_method, path) => (path.endsWith('/diff') ? { stat: ' NOTE.md | 1 +', patch: '+a note', lines: 1 } : detail([])));
    mount(<TaskDrawer taskId="task1" tab="diff" onClose={() => {}} />, { store: store(), now: T0, api });
    expect(await screen.findByText(/\+a note/)).toBeTruthy();
    expect(api.calls.map((c) => c[1])).toContain('/api/tasks/task1/diff');
  });

  it('shows the files a task without a repository wrote, in place of a diff', async () => {
    const research = task({ state: 'done', assigneeId: 'emp1', title: 'Research the market' });
    const written = { folder: '/data/folders/task1', more: 2, files: [{ path: 'market-brief.md', bytes: 16238, text: '# Market brief\n\nThree competitors.' }, { path: 'chart.png', bytes: 2048, text: null }] };
    const api = fakeApi((_method, route) => (route.endsWith('/files') ? written : { task: research, children: [], runs: [], events: [], decisions: [] }));
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store([research]), now: T0, api });
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(api.calls).toContainEqual(['GET', '/api/tasks/task1/files']);
    expect(await screen.findByText(/market-brief\.md · 16 KB/)).toBeTruthy();
    expect(screen.getByText(/Three competitors\./)).toBeTruthy();
    expect(screen.getByText(/chart\.png · 2 KB/)).toBeTruthy();
    expect(screen.getByText(/not shown here: it is not text, or it is too long/)).toBeTruthy();
    expect(screen.getByText(/and 2 more/)).toBeTruthy();
    expect(screen.getByText('/data/folders/task1')).toBeTruthy();
  });

  it('says so when a task without a repository has written nothing', async () => {
    const research = task({ state: 'running', assigneeId: 'emp1' });
    const api = fakeApi((_method, route) => (route.endsWith('/files') ? { folder: '/data/folders/task1', files: [], more: 0 } : { task: research, children: [], runs: [], events: [], decisions: [] }));
    mount(<TaskDrawer taskId="task1" tab="diff" onClose={() => {}} />, { store: store([research]), now: T0, api });
    expect(await screen.findByText('This task has not written any files yet.')).toBeTruthy();
  });

  it('sends a message and shows waiting, then delivered', async () => {
    const sent = message({ id: 'm9', toId: 'emp1', taskId: 'task1', text: 'Stop at the test step.' });
    const api = fakeApi((method) => (method === 'POST' ? { message: sent } : detail([])));
    const { handle } = mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    expect(screen.getByLabelText('Message to Ada').tagName).toBe('TEXTAREA'); // long messages stay readable while they are typed
    await userEvent.type(screen.getByLabelText('Message to Ada'), 'Stop at the test step.{Enter}');
    expect(api.calls).toContainEqual(['POST', '/api/tasks/task1/message', { text: 'Stop at the test step.' }]);
    expect(await screen.findByText(/waiting for Ada's next turn/)).toBeTruthy();
    act(() => handle.apply(row(8, { kind: 'message_delivered', message: { ...sent, state: 'delivered', deliveredAt: T0.toISOString() } })));
    expect(await screen.findByText(/delivered/)).toBeTruthy();
  });

  it('asks before cancelling a task, and stops a run at once', async () => {
    const api = fakeApi(() => detail([]));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the task' }));
    expect(api.calls.filter((c) => c[0] === 'PATCH')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the task' }));
    expect(api.calls).toContainEqual(['PATCH', '/api/tasks/task1', { cancel: true }]);
    expect(confirm).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Stop the run' }));
    expect(api.calls).toContainEqual(['POST', '/api/runs/run1/stop']);
  });

  it('closes on Escape and on its close button', async () => {
    let closed = 0;
    mount(<TaskDrawer taskId="task1" onClose={() => closed++} />, { store: store(), now: T0, api: fakeApi(() => detail([])) });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(closed).toBe(2));
  });

  it('says what the task is built on, and opens a decision in place', async () => {
    const entry = (n: number, statement: string, why: string) => ({ id: `D-${n}`, n, at: T0.toISOString(), statement, why, by: { kind: 'chief' as const, employeeId: 'emp2' }, taskId: null, repoId: null, replaces: null, replacedBy: null, byName: 'Grace, for the user' });
    const builtOn = { entries: [entry(231, 'Errors are problem+json.', 'One shape for every client.'), entry(228, 'Dates are ISO 8601.', '')], contract: '0.10.1', changesContractTo: '0.10.2' };
    const api = fakeApi(() => ({ ...detail([]), builtOn }));
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    const line = await screen.findByLabelText('What this task is built on');
    expect(line.textContent).toBe('Built on D-231 and D-228 · contract 0.10.1 · changes the contract to 0.10.2');
    const opener = within(line).getByRole('button', { name: 'D-231' });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Errors are problem+json.')).toBeNull();
    await userEvent.click(opener);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Errors are problem+json.')).toBeTruthy();
    expect(screen.getByText('One shape for every client.')).toBeTruthy();
    expect(screen.getByText(/Grace, for the user · 2026-11-09/)).toBeTruthy();
    await userEvent.click(opener);
    expect(screen.queryByText('Errors are problem+json.')).toBeNull();
  });

  it('says nothing of the record for a task built on nothing, where there is no contract', async () => {
    const api = fakeApi(() => ({ ...detail([said(3, 'Loaded.')]), builtOn: { entries: [], contract: null, changesContractTo: null } }));
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
    await screen.findByText('Loaded.');
    expect(screen.queryByLabelText('What this task is built on')).toBeNull();
  });

  it('says what was checked on the last work, from what the engine verified, and nothing for work from before there were checks', async () => {
    const checked = run({ id: 'run2', mode: 'work', outcome: 'done', endedAt: T0.toISOString(), gateResults: [{ name: 'tests', command: 'npm test', exitCode: 0, output: '', durationMs: 5, at: T0.toISOString() }], checks: [{ kind: 'command', what: 'npm run lint', shown: 'ran npm run lint' }] });
    const withChecks = fromSnapshot({ ...base, tasks: [theTask], runs: [checked] });
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: withChecks, now: T0, api: fakeApi(() => detail([])) });
    expect(screen.getByLabelText('What was checked').textContent).toMatch(/^Checked: tests \(gate, passed \d\d:\d\d\) · ran npm run lint$/);
  });

  it('shows no line of checks for work done before there were any', () => {
    const old = run({ id: 'run2', mode: 'work', outcome: 'done', endedAt: T0.toISOString(), gateResults: [] });
    mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: fromSnapshot({ ...base, tasks: [theTask], runs: [old] }), now: T0, api: fakeApi(() => detail([])) });
    expect(screen.queryByLabelText('What was checked')).toBeNull();
  });
});
