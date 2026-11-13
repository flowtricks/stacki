// French `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Chat IA',
  'rail.appWaiting': '{name} : {count} en attente',
  'rail.apps': 'Apps', // same
  'rail.assets': 'Ressources',
  'rail.audits': 'Audits', // same
  'rail.cms': 'CMS', // same
  'rail.code': 'Code', // same
  'rail.collections': 'Collections', // same
  'rail.components': 'Composants',
  'rail.editorPanels': 'Panneaux de l’éditeur',
  'rail.history': 'Git', // same
  'rail.instructions': 'Instructions', // same
  'rail.more': 'Plus',
  'rail.navigator': 'Navigateur',
  'rail.pages': 'Pages', // same
  'rail.properties': 'Propriétés',
  'rail.selectors': 'Sélecteurs de style',
  'rail.settings': 'Réglages',
  'rail.variables': 'Variables', // same
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
