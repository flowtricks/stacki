// Hebrew `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'יש לסגור את עורך ברירות המחדל לפני פתיחת קנבס.',
  'componentCanvas.error.notOpened': 'הרכיב לא נפתח בקנבס. יש לנסות שוב.',
  'componentCanvas.error.notReturned': 'לא ניתן היה לחזור לקובץ שבו היית. אפשר לפתוח אותו מחלונית הדפים.',
  'componentCanvas.error.open': 'לא ניתן היה לפתוח את הקנבס: {message}',
  'componentCanvas.error.save': 'לא ניתן היה לשמור את הגדרות הקנבס: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'לא הוגדר',
  'componentCanvas.menu.open': 'פתיחה בקנבס',
  'componentCanvas.notice.truncated': 'מוצגות {shown} המסגרות הראשונות מתוך {total}. כדי לראות את השאר, יש לתת מסגרות נפרדות לפחות props.',
  'componentCanvas.pageName': 'קנבס {name}',
  'componentCanvas.panel.background': 'רקע',
  'componentCanvas.panel.fixed': 'קבוע',
  'componentCanvas.panel.frame.hint': 'לחיצה על התווית של מסגרת או על השטח שסביב הרכיב שלה בוחרת את המסגרת. לחיצה בתוך הרכיב מאפשרת לערוך אותו.',
  'componentCanvas.panel.frame.pick': 'מסגרת',
  'componentCanvas.panel.frame.title': 'מסגרת',
  'componentCanvas.panel.frames': {
    one: 'מסגרת {count}',
    two: '{count} מסגרות',
    other: '{count} מסגרות',
  },
  'componentCanvas.panel.height': 'גובה',
  'componentCanvas.panel.hug': 'התאמה לתוכן',
  'componentCanvas.panel.pixels': '{side} בפיקסלים',
  'componentCanvas.panel.props.hint': 'הערכים שאיתם המסגרת הזו מרונדרת. הם נשארים בקנבס וחוזרים בכל פתיחה שלו. הם אף פעם לא נכתבים לרכיב או ל־instances שלו.',
  'componentCanvas.panel.props.none': 'לא הוגדר',
  'componentCanvas.panel.props.split': 'לכל ערך של {name} יש מסגרת משלו.',
  'componentCanvas.panel.props.title': 'Props לתצוגה מקדימה',
  'componentCanvas.panel.props.unused': 'הווריאנט הזה לא משתמש ב־{name}.',
  'componentCanvas.panel.scope.all': 'כל המסגרות',
  'componentCanvas.panel.scope.frame': 'המסגרת הזו',
  'componentCanvas.panel.scope.hint':
    'היכן חלים הגודל, הרקע וערכי ה־props שמגדירים: במסגרת הזו, בכל המסגרות של ערך אחד, או בכל המסגרות. הגדרה של מסגרת עצמה גוברת על הגדרה רחבה יותר.',
  'componentCanvas.panel.scope.label': 'החלה על',
  'componentCanvas.panel.scope.part': 'כל מסגרות {part}',
  'componentCanvas.panel.split.hint':
    'כל ערך של prop שמופעל כאן מקבל מסגרת משלו, והמסגרות מציגות את כל השילובים. prop שנשאר כבוי מציג ערך אחד בכל מסגרת, והוא נקבע ב־Props לתצוגה מקדימה.',
  'componentCanvas.panel.split.title': 'מסגרות נפרדות',
  'componentCanvas.panel.split.toggle': 'מסגרת נפרדת לכל ערך של {name}',
  'componentCanvas.panel.transparent': 'שקוף',
  'componentCanvas.panel.values': {
    one: 'ערך {count}',
    two: '{count} ערכים',
    other: '{count} ערכים',
  },
  'componentCanvas.panel.width': 'רוחב',
  'componentCanvas.popup.close': 'סגירת הגדרות המסגרת',
  'componentCanvas.popup.title': 'הגדרות מסגרת',
  'componentCanvas.titleBar.close': 'סגירת הקנבס {name}',
  'componentCanvas.zoom.fit': 'התאמה',
  'componentCanvas.zoom.fitAll': 'זום להתאמת כל המסגרות',
  'componentCanvas.zoom.in': 'הגדלה',
  'componentCanvas.zoom.out': 'הקטנה',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'זום ל-100%',
} as const satisfies CatalogOf<MessageKey>;
