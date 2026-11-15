import { useRef, useState } from 'react';
import { followWhileRendering } from './fieldHooks';

// What a value field is showing, which is not always what the file says.
//
// A field keeps a draft so that typing is not fought by the model, and the
// draft follows the file whenever the field is idle. Clearing the property is
// the one edit the draft cannot learn about that way: the value it holds is
// exactly what was removed, and the model that would say so is a save and a
// re-resolve away — every rule is matched against the element again before any
// field hears a word about it. So the field went on showing the value it had
// just deleted, for as long as that took, while the CSS on disk no longer had
// it and the canvas had already moved.
//
// `cleared()` empties the field at once, because that is what was asked for.
// The model still arrives and still wins: when the save finishes, the field
// shows whatever the file now says — including a value from a rule further
// down the cascade, which was there all along and is now the one that applies.
export function useFieldDraft(external: string, options: { readonly busy: boolean }) {
  const { busy } = options;
  const [draft, setDraft] = useState(external);
  const focused = useRef(false);

  // The ordinary sync: a value that changed elsewhere, while nobody is typing
  // in this field. Followed while rendering (fieldHooks.ts followWhileRendering).
  followWhileRendering(useState(external), external, () => {
    if (!focused.current) {
      setDraft(external);
    }
  });

  // And the end of a save, which is the moment the model is worth believing
  // again — the value may be the same string it was before the edit, so there
  // is nothing above for the change to fire on.
  followWhileRendering(useState(busy), busy, () => {
    if (busy) {
      return;
    }
    if (!focused.current) {
      setDraft(external);
    }
  });

  return { draft, setDraft, focused, cleared: () => setDraft('') };
}
