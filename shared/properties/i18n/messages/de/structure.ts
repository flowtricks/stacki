// German `structure` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/structure';

export const messages = {
  'structure.collapseAll': 'Alle einklappen',
  'structure.dragHere': 'Komponenten hierher ziehen',
  'structure.error.needsDeveloper': 'Diese Seite muss von einem Entwickler im Quelltext korrigiert werden, bevor sie bearbeitet werden kann.',
  'structure.error.openCode': 'Code-Bereich öffnen',
  'structure.error.syntax': 'Diese Seite enthält einen Syntaxfehler.',
  'structure.error.syntaxNear': '{message} In der Nähe von {near}',
  'structure.expandAll': 'Alle ausklappen',
  'structure.frontmatter': 'Frontmatter', // same
  'structure.imports': { one: '1 Import', other: '{count} Imports' },
  'structure.menu.convertTo': 'Umwandeln in',
  'structure.menu.copy': 'Kopieren',
  'structure.menu.cut': 'Ausschneiden',
  'structure.menu.delete': 'Löschen',
  'structure.menu.duplicate': 'Duplizieren',
  'structure.menu.label': 'Element-Aktionen',
  'structure.menu.openComponent': 'Komponente öffnen',
  'structure.menu.paste': 'Einfügen',
  'structure.menu.setDefaults': 'Komponenten-Standardwerte festlegen',
  'structure.menu.wrapIn': 'Umschließen mit',
  'structure.missing.injected':
    '{route} stammt von {from}, nicht aus diesem Projekt – sie lässt sich hier in der Vorschau ansehen, ihr Markup liegt aber in einer Abhängigkeit und ist nicht bearbeitbar.',
  'structure.missing.integration': 'eine Integration',
  'structure.missing.select': 'Wähle eine Seite zum Bearbeiten.',
  'structure.row.imported': 'Importiert aus {file}',
  'structure.status.empty': 'Zeigt mit den aktuellen Props nichts auf der Seite an',
  'structure.status.hidden': 'display: none – auf der Seite, aber nicht gezeichnet',
  'structure.status.inert': 'pointer-events: none – wird gezeichnet, nimmt aber keine Klicks an',
} as const satisfies CatalogOf<MessageKey>;
