// Italian `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Chat IA',
  'rail.appWaiting': '{name}: {count} in attesa',
  'rail.apps': 'App',
  'rail.assets': 'Risorse',
  'rail.audits': 'Audit', // same
  'rail.cms': 'CMS', // same
  'rail.code': 'Codice',
  'rail.collections': 'Collezioni',
  'rail.components': 'Componenti',
  'rail.editorPanels': 'Pannelli dell’editor',
  'rail.history': 'Git', // same
  'rail.more': 'Altro',
  'rail.moveToBottom': 'Sposta nel gruppo in basso',
  'rail.moveToTop': 'Sposta nel gruppo in alto',
  'rail.movedBottom': '{label}: gruppo in basso, posizione {position} di {count}',
  'rail.movedTop': '{label}: gruppo in alto, posizione {position} di {count}',
  'rail.navigator': 'Navigatore',
  'rail.orderMenu': 'Ordine della barra',
  'rail.pages': 'Pagine',
  'rail.properties': 'Proprietà',
  'rail.reset': 'Ripristina l’ordine della barra',
  'rail.resetDone': 'Ordine della barra ripristinato',
  'rail.selectors': 'Selettori di stile',
  'rail.settings': 'Impostazioni',
  'rail.settingsOrder.description': 'Trascina le icone nella barra laterale per riordinarle. Ripristina l’ordine predefinito.',
  'rail.settingsOrder.done': 'Ordine della barra laterale ripristinato',
  'rail.settingsOrder.label': 'Ordine delle icone della barra laterale',
  'rail.settingsOrder.reset': 'Ripristina predefinito',
  'rail.variables': 'Variabili',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
