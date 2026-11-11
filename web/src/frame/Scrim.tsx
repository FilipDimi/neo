import { useRef, type ReactNode } from 'react';

/**
 * The dimmed page behind a form. A click on it closes the form, but only a click that began there: a text selection
 * dragged out of the panel is released over the dimmed page too, and that must not throw away what was typed.
 */
export function Scrim({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const pressed = useRef(false);
  return (
    <div
      className="scrim"
      onMouseDown={(event) => void (pressed.current = event.target === event.currentTarget)}
      onClick={(event) => {
        if (pressed.current && event.target === event.currentTarget) onClose();
        pressed.current = false;
      }}
    >
      {children}
    </div>
  );
}
