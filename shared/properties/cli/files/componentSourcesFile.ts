// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/component-sources.json`: installed packages whose .astro components appear in the palette. The parser is
// shared/properties/componentSources.ts. The app only reads this file; people (or the CLI) write it.
import { COMPONENT_SOURCE_LIMITS } from '../../componentSources';
import { arrayOf, field, literal, objectOf, text, type FileSchema } from '../stackiSchema';

// The bounds below mirror parsePackageComponentSource, which keeps them inline: package names (npm's 214), directories (300), prefixes (500).
const PACKAGE_NAME_CHARS_MAX = 214;
const DIRECTORY_CHARS_MAX = 300;
const IMPORT_PREFIX_CHARS_MAX = 500;

export const COMPONENT_SOURCES_FILE: FileSchema = {
  id: 'componentSources',
  file: '.stacki/component-sources.json',
  description: 'Installed packages whose components the palette lists, with the import spelling used when one is inserted.',
  requires: 'settings:folders',
  metadataKind: 'componentSources',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    sources: field(
      arrayOf(
        objectOf({
          kind: field(literal('package'), 'The source kind; only installed packages are supported.', { required: true }),
          package: field(
            text(PACKAGE_NAME_CHARS_MAX, { charsMin: 1, pattern: '^(?:@[a-z0-9][\\w.-]*/)?[a-z0-9][\\w.-]*$' }),
            'The npm package name, such as @scope/ui.',
            { required: true },
          ),
          directory: field(
            text(DIRECTORY_CHARS_MAX, { charsMin: 1, pattern: '^[\\w-]+(?:/[\\w-]+)*$' }),
            'The folder inside the package that holds the .astro components.',
            { required: true },
          ),
          importPrefix: field(
            text(IMPORT_PREFIX_CHARS_MAX, { charsMin: 1, pattern: '^(?:@/|@?[\\w-])[\\w@./-]*/$' }),
            'What an import of a component starts with, ending in a slash (@scope/ui/). Prefixes and directories of two sources must not overlap.',
            { required: true },
          ),
        }),
        COMPONENT_SOURCE_LIMITS.sourcesMax,
      ),
      'The configured packages.',
      { required: true },
    ),
  },
  empty: { version: 1, sources: [] },
  commands: [],
  parserSources: ['shared/properties/componentSources.ts'],
  parserKeyExceptions: {
    importPath: 'Read from a scanned component origin (parseComponentOrigin), a runtime shape of the scan, not a key of this file.',
    local: 'A value of origin.kind in the scan, not a key of this file.',
  },
};
