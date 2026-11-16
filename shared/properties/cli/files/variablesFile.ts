// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/variables.json`: which custom properties the variable suggestion dropdowns leave out.
import { EMPTY_VARIABLE_VISIBILITY, VARIABLE_VISIBILITY_LIMITS, parseVariableVisibility, serializeVariableVisibility } from '../../variableVisibility';
import { arrayOf, field, literal, text, type FileSchema } from '../stackiSchema';

// The app's custom property rule (`isVariableName`): `--` and at least one more character that is not whitespace, a quote or a CSS delimiter.
const VARIABLE_NAME = '^--[^\\s"\'`;:{}()<>\\\\/,]+$';

/** The app's canonical writer on a document: parsed first, so a document the app refuses throws its reason; names come back sorted. */
function serializeVariablesDocument(document: Record<string, unknown>): string {
  const parsed = parseVariableVisibility(document);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return serializeVariableVisibility(parsed.value);
}

export const VARIABLES_FILE: FileSchema = {
  id: 'variables',
  file: '.stacki/variables.json',
  description:
    "The custom properties the style panel's variable picker leaves out of its suggestions. Hiding never touches the Variables panel, how a variable resolves, the canvas or the exported CSS; the variable already applied to the property being edited stays listed.",
  requires: 'panel:style',
  metadataKind: 'variables',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    hiddenFromSuggestions: field(
      arrayOf(text(VARIABLE_VISIBILITY_LIMITS.nameCharsMax, { charsMin: 3, pattern: VARIABLE_NAME }), VARIABLE_VISIBILITY_LIMITS.hiddenMax, { unique: true }),
      'Custom property names, leading -- included, that suggestion lists leave out. The app writes them sorted and without duplicates.',
      { required: true },
    ),
  },
  empty: { version: EMPTY_VARIABLE_VISIBILITY.version, hiddenFromSuggestions: [...EMPTY_VARIABLE_VISIBILITY.hiddenFromSuggestions] },
  serialize: serializeVariablesDocument,
  commands: [],
  parserSources: ['shared/properties/variableVisibility.ts'],
};
