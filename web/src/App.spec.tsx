import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { ApiContext, NowContext } from './app/context.ts';
import { ApiError } from './client/api.ts';
import type { SocketLike } from './client/live.ts';
import { storyAt, storyEvents, storySnapshot } from './fixtures/story.ts';
import { fakeApi, type FakeApi } from './testing.tsx';

type Wire = SocketLike & { sent: string[] };
function wires() {
  const made: Wire[] = [];
  const socket = (): SocketLike => {
    const wire: Wire = { sent: [], send: (data) => void wire.sent.push(data), close() {}, onopen: null, onmessage: null, onclose: null };
    made.push(wire);
    return wire;
  };
  return { made, socket };
}

function start(api: FakeApi, mark = 'start') {
  const wire = wires();
  const { now } = storyAt(mark);
  render(
    <ApiContext value={api}>
      <NowContext value={now}>
        <App socket={wire.socket} retryMs={5} />
      </NowContext>
    </ApiContext>,
  );
  /** Opens the stream and plays the recorded day up to the mark. */
  const play = async () => {
    const upTo = storyAt(mark).store.lastEventId;
    await act(async () => {
      wire.made[0]!.onopen?.();
      for (const row of storyEvents) if (row.id <= upTo) wire.made[0]!.onmessage?.({ data: JSON.stringify(row) });
    });
  };
  return { ...wire, play };
}
const HIRE_OPTIONS = { presets: [], skills: [], models: [], capabilities: [], availableByTeam: {} };
const snapshotApi = () => fakeApi((_method, path) => (path === '/api/snapshot' ? storySnapshot : path === '/api/hire-options' ? HIRE_OPTIONS : {}));

afterEach(() => void (location.hash = ''));

describe('App', () => {
  it('loads the company and opens on the office, with the live stream asked for from where the snapshot ends', async () => {
    const app = start(snapshotApi());
    expect(await screen.findByText('lit screen = working')).toBeTruthy();
    expect(screen.getAllByText(storySnapshot.company!.name).length).toBeGreaterThan(0);
    await app.play();
    expect(JSON.parse(app.made[0]!.sent[0]!)).toMatchObject({ since: storySnapshot.lastEventId });
  });

  it('shows first setup when there is no company yet', async () => {
    start(fakeApi((_method, path) => (path === '/api/snapshot' ? { ...storySnapshot, company: null, teams: [], employees: [], repos: [] } : {})));
    expect(await screen.findByRole('heading', { name: 'Start a company' })).toBeTruthy();
  });

  it('switches views with the pills and keeps the view in the address', async () => {
    start(snapshotApi());
    await userEvent.click(await screen.findByRole('button', { name: 'Board' }));
    expect(location.hash).toBe('#board');
    expect(screen.getByRole('region', { name: 'Queued' })).toBeTruthy();
    expect(screen.queryByText('lit screen = working')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Hire' }));
    expect(location.hash).toBe('#hire');
    await userEvent.click(screen.getByRole('button', { name: 'Office' }));
    expect(await screen.findByText('lit screen = working')).toBeTruthy();
  });

  it('opens on the view named in the address', async () => {
    location.hash = '#board';
    start(snapshotApi());
    expect(await screen.findByRole('region', { name: 'Queued' })).toBeTruthy();
  });

  it('keeps the deck folded on the office until asked, and pinned on the board', async () => {
    const app = start(snapshotApi(), 'lease_card');
    await screen.findByText('lit screen = working');
    await app.play();
    expect(screen.queryByRole('region', { name: 'Decisions waiting for you' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Decide for NH' }));
    const deck = screen.getByRole('region', { name: 'Decisions waiting for you' });
    expect(deck.querySelector('.focused')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close the decision deck' }));
    expect(screen.queryByRole('region', { name: 'Decisions waiting for you' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByRole('region', { name: 'Decisions waiting for you' })).toBeTruthy();
  });

  it("opens a person's page from the office and closes it", async () => {
    const app = start(snapshotApi(), 'parts_running');
    await screen.findByText('lit screen = working');
    await app.play();
    await userEvent.click(screen.getByRole('button', { name: /^NH, / }));
    const page = await screen.findByRole('dialog', { name: 'NH' });
    await userEvent.click(page.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);
    expect(screen.queryByRole('dialog', { name: 'NH' })).toBeNull();
  });

  it('says the engine is not answering, and carries on when it does', async () => {
    let calls = 0;
    start(
      fakeApi((_method, path) => {
        if (path !== '/api/snapshot') return {};
        if (calls++ < 2) throw new ApiError(0, 'The engine is not answering.');
        return storySnapshot;
      }),
    );
    expect(await screen.findByText(/The engine is not answering/)).toBeTruthy();
    expect(await screen.findByText('lit screen = working')).toBeTruthy();
  });

  it('asks for a reload when the first answer comes from an engine that serves a newer screen than this page', async () => {
    const meta = document.createElement('meta');
    meta.name = 'vs-screen';
    meta.content = 'aaaaaaaaaaaa';
    document.head.append(meta);
    try {
      start(fakeApi((_method, path) => (path === '/api/snapshot' ? { ...storySnapshot, screen: 'bbbbbbbbbbbb' } : {})));
      expect(await screen.findByText(/The engine was updated/)).toBeTruthy();
    } finally {
      meta.remove();
    }
  });

  it('asks for a reload when the engine speaks a newer version', async () => {
    start(fakeApi((_method, path) => (path === '/api/snapshot' ? { ...storySnapshot, version: storySnapshot.version + 1 } : {})));
    expect(await screen.findByText(/The engine was updated/)).toBeTruthy();
  });
});
