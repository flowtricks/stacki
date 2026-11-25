// Hindi `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'बंद करें (बदलाव तुरंत सहेजे जाते हैं)',
  'workspace.code.title': 'कोड',
  'workspace.notifications.copied': 'कॉपी हो गया',
  'workspace.notifications.copy': 'कॉपी करें',
  'workspace.notifications.dismiss': 'सूचना हटाएँ',
  'workspace.notifications.label': 'सूचनाएँ',
  'workspace.notifications.loadMore': 'और लोड करें ({count})',
  'workspace.notifications.showFewer': 'कम दिखाएँ',
  'workspace.terminal.close': 'टर्मिनल बंद करें',
  'workspace.terminal.custom': 'कस्टम…',
  'workspace.terminal.customPlaceholder': 'जैसे bun run watch',
  'workspace.terminal.customTitle': 'हर नए टर्मिनल में एक बार चलाएँ',
  'workspace.terminal.hide': 'टर्मिनल छिपाएँ ({shortcut})',
  'workspace.terminal.loading': 'टर्मिनल लोड हो रहा है',
  'workspace.terminal.new': 'नया टर्मिनल',
  'workspace.terminal.resize': 'आकार बदलने के लिए खींचें',
  'workspace.terminal.scrollBottom': 'नीचे तक स्क्रोल करें',
  'workspace.terminal.shellOnly': 'केवल शेल',
} as const satisfies CatalogOf<MessageKey>;
