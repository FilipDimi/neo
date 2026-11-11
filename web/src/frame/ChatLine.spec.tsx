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
    expect(document.querySelector('.chat-reply')!.textContent).toBe('NeoI wrote 2 tasks from that.');
    expect(screen.getByText('Neo').className).toBe('chat-from');
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

  it('shows a reply with its formatting, and takes several lines', async () => {
    const { store, now } = storyAt('start');
    const { handle, api } = mount(<ChatLine />, { store, now, api: fakeApi(() => ({ message: {} })) });
    const reply = { kind: 'message_sent' as const, message: message({ id: 'r1', fromId: store.company!.chiefOfStaffId!, toId: 'user', text: '**Done:** 2 tasks.\n\n- header\n- footer', at: now.toISOString(), state: 'delivered' }) };
    act(() => handle.apply({ id: store.lastEventId + 1, at: now.toISOString(), ...subjectsOf(reply), event: reply }));
    expect(screen.getByText('Done:').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const field = screen.getByLabelText('Tell Neo what to do next') as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    await userEvent.type(field, 'One{Shift>}{Enter}{/Shift}two{Enter}');
    expect(api.calls).toEqual([['POST', '/api/chat', { text: 'One\ntwo' }]]);
  });

  it('keeps a long reply for as long as it takes to read', () => {
    const { store, now } = storyAt('start');
    const long = { kind: 'message_sent' as const, message: message({ id: 'r1', fromId: store.company!.chiefOfStaffId!, toId: 'user', text: `Here is where every team stands. ${'The board is moving. '.repeat(100)}`, at: now.toISOString(), state: 'delivered' }) };
    const { handle, unmount } = mount(<ChatLine />, { store, now });
    act(() => handle.apply({ id: store.lastEventId + 1, at: now.toISOString(), ...subjectsOf(long), event: long }));
    unmount();
    const later = mount(<ChatLine />, { store: handle.get(), now: plus(now, 60) }); // a short reply is gone by now
    expect(screen.getByText(/Here is where every team stands/)).toBeTruthy();
    later.unmount();
    mount(<ChatLine />, { store: handle.get(), now: plus(now, 600) });
    expect(screen.queryByText(/Here is where every team stands/)).toBeNull();
  });

  it('is disabled when there is no chief of staff', () => {
    const { store, now } = storyAt('start');
    mount(<ChatLine />, { store: { ...store, company: { ...store.company!, chiefOfStaffId: null } }, now });
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });
});
