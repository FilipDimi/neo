import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { EventRow } from '../../../src/shared/events.ts';
import { reduce, type Store } from './reduce.ts';

export type StoreHandle = {
  get(): Store;
  set(next: Store): void;
  patch(change: Partial<Store>): void;
  apply(row: EventRow): void;
  subscribe(listener: () => void): () => void;
};

export function createStore(initial: Store): StoreHandle {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: Store) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    set,
    patch: (change) => set({ ...state, ...change }),
    apply: (row) => set(reduce(state, row)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const StoreContext = createContext<StoreHandle | null>(null);

export function useStoreHandle(): StoreHandle {
  const handle = useContext(StoreContext);
  if (!handle) throw new Error('no store: wrap the tree in StoreContext');
  return handle;
}

/** A view of the store. `select` runs again only when the store changes (or its other inputs do). */
export function useStore<T>(select: (store: Store) => T, inputs: unknown[] = []): T {
  const handle = useStoreHandle();
  const state = useSyncExternalStore(handle.subscribe, handle.get, handle.get);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => select(state), [state, ...inputs]);
}

/** The clock, ticking. Ages on screen are computed from it, never stored. */
export function useNow(everyMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
