// How the AI panel lays itself out at a given width, and which key steps to the next or previous chat.
// Pure, so the tests call it with numbers: the panel measures its own body and asks here.
//
// Below the split width the panel is one column that shows either the chat list or one chat (the back
// chevron moves between them). At the split width and wider (an expanded panel, a wide floating window or a
// docked panel dragged wide) the list stays beside the chat as a sidebar on the inline-start side, so moving
// between chats is one click and the open one stays marked in the list.
import { assert } from '../../../shared/core/assert';

/** The narrowest body that shows the list beside the chat: a 280px sidebar plus a chat column that still reads well (480px). */
export const CHAT_SPLIT_WIDTH_PX_MIN = 760;
/** The sidebar's width in the split layout; aiShell.css holds the same number for `.ai-sidebar`. */
export const CHAT_SIDEBAR_WIDTH_PX = 280;
/** The widest a message column grows before it centres: longer lines are hard to read. aiShell.css holds the same number. */
export const CHAT_COLUMN_WIDTH_PX_MAX = 760;

export type ChatLayout = 'stacked' | 'split';

/** The layout for a body `widthPx` wide; an unmeasured body (undefined) is stacked, the layout every panel opens in. */
export function chatLayoutFor(widthPx: number | undefined): ChatLayout {
  if (widthPx === undefined) {
    return 'stacked';
  }
  assert(Number.isFinite(widthPx), 'chatLayoutFor: the width is finite');
  assert(widthPx >= 0, 'chatLayoutFor: the width is not negative');
  return widthPx >= CHAT_SPLIT_WIDTH_PX_MIN ? 'split' : 'stacked';
}

export interface ChatStepKeyEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Ctrl+Tab goes to the next chat in the list and Ctrl+Shift+Tab to the previous one, the chord every tabbed app
 * uses for its next tab. Control on every platform (not Command), because Command+Tab belongs to macOS.
 */
export function chatStepFor(event: ChatStepKeyEvent): 'next' | 'previous' | undefined {
  if (event.key !== 'Tab') {
    return undefined;
  }
  if (!event.ctrlKey) {
    return undefined;
  }
  if (event.altKey || event.metaKey) {
    return undefined;
  }
  return event.shiftKey ? 'previous' : 'next';
}

/**
 * The item `direction` steps to from `current` in `order`, wrapping at the ends. With nothing current the
 * step lands on the first item (next) or the last (previous); an empty order has nowhere to go.
 */
export function stepThrough<T>(order: readonly T[], current: T | undefined, direction: 'next' | 'previous'): T | undefined {
  if (order.length === 0) {
    return undefined;
  }
  const index = current === undefined ? -1 : order.indexOf(current);
  const count = order.length;
  const target = index < 0 ? (direction === 'next' ? 0 : count - 1) : (index + (direction === 'next' ? 1 : count - 1)) % count;
  assert(target >= 0, 'stepThrough: the step stays inside the list');
  assert(target < count, 'stepThrough: the step stays inside the list');
  return order[target];
}
