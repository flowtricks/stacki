// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/styles.json`: class and id names, and stylesheets or folders, the unused-selector cleanup must never remove.
// The parser is shared/properties/styleKeepList.ts; the Selectors panel writes it through serializeStyleKeepList.
import { BOUNDARY_LIMITS } from '../../../core/boundary';
import { NEW_STYLE_LOCATION_LIMITS } from '../../newStyleLocations';
import { NEW_STYLE_TAG_RULES_TOKEN } from '../../newStyleTag';
import { STYLE_KEEP_LIMITS, parseStyleKeepList, serializeStyleKeepList } from '../../styleKeepList';
import { arrayOf, bool, field, integer, jsonValue, literal, objectOf, oneOf, text, type FileSchema } from '../stackiSchema';

const NEW_STYLE_TAG_SCHEMA = objectOf({
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
});

const NEW_STYLE_LOCATION_SCHEMA = objectOf({
  use: field(oneOf('tag', 'file'), 'tag: a <style> tag in the open file; file: an existing stylesheet of the project.', { default: 'tag' }),
  file: field(
    text(NEW_STYLE_LOCATION_LIMITS.pathCharsMax, { charsMin: 1, pattern: '^[^/\\\\][^\\\\]*\\.(css|scss|sass|less)$' }),
    'The project-relative stylesheet new styles are appended to (src/styles/global.css). Only with use "file". A missing file falls back to the tag.',
  ),
  tag: field(NEW_STYLE_TAG_SCHEMA, 'What a <style> tag created in this scope starts with; kept while a file is chosen.'),
});

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
    newStyleTag: field(NEW_STYLE_TAG_SCHEMA, 'What a <style> tag created by the Style panel starts with. Absent: <style is:global> holding just the rules.', {
      default: '<style is:global> holding just the rules',
    }),
    newStyleLocations: field(
      objectOf({
        version: field(literal(1), 'The section format version.', { required: true }),
        page: field(NEW_STYLE_LOCATION_SCHEMA, 'Where a style created while a page is open goes.', { default: 'a <style> tag in the page' }),
        component: field(
          NEW_STYLE_LOCATION_SCHEMA,
          'Where a style created while a component is open goes, and what a component made by Create component starts with.',
          {
            default: 'a <style> tag in the component',
          },
        ),
      }),
      'Where the Style panel creates new styles, for a page and for a component. Absent: the newStyleTag section applies to both.',
      { default: 'a <style> tag, from newStyleTag' },
    ),
    trustedScripts: field(
      jsonValue('Dropped on the next save; no reader uses it.'),
      'An earlier version stored the scripts trusted by the check; scripts no longer affect it.',
      { legacy: true },
    ),
  },
  empty: { version: 1, keep: [] },
  commands: [],
  parserSources: ['shared/properties/styleKeepList.ts', 'shared/properties/newStyleLocations.ts'],
};
