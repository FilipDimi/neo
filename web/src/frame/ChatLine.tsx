import { useState, type FormEvent } from 'react';
import { useApi } from '../app/context.ts';
import { useNow, useStore } from '../store/store.ts';

const REPLY_SHOWN_MS = 20_000;

/** The line to the chief of staff, on every view. What is typed here becomes tasks on the board. */
export function ChatLine() {
  const api = useApi();
  const now = useNow();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chief = useStore((store) => (store.company?.chiefOfStaffId ? store.employees.get(store.company.chiefOfStaffId) : undefined));
  const reply = useStore((store) => [...store.messages.values()].filter((message) => message.toId === 'user').sort((a, b) => a.at.localeCompare(b.at)).at(-1));
  const fresh = reply && now.getTime() - new Date(reply.at).getTime() < REPLY_SHOWN_MS;
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
      {fresh && <div className="chat-reply">{`${chief?.name ?? 'Chief of staff'}: ${reply.text}`}</div>}
      {error && (
        <div className="chat-reply error" role="alert">
          {error}
        </div>
      )}
      <div className="chat-line">
        <label htmlFor="chat-text" className="sr-only">
          {label}
        </label>
        <input id="chat-text" type="text" autoComplete="off" disabled={!ready} placeholder={`${label}…`} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="send" disabled={!ready}>
          Send
        </button>
      </div>
    </form>
  );
}
