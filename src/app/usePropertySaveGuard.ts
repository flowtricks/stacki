import { useEffect, useRef, useState } from 'react';

// A prop edit spans multiple files. Hold interaction until the old editor model
// has been replaced, otherwise an ordinary autosave could resurrect the old API.
export function usePropertySaveGuard() {
  const saving = useRef(false);
  // Input stops only for a whole-site save. A form saving itself holds page edits
  // and undo (`saving`), but the person is still typing in that form.
  const blocking = useRef(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'autosaving'>('idle');
  const changePhase = (next: 'idle' | 'saving' | 'autosaving'): void => {
    saving.current = next !== 'idle';
    blocking.current = next === 'saving';
    setPhase(next);
  };
  useEffect(() => {
    const block = (event: Event): void => {
      if (blocking.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const events = ['keydown', 'pointerdown', 'mousedown', 'click', 'dblclick', 'drop'] as const;
    for (const event of events) {
      window.addEventListener(event, block, true);
    }
    return () => {
      for (const event of events) {
        window.removeEventListener(event, block, true);
      }
    };
  }, []);
  return { phase, saving, changePhase };
}
