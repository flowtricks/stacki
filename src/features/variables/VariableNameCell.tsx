// A variable's name cell in the Variables panel: the type icon and the name (children), then a settings button that
// appears beside the name while the pointer is over the cell or focus is inside it (always, on a touch screen), and a
// quiet eye-off mark when the variable is hidden from suggestions.
//
// The button opens the shared Menu (src/ui/Menu.tsx). Its one row, "Hide from variable suggestions", ends in a check
// while the variable is hidden; choosing it again shows the variable. The list of rows is built in `settingsEntries`, so
// a later setting is one more entry.
//
// Layout: the button's box (`.vars-name-tools`) is always there, so the name does not shift when the button appears.
// Not revealed, the button is `hidden`, so it takes no focus; it is revealed by hover, by focus anywhere in the cell
// (Tab from the name reaches it), while its menu is open, and always on a touch screen. Clicking it never reaches the
// row, so it cannot start a rename or a drag.
import React, { useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import Menu, { useMenuTrigger, type MenuEntry } from '../../ui/Menu';
import { GearIcon, HideIcon } from '../../ui/Icons';

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

/** The menu's rows. Pure, so a test reads them without drawing anything. */
export function settingsEntries(name: string, visibility: VariableVisibilityControl, translate: Translator): readonly MenuEntry[] {
  const hidden = visibility.isHidden(name);
  return [
    {
      kind: 'item',
      id: 'hide-from-suggestions',
      label: translate('variables.settings.hideFromSuggestions'),
      checked: hidden,
      onSelect: () => visibility.setHidden(name, { hidden: !hidden }),
    },
  ];
}

// A phone or tablet has no hover: the button is simply there.
function primaryInputIsTouch(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
}

export default function VariableNameCell({ name, title, visibility, children }: VariableNameCellProps) {
  const translate = useTranslate();
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [touch] = useState(primaryInputIsTouch);
  const menu = useMenuTrigger();
  const settings = name !== undefined && visibility !== undefined ? { name, visibility } : undefined;
  const hidden = settings !== undefined && settings.visibility.isHidden(settings.name);
  const revealed = settings !== undefined && (pointerInside || focusInside || menu.open || touch);
  return (
    <div
      className="vars-name"
      title={title}
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        const next = event.relatedTarget ?? undefined;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setFocusInside(false);
        }
      }}
    >
      {children}
      {hidden && (
        <span className="vars-name-hidden" title={translate('variables.hidden.indicator')} role="img" aria-label={translate('variables.hidden.indicator')}>
          <HideIcon size={12} />
        </span>
      )}
      {settings !== undefined && (
        <span className="vars-name-tools">
          <button
            ref={menu.ref}
            type="button"
            className={`vars-name-settings ${menu.open ? 'is-open' : ''}`}
            hidden={!revealed}
            title={translate('variables.settings.open', { name: settings.name })}
            aria-label={translate('variables.settings.open', { name: settings.name })}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={(event) => {
              // The row underneath renames or drags; this button only opens its menu.
              event.stopPropagation();
              menu.toggle();
            }}
          >
            <GearIcon size={12} />
          </button>
          <Menu
            open={menu.open}
            anchor={menu.anchor}
            entries={settingsEntries(settings.name, settings.visibility, translate)}
            label={translate('variables.settings.menu')}
            onClose={() => {
              // Focus returns to the button when the menu closes, so the cell stays revealed until it leaves.
              setFocusInside(true);
              menu.close();
            }}
          />
        </span>
      )}
    </div>
  );
}
