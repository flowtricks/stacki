// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/breakpoints.json`: Desktop's frame width and the breakpoints the preview bar jumps to (version 4).
import { BREAKPOINT_DEFAULT_LIST, BREAKPOINT_LIMITS, DESKTOP_DEFAULT, parseBreakpoints, serializeBreakpoints } from '../../projectBreakpoints';
import { arrayOf, field, literal, numberIn, objectOf, oneOf, text, type FieldSchema, type FileSchema } from '../stackiSchema';

const ID_PATTERN = '^[a-z][a-z0-9-]*$';

// A boundary has to land between boundaryPxMin and boundaryPxMax pixels. The unit decides the number, so the registry
// bounds the number by the widest reading (rem is the smaller number for the same pixels) and the app's parser refuses
// the exact range for the chosen unit.
const BOUNDARY_VALUE_MIN = BREAKPOINT_LIMITS.boundaryPxMin / BREAKPOINT_LIMITS.remPx;

const valueField: FieldSchema = field(
  numberIn(BOUNDARY_VALUE_MIN, BREAKPOINT_LIMITS.boundaryPxMax),
  'The width in the unit: the boundary must be 281px to 7681px (17.5625rem to 480.0625rem); a px value is a whole number, a rem value has at most 4 decimals.',
  { required: true },
);

const unitField: FieldSchema = field(oneOf('rem', 'px'), 'The unit of the value. The app reads rem at 16px.', { required: true });

/** The defaults in the order the app writes them: what the file holds when the first edit creates it. */
const EMPTY_BREAKPOINTS = {
  version: 4,
  desktop: { value: DESKTOP_DEFAULT.value, unit: DESKTOP_DEFAULT.unit },
  breakpoints: BREAKPOINT_DEFAULT_LIST.map((breakpoint) => ({ id: breakpoint.id, value: breakpoint.setting.value, unit: breakpoint.setting.unit })),
};

/** The app's canonical writer on a document: parsed first, so a document the app refuses throws its reason. */
function serializeBreakpointsDocument(document: Record<string, unknown>): string {
  const parsed = parseBreakpoints(document);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return serializeBreakpoints(parsed.value);
}

export const BREAKPOINTS_FILE: FileSchema = {
  id: 'breakpoints',
  file: '.stacki/breakpoints.json',
  description:
    "Desktop's frame width and the breakpoints the preview bar jumps to. A breakpoint's direction is never stored: wider than Desktop it is a min-width (up) query, narrower a max-width (down) one. The list is strictly decreasing in pixels, Desktop included.",
  requires: 'settings:breakpoints',
  metadataKind: 'breakpoints',
  fields: {
    version: field(literal(4), 'The file format version. Versions 1 to 3 are read and rewritten as 4 by the next edit.', { required: true }),
    desktop: field(
      objectOf({ value: valueField, unit: unitField }),
      "Desktop's frame width in the side-by-side view, and the line that decides which side of Desktop a breakpoint falls on; absent reads as 90rem (1440px).",
      { default: `${DESKTOP_DEFAULT.value}${DESKTOP_DEFAULT.unit}`, commands: ['breakpoints set'] },
    ),
    breakpoints: field(
      arrayOf(
        objectOf({
          id: field(
            text(BREAKPOINT_LIMITS.idCharsMax, { charsMin: 1, pattern: ID_PATTERN }),
            'The stable id the sync record and the preview device are named by: lower-case letters, digits and hyphens, never "desktop".',
            { required: true },
          ),
          name: field(
            text(BREAKPOINT_LIMITS.nameCharsMax, { charsMin: 1 }),
            'The name shown for the breakpoint, unique without regard to case; absent, a built-in one reads as Laptop, Tablet or Phone.',
            { commands: ['breakpoints set'] },
          ),
          value: valueField,
          unit: unitField,
          direction: field(oneOf('up', 'down'), 'Version 3 stored a direction: it is read and ignored, the app derives it from the number against Desktop.', {
            legacy: true,
          }),
        }),
        BREAKPOINT_LIMITS.countMax,
      ),
      'The breakpoints, widest first. An empty list means no breakpoints: the three built-in ones exist only while listed.',
      { required: true, commands: ['breakpoints add', 'breakpoints remove', 'breakpoints set'] },
    ),
    laptop: field(
      objectOf({ value: valueField, unit: unitField }),
      'Version 2 stored the three built-in breakpoints as top-level keys (version 1 as pixel numbers): read and rewritten as a list.',
      { legacy: true },
    ),
    tablet: field(objectOf({ value: valueField, unit: unitField }), 'Version 2 top-level key, as laptop.', { legacy: true }),
    phone: field(objectOf({ value: valueField, unit: unitField }), 'Version 2 top-level key, as laptop.', { legacy: true }),
  },
  empty: EMPTY_BREAKPOINTS,
  serialize: serializeBreakpointsDocument,
  commands: ['breakpoints set', 'breakpoints add', 'breakpoints remove'],
  parserSources: ['shared/properties/projectBreakpoints.ts'],
};
