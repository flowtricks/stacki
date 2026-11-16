// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/styles.json`: class and id names, and stylesheets or folders, the unused-selector cleanup must never remove.
// The parser is shared/properties/styleKeepList.ts; the Selectors panel writes it through serializeStyleKeepList.
import { STYLE_KEEP_LIMITS, parseStyleKeepList, serializeStyleKeepList } from '../../styleKeepList';
import { arrayOf, field, jsonValue, literal, text, type FileSchema } from '../stackiSchema';

export const STYLES_FILE: FileSchema = {
  id: 'styles',
  file: '.stacki/styles.json',
  description: "The unused-selector cleanup's keep list and locked stylesheets, shared by Desktop, Studio and check-project.",
  requires: 'panel:selectors',
  metadataKind: 'styles',
  serialize: (document) => serializeStyleKeepList(parseStyleKeepList(document)),
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    keep: field(
      arrayOf(text(STYLE_KEEP_LIMITS.patternCharsMax, { charsMin: 1, pattern: '^[^\\s"\'`,{}<>]+$' }), STYLE_KEEP_LIMITS.patternsMax, { unique: true }),
      'Class or id names the cleanup never removes; * matches any run of characters (is-*), and a pattern must name more than a wildcard.',
      { default: 'nothing is kept' },
    ),
    lockedStylesheets: field(
      arrayOf(text(STYLE_KEEP_LIMITS.lockedPathCharsMax, { charsMin: 1, pattern: '^[^/\\\\][^\\\\]*$' }), STYLE_KEEP_LIMITS.lockedStylesheetsMax, {
        unique: true,
      }),
      'Project-relative stylesheets (src/styles/patterns.css) and folders (src/styles/, ending in a slash) whose selectors the cleanup never removes.',
      { default: 'nothing is locked' },
    ),
    trustedScripts: field(
      jsonValue('Dropped on the next save; no reader uses it.'),
      'An earlier version stored the scripts trusted by the check; scripts no longer affect it.',
      { legacy: true },
    ),
  },
  empty: { version: 1, keep: [] },
  commands: [],
  parserSources: ['shared/properties/styleKeepList.ts'],
};
