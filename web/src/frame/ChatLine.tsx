import { useState, type FormEvent } from 'react';
import { useApi } from '../app/context.ts';
import { useNow, useStore } from '../store/store.ts';
import { MessageBox } from './MessageBox.tsx';
import { Prose } from './Prose.tsx';

/** How long a reply stays: long enough to read it, and never less than this. */
const REPLY_SHOWN_MS = 20_000;
const MS_PER_LETTER = 60; // an unhurried reader

/** The line to the chief of staff, on every view. What is typed here becomes tasks on the board. */
export function ChatLine() {
  const api = useApi();
  const now = useNow();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chief = useStore((store) => (store.company?.chiefOfStaffId ? store.employees.get(store.company.chiefOfStaffId) : undefined));
  const reply = useStore((store) => [...store.messages.values()].filter((message) => message.toId === 'user').sort((a, b) => a.at.localeCompare(b.at)).at(-1));
  const fresh = reply && now.getTime() - new Date(reply.at).getTime() < Math.max(REPLY_SHOWN_MS, reply.text.length * MS_PER_LETTER);
  // Anyone who was written to can answer here, so the answer carries the name of whoever gave it.
  const from = useStore((store) => (reply ? store.employees.get(reply.fromId)?.name : undefined), [reply?.fromId]);
  const ready = Boolean(chief && !chief.fired);
  const label = ready ? `Tell ${chief!.name} what to do next` : 'Hire a chief of staff to use the chat';

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const line = text.trim();
    if (!line || !ready) return;
    setError(null);
    try {
      await api.post('/api/chat', { text: line });
      setText('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure)); // the text stays, to send again
    }
  }

  return (
    <form className="chat" onSubmit={(event) => void send(event)}>
      {fresh && (
        <div className="chat-reply">
          <div className="chat-from">{from ?? chief?.name ?? 'Chief of staff'}</div>
          <Prose text={reply.text} />
        </div>
      )}
      {error && (
        <div className="chat-reply error" role="alert">
          {error}
        </div>
      )}
      <div className="chat-line">
        <label htmlFor="chat-text" className="sr-only">
          {label}
        </label>
        <MessageBox id="chat-text" autoComplete="off" disabled={!ready} placeholder={`${label}…`} value={text} onChange={setText} />
        <button type="submit" className="send" disabled={!ready}>
          Send
        </button>
      </div>
    </form>
  );
}
