import type { ReactNode } from 'react';

// The `!important` mark for a control that has no text to show it in.
//
// A text field shows the flag after its value (model/styleDisplay.ts). A
// segmented bar, a select or a spacing label cannot: their face is a picked
// option or a number, and before this mark they drew `solid !important` exactly
// as they drew `solid`. The mark is the same small `!` wherever it appears, so
// one look tells the person that the flag is set and that a pick keeps it.

/** The `!` itself, for a face that places it in its own flow (a spacing label). */
export function ImportantBadge() {
  return (
    <span className="embed-editor_important-badge" role="img" aria-label="!important" title="!important">
      !
    </span>
  );
}

/** A control, marked when its property is `!important`; unchanged otherwise. */
export default function ImportantMark({ important, children }: { readonly important: boolean; readonly children: ReactNode }) {
  if (!important) {
    return children;
  }
  return (
    <div className="embed-editor_important-mark">
      {children}
      <ImportantBadge />
    </div>
  );
}
