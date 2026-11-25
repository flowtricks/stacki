// Arabic `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'إغلاق (تُحفظ التعديلات مباشرة)',
  'workspace.code.title': 'الكود',
  'workspace.notifications.dismiss': 'تجاهل الإشعار',
  'workspace.notifications.label': 'الإشعارات',
  'workspace.notifications.loadMore': 'تحميل المزيد ({count})',
  'workspace.notifications.showFewer': 'عرض أقل',
  'workspace.terminal.close': 'إغلاق الطرفية',
  'workspace.terminal.custom': 'مخصص…',
  'workspace.terminal.customPlaceholder': 'مثل bun run watch',
  'workspace.terminal.customTitle': 'يُنفَّذ مرة واحدة في كل طرفية جديدة',
  'workspace.terminal.hide': 'إخفاء الطرفية ({shortcut})',
  'workspace.terminal.loading': 'جارٍ تحميل الطرفية',
  'workspace.terminal.new': 'طرفية جديدة',
  'workspace.terminal.resize': 'اسحب لتغيير الحجم',
  'workspace.terminal.scrollBottom': 'التمرير إلى الأسفل',
  'workspace.terminal.shellOnly': 'الصدفة فقط',
} as const satisfies CatalogOf<MessageKey>;
