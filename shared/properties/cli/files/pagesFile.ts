// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/pages.json`: the order of pages and folders in the Pages panel. The parser is shared/properties/pageOrder.ts;
// the panel writes it (src/features/pages/pageOrderPersistence.ts) as two-space JSON with a final newline.
import { PAGE_ORDER_LIMITS } from '../../pageOrder';
import { arrayOf, field, literal, text, type FileSchema } from '../stackiSchema';

export const PAGES_FILE: FileSchema = {
  id: 'pages',
  file: '.stacki/pages.json',
  description: 'The order of pages and folders in the Pages panel; entries not listed sort after the listed ones.',
  requires: 'panel:pages',
  metadataKind: 'pages',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    entries: field(
      arrayOf(
        // The parser (pageOrderKey) also refuses an empty, . or .. step and a file entry that does not end in .astro, .md or .mdx; it judges the finished file.
        text(PAGE_ORDER_LIMITS.pathCharsMax, { charsMin: 1, pattern: '^[^\\\\\\u0000-\\u001f]+$' }),
        PAGE_ORDER_LIMITS.entriesMax,
        { unique: true },
      ),
      'Page-relative paths in display order: a page file (blog/index.astro) or a folder with a trailing slash (blog/). Each folder orders only its own children.',
      { required: true, default: 'alphabetical order' },
    ),
  },
  empty: { version: 1, entries: [] },
  commands: [],
  parserSources: ['shared/properties/pageOrder.ts'],
};
