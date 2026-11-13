// English `structure` strings: the source of truth for every key beginning `structure.` (docs/i18n.md). Alphabetical.
// Each key is a stable dotted name; the other four locales hold exactly these keys, checked by the compiler and the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';

export const messages = {
  'structure.collapseAll': 'Collapse all',
  'structure.dragHere': 'Drag components here',
  'structure.error.needsDeveloper': 'This page needs a Developer to fix its source before editing.',
  'structure.error.openCode': 'Open code panel',
  'structure.error.syntax': 'This page contains a syntax error.',
  'structure.error.syntaxNear': '{message} Near {near}',
  'structure.expandAll': 'Expand all',
  'structure.frontmatter': 'Frontmatter',
  'structure.imports': { one: '1 import', other: '{count} imports' },
  'structure.menu.convertTo': 'Convert to',
  'structure.menu.copy': 'Copy',
  'structure.menu.cut': 'Cut',
  'structure.menu.delete': 'Delete',
  'structure.menu.duplicate': 'Duplicate',
  'structure.menu.label': 'Element actions',
  'structure.menu.openComponent': 'Open component',
  'structure.menu.paste': 'Paste',
  'structure.menu.setDefaults': 'Set component defaults',
  'structure.menu.wrapIn': 'Wrap in',
  'structure.missing.injected':
    '{route} comes from {from}, not from this project — it can be previewed here, but its markup lives in a dependency and isn’t editable.',
  'structure.missing.integration': 'an integration',
  'structure.missing.select': 'Select a page to edit.',
  'structure.row.imported': 'Imported from {file}',
  'structure.status.empty': 'Renders nothing on the page with its current props',
  'structure.status.hidden': 'display: none — on the page, not drawn',
  'structure.status.inert': 'pointer-events: none — drawn, but takes no clicks',
} as const satisfies CatalogOf<`structure.${string}`>;

export type MessageKey = keyof typeof messages;
