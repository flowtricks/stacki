// English `workspace` strings: terminal, code editor and notifications. Alphabetical.
// Each key is a stable dotted name; the other four locales hold exactly these keys, checked by the compiler and the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';

export const messages = {
  'workspace.code.close': 'Close (edits are saved live)',
  'workspace.code.title': 'Code',
  'workspace.notifications.dismiss': 'Dismiss notification',
  'workspace.notifications.label': 'Notifications',
  'workspace.notifications.loadMore': 'Load more ({count})',
  'workspace.notifications.showFewer': 'Show fewer',
  'workspace.terminal.close': 'Close terminal',
  'workspace.terminal.custom': 'Custom…',
  'workspace.terminal.customPlaceholder': 'e.g. bun run watch',
  'workspace.terminal.customTitle': 'Run once in each new terminal',
  'workspace.terminal.hide': 'Hide terminal ({shortcut})',
  'workspace.terminal.loading': 'Loading terminal',
  'workspace.terminal.new': 'New terminal',
  'workspace.terminal.resize': 'Drag to resize',
  'workspace.terminal.scrollBottom': 'Scroll to bottom',
  'workspace.terminal.shellOnly': 'Shell only',
} as const satisfies CatalogOf<`workspace.${string}`>;

export type MessageKey = keyof typeof messages;
