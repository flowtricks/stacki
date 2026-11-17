// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/styles.json`: class and id names, and stylesheets or folders, the unused-selector cleanup must never remove.
// The parser is shared/properties/styleKeepList.ts; the Selectors panel writes it through serializeStyleKeepList.
import { BOUNDARY_LIMITS } from '../../../core/boundary';
import { NEW_STYLE_TAG_RULES_TOKEN } from '../../newStyleTag';
import { STYLE_KEEP_LIMITS, parseStyleKeepList, serializeStyleKeepList } from '../../styleKeepList';
import { arrayOf, bool, field, integer, jsonValue, literal, objectOf, text, type FileSchema } from '../stackiSchema';

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
    newStyleTag: field(
      objectOf({
        version: field(integer(1, 2), 'The section format version: 2 writes attributes, 1 wrote isGlobal; absent reads as 1. Every save writes 2.'),
        attributes: field(
          text(BOUNDARY_LIMITS.textLengthMax),
          'The opening tag\'s attributes as written, for example is:global lang="scss". Names are Astro attribute names; values are quoted strings, never {expressions}. Empty means a plain <style>.',
          { default: 'is:global' },
        ),
        isGlobal: field(bool(), 'Version 1 only: whether the new tag carries is:global. Read, and written as attributes on the next save.', {
          default: true,
        }),
        content: field(
          text(BOUNDARY_LIMITS.textLengthMax),
          `The body a new <style> tag starts with. ${NEW_STYLE_TAG_RULES_TOKEN} marks where rules go (once; at the top level or inside at-rule blocks such as @layer). Without it, a template ending in a block at-rule (@layer components {}) takes rules inside it and any other template gets them after it. Empty means just the rules.`,
          { default: 'just the rules' },
        ),
      }),
      'What a <style> tag created by the Style panel starts with. Absent: <style is:global> holding just the rules.',
      { default: '<style is:global> holding just the rules' },
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
