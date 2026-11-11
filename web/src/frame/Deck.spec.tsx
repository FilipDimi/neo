import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { subjectsOf } from '../../../src/shared/events.ts';
import { company, decision, T0, task, team } from '../../../test/rows.ts';
import { storyAt } from '../fixtures/story.ts';
import { fromSnapshot } from '../store/reduce.ts';
import { fakeApi, mount } from '../testing.tsx';
import { Deck } from './Deck.tsx';

const base = { version: 1, company: company(), repos: [], teams: [team()], employees: [], runs: [], requests: [], messages: [], health: null, planUsage: null, spend: { company: 0, byTeam: {}, byEmployee: {} }, lastEventId: 1, now: T0.toISOString() };
const lease = decision({ id: 'd1', kind: 'lease', text: "NH's run expired twice. Retry, or stop?", options: [{ id: 'retry', label: 'Retry, 30 min', effect: 'retry', params: { leaseMinutes: 30 } }, { id: 'stop', label: 'Stop it', effect: 'stop_task' }] });
const question = decision({ id: 'd2', kind: 'question', text: 'Ada asks: old layout or new?', freeText: true, options: [{ id: 'choice1', label: 'Old', effect: 'resume_with_answer', params: { text: 'Old' } }, { id: 'answer', label: 'Answer', effect: 'resume_with_answer' }, { id: 'stop', label: 'Stop it', effect: 'stop_task' }] });
const store = (decisions = [lease], tasks = [task({ branch: 'task/x' })]) => fromSnapshot({ ...base, tasks, decisions });

describe('Deck', () => {
  it('shows one card per open decision with its options as buttons', () => {
    const { store: day, now } = storyAt('cards_open');
    mount(<Deck />, { store: day, now });
    expect(screen.getAllByRole('article')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Retry, 20 min' })).toBeTruthy();
    expect(screen.getAllByText(/Decision · .* · Engineering · iOS/).length).toBeGreaterThan(0);
  });

  it('renders nothing when no decision is open', () => {
    const { container } = mount(<Deck />, { store: store([]), now: T0 });
    expect(container.textContent).toBe('');
  });

  it("answers with the option's id", async () => {
    const { api } = mount(<Deck />, { store: store(), now: T0, api: fakeApi(() => ({ result: 'applied' })) });
    await userEvent.click(screen.getByRole('button', { name: 'Retry, 30 min' }));
    expect(api.calls).toEqual([['POST', '/api/decisions/d1/answer', { optionId: 'retry' }]]);
  });

  it('a second click does not answer twice, and an ignored answer removes the card', async () => {
    let finish: (value: unknown) => void = () => {};
    const { api } = mount(<Deck />, { store: store(), now: T0, api: fakeApi(() => new Promise((resolve) => (finish = resolve))) });
    const retry = screen.getByRole('button', { name: 'Retry, 30 min' });
    await userEvent.click(retry);
    await userEvent.click(retry);
    await userEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    expect(api.calls).toHaveLength(1);
    await act(async () => finish({ result: 'ignored' }));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why an answer failed and lets the user try again', async () => {
    mount(<Deck />, { store: store(), now: T0, api: fakeApi(() => Promise.reject(new Error('The engine is not answering.'))) });
    await userEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not answering');
    expect((screen.getByRole('button', { name: 'Stop it' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Not now puts the card aside without calling the engine, and it can be brought back', async () => {
    const { api } = mount(<Deck />, { store: store(), now: T0 });
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('article')).toBeNull();
    expect(api.calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: /1 put aside/ }));
    expect(screen.getByRole('article')).toBeTruthy();
  });

  it("Open diff opens the task's drawer on its diff without answering", async () => {
    const { api, ui } = mount(<Deck />, { store: store(), now: T0 });
    await userEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(ui.asked).toEqual([['openTask', 'task1', 'diff']]);
    expect(api.calls).toEqual([]);
  });

  it('a question takes typed text, and Answer waits for some', async () => {
    const { api } = mount(<Deck />, { store: store([question]), now: T0, api: fakeApi(() => ({ result: 'applied' })) });
    const answer = screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Your answer'), 'Teal, actually.');
    await userEvent.click(answer);
    expect(api.calls).toEqual([['POST', '/api/decisions/d2/answer', { optionId: 'answer', text: 'Teal, actually.' }]]);
  });

  it('shows what a card asks with its formatting', () => {
    const asked = decision({ id: 'd3', kind: 'question', text: '**Merge task/x?**\n\n- 14 files\n- `tests` passed', options: [{ id: 'stop', label: 'Stop it', effect: 'stop_task' }] });
    mount(<Deck />, { store: store([asked]), now: T0 });
    expect(screen.getByText('Merge task/x?').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['14 files', 'tests passed']);
  });

  it('drops a card as soon as the engine says it was answered', () => {
    const { handle } = mount(<Deck />, { store: store(), now: T0 });
    const answered = { kind: 'decision_answered' as const, decision: { ...lease, answer: { optionId: 'stop' }, answeredAt: T0.toISOString() }, result: 'applied' as const };
    act(() => handle.apply({ id: 2, at: T0.toISOString(), ...subjectsOf(answered), event: answered }));
    expect(screen.queryByRole('article')).toBeNull();
  });
});

describe('a question from an employee', () => {
  it('says that its buttons only send words back, so nobody presses one expecting it to change a tool', () => {
    const { store, now } = storyAt('cards_open');
    mount(<Deck />, { store, now });
    const question = [...store.decisions.values()].find((d) => d.kind === 'question' && d.answeredAt === null)!;
    const card = screen.getByRole('article', { name: `Decision: ${question.text}` });
    expect(card.textContent).toMatch(/Your answer goes back to .+ as words\. It changes no tools and no limits\./);
    const merge = [...store.decisions.values()].find((d) => d.kind === 'merge' && d.answeredAt === null)!;
    expect(screen.getByRole('article', { name: `Decision: ${merge.text}` }).textContent).not.toMatch(/as words/);
  });
});

