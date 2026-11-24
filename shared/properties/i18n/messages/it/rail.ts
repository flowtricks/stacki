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
  'rail.elements': 'Aggiungi elementi',
  'rail.history': 'Git', // same
  'rail.more': 'Altro',
  'rail.moveDown': 'Sposta in basso',
  'rail.moveToRail': 'Sposta nella barra laterale',
  'rail.moveUp': 'Sposta in alto',
  'rail.movedBottom': '{label}: gruppo in basso, posizione {position} di {count}',
  'rail.movedSettings': '{label}: Impostazioni, posizione {position} di {count}',
  'rail.movedTop': '{label}: gruppo in alto, posizione {position} di {count}',
  'rail.navigator': 'Navigatore',
  'rail.orderMenu': 'Ordine della barra',
  'rail.pages': 'Pagine',
  'rail.properties': 'Proprietà',
  'rail.selectors': 'Selettori di stile',
  'rail.settings': 'Impostazioni',
  'rail.settingsEmpty': 'Trascina qui le icone della barra laterale per tenerle in Impostazioni',
  'rail.settingsOrder.description': 'Trascina le icone nella barra laterale per riordinarle. Ripristina l’ordine predefinito.',
  'rail.settingsOrder.done': 'Ordine della barra laterale ripristinato',
  'rail.settingsOrder.label': 'Ordine delle icone della barra laterale',
  'rail.settingsOrder.reset': 'Ripristina predefinito',
  'rail.variables': 'Variabili',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
