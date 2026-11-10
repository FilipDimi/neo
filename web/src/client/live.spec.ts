import { describe, expect, it, vi } from 'vitest';
import { subjectsOf } from '../../../src/shared/events.ts';
import { company, T0, task } from '../../../test/rows.ts';
import { createStore } from '../store/store.ts';
import { fromSnapshot, type Snapshot } from '../store/reduce.ts';
import { ApiError } from './api.ts';
import { connect, type SocketLike } from './live.ts';

const snapshot = (lastEventId: number, over: Partial<Snapshot> = {}): Snapshot => ({ version: 1, company: company(), repos: [], teams: [], employees: [], tasks: [], runs: [], requests: [], decisions: [], messages: [], health: null, planUsage: null, spend: { company: 0, byTeam: {}, byEmployee: {} }, lastEventId, now: T0.toISOString(), ...over });

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  open(): void {
    this.onopen?.();
  }
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function setup(snapshots: Snapshot[], screen?: string) {
  const sockets: FakeSocket[] = [];
  const store = createStore(fromSnapshot(snapshots[0]!));
  let fetched = 0;
  const live = connect({
    store,
    token: 'tok',
    snapshot: async () => snapshots[Math.min(++fetched, snapshots.length - 1)]!,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    retryMs: 10,
    ...(screen !== undefined && { screen }),
  });
  return { store, sockets, live, fetches: () => fetched };
}
const event = (id: number) => {
  const e = { kind: 'task_changed' as const, task: task({ id: `t${id}` }), cause: 'created' as const };
  return { id, at: T0.toISOString(), ...subjectsOf(e), event: e };
};

describe('the live connection', () => {
  it('sends the token and since as its first message, and applies what follows', () => {
    const { store, sockets, live } = setup([snapshot(7)]);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ token: 'tok', since: 7 });
    sockets[0]!.say(event(8));
    sockets[0]!.say(event(9));
    expect([...store.get().tasks.keys()]).toEqual(['t8', 't9']);
    expect(store.get().lastEventId).toBe(9);
    live.close();
  });

  it('takes a new snapshot when the server asks for a resync', async () => {
    const { store, sockets, live, fetches } = setup([snapshot(7), snapshot(500, { tasks: [task({ id: 'from-snapshot' })] })]);
    sockets[0]!.open();
    sockets[0]!.say({ resync: true });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(fetches()).toBe(1);
    expect(store.get().tasks.has('from-snapshot')).toBe(true);
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ token: 'tok', since: 500 });
    live.close();
  });

  it('marks the store offline when the socket closes, and online after it reconnects from a fresh snapshot', async () => {
    const { store, sockets, live } = setup([snapshot(7), snapshot(9)]);
    sockets[0]!.open();
    expect(store.get().online).toBe(true);
    sockets[0]!.onclose?.();
    expect(store.get().online).toBe(false);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(store.get()).toMatchObject({ online: true, lastEventId: 9 });
    live.close();
  });

  it('keeps trying while the engine cannot be reached', async () => {
    let attempts = 0;
    const store = createStore(fromSnapshot(snapshot(1)));
    const sockets: FakeSocket[] = [];
    const live = connect({
      store,
      token: 'tok',
      snapshot: async () => {
        if (++attempts < 3) throw new Error('refused');
        return snapshot(2);
      },
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      retryMs: 5,
    });
    sockets[0]!.onclose?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(attempts).toBe(3);
    live.close();
  });

  it('asks for a reload when the engine speaks a newer version of the events', async () => {
    const { store, sockets, live } = setup([snapshot(7), snapshot(9, { version: 2 })]);
    sockets[0]!.open();
    sockets[0]!.say({ resync: true });
    await vi.waitFor(() => expect(store.get().needsReload).toBe(true));
    live.close();
  });

  it('asks for a reload when the engine now serves another screen than the one this page is', async () => {
    const { store, sockets, live } = setup([snapshot(7, { screen: 'aaaaaaaaaaaa' }), snapshot(9, { screen: 'bbbbbbbbbbbb' })], 'aaaaaaaaaaaa');
    sockets[0]!.open();
    sockets[0]!.say({ resync: true });
    await vi.waitFor(() => expect(store.get().needsReload).toBe(true));
    expect(sockets).toHaveLength(1);
    live.close();
  });

  it('carries on when the engine serves the same screen, or the page does not know its own', async () => {
    for (const own of ['aaaaaaaaaaaa', '']) {
      const { store, sockets, live } = setup([snapshot(7, { screen: 'aaaaaaaaaaaa' }), snapshot(9, { screen: 'aaaaaaaaaaaa' })], own);
      sockets[0]!.open();
      sockets[0]!.say({ resync: true });
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(store.get().needsReload).toBe(false);
      live.close();
    }
  });

  it('asks for a reload, and stops trying, when the engine no longer accepts the token this page was given', async () => {
    let attempts = 0;
    const store = createStore(fromSnapshot(snapshot(1)));
    const sockets: FakeSocket[] = [];
    const live = connect({
      store,
      token: 'tok',
      snapshot: async () => {
        attempts++;
        throw new ApiError(401, 'The token is missing or wrong.');
      },
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      retryMs: 5,
    });
    sockets[0]!.onclose?.();
    await vi.waitFor(() => expect(store.get().needsReload).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
    expect(sockets).toHaveLength(1);
    live.close();
  });

  it('stops for good when closed', async () => {
    const { sockets, live } = setup([snapshot(7)]);
    sockets[0]!.open();
    live.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
  });
});
