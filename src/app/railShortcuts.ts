// The rail's keyboard shortcuts, in one table that the keys, the tooltips and the Settings root all read, so the
// chord a person sees is the chord that works and no two actions share one. A letter alone opens a panel
// (matched on the typed letter); ⌥ plus a letter opens one matched on the physical key, because Option rewrites
// the typed letter ("ç" for C). Free ⌥ letters: B D F G J K N O Q R T U W X Y Z. Taken elsewhere: ⌥P is the
// interactive preview (appShortcuts.ts), Alt+arrows reorder rail buttons, ⌘⌥⇧ digits are app commands.
import type { SettingsViewId } from '../lib/settingsSections';

/** What a chord does: toggles a panel, opens Settings at a view, or toggles the AI chat. */
export type RailAction =
  | 'elements'
  | 'pages'
  | 'navigator'
  | 'properties'
  | 'components'
  | 'assets'
  | 'cms'
  | 'variables'
  | 'selectors'
  | 'code'
  | 'history'
  | 'apps'
  | 'audits'
  | 'projectSettings'
  | 'ai'
  // Roles has no chord: only hosted Studio lists it, in its Settings root. Agents has none either: it opens from its row.
  | Exclude<SettingsViewId, 'roles' | 'agents'>;

export interface RailShortcut {
  readonly action: RailAction;
  /** The letter: `p`, matched on the typed key; or on the physical key when `alt` is set. */
  readonly letter: string;
  readonly alt: boolean;
  readonly shift: boolean;
}

export const RAIL_SHORTCUTS: readonly RailShortcut[] = [
  { action: 'elements', letter: 'a', alt: false, shift: false },
  { action: 'pages', letter: 'p', alt: false, shift: false },
  { action: 'navigator', letter: 'z', alt: false, shift: false },
  { action: 'components', letter: 'a', alt: false, shift: true },
  { action: 'properties', letter: 'k', alt: false, shift: false },
  { action: 'assets', letter: 'j', alt: false, shift: false },
  { action: 'code', letter: 'c', alt: false, shift: false },
  { action: 'selectors', letter: 'g', alt: false, shift: false },
  { action: 'apps', letter: 'e', alt: false, shift: false },
  { action: 'cms', letter: 'c', alt: true, shift: false },
  { action: 'variables', letter: 'v', alt: true, shift: false },
  { action: 'history', letter: 'h', alt: true, shift: false },
  { action: 'instructions', letter: 'i', alt: true, shift: false },
  { action: 'audits', letter: 'a', alt: true, shift: false },
  { action: 'projectSettings', letter: 's', alt: true, shift: false },
  { action: 'ai', letter: 'l', alt: true, shift: false },
  { action: 'secrets', letter: 'e', alt: true, shift: false },
  { action: 'mcp', letter: 'm', alt: true, shift: false },
];

/** The chord as the rail writes it: `P`, `⇧A`, `⌥L`. */
export function railShortcutLabel(shortcut: RailShortcut): string {
  return `${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.letter.toUpperCase()}`;
}

/** The label of an action's chord; every action in the table has one. */
export function shortcutOf(action: RailAction): string {
  const found = RAIL_SHORTCUTS.find((shortcut) => shortcut.action === action);
  if (found === undefined) {
    throw new Error(`No rail shortcut for ${action}`);
  }
  return railShortcutLabel(found);
}

/** The action a key press asks for, or undefined. Modified presses (⌘, Ctrl) are never the rail's. */
export function railActionOf(event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'key' | 'code'>): RailShortcut | undefined {
  if (event.metaKey || event.ctrlKey) {
    return undefined;
  }
  return RAIL_SHORTCUTS.find((shortcut) => {
    if (shortcut.alt !== event.altKey) {
      return false;
    }
    if (shortcut.alt) {
      // Shift is not part of an ⌥ chord; ⌥⇧ is something else.
      return !event.shiftKey && event.code === `Key${shortcut.letter.toUpperCase()}`;
    }
    return shortcut.shift === event.shiftKey && event.key.toLowerCase() === shortcut.letter;
  });
}
