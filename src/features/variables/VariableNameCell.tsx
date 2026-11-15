// A variable's name cell in the Variables panel: the type icon and the name (children), and a quiet eye-off mark when
// the variable is hidden from suggestions. The control that hides it is not here: it is an eye button drawn over the
// variable's VALUE, at the end of its cell (ValueCellHost in VariableTable.tsx), in every layout.
//
// The eye (`VariableVisibilityButton` below) is one click: an eye while the variable is offered in suggestions, an eye
// with a line through it once hidden. It writes `.stacki/variables.json` once per click and never on hover or focus.
//
// Why its visibility is CSS and not React state: it used to follow `mouseenter`/`mouseleave` and `focus`/`blur` flags
// and stuck on screen when focus left without a `blur`. Now the stylesheet decides, from states the browser keeps true
// by itself: `:hover` on the value cell, `:focus-visible` on the button, and `aria-pressed="true"` (hidden variables
// always show their line-through eye, dimmed, so they can be found and shown again). Nothing here can fall out of step
// with the pointer or the focus. Not shown, the button ignores the pointer but stays focusable, so Tab from the value
// reaches it. Clicking it never reaches the row, so it cannot start a rename or a drag.
import React, { useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { HideIcon, PreviewIcon } from '../../ui/Icons';

/** What the panel gives the cells: which variables are hidden, and how to change that. */
export interface VariableVisibilityControl {
  readonly isHidden: (name: string) => boolean;
  /** Resolves true once the change is saved, false when it could not be (the panel has already said so). */
  readonly setHidden: (name: string, change: { readonly hidden: boolean }) => Promise<boolean>;
}

interface VariableNameCellProps {
  /** The custom property (`--light-100`). Absent for a row that stands for several variables (a matrix row): it has no settings. */
  readonly name: string | undefined;
  readonly title: string;
  readonly visibility: VariableVisibilityControl | undefined;
  readonly children: React.ReactNode;
}

/**
 * The eye for one variable, drawn over the end of its value cell. It flips at once (`pending`) and the file is written
 * once per click; when the panel reports a refusal the eye goes back to what the file says.
 */
export function VariableVisibilityButton({ name, visibility }: { readonly name: string; readonly visibility: VariableVisibilityControl }) {
  const translate = useTranslate();
  const [pending, setPending] = useState<boolean | undefined>(undefined);
  const hidden = pending ?? visibility.isHidden(name);
  const label = translate(hidden ? 'variables.settings.showInSuggestions' : 'variables.settings.hideFromSuggestions');
  return (
    <button
      type="button"
      className="vars-visibility"
      title={label}
      aria-label={label}
      aria-pressed={hidden}
      data-variable={name}
      onClick={(event) => {
        // The row underneath renames or drags; this button only flips the variable.
        event.stopPropagation();
        const next = !hidden;
        setPending(next);
        void visibility.setHidden(name, { hidden: next }).then(() => {
          // Saved: the file now says what the eye shows. Refused: it says the old thing, and the eye goes back to it.
          setPending((current) => (current === next ? undefined : current));
        });
      }}
    >
      {hidden ? <HideIcon size={12} /> : <PreviewIcon size={12} />}
    </button>
  );
}

export default function VariableNameCell({ name, title, visibility, children }: VariableNameCellProps) {
  const translate = useTranslate();
  const hidden = name !== undefined && visibility !== undefined && visibility.isHidden(name);
  return (
    <div className="vars-name" title={title}>
      {children}
      {hidden && (
        <span className="vars-name-hidden" title={translate('variables.hidden.indicator')} role="img" aria-label={translate('variables.hidden.indicator')}>
          <HideIcon size={12} />
        </span>
      )}
    </div>
  );
}
