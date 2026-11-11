import { useLayoutEffect, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import './prose.css';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'> & { value: string; onChange(text: string): void };

/**
 * Where a message is typed. It starts one line high and grows with what is typed, so a long message
 * can be read whole before it is sent; past its tallest it scrolls. Enter sends the form it is in,
 * Shift+Enter starts a new line.
 */
export function MessageBox({ value, onChange, className, ...rest }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const area = box.current;
    if (!area) return;
    area.style.height = 'auto'; // let it shrink first, or it would only ever grow
    area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter while a word is still being composed (Japanese, accents) chooses the word; it does not send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return <textarea ref={box} rows={1} className={className ? `message-box ${className}` : 'message-box'} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} {...rest} />;
}
