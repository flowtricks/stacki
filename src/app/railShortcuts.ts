// The rail's keyboard shortcuts, in one table that the keys, the tooltips and the Settings root all read, so the
// chord a person sees is the chord that works and no two actions share one. Desktop and Studio both read it. Every
// panel is ⌥ (Alt) plus a letter, matched on the physical key, because Option rewrites the typed letter ("ç" for C)
// and several letters are macOS dead keys; a field keeps them, so they still type there. Properties alone is a plain
// letter. Taken elsewhere: ⌥⇧P is the interactive preview, Alt+arrows reorder rail buttons, ⌘⌥⇧ digits are app
// commands. The canvas frames write the letters out (electron/preload/frameDesign.ts), held to this table by test.
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
  | 'files'
  | 'history'
  | 'apps'
  | 'audits'
  | 'projectSettings'
  | 'ai'
  // Roles has no chord: only hosted Studio lists it, in its Settings root.
  | Exclude<SettingsViewId, 'roles'>;

export interface RailShortcut {
  readonly action: RailAction;
  /** The letter: `p`, matched on the typed key; or on the physical key when `alt` is set. */
  readonly letter: string;
  readonly alt: boolean;
  readonly shift: boolean;
}

export const RAIL_SHORTCUTS: readonly RailShortcut[] = [
  { action: 'elements', letter: 'e', alt: true, shift: false },
  { action: 'pages', letter: 'p', alt: true, shift: false },
  { action: 'navigator', letter: 'n', alt: true, shift: false },
  { action: 'assets', letter: 'k', alt: true, shift: false },
  { action: 'cms', letter: 'd', alt: true, shift: false },
  { action: 'variables', letter: 'v', alt: true, shift: false },
  { action: 'history', letter: 'g', alt: true, shift: false },
  { action: 'components', letter: 'c', alt: true, shift: false },
  { action: 'properties', letter: 'k', alt: false, shift: false },
  { action: 'apps', letter: 'b', alt: true, shift: false },
  { action: 'code', letter: 'o', alt: true, shift: false },
  { action: 'files', letter: 'f', alt: true, shift: false },
  { action: 'selectors', letter: 's', alt: true, shift: false },
  { action: 'audits', letter: 'u', alt: true, shift: false },
  { action: 'projectSettings', letter: 'z', alt: true, shift: false },
  { action: 'ai', letter: 'a', alt: true, shift: false },
  { action: 'secrets', letter: 'r', alt: true, shift: false },
  { action: 'mcp', letter: 'm', alt: true, shift: false },
  { action: 'instructions', letter: 'i', alt: true, shift: false },
  { action: 'agents', letter: 'q', alt: true, shift: false },
];

/** The interactive preview's toggle: not a rail action, but written here so the table's test holds it apart. */
export const PREVIEW_SHORTCUT = { letter: 'p', alt: true, shift: true } as const satisfies Omit<RailShortcut, 'action'>;

/** The chord as the rail writes it: `K`, `⌥P`, `⌥⇧P`. */
export function railShortcutLabel(shortcut: Omit<RailShortcut, 'action'>): string {
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
