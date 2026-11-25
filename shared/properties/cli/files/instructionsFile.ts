// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/instructions.json`: the paths the Instructions panel hides (skills, rules and docs), shared by Desktop and Studio.
import { INSTRUCTION_LIMITS } from '../../instructions';
import { arrayOf, field, literal, text, type FileSchema } from '../stackiSchema';

const WIRE_KEY = 'Wire key of the Instructions panel listing or a skill frontmatter, read by the same module; not a setting of the file.';

export const INSTRUCTIONS_FILE: FileSchema = {
  id: 'instructions',
  file: '.stacki/instructions.json',
  description: 'The Instructions panel settings: which Markdown files (skills, rules, docs) the project hides from the panel.',
  requires: 'instructions:edit',
  metadataKind: 'instructions',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    hidden: field(
      arrayOf(text(INSTRUCTION_LIMITS.patternCharsMax, { charsMin: 1 }), INSTRUCTION_LIMITS.hiddenMax, { unique: true }),
      'Project-relative paths or patterns, anchored at the project root, in the order they were added. A folder hides everything inside it; ** spans folders, * stays inside one name, ? is one character. No leading slash, no .. segments, / between folders.',
      { default: 'nothing hidden' },
    ),
  },
  empty: { version: 1, hidden: [] },
  commands: [],
  parserSources: ['shared/properties/instructions.ts'],
  parserKeyExceptions: {
    name: WIRE_KEY,
    description: WIRE_KEY,
    path: WIRE_KEY,
    section: WIRE_KEY,
    sizeBytes: WIRE_KEY,
    skill: WIRE_KEY,
    kind: WIRE_KEY,
    message: WIRE_KEY,
    files: WIRE_KEY,
    folders: WIRE_KEY,
    truncated: WIRE_KEY,
    source: WIRE_KEY,
    ok: WIRE_KEY,
    value: WIRE_KEY,
    error: WIRE_KEY,
    code: WIRE_KEY,
  },
};
