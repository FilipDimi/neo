import { useUi } from '../app/context.ts';
import type { BoardCard } from '../model/select.ts';

/** A task on the board: its title, who and how much, and one line of what is happening, coloured by what it needs. */
export function Card({ card }: { card: BoardCard }) {
  const ui = useUi();
  return (
    <button type="button" className="card" data-attention={card.failed ? 'silent' : card.attention} data-failed={card.failed} onClick={() => ui.openTask(card.taskId)}>
      <span className="card-title clamp2" title={card.title}>
        {card.title}
      </span>
      <span className="card-line muted">{card.line2}</span>
      {card.line3 && <span className="card-line status">{card.line3}</span>}
    </button>
  );
}
