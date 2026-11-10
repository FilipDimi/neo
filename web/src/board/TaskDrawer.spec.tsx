import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { subjectsOf, type EngineEvent, type EventRow } from '../../../src/shared/events.ts';
import { company, employee, message, run, T0, task, team } from '../../../test/rows.ts';
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
    expect(screen.getByText(/tests passed/)).toBeTruthy();
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

  it('shows the diff when asked', async () => {
    const api = fakeApi((_method, path) => (path.endsWith('/diff') ? { stat: ' NOTE.md | 1 +', patch: '+a note', lines: 1 } : detail([])));
    mount(<TaskDrawer taskId="task1" tab="diff" onClose={() => {}} />, { store: store(), now: T0, api });
    expect(await screen.findByText(/\+a note/)).toBeTruthy();
    expect(api.calls.map((c) => c[1])).toContain('/api/tasks/task1/diff');
  });

  it('sends a message and shows waiting, then delivered', async () => {
    const sent = message({ id: 'm9', toId: 'emp1', taskId: 'task1', text: 'Stop at the test step.' });
    const api = fakeApi((method) => (method === 'POST' ? { message: sent } : detail([])));
    const { handle } = mount(<TaskDrawer taskId="task1" onClose={() => {}} />, { store: store(), now: T0, api });
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
});
