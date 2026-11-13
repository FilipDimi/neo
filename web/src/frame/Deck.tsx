import { useEffect, useRef, useState } from 'react';
import { deck } from '../model/select.ts';
import { useNow, useStore } from '../store/store.ts';
import { DecisionCard } from './DecisionCard.tsx';

/**
 * The decision deck: every open card, newest first. It is folded into the amber pill until asked for, on every view,
 * and then lies over the page. An unanswered card never goes away by itself; "Not now" only puts it aside on this screen.
 */
export function Deck({ focus }: { focus?: string | undefined }) {
  const now = useNow(15_000);
  const cards = useStore((store) => deck(store, now), [now]);
  const [aside, setAside] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    setAside((current) => new Set([...current].filter((id) => id !== focus)));
    strip.current?.querySelector(`[data-decision="${focus}"]`)?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [focus]);

  const open = cards.filter((card) => !gone.has(card.id));
  const shown = open.filter((card) => !aside.has(card.id));
  const hidden = open.length - shown.length;
  if (open.length === 0) return null;
  return (
    <section className="deck" aria-label="Decisions waiting for you" ref={strip}>
      {shown.map((card) => (
        <div key={card.id} data-decision={card.id} className={card.id === focus ? 'focused' : undefined}>
          <DecisionCard card={card} onAside={() => setAside((current) => new Set(current).add(card.id))} onGone={() => setGone((current) => new Set(current).add(card.id))} />
        </div>
      ))}
      {hidden > 0 && (
        <button type="button" className="quiet aside" onClick={() => setAside(new Set())}>
          {hidden} put aside · show
        </button>
      )}
    </section>
  );
}
