/**
 * The live connection: one WebSocket, kept open. Events are applied as they arrive. Whenever the
 * stream breaks, or the server says we are too far behind, the screen starts again from a fresh
 * snapshot, so it never keeps showing a dead company as if it were alive.
 */
import type { EventRow } from '../../../src/shared/events.ts';
import { EVENT_VERSION } from '../../../src/shared/events.ts';
import { ApiError } from './api.ts';
import { fromSnapshot, type Snapshot } from '../store/reduce.ts';
import type { StoreHandle } from '../store/store.ts';

export type SocketLike = { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null };

export function connect(options: { store: StoreHandle; token: string; snapshot: () => Promise<Snapshot>; socket: () => SocketLike; retryMs?: number }): { close(): void } {
  const { store } = options;
  let closed = false;
  let current: SocketLike | null = null;
  let delay = options.retryMs ?? 1000;
  const first = options.retryMs ?? 1000;

  function open(): void {
    if (closed) return;
    const socket = options.socket();
    current = socket;
    let restarting = false;
    socket.onopen = () => {
      delay = first;
      socket.send(JSON.stringify({ token: options.token, since: store.get().lastEventId }));
      store.patch({ online: true });
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as EventRow | { resync: true };
      if ('resync' in message) {
        restarting = true;
        return void restart();
      }
      store.apply(message);
    };
    socket.onclose = () => {
      if (closed || restarting || current !== socket) return;
      store.patch({ online: false });
      void restart();
    };
  }

  /** Start again from a fresh snapshot. Keeps trying, more slowly, until the engine answers. */
  async function restart(): Promise<void> {
    for (;;) {
      if (closed) return;
      try {
        const snapshot = await options.snapshot();
        if (closed) return;
        if (snapshot.version !== EVENT_VERSION) return store.patch({ needsReload: true });
        // Offline until the new stream is open: the snapshot is fresh, but nothing is arriving yet.
        store.set({ ...fromSnapshot(snapshot), online: false });
        return open();
      } catch (failure) {
        // The engine answers, but not to this page: it came back with another token. Only a fresh page has the new one.
        if (failure instanceof ApiError && failure.status === 401) return store.patch({ needsReload: true });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    }
  }

  open();
  return {
    close() {
      closed = true;
      current?.close();
    },
  };
}
