import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { storyAt } from '../fixtures/story.ts';
import { fakeUi, mount } from '../testing.tsx';
import { Banner } from './Banner.tsx';
import { Header } from './Header.tsx';

describe('Header', () => {
  it('shows the company, the clock, the seats, the spend against the cap, and the decisions button', () => {
    const { store, now } = storyAt('cards_open');
    mount(<Header />, { store, now });
    expect(screen.getByText('Receipts Inc.')).toBeTruthy();
    expect(screen.getByText(/^Mon \d\d:\d\d · \d of 3 seats busy$/)).toBeTruthy();
    expect(screen.getByText(/of \$40/).textContent).toMatch(/^Today \$\d+\.\d\d of \$40$/);
    expect(screen.getByRole('button', { name: 'Open the decision deck, 4 waiting' }).textContent).toBe('4 decisions');
  });

  it('says nothing about spend in a company where cost is not counted', () => {
    const { store, now } = storyAt('cards_open');
    mount(<Header />, { store: { ...store, company: { ...store.company!, costs: 'off' } }, now });
    expect(screen.getByText(/seats busy$/)).toBeTruthy();
    expect(screen.queryByText(/Today/)).toBeNull();
    expect(document.body.textContent).not.toContain('$');
  });

  it('the decisions button opens the deck, and the pills switch the view', async () => {
    const { store, now } = storyAt('cards_open');
    const ui = fakeUi('board');
    mount(<Header />, { store, now, ui });
    await userEvent.click(screen.getByRole('button', { name: /decision deck/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Office' }));
    expect(ui.asked).toEqual([['openDeck', undefined], ['setView', 'office']]);
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBe('page');
  });

  it('has no decisions button when nothing waits, and says when the company is paused', () => {
    const { store, now } = storyAt('paused');
    mount(<Header />, { store, now });
    expect(screen.getByText(/paused at the plan's usage limit/)).toBeTruthy();
    const quiet = storyAt('start');
    mount(<Header />, { store: quiet.store, now: quiet.now });
    expect(screen.getAllByRole('button', { name: /decision deck/ })).toHaveLength(1);
  });
});

describe('Banner', () => {
  it('says so when the engine cannot be reached, and when the page is out of date', () => {
    const { store, now } = storyAt('start');
    const { handle, rerender: _rerender } = mount(<Banner />, { store: { ...store, online: false }, now });
    expect(screen.getByRole('status').textContent).toContain('The engine is not answering');
    void handle;
  });

  it('asks for a reload when the engine was updated, and shows nothing when all is well', () => {
    const { store, now } = storyAt('start');
    const { container } = mount(<Banner />, { store, now });
    expect(container.textContent).toBe('');
    mount(<Banner />, { store: { ...store, needsReload: true }, now });
    expect(screen.getByRole('status').textContent).toContain('Reload');
  });
});
