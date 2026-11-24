// Dutch `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'AI-chat',
  'rail.appWaiting': '{name}: {count} wachtend',
  'rail.apps': 'Apps', // same
  'rail.assets': 'Assets', // same
  'rail.audits': 'Audits', // same
  'rail.cms': 'CMS', // same
  'rail.code': 'Code', // same
  'rail.collections': 'Collecties',
  'rail.components': 'Componenten',
  'rail.editorPanels': 'Editorpanelen',
  'rail.elements': 'Elementen toevoegen',
  'rail.history': 'Git', // same
  'rail.more': 'Meer',
  'rail.moveDown': 'Omlaag verplaatsen',
  'rail.moveToRail': 'Naar zijbalk verplaatsen',
  'rail.moveUp': 'Omhoog verplaatsen',
  'rail.movedBottom': '{label}: onderste groep, positie {position} van {count}',
  'rail.movedSettings': '{label}: Instellingen, positie {position} van {count}',
  'rail.movedTop': '{label}: bovenste groep, positie {position} van {count}',
  'rail.navigator': 'Navigator', // same
  'rail.orderMenu': 'Volgorde van de balk',
  'rail.pages': 'Pagina’s',
  'rail.properties': 'Eigenschappen',
  'rail.selectors': 'Stijlselectors',
  'rail.settings': 'Instellingen',
  'rail.settingsEmpty': 'Sleep pictogrammen uit de zijbalk hierheen om ze in Instellingen te bewaren',
  'rail.settingsOrder.description': 'Sleep de pictogrammen in de zijbalk om ze te herordenen. Herstel de standaardvolgorde.',
  'rail.settingsOrder.done': 'Volgorde van de zijbalk hersteld',
  'rail.settingsOrder.label': 'Volgorde van zijbalkpictogrammen',
  'rail.settingsOrder.reset': 'Standaard herstellen',
  'rail.variables': 'Variabelen',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
