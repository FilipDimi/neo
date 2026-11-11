import { useUi, type View } from '../app/context.ts';
import { money } from '../format.ts';
import { header } from '../model/select.ts';
import { useNow, useStore } from '../store/store.ts';

const VIEWS: [View, string][] = [['board', 'Board'], ['office', 'Office'], ['hire', 'Hire']];

export function ViewPills() {
  const ui = useUi();
  return (
    <nav className="pills" aria-label="Views">
      {VIEWS.map(([view, label]) => (
        <button key={view} type="button" className={`pill${ui.view === view ? ' on' : ''}`} aria-current={ui.view === view ? 'page' : undefined} onClick={() => ui.setView(view)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

export function DecisionsButton({ label }: { label: (count: number) => string }) {
  const ui = useUi();
  const count = useStore((store) => header(store, new Date(0)).openDecisions);
  if (count === 0) return null;
  return (
    <button type="button" className="pill amber" aria-label={`Open the decision deck, ${count} waiting`} onClick={() => ui.openDeck()}>
      {label(count)}
    </button>
  );
}

/** The bar on the board and the hire view. The office shows the same facts as two floating pills. */
export function Header() {
  const now = useNow();
  const top = useStore((store) => header(store, now), [now]);
  return (
    <header className="header">
      <div className="company">{top.company}</div>
      <div className="muted">
        {top.clock} · {top.seatsBusy} of {top.seats} seats busy
      </div>
      {top.paused && <div className="paused">{top.paused}</div>}
      <div className="grow" />
      <ViewPills />
      {top.priced && (
        <>
          <div className="rule" />
          <div className="muted">
            Today <strong>{money(top.spentToday)}</strong> of {money(top.capToday, true)}
          </div>
        </>
      )}
      <DecisionsButton label={(count) => `${count} decision${count === 1 ? '' : 's'}`} />
    </header>
  );
}
