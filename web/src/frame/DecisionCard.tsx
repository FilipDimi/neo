import { useId, useState } from 'react';
import { useApi, useUi } from '../app/context.ts';
import type { DeckCard, LocalAction } from '../model/select.ts';

const LOCAL_LABEL: Record<LocalAction, string> = { open_diff: 'Open diff', read_first: 'Read it first', not_now: 'Not now' };

/**
 * One card on the deck. Its buttons are the engine's options, answered by id. "Open diff",
 * "Read it first" and "Not now" are the screen's own: they open or put aside, and never answer.
 */
export function DecisionCard({ card, onAside, onGone }: { card: DeckCard; onAside(): void; onGone(): void }) {
  const api = useApi();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useId();

  async function answer(optionId: string): Promise<void> {
    if (busy) return; // one answer per card, however often it is clicked
    setBusy(true);
    setError(null);
    try {
      await api.post<{ result: 'applied' | 'ignored' }>(`/api/decisions/${card.id}/answer`, { optionId, ...(text.trim() ? { text: text.trim() } : {}) });
      onGone(); // answered, or already answered elsewhere: either way this card is finished
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }

  function local(action: LocalAction): void {
    if (action === 'not_now') return onAside();
    if (card.taskId) ui.openTask(card.taskId, action === 'open_diff' ? 'diff' : 'feed');
  }

  return (
    <article className="decision" aria-label={`Decision: ${card.text}`}>
      <div className="label amber-text">
        Decision · {card.age}
        {card.team ? ` · ${card.team}` : ''}
      </div>
      <p className="decision-text">{card.text}</p>
      {card.asker && <p className="decision-note">{`Your answer goes back to ${card.asker} as words. It changes no tools and no limits.`}</p>}
      {card.freeText && (
        <>
          <label htmlFor={field} className="sr-only">
            Your answer
          </label>
          <textarea id={field} className="field" rows={2} placeholder="Your answer, or notes to send back" value={text} onChange={(event) => setText(event.target.value)} />
        </>
      )}
      <div className="decision-buttons">
        {card.options.map((option) => (
          <button key={option.id} type="button" className={`pill small${option.primary ? ' amber' : ''}`} disabled={busy || (option.id === 'answer' && !text.trim())} onClick={() => void answer(option.id)}>
            {option.label}
          </button>
        ))}
        <span className="grow" />
        {card.local.map((action) => (
          <button key={action} type="button" className="quiet" onClick={() => local(action)}>
            {LOCAL_LABEL[action]}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
