import { useState } from 'react';
import { money } from '../format.ts';
import { board, spendToday } from '../model/select.ts';
import { useNow, useStore } from '../store/store.ts';
import './board.css';
import { Card } from './Card.tsx';
import { NewTask } from './NewTask.tsx';

/** The board: the truth about every piece of work, in six columns. */
export function Board() {
  const now = useNow();
  const columns = useStore((store) => board(store, now), [now]);
  const spend = useStore((store) => spendToday(store, now), [now]);
  const [adding, setAdding] = useState(false);
  return (
    <div className="board-view">
      <div className="board">
        {columns.map((column) => (
          <section key={column.key} className="column" aria-label={column.title} data-column={column.key}>
            <h2 className="label">
              <span>{column.title}</span>
              <span data-testid="count">{column.count}</span>
            </h2>
            {column.key === 'queued' && (
              <button type="button" className="new-task" onClick={() => setAdding(true)}>
                + New task
              </button>
            )}
            <div className="cards">
              {column.cards.map((card) => (
                <Card key={card.taskId} card={card} />
              ))}
              {column.more > 0 && <div className="more">+ {column.more} more</div>}
            </div>
          </section>
        ))}
      </div>
      <footer className="board-footer">
        <div>
          Colour: <span style={{ color: 'var(--working)' }}>working</span> · <span style={{ color: 'var(--review)' }}>review</span> · <span style={{ color: 'var(--waiting)' }}>waiting on you</span> ·{' '}
          <span style={{ color: 'var(--silent)' }}>silent past its lease</span>
        </div>
        <div className="grow" />
        <div>{`Spend today by team: ${spend.byTeam.map((team) => `${team.name} ${money(team.usd)}`).join(' · ') || 'nothing yet'}`}</div>
      </footer>
      {adding && (
        <div className="scrim" onClick={(event) => event.target === event.currentTarget && setAdding(false)}>
          <NewTask onDone={() => setAdding(false)} />
        </div>
      )}
    </div>
  );
}
