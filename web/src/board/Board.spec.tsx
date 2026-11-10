import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { company, employee, T0, task, team } from '../../../test/rows.ts';
import { storyAt } from '../fixtures/story.ts';
import { fromSnapshot } from '../store/reduce.ts';
import { fakeUi, mount } from '../testing.tsx';
import { Board } from './Board.tsx';

const base = { version: 1, company: company(), repos: [], teams: [team()], employees: [employee()], runs: [], requests: [], decisions: [], messages: [], health: null, planUsage: null, spend: { company: 0, byTeam: {}, byEmployee: {} }, lastEventId: 1, now: T0.toISOString() };

describe('Board', () => {
  it('renders six columns with their counts', () => {
    const { store, now } = storyAt('cards_open');
    mount(<Board />, { store, now });
    const columns = screen.getAllByRole('region');
    expect(columns.map((c) => c.getAttribute('aria-label'))).toEqual(['Queued', 'Briefing', 'Running', 'Review', 'Blocked', 'Done today']);
    const blocked = columns[4]!;
    expect(within(blocked).getAllByRole('button').length).toBe(Number(within(blocked).getByTestId('count').textContent));
  });

  it("colours a card's edge by its attention, and marks a failed task", () => {
    const { store, now } = storyAt('cards_answered');
    mount(<Board />, { store, now });
    expect(screen.getByRole('button', { name: /Nav-hang recorder/ }).getAttribute('data-attention')).toBe('silent');
    const failed = screen.getByRole('button', { name: /Re-run the 29 refused plain drafts/ });
    expect(failed.getAttribute('data-failed')).toBe('true');
    expect(within(failed).getByText(/failed/)).toBeTruthy();
  });

  it('clips a long title to two lines and keeps the whole of it as a tooltip', () => {
    const long = 'A very long title '.repeat(20).trim();
    mount(<Board />, { store: fromSnapshot({ ...base, tasks: [task({ title: long })] }), now: T0 });
    const title = screen.getByText(long);
    expect(title.className).toContain('clamp2');
    expect(title.getAttribute('title')).toBe(long);
  });

  it('opens the task when a card is clicked', async () => {
    const { ui } = mount(<Board />, { store: fromSnapshot({ ...base, tasks: [task()] }), now: T0 });
    await userEvent.click(screen.getByRole('button', { name: /Do the thing/ }));
    expect(ui.asked).toEqual([['openTask', 'task1', undefined]]);
  });

  it('lists what finished before today under Earlier, and opens it like any card', async () => {
    const { store, now } = storyAt('cards_answered');
    const nextDay = new Date(now.getTime() + 24 * 3600_000);
    const ui = fakeUi();
    mount(<Board />, { store, now: nextDay, ui });
    const done = screen.getByRole('region', { name: 'Done today' });
    expect(within(done).getByTestId('count').textContent).toBe('0');
    expect(within(done).getByText('Earlier')).toBeTruthy();
    const cards = within(done).getAllByRole('button');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(5);
    await userEvent.click(cards[0]!);
    expect(ui.asked[0]![0]).toBe('openTask');
  });

  it('counts what Done today does not show', () => {
    const today = new Date(2026, 10, 9, 15, 0);
    const done = Array.from({ length: 11 }, (_, i) => task({ id: `d${i}`, title: `Done ${i}`, state: 'done', updatedAt: new Date(2026, 10, 9, 10, i).toISOString() }));
    mount(<Board />, { store: fromSnapshot({ ...base, tasks: done }), now: today });
    expect(screen.getByText('+ 3 more')).toBeTruthy();
  });

  it('shows the legend and the spend by team in its footer', () => {
    const { store, now } = storyAt('cards_answered');
    mount(<Board />, { store, now });
    expect(screen.getByText(/silent past its lease/)).toBeTruthy();
    expect(screen.getByText(/^Spend today by team: .*Engineering · iOS \$\d+\.\d\d/)).toBeTruthy();
  });
});
