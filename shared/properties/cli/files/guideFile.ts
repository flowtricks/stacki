// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/guide.json`: the column guide drawn over the canvas (visibility, colour, columns, margin, gutter, maximum width).
import { GUIDE_LIMITS } from '../../guideLimits';
import {
  bool,
  field,
  integer,
  literal,
  numberIn,
  objectOf,
  oneOf,
  text,
  variantOf,
  type FieldSchema,
  type FileSchema,
  type ValueSchema,
} from '../stackiSchema';

const VARIABLE = '^--[A-Za-z0-9_-]+$';

const size: ValueSchema = variantOf('kind', {
  length: {
    length: field(
      objectOf({
        amount: field(numberIn(0, GUIDE_LIMITS.lengthRemMax), 'The size: at most 100000 for px, 6000 for rem.', { required: true }),
        unit: field(oneOf('px', 'rem'), 'The unit.', { required: true }),
      }),
      'A fixed length.',
      { required: true },
    ),
  },
  variable: {
    name: field(text(GUIDE_LIMITS.variableCharsMax, { pattern: VARIABLE }), 'A CSS custom property of the project, such as --site-margin.', { required: true }),
  },
});

const sizeField = (what: string): FieldSchema =>
  field(size, `${what}; absent means the project's own variable, then the app default.`, { commands: ['guides set', 'guides clear'] });

export const GUIDE_FILE: FileSchema = {
  id: 'guide',
  file: '.stacki/guide.json',
  description: 'The column guide the canvas draws: shared by Desktop and Studio.',
  requires: 'settings:editor',
  metadataKind: 'guide',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    settings: field(
      objectOf({
        visible: field(bool(), 'Whether the guide is drawn.', { required: true, default: false, commands: ['guides set'] }),
        numbers: field(bool(), 'Whether columns are numbered.', { required: true, default: true, commands: ['guides set'] }),
        color: field(text(GUIDE_LIMITS.colorCharsMax, { charsMin: 1 }), 'A literal CSS colour (never var()).', {
          required: true,
          default: 'rgb(146, 146, 146)',
          commands: ['guides set'],
        }),
        opacity: field(numberIn(GUIDE_LIMITS.opacityMin, GUIDE_LIMITS.opacityMax), 'Column opacity.', {
          required: true,
          default: 0.06,
          commands: ['guides set'],
        }),
        columns: field(
          variantOf('kind', {
            automatic: {},
            count: { count: field(integer(GUIDE_LIMITS.columnPickMin, GUIDE_LIMITS.columnPickMax), 'How many columns.', { required: true }) },
            variable: {
              name: field(text(GUIDE_LIMITS.variableCharsMax, { pattern: VARIABLE }), 'A CSS custom property that holds the count.', { required: true }),
            },
          }),
          'Where the column count comes from.',
          { required: true, commands: ['guides set'] },
        ),
        margin: sizeField('The outer margin'),
        gutter: sizeField('The gap between columns'),
        widthMax: sizeField('The maximum content width'),
        columnDefaultsVersion: field(literal(1), 'Marks that the column default was chosen deliberately; the app writes it, set by "guides set".', {
          commands: ['guides set'],
        }),
      }),
      'The guide preferences.',
      { required: true, commands: ['guides set', 'guides clear'] },
    ),
  },
  empty: {
    version: 1,
    settings: { visible: false, numbers: true, color: 'rgb(146, 146, 146)', opacity: 0.06, columns: { kind: 'automatic' }, columnDefaultsVersion: 1 },
  },
  commands: ['guides set', 'guides clear'],
  parserSources: ['shared/properties/guidePreferences.ts', 'src/features/preview/guideSettings.ts'],
  parserKeyExceptions: {
    columnVariable: 'Legacy: older versions stored the variable beside columns:"project"; read once, never written.',
    project: 'Legacy value of columns, not a key.',
  },
};
