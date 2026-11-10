import { useEffect, useMemo, useState } from 'react';
import { EVENT_VERSION } from '../../src/shared/events.ts';
import './app/app.css';
import { UiContext, useApi, type TaskTab, type Ui, type View } from './app/context.ts';
import { Board } from './board/Board.tsx';
import { TaskDrawer } from './board/TaskDrawer.tsx';
import { pageToken } from './client/api.ts';
import { connect, type SocketLike } from './client/live.ts';
import { Company } from './company/Company.tsx';
import { PersonPage } from './company/PersonPage.tsx';
import { Setup } from './company/Setup.tsx';
import { Banner } from './frame/Banner.tsx';
import { ChatLine } from './frame/ChatLine.tsx';
import { Deck } from './frame/Deck.tsx';
import './frame/frame.css';
import { Header } from './frame/Header.tsx';
import { openDecisions } from './model/select.ts';
import { Office } from './office/Office.tsx';
import { fromSnapshot, type Snapshot } from './store/reduce.ts';
import { createStore, StoreContext, useStore, type StoreHandle } from './store/store.ts';
import './tokens.css';

const VIEWS: View[] = ['office', 'board', 'hire'];
const viewInAddress = (): View => VIEWS.find((view) => `#${view}` === location.hash) ?? 'office';
const liveSocket = (): SocketLike => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`) as unknown as SocketLike;

/**
 * The whole screen: it loads the company once, keeps it current from the engine's event stream,
 * and shows one of three views of it. Nothing on screen is kept anywhere but the store.
 */
export function App({ socket = liveSocket, retryMs = 2000 }: { socket?: () => SocketLike; retryMs?: number }) {
  const api = useApi();
  const [store, setStore] = useState<StoreHandle | null>(null);
  const [waiting, setWaiting] = useState<'loading' | 'offline' | 'reload'>('loading');

  useEffect(() => {
    let gone = false;
    let live: { close(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = () => api.get<Snapshot>('/api/snapshot');
    async function load(): Promise<void> {
      try {
        const first = await snapshot();
        if (gone) return;
        if (first.version !== EVENT_VERSION) return setWaiting('reload');
        const made = createStore(fromSnapshot(first));
        live = connect({ store: made, token: pageToken(), snapshot, socket, retryMs });
        setStore(made);
      } catch {
        if (gone) return;
        setWaiting('offline');
        timer = setTimeout(() => void load(), retryMs);
      }
    }
    void load();
    return () => {
      gone = true;
      clearTimeout(timer);
      live?.close();
    };
  }, [api, socket, retryMs]);

  if (!store)
    return (
      <div className="app-wait" role="status">
        {waiting === 'reload' ? (
          <span>
            The engine was updated. <button type="button" className="quiet" onClick={() => location.reload()}>Reload</button> to carry on.
          </span>
        ) : waiting === 'offline' ? (
          'The engine is not answering. Trying again…'
        ) : (
          'Opening the company…'
        )}
      </div>
    );
  return (
    <StoreContext value={store}>
      <Shell />
    </StoreContext>
  );
}

function Shell() {
  const hasCompany = useStore((state) => state.company !== null);
  const cards = useStore((state) => openDecisions(state).length);
  const [view, setView] = useState<View>(viewInAddress);
  const [deck, setDeck] = useState<{ open: boolean; focus: string | undefined }>({ open: false, focus: undefined });
  const [task, setTask] = useState<{ id: string; tab: TaskTab | undefined } | null>(null);
  const [person, setPerson] = useState<string | null>(null);

  useEffect(() => {
    const follow = () => setView(viewInAddress());
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);

  const ui = useMemo<Ui>(
    () => ({
      view,
      setView(next) {
        location.hash = next;
        setView(next);
        setDeck({ open: false, focus: undefined });
      },
      openDeck: (decisionId) => setDeck({ open: true, focus: decisionId }),
      openTask(id, tab) {
        setPerson(null);
        setTask({ id, tab });
      },
      openPerson(id) {
        setTask(null);
        setPerson(id);
      },
    }),
    [view],
  );

  if (!hasCompany)
    return (
      <div className="app">
        <Banner />
        <Setup />
      </div>
    );
  const office = view === 'office';
  return (
    <UiContext value={ui}>
      <div className="app">
        <Banner />
        {!office && <Header />}
        {!office && <Deck focus={deck.focus} />}
        <main className="app-main">{office ? <Office /> : view === 'board' ? <Board /> : <Company />}</main>
        {/* On the office the deck stays folded into the amber pill until it is asked for. */}
        {office && deck.open && cards > 0 && (
          <div className="office-deck">
            <Deck focus={deck.focus} />
            <button type="button" className="pill small" aria-label="Close the decision deck" onClick={() => setDeck({ open: false, focus: undefined })}>
              Close
            </button>
          </div>
        )}
        {!office && (
          <div className="app-chat">
            <ChatLine />
          </div>
        )}
        {task && <TaskDrawer taskId={task.id} tab={task.tab} onClose={() => setTask(null)} />}
        {person && <PersonPage employeeId={person} onClose={() => setPerson(null)} />}
      </div>
    </UiContext>
  );
}
