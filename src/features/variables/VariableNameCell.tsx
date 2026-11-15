// A variable's name cell in the Variables panel: the type icon and the name (children), then a settings button that
// appears beside the name while the pointer is over the cell, while its popup is open or while it has keyboard focus
// (always, on a touch screen), and a quiet eye-off mark when the variable is hidden from suggestions.
//
// The button opens a small popup (VariableSettingsPopup), not a menu: a titled surface with the one setting, "Hide from
// variable suggestions", or "Show in variable suggestions" once the variable is hidden. The setting is built in
// `settingsAction`, so a later setting is one more row.
//
// Why the button's visibility is CSS and not React state: it used to follow `mouseenter`/`mouseleave` and `focus`/`blur`
// flags. A popup closed by an outside press does not give focus back (the press already moved it), so no `blur` ever
// reached the cell, the focus flag stayed set and the button stayed on screen for good. Now the stylesheet decides, from
// states the browser keeps true by itself: `:hover` on the cell, `:focus-visible` on the button and
// `aria-expanded="true"` while the popup is open. Nothing here can fall out of step with the pointer or the focus.
//
// Layout: the button's box (`.vars-name-tools`) is always there, so the name does not shift when the button appears.
// Not shown, the button is transparent and ignores the pointer, but stays focusable so Tab from the name reaches it.
// Clicking it never reaches the row, so it cannot start a rename or a drag.
import React from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { useMenuTrigger } from '../../ui/Menu';
import { GearIcon, HideIcon } from '../../ui/Icons';
import VariableSettingsPopup, { type VariableSettingsAction } from './VariableSettingsPopup';

/** What the panel gives the name cell: which variables are hidden, and how to change that. */
export interface VariableVisibilityControl {
  readonly isHidden: (name: string) => boolean;
  readonly setHidden: (name: string, change: { readonly hidden: boolean }) => void;
}

interface VariableNameCellProps {
  /** The custom property (`--light-100`). Absent for a row that stands for several variables (a matrix row): it has no settings. */
  readonly name: string | undefined;
  readonly title: string;
  readonly visibility: VariableVisibilityControl | undefined;
  readonly children: React.ReactNode;
}

/** The popup's actions. Pure, so a test reads them without drawing anything. */
export function settingsActions(name: string, visibility: VariableVisibilityControl, translate: Translator): readonly VariableSettingsAction[] {
  const hidden = visibility.isHidden(name);
  return [
    {
      id: hidden ? 'show-in-suggestions' : 'hide-from-suggestions',
      label: translate(hidden ? 'variables.settings.showInSuggestions' : 'variables.settings.hideFromSuggestions'),
      onSelect: () => visibility.setHidden(name, { hidden: !hidden }),
    },
  ];
}

export default function VariableNameCell({ name, title, visibility, children }: VariableNameCellProps) {
  const translate = useTranslate();
  const popup = useMenuTrigger();
  const settings = name !== undefined && visibility !== undefined ? { name, visibility } : undefined;
  const hidden = settings !== undefined && settings.visibility.isHidden(settings.name);
  return (
    <div className="vars-name" title={title}>
      {children}
      {hidden && (
        <span className="vars-name-hidden" title={translate('variables.hidden.indicator')} role="img" aria-label={translate('variables.hidden.indicator')}>
          <HideIcon size={12} />
        </span>
      )}
      {settings !== undefined && (
        <span className="vars-name-tools">
          <button
            ref={popup.ref}
            type="button"
            className="vars-name-settings"
            title={translate('variables.settings.open', { name: settings.name })}
            aria-label={translate('variables.settings.open', { name: settings.name })}
            aria-haspopup="dialog"
            aria-expanded={popup.open}
            onClick={(event) => {
              // The row underneath renames or drags; this button only opens its popup.
              event.stopPropagation();
              popup.toggle();
            }}
          >
            <GearIcon size={12} />
          </button>
          <VariableSettingsPopup
            open={popup.open}
            anchor={popup.anchor}
            title={settings.name}
            label={translate('variables.settings.menu')}
            actions={settingsActions(settings.name, settings.visibility, translate)}
            onClose={popup.close}
          />
        </span>
      )}
    </div>
  );
}
