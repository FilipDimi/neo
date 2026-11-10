import { act, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { subjectsOf } from '../../../src/shared/events.ts';
import { message, plus } from '../../../test/rows.ts';
import { storyAt } from '../fixtures/story.ts';
import { fakeApi, mount } from '../testing.tsx';
import { ChatLine } from './ChatLine.tsx';

describe('ChatLine', () => {
  it('names the chief of staff, sends the text and clears the field', async () => {
    const { store, now } = storyAt('start');
    const { api } = mount(<ChatLine />, { store, now, api: fakeApi(() => ({ message: {} })) });
    const field = screen.getByLabelText('Tell Neo what to do next') as HTMLInputElement;
    expect(field.placeholder).toBe('Tell Neo what to do next…');
    await userEvent.type(field, 'Make the open seamless{Enter}');
    expect(api.calls).toEqual([['POST', '/api/chat', { text: 'Make the open seamless' }]]);
    expect(field.value).toBe('');
  });

  it('does not send an empty line', async () => {
    const { store, now } = storyAt('start');
    const { api } = mount(<ChatLine />, { store, now });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.calls).toEqual([]);
  });

  it("shows the chief of staff's reply when it arrives, and lets it go after a while", () => {
    const { store, now } = storyAt('start');
    const { handle, unmount } = mount(<ChatLine />, { store, now });
    expect(screen.queryByText(/I wrote 2 tasks/)).toBeNull();
    const reply = { kind: 'message_sent' as const, message: message({ id: 'r1', fromId: store.company!.chiefOfStaffId!, toId: 'user', text: 'I wrote 2 tasks from that.', at: now.toISOString(), state: 'delivered' }) };
    act(() => handle.apply({ id: store.lastEventId + 1, at: now.toISOString(), ...subjectsOf(reply), event: reply }));
    expect(screen.getByText('Neo: I wrote 2 tasks from that.')).toBeTruthy();
    unmount();
    mount(<ChatLine />, { store: handle.get(), now: plus(now, 60) });
    expect(screen.queryByText(/I wrote 2 tasks/)).toBeNull();
  });

  it('keeps the text and says why when sending fails', async () => {
    const { store, now } = storyAt('start');
    mount(<ChatLine />, { store, now, api: fakeApi(() => Promise.reject(new Error('The engine is not answering.'))) });
    const field = screen.getByLabelText('Tell Neo what to do next') as HTMLInputElement;
    await userEvent.type(field, 'Hello{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('not answering');
    expect(field.value).toBe('Hello');
  });

  it('is disabled when there is no chief of staff', () => {
    const { store, now } = storyAt('start');
    mount(<ChatLine />, { store: { ...store, company: { ...store.company!, chiefOfStaffId: null } }, now });
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });
});
