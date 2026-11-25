// Hebrew `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'סגירה (העריכות נשמרות מיד)',
  'workspace.code.title': 'קוד',
  'workspace.notifications.dismiss': 'סגירת ההתראה',
  'workspace.notifications.label': 'התראות',
  'workspace.notifications.loadMore': 'טעינת עוד ({count})',
  'workspace.notifications.showFewer': 'הצגת פחות',
  'workspace.terminal.close': 'סגירת הטרמינל',
  'workspace.terminal.custom': 'מותאם אישית…',
  'workspace.terminal.customPlaceholder': 'למשל bun run watch',
  'workspace.terminal.customTitle': 'הרצה חד-פעמית בכל טרמינל חדש',
  'workspace.terminal.hide': 'הסתרת הטרמינל ({shortcut})',
  'workspace.terminal.loading': 'הטרמינל נטען',
  'workspace.terminal.new': 'טרמינל חדש',
  'workspace.terminal.resize': 'גרירה לשינוי הגודל',
  'workspace.terminal.scrollBottom': 'גלילה לתחתית',
  'workspace.terminal.shellOnly': 'Shell בלבד',
} as const satisfies CatalogOf<MessageKey>;
