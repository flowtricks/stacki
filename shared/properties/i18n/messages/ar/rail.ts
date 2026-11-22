// Arabic `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'محادثة الذكاء الاصطناعي',
  'rail.appWaiting': '{name}: {count} قيد الانتظار',
  'rail.apps': 'التطبيقات',
  'rail.assets': 'الأصول',
  'rail.audits': 'عمليات التدقيق',
  'rail.cms': 'CMS', // same
  'rail.code': 'الشيفرة',
  'rail.collections': 'المجموعات',
  'rail.components': 'المكوّنات',
  'rail.editorPanels': 'لوحات المحرّر',
  'rail.elements': 'إضافة عناصر',
  'rail.history': 'Git', // same
  'rail.more': 'المزيد',
  'rail.moveDown': 'نقل لأسفل',
  'rail.moveIntoSettings': 'نقل إلى الإعدادات',
  'rail.moveToBottom': 'نقل إلى المجموعة السفلية',
  'rail.moveToRail': 'نقل إلى الشريط الجانبي',
  'rail.moveToTop': 'نقل إلى المجموعة العلوية',
  'rail.moveUp': 'نقل لأعلى',
  'rail.movedBottom': '{label}: المجموعة السفلية، الموضع {position} من {count}',
  'rail.movedSettings': '{label}: الإعدادات، الموضع {position} من {count}',
  'rail.movedTop': '{label}: المجموعة العلوية، الموضع {position} من {count}',
  'rail.navigator': 'المستكشف',
  'rail.orderMenu': 'ترتيب الشريط',
  'rail.pages': 'الصفحات',
  'rail.properties': 'الخصائص',
  'rail.reset': 'إعادة ضبط ترتيب الشريط',
  'rail.resetDone': 'تمت إعادة ضبط ترتيب الشريط',
  'rail.selectors': 'محدِّدات التنسيق',
  'rail.settings': 'الإعدادات',
  'rail.settingsEmpty': 'اسحب أيقونات الشريط الجانبي إلى هنا لإبقائها في الإعدادات',
  'rail.settingsOrder.description': 'اسحب الأيقونات في الشريط الجانبي لإعادة ترتيبها. أعد الضبط إلى الترتيب الافتراضي.',
  'rail.settingsOrder.done': 'تمت إعادة ضبط ترتيب الشريط الجانبي',
  'rail.settingsOrder.label': 'ترتيب أيقونات الشريط الجانبي',
  'rail.settingsOrder.reset': 'إعادة الضبط إلى الافتراضي',
  'rail.variables': 'المتغيرات',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
