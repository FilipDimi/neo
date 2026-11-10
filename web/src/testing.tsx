/** Mounts a component with a store, a recording API and a fixed clock. */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiContext, NowContext, UiContext, type Ui } from './app/context.ts';
import type { Api } from './client/api.ts';
import type { Store } from './store/reduce.ts';
import { createStore, StoreContext, type StoreHandle } from './store/store.ts';

export type Call = [method: string, path: string, body?: unknown];
export type FakeApi = Api & { calls: Call[] };

/** Records every call and answers from `answer` (which may throw, or return a promise that the test resolves). */
export function fakeApi(answer: (method: string, path: string, body?: unknown) => unknown = () => ({})): FakeApi {
  const calls: Call[] = [];
  const call = (method: string) => async (path: string, body?: unknown) => {
    calls.push(body === undefined ? [method, path] : [method, path, body]);
    return (await answer(method, path, body)) as never;
  };
  return { calls, get: call('GET'), post: call('POST'), patch: call('PATCH') };
}

export type UiCalls = Ui & { asked: [string, ...unknown[]][] };
export function fakeUi(view: Ui['view'] = 'board'): UiCalls {
  const asked: [string, ...unknown[]][] = [];
  return { asked, view, setView: (v) => void asked.push(['setView', v]), openDeck: (id) => void asked.push(['openDeck', id]), openTask: (id, tab) => void asked.push(['openTask', id, tab]), openPerson: (id) => void asked.push(['openPerson', id]) };
}

export function mount(node: ReactNode, options: { store: Store; now: Date; api?: Api; ui?: Ui }): { handle: StoreHandle; api: FakeApi; ui: UiCalls } & ReturnType<typeof render> {
  const handle = createStore(options.store);
  const api = (options.api ?? fakeApi()) as FakeApi;
  const ui = (options.ui ?? fakeUi()) as UiCalls;
  const rendered = render(
    <StoreContext value={handle}>
      <ApiContext value={api}>
        <UiContext value={ui}>
          <NowContext value={options.now}>{node}</NowContext>
        </UiContext>
      </ApiContext>
    </StoreContext>,
  );
  return { handle, api, ui, ...rendered };
}
