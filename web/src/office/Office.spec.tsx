import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { storyAt } from '../fixtures/story.ts';
import { fakeUi, mount } from '../testing.tsx';
import { Office } from './Office.tsx';

// jsdom has no WebGL, so nothing is painted here. Everything that can be clicked or read is in the page itself.
describe('Office', () => {
  it('has a button for every person, named with what they are doing', async () => {
    const { store, now } = storyAt('parts_running');
    const ui = fakeUi('office');
    mount(<Office />, { store, now, ui });
    const staff = [...store.employees.values()].filter((employee) => !employee.fired);
    for (const employee of staff) expect(screen.getByRole('button', { name: new RegExp(`^${employee.name}, (working|idle|in a review|stuck)`) })).toBeTruthy();
    const working = screen.getAllByRole('button', { name: /, working: / });
    expect(working.length).toBe(3);

    const first = staff[0]!;
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${first.name}, `) }));
    expect(ui.asked).toContainEqual(['openPerson', first.id]);
  });

  it("opens a task from its owner's bubble", async () => {
    const { store, now } = storyAt('parts_running');
    const ui = fakeUi('office');
    mount(<Office />, { store, now, ui });
    const bubbles = screen.getAllByRole('button', { name: /^Open the task: / });
    expect(bubbles.length).toBe(3);
    await userEvent.click(bubbles[0]!);
    const [, taskId] = ui.asked.find(([what]) => what === 'openTask')!;
    expect(store.tasks.get(String(taskId))?.state).toBe('running');
  });

  it('opens the deck at the card from Decide, and the whole deck from the tray', async () => {
    const { store, now } = storyAt('lease_card');
    const ui = fakeUi('office');
    mount(<Office />, { store, now, ui });
    const card = [...store.decisions.values()].find((decision) => decision.kind === 'lease')!;
    await userEvent.click(screen.getByRole('button', { name: 'Decide for NH' }));
    expect(ui.asked).toContainEqual(['openDeck', card.id]);
    await userEvent.click(screen.getByRole('button', { name: /^The chief of staff's tray, \d+ waiting for you$/ }));
    expect(ui.asked).toContainEqual(['openDeck', undefined]);
    expect(screen.getByRole('button', { name: /^NH, stuck, needs you: silent 10 min · twice$/ })).toBeTruthy();
  });

  it('has no tray button and no Decide when nothing waits', () => {
    const { store, now } = storyAt('start');
    mount(<Office />, { store, now, ui: fakeUi('office') });
    expect(screen.queryByRole('button', { name: /tray/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Decide/ })).toBeNull();
  });

  it('shows the company, the seats, the views, the legend and the chat line over the room', () => {
    const { store, now } = storyAt('cards_open');
    mount(<Office />, { store, now, ui: fakeUi('office') });
    const strip = screen.getByTestId('office-strip');
    expect(within(strip).getByText(store.company!.name)).toBeTruthy();
    expect(strip.textContent).toMatch(/\d of \d seats busy · \$\d+\.\d\d today/);
    expect(screen.getByRole('button', { name: /^Open the decision deck, 4 waiting$/ }).textContent).toBe('4 on your desk');
    expect(screen.getByRole('navigation', { name: 'Views' })).toBeTruthy();
    for (const line of ['lit screen = working', 'meeting room = a review', 'red lamp = stuck, needs you', 'white shirt = a lead']) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByLabelText(/^Tell .+ what to do next$/)).toBeTruthy();
  });

  it('reads the wall board out for someone who cannot see the room', () => {
    const { store, now } = storyAt('cards_open');
    mount(<Office />, { store, now, ui: fakeUi('office') });
    const wall = screen.getByTestId('wallboard-text').textContent ?? '';
    expect(wall).toMatch(/queued \d+, briefing \d+, running \d+, review \d+, stuck \d+, done \d+/);
    expect(wall).toMatch(/Four things on your desk\./);
  });

  it('says so when the room cannot be drawn here', async () => {
    const { store, now } = storyAt('start');
    mount(<Office />, { store, now, ui: fakeUi('office') });
    expect((await screen.findByRole('status')).textContent).toMatch(/cannot be drawn/);
  });
});
