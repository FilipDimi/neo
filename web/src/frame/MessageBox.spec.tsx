import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBox } from './MessageBox.tsx';

function Form({ onSend }: { onSend(text: string): void }) {
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSend(text);
      }}
    >
      <MessageBox id="box" aria-label="Message" value={text} onChange={setText} />
    </form>
  );
}

describe('MessageBox', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a box of several lines: Enter sends, Shift+Enter starts a new line', async () => {
    const sent: string[] = [];
    render(<Form onSend={(text) => sent.push(text)} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    await userEvent.type(box, 'First line{Shift>}{Enter}{/Shift}second line');
    expect(sent).toEqual([]);
    expect(box.value).toBe('First line\nsecond line');
    await userEvent.type(box, '{Enter}');
    expect(sent).toEqual(['First line\nsecond line']);
    expect(box.value).toBe('First line\nsecond line'); // Enter itself adds no line
  });

  it('grows to the height of what is typed, and shrinks back when it is cleared', async () => {
    // jsdom lays nothing out, so the height the text needs is given here: 20px a line.
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
      return 20 * this.value.split('\n').length;
    });
    render(<Form onSend={() => {}} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(box.style.height).toBe('20px');
    await userEvent.type(box, 'one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three');
    expect(box.style.height).toBe('60px');
    await userEvent.clear(box);
    expect(box.style.height).toBe('20px');
  });
});
