// Hebrew `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'צ׳אט AI',
  'rail.appWaiting': '{name}: {count} ממתינים',
  'rail.apps': 'אפליקציות',
  'rail.assets': 'נכסים',
  'rail.audits': 'ביקורות',
  'rail.cms': 'CMS', // same
  'rail.code': 'קוד',
  'rail.collections': 'אוספים',
  'rail.components': 'רכיבים',
  'rail.editorPanels': 'חלוניות העורך',
  'rail.elements': 'הוספת אלמנטים',
  'rail.history': 'Git', // same
  'rail.more': 'עוד',
  'rail.moveDown': 'הזזה למטה',
  'rail.moveToRail': 'העברה לסרגל הצד',
  'rail.moveUp': 'הזזה למעלה',
  'rail.movedBottom': '{label}: הקבוצה התחתונה, מקום {position} מתוך {count}',
  'rail.movedSettings': '{label}: הגדרות, מקום {position} מתוך {count}',
  'rail.movedTop': '{label}: הקבוצה העליונה, מקום {position} מתוך {count}',
  'rail.navigator': 'ניווט',
  'rail.orderMenu': 'סדר הסרגל',
  'rail.pages': 'דפים',
  'rail.properties': 'מאפיינים',
  'rail.selectors': 'סלקטורים של סגנון',
  'rail.settings': 'הגדרות',
  'rail.settingsEmpty': 'גררו לכאן סמלים מסרגל הצד כדי לשמור אותם בהגדרות',
  'rail.settingsOrder.description': 'גררו סמלים בסרגל הצד כדי לשנות את סדרם. אפשר לאפס לסדר ברירת המחדל.',
  'rail.settingsOrder.done': 'סדר סרגל הצד אופס',
  'rail.settingsOrder.label': 'סדר הסמלים בסרגל הצד',
  'rail.settingsOrder.reset': 'איפוס לברירת מחדל',
  'rail.variables': 'משתנים',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
