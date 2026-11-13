import { useEffect, useMemo, useState } from 'react';
import { EVENT_VERSION } from '../../src/shared/events.ts';
import './app/app.css';
import { UiContext, useApi, type TaskTab, type Ui, type View } from './app/context.ts';
import { Board } from './board/Board.tsx';
import { TaskDrawer } from './board/TaskDrawer.tsx';
import { ApiError, pageScreen, pageToken } from './client/api.ts';
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
        // An engine that speaks a newer version, or serves a newer screen than this page is, needs a fresh page.
        if (first.version !== EVENT_VERSION || (pageScreen() && first.screen && first.screen !== pageScreen())) return setWaiting('reload');
        const made = createStore(fromSnapshot(first));
        live = connect({ store: made, token: pageToken(), snapshot, socket, retryMs, screen: pageScreen() });
        setStore(made);
      } catch (failure) {
        if (gone) return;
        if (failure instanceof ApiError && failure.status === 401) return setWaiting('reload'); // a page from before the engine's token changed
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
      // Asked for by a card's own button, it opens on that card. Asked for by the pill, it opens, and shuts if it was open.
      openDeck: (decisionId) => setDeck((current) => (decisionId === undefined && current.open ? { open: false, focus: undefined } : { open: true, focus: decisionId })),
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

  // The deck shuts when its last card is answered, and stays shut: a card raised later does not open it by itself.
  useEffect(() => {
    if (cards === 0) setDeck({ open: false, focus: undefined });
  }, [cards]);
  useEffect(() => {
    if (!deck.open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDeck({ open: false, focus: undefined });
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [deck.open]);

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
        <main className="app-main">{office ? <Office /> : view === 'board' ? <Board /> : <Company />}</main>
        {/* On every view the deck stays folded into the amber pill until it is asked for, and then lies over the page:
            a card can be a page long, and the board or the hire form under it is what was opened. */}
        {deck.open && cards > 0 && (
          <div className="open-deck">
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
        {/* Keyed: a drawer opened on another task or person starts afresh, with nothing typed or shown for the one before. */}
        {task && <TaskDrawer key={task.id} taskId={task.id} tab={task.tab} onClose={() => setTask(null)} />}
        {person && <PersonPage key={person} employeeId={person} onClose={() => setPerson(null)} />}
      </div>
    </UiContext>
  );
}
