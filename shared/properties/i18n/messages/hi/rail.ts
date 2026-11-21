// Hindi `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'AI चैट',
  'rail.appWaiting': '{name}: {count} प्रतीक्षा में',
  'rail.apps': 'ऐप्स',
  'rail.assets': 'एसेट',
  'rail.audits': 'ऑडिट',
  'rail.cms': 'CMS', // same
  'rail.code': 'कोड',
  'rail.collections': 'कलेक्शन',
  'rail.components': 'कंपोनेंट',
  'rail.editorPanels': 'एडिटर पैनल',
  'rail.history': 'Git', // same
  'rail.more': 'और',
  'rail.moveToBottom': 'निचले समूह में ले जाएँ',
  'rail.moveToTop': 'ऊपरी समूह में ले जाएँ',
  'rail.movedBottom': '{label}: निचला समूह, {count} में से स्थान {position}',
  'rail.movedTop': '{label}: ऊपरी समूह, {count} में से स्थान {position}',
  'rail.navigator': 'नेविगेटर',
  'rail.orderMenu': 'रेल का क्रम',
  'rail.pages': 'पेज',
  'rail.properties': 'प्रॉपर्टी',
  'rail.reset': 'रेल का क्रम रीसेट करें',
  'rail.resetDone': 'रेल का क्रम रीसेट हुआ',
  'rail.selectors': 'स्टाइल सेलेक्टर',
  'rail.settings': 'सेटिंग',
  'rail.settingsOrder.description': 'साइडबार में आइकन खींचकर उनका क्रम बदलें। डिफ़ॉल्ट क्रम पर रीसेट करें।',
  'rail.settingsOrder.done': 'साइडबार का क्रम रीसेट हुआ',
  'rail.settingsOrder.label': 'साइडबार आइकन का क्रम',
  'rail.settingsOrder.reset': 'डिफ़ॉल्ट पर रीसेट करें',
  'rail.variables': 'वेरिएबल',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
