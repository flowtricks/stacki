// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/component-canvas.json`: the component canvas's layout and preview values, keyed by the component's file. The parser
// is shared/properties/componentCanvas.ts; preview values are what the canvas renders with and never reach the component.
import { CANVAS_LIMITS } from '../../componentCanvas';
import { arrayOf, field, jsonValue, literal, mapOf, objectOf, text, type FileSchema, type ValueSchema } from '../stackiSchema';

const COMPONENT_PATH = '^(?:src/|node_modules/)[^\\u0000]*\\.astro$';
const PROP_NAME = '^[A-Za-z_$][\\w$-]{0,99}$';
// Sorted `name` or `name=URI-encoded value` pairs joined by `&`; the empty key is every frame. parseFrameKey checks the order.
const FRAME_KEY = '^(?:[A-Za-z_$][\\w$-]*(?:=[^&]*)?(?:&[A-Za-z_$][\\w$-]*(?:=[^&]*)?)*)?$';
const COMMANDS = ['components rename', 'components move', 'components delete'] as const;

const length = (side: string): ValueSchema =>
  jsonValue(`"hug" (the ${side} follows the component) or a whole number of pixels from ${CANVAS_LIMITS.sizePxMin} to ${CANVAS_LIMITS.sizePxMax}`);

const frameEntry: ValueSchema = objectOf({
  props: field(
    mapOf(
      jsonValue('text, a finite number or true or false; componentCanvas.ts canvasValue refuses anything else'),
      CANVAS_LIMITS.valuesMax,
      'a prop name',
      PROP_NAME,
    ),
    'Preview values the frames this entry covers render with. They are never written to the component or its instances.',
  ),
  unset: field(
    arrayOf(text(CANVAS_LIMITS.propNameCharsMax, { pattern: PROP_NAME }), CANVAS_LIMITS.valuesMax, { unique: true }),
    'Props shown as not set here, over a wider entry.',
  ),
  width: field(length('width'), 'The frame width; absent: a wider entry decides, else hug.'),
  height: field(length('height'), 'The frame height; absent: a wider entry decides, else hug.'),
  background: field(text(CANVAS_LIMITS.backgroundCharsMax, { charsMin: 1 }), 'A CSS colour or var(--...) behind the component; absent: transparent.'),
});

export const COMPONENT_CANVAS_FILE_SCHEMA: FileSchema = {
  id: 'componentCanvas',
  file: '.stacki/component-canvas.json',
  description:
    'The component canvas, per component: which props get their own frames, and each frame\'s preview values, size and background. An entry keyed "" covers every frame, "variant=arrow" every arrow frame, and a full key one frame; a frame merges every entry whose pairs it has, the most specific last. Shared by Desktop and Studio.',
  requires: 'component:edit',
  metadataKind: 'componentCanvas',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    components: field(
      mapOf(
        objectOf({
          split: field(
            arrayOf(text(CANVAS_LIMITS.propNameCharsMax, { pattern: PROP_NAME }), CANVAS_LIMITS.splitPropsMax, { unique: true }),
            'The props whose values each get a frame, in layout order (the first is the rows); [] is one frame; absent: the variant prop.',
          ),
          frames: field(
            mapOf(frameEntry, CANVAS_LIMITS.entriesMax, 'a frame key: sorted name=value pairs joined by &, or "" for every frame', FRAME_KEY),
            'Frame settings by frame key.',
          ),
        }),
        CANVAS_LIMITS.componentsMax,
        'a project-relative component path (src/...)',
        COMPONENT_PATH,
      ),
      'Canvas settings by component file. Renaming, moving or deleting a component updates its key.',
      { required: true, commands: COMMANDS },
    ),
  },
  empty: { version: 1, components: {} },
  commands: [],
  parserSources: ['shared/properties/componentCanvas.ts'],
};
