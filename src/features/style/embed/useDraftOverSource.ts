// The text a CSS code editor shows over the text it was read from (InlineBranchEditor.tsx, QueryForms.tsx).
// An edit from outside (the panel's controls, undo) replaces a clean draft; text being typed stays. The editor
// saves a draft that differs from its source, so a clean draft left behind would be saved over the outside edit.

import { useEffect, useRef, useState } from 'react';

export function useDraftOverSource(source: string): readonly [string, (next: string) => void] {
  const [draft, setDraft] = useState(source);
  const previousRef = useRef(source);
  useEffect(() => {
    // Taken before the ref moves on: React runs the updater at once only while the component has nothing pending,
    // and otherwise in the next render, where reading the ref would call every clean draft typed text.
    const previous = previousRef.current;
    previousRef.current = source;
    setDraft((current) => (current === previous ? source : current));
  }, [source]);
  return [draft, setDraft];
}
