// The chat's own keyboard shortcuts, answered while focus is in the chat (its transcript or its
// composer) so they never take a key from the canvas: ⌘F / Ctrl+F finds in the chat (the app's ⌘F
// opens the insert palette everywhere else) and ⌘⇧O / Ctrl+Shift+O starts a new chat, as in Claude's
// apps. Escape in an empty composer stops the turn (ChatComposer.tsx). The shortcuts are shown only
// in tooltips (the "+" menu's rows), never printed inline.
import { assert } from '../../../shared/core/assert';
import { shortcutLabel } from '../../lib/shortcutLabel';

export type ChatShortcut = 'find' | 'new-chat';

/** The parts of a key event a shortcut is read from, so the rule is testable without a DOM. */
export interface ShortcutKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** The chat shortcut a key press is, or undefined. The primary modifier is ⌘ on a Mac and Ctrl elsewhere. */
export function chatShortcut(event: ShortcutKey, platform: NodeJS.Platform): ChatShortcut | undefined {
  const primary = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  if (!primary) {
    return undefined;
  }
  if (event.altKey) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  assert(key.length > 0, 'chatShortcut: a key press names its key');
  if (key === 'f') {
    return event.shiftKey ? undefined : 'find';
  }
  if (key === 'o') {
    return event.shiftKey ? 'new-chat' : undefined;
  }
  return undefined;
}

/** The label a tooltip shows for a chat shortcut ("⌘F", "Ctrl+Shift+O"). */
export function chatShortcutLabel(shortcut: ChatShortcut, platform: NodeJS.Platform): string {
  switch (shortcut) {
    case 'find':
      return shortcutLabel('F', 'primary', platform);
    case 'new-chat':
      return shortcutLabel('O', 'primary-shift', platform);
    default: {
      const exhaustive: never = shortcut;
      return exhaustive;
    }
  }
}
